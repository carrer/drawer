import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INBOX_CATEGORY_ID } from '@drawer/shared';
import { migrate, SCHEMA_VERSION } from './migrations.ts';
import {
  countItems,
  createCategory,
  deleteCategory,
  deleteItem,
  DuplicateCategoryError,
  getItem,
  InboxUndeletableError,
  insertItems,
  listCategories,
  listItems,
  moveCategory,
  setImageSize,
  updateCategory,
  updateItem,
  countUnsynced,
  wipeLocalData,
} from './repo.ts';
import { seedSampleData } from './seed.ts';
import { memoryDb } from './testing.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 12, minute)).toISOString();

test('migrations seed the same four default categories as the server, already synced', () => {
  const db = memoryDb();
  const cats = listCategories(db);
  assert.deepEqual(
    cats.map((c) => c.name),
    ['Inbox', 'Memes', 'Read later', 'Reference'],
  );
  assert.equal(cats[0]!.id, INBOX_CATEGORY_ID);
  assert.ok(cats.every((c) => c.syncState === 'synced'));
});

test('migrate is idempotent and records the schema version', () => {
  const db = memoryDb();
  migrate(db);
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version, SCHEMA_VERSION);
  assert.equal(listCategories(db).length, 4);
});

test('migrate refuses a database from a newer build instead of corrupting it', () => {
  const db = memoryDb();
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => migrate(db), /newer than this build/);
});

test('captures land in Inbox by default, newest first', () => {
  const db = memoryDb();
  insertItems(db, [
    { kind: 'text', body: 'older', capturedAt: at(1) },
    { kind: 'link', url: 'https://example.com', capturedAt: at(2) },
  ]);
  const items = listItems(db);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['link', 'text'],
  );
  assert.ok(items.every((i) => i.categoryIds.join() === INBOX_CATEGORY_ID));
  assert.ok(items.every((i) => i.syncState === 'local'));
});

test('items captured in the same instant come back in a stable order', () => {
  const db = memoryDb();
  const ids = insertItems(db, [1, 2, 3].map((n) => ({ kind: 'text' as const, body: `n${n}`, capturedAt: at(0) })));
  const order = listItems(db).map((i) => i.id);
  assert.deepEqual(order, [...ids].sort().reverse());
  assert.deepEqual(listItems(db).map((i) => i.id), order);
});

test('inserting an existing id is a no-op, so a retried capture cannot duplicate', () => {
  const db = memoryDb();
  const [id] = insertItems(db, [{ kind: 'text', body: 'first', capturedAt: at(1) }]);
  insertItems(db, [{ id, kind: 'text', body: 'second', capturedAt: at(1), categoryIds: [] }]);
  assert.equal(countItems(db), 1);
  const item = getItem(db, id!)!;
  assert.equal(item.body, 'first');
  assert.deepEqual(item.categoryIds, [INBOX_CATEGORY_ID]);
});

test('filters by category and by kind, and counts match', () => {
  const db = memoryDb();
  const memes = listCategories(db).find((c) => c.name === 'Memes')!.id;
  insertItems(db, [
    { kind: 'image', capturedAt: at(1), categoryIds: [memes] },
    { kind: 'image', capturedAt: at(2) },
    { kind: 'text', body: 'x', capturedAt: at(3), categoryIds: [memes, INBOX_CATEGORY_ID] },
  ]);
  assert.equal(listItems(db, { categoryId: memes }).length, 2);
  assert.equal(listItems(db, { kind: 'image' }).length, 2);
  assert.equal(listItems(db, { categoryId: memes, kind: 'image' }).length, 1);
  assert.equal(countItems(db, { categoryId: INBOX_CATEGORY_ID }), 2);
  assert.equal(listCategories(db).find((c) => c.id === memes)!.itemCount, 2);
});

test('search matches any text field, ignoring case, and treats % and _ literally', () => {
  const db = memoryDb();
  insertItems(db, [
    { kind: 'link', url: 'https://uxdesign.cc/empty-states', linkTitle: 'Designing better empty states', capturedAt: at(1) },
    { kind: 'text', body: 'Pick up the film on Thursday', note: 'lab closes at 6', capturedAt: at(2) },
    { kind: 'text', body: 'discount: 100% off', capturedAt: at(3) },
    { kind: 'text', body: 'snake_case names', capturedAt: at(4) },
  ]);
  const hits = (query: string) => listItems(db, { query }).map((i) => i.body ?? i.linkTitle);
  assert.deepEqual(hits('EMPTY'), ['Designing better empty states']);
  assert.deepEqual(hits('uxdesign'), ['Designing better empty states'], 'the URL is searched');
  assert.deepEqual(hits('closes'), ['Pick up the film on Thursday'], 'the note is searched');
  assert.deepEqual(hits('100%'), ['discount: 100% off']);
  assert.deepEqual(hits('e_c'), ['snake_case names']);
  assert.deepEqual(hits('%'), ['discount: 100% off'], 'a bare % is not a wildcard');
  assert.equal(listItems(db, { query: '   ' }).length, 4, 'a blank query filters nothing');
  assert.equal(countItems(db, { query: 'film' }), 1);
});

test('order oldest reverses the feed', () => {
  const db = memoryDb();
  insertItems(db, [1, 2, 3].map((n) => ({ kind: 'text' as const, body: `n${n}`, capturedAt: at(n) })));
  assert.deepEqual(
    listItems(db, { order: 'oldest' }).map((i) => i.body),
    ['n1', 'n2', 'n3'],
  );
});

test('limit caps the page', () => {
  const db = memoryDb();
  insertItems(db, Array.from({ length: 10 }, (_, n) => ({ kind: 'text' as const, body: `${n}`, capturedAt: at(n) })));
  assert.equal(listItems(db, { limit: 4 }).length, 4);
  assert.equal(countItems(db), 10);
});

