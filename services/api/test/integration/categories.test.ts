import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { INBOX_CATEGORY_ID, uuidv7 } from '@drawer/shared';
import { setup } from './harness.ts';

let h: Awaited<ReturnType<typeof setup>>;
let dev: Awaited<ReturnType<typeof h.device>>;
before(async () => {
  h = await setup();
  dev = await h.device();
});
after(() => h.teardown());

test('the seeded defaults are listed in order', async () => {
  const { categories } = (await dev.request('GET', '/v1/categories')).json();
  assert.deepEqual(
    categories.map((c: { name: string }) => c.name),
    ['Inbox', 'Memes', 'Read later', 'Reference'],
  );
});

test('upsert: 201, then an identical retry keeps rev, then an edit bumps it', async () => {
  const input = { id: uuidv7(), name: 'Recipes', color: '#ff8800', icon: '🍳', sortOrder: 9 };
  const a = await dev.request('POST', '/v1/categories', input);
  assert.equal(a.statusCode, 201);
  const b = await dev.request('POST', '/v1/categories', input);
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().rev, a.json().rev);
  const c = (await dev.request('POST', '/v1/categories', { ...input, name: 'Cooking' })).json();
  assert.ok(c.rev > a.json().rev);
});

test('names are unique case-insensitively among live categories', async () => {
  const res = await dev.request('POST', '/v1/categories', { id: uuidv7(), name: 'memes' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'name_taken');

  const other = (await dev.request('POST', '/v1/categories', { id: uuidv7(), name: 'Other' })).json();
  assert.equal((await dev.request('PATCH', `/v1/categories/${other.id}`, { name: 'INBOX' })).json().error, 'name_taken');
});

test('delete drops memberships and bumps the affected items', async () => {
  const cat = (await dev.request('POST', '/v1/categories', { id: uuidv7(), name: 'Temp' })).json();
  const item = (
    await dev.request('POST', '/v1/items', {
      id: uuidv7(), kind: 'text', body: 'x', capturedAt: new Date().toISOString(),
      categoryIds: [cat.id, INBOX_CATEGORY_ID],
    })
  ).json();

  assert.equal((await dev.request('DELETE', `/v1/categories/${cat.id}`)).statusCode, 204);
  const after = (await dev.request('GET', `/v1/items/${item.id}`)).json();
  assert.deepEqual(after.categoryIds, [INBOX_CATEGORY_ID]);
  assert.ok(after.rev > item.rev);

  // Its name is free again, and the tombstone isn't resurrected by a retry.
  assert.equal((await dev.request('POST', '/v1/categories', { id: uuidv7(), name: 'Temp' })).statusCode, 201);
  const retry = (await dev.request('POST', '/v1/categories', { id: cat.id, name: 'Temp again' })).json();
  assert.ok(retry.deletedAt);
  assert.equal(retry.name, 'Temp');
});

test('the Inbox cannot be deleted, but can be renamed', async () => {
  assert.equal((await dev.request('DELETE', `/v1/categories/${INBOX_CATEGORY_ID}`)).statusCode, 409);
  const renamed = await dev.request('PATCH', `/v1/categories/${INBOX_CATEGORY_ID}`, { name: 'Unsorted' });
  assert.equal(renamed.json().name, 'Unsorted');
});