test('updateItem follows ItemPatch: omitted untouched, null or blank clears, categories replaced', () => {
  const db = memoryDb();
  const memes = listCategories(db).find((c) => c.name === 'Memes')!.id;
  const [id] = insertItems(db, [{ kind: 'image', title: 'cat.jpg', note: 'lol', capturedAt: at(1) }]);
  db.run(`UPDATE items SET sync_state = 'synced' WHERE id = ?`, [id!]);

  assert.equal(updateItem(db, id!, { note: '   ', categoryIds: [memes, memes, 'not-a-category'] }), true);
  const item = getItem(db, id!)!;
  assert.equal(item.title, 'cat.jpg');
  assert.equal(item.note, null);
  assert.deepEqual(item.categoryIds, [memes]);
  assert.equal(item.syncState, 'local', 'an edit to a synced item makes it pending again');
});

test('an edit does not knock an item out of uploading', () => {
  const db = memoryDb();
  const [id] = insertItems(db, [{ kind: 'image', capturedAt: at(1) }]);
  db.run(`UPDATE items SET sync_state = 'uploading' WHERE id = ?`, [id!]);
  updateItem(db, id!, { title: 'renamed' });
  assert.equal(getItem(db, id!)!.syncState, 'uploading');
});

test('deleted items leave the feed but stay readable, and cannot be edited', () => {
  const db = memoryDb();
  const [id] = insertItems(db, [{ kind: 'text', body: 'bye', capturedAt: at(1) }]);
  deleteItem(db, id!);
  assert.equal(countItems(db), 0);
  assert.ok(getItem(db, id!)!.deletedAt);
  assert.equal(updateItem(db, id!, { title: 'zombie' }), false);
  assert.equal(listCategories(db)[0]!.itemCount, 0);
});

test('setImageSize records dimensions without marking the item dirty', () => {
  const db = memoryDb();
  const [id] = insertItems(db, [{ kind: 'image', capturedAt: at(1) }]);
  db.run(`UPDATE items SET sync_state = 'synced' WHERE id = ?`, [id!]);
  setImageSize(db, id!, 1080.4, 1920);
  const item = getItem(db, id!)!;
  assert.deepEqual([item.width, item.height, item.syncState], [1080, 1920, 'synced']);
  setImageSize(db, id!, 0, 100); // bogus sizes are ignored
  assert.equal(getItem(db, id!)!.width, 1080);
});

test('category names are unique among live categories, ignoring case', () => {
  const db = memoryDb();
  assert.throws(() => createCategory(db, { name: '  inbox ' }), DuplicateCategoryError);
  const id = createCategory(db, { name: 'Recipes', icon: '🍝' });
  assert.equal(listCategories(db).at(-1)!.id, id, 'new categories go to the end');
  assert.throws(() => updateCategory(db, id, { name: 'MEMES' }), DuplicateCategoryError);

  deleteCategory(db, id);
  assert.doesNotThrow(() => createCategory(db, { name: 'recipes' }), 'a deleted name can be reused');
});

test('deleting a category removes memberships and marks those items pending', () => {
  const db = memoryDb();
  const memes = listCategories(db).find((c) => c.name === 'Memes')!.id;
  const [id] = insertItems(db, [{ kind: 'image', capturedAt: at(1), categoryIds: [memes, INBOX_CATEGORY_ID] }]);
  db.run(`UPDATE items SET sync_state = 'synced'`);

  deleteCategory(db, memes);
  const item = getItem(db, id!)!;
  assert.deepEqual(item.categoryIds, [INBOX_CATEGORY_ID]);
  assert.equal(item.syncState, 'local');
  assert.ok(!listCategories(db).some((c) => c.id === memes));
});

test('Inbox cannot be deleted', () => {
  const db = memoryDb();
  assert.throws(() => deleteCategory(db, INBOX_CATEGORY_ID), InboxUndeletableError);
});

test('moveCategory swaps neighbours and ignores moves off either end', () => {
  const db = memoryDb();
  const names = () => listCategories(db).map((c) => c.name);
  const readLater = listCategories(db)[2]!.id;
  moveCategory(db, readLater, -1);
  assert.deepEqual(names(), ['Inbox', 'Read later', 'Memes', 'Reference']);
  moveCategory(db, INBOX_CATEGORY_ID, -1);
  assert.deepEqual(names(), ['Inbox', 'Read later', 'Memes', 'Reference']);
  const syncedAfter = listCategories(db).filter((c) => c.syncState === 'synced').map((c) => c.name);
  assert.deepEqual(syncedAfter, ['Inbox', 'Reference'], 'only categories that actually moved are dirty');
});

test('the dev seed covers every kind and is safe to run twice', () => {
  const db = memoryDb();
  const first = seedSampleData(db);
  const second = seedSampleData(db);
  assert.ok(first > 0);
  assert.equal(second, 0);
  const kinds = new Set(listItems(db, { limit: 1000 }).map((i) => i.kind));
  assert.deepEqual([...kinds].sort(), ['audio', 'document', 'image', 'link', 'text', 'video']);
});

test('wipeLocalData leaves exactly what a fresh install has', () => {
  const db = memoryDb();
  const fresh = listCategories(db);
  seedSampleData(db);
  createCategory(db, { name: 'Extra' });
  assert.ok(countUnsynced(db) > 0);

  wipeLocalData(db);
  assert.deepEqual(listItems(db), []);
  assert.deepEqual(listCategories(db), fresh);
  assert.equal(countUnsynced(db), 0);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM item_categories')?.n, 0);
});
