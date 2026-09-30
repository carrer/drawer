/**
 * Two accounts on one drawer must not see, touch or reference each other's
 * data — including where they deliberately share ids (every account's Inbox has
 * INBOX_CATEGORY_ID) or content (the same file's SHA-256).
 */
import assert from 'node:assert/strict';
import { INBOX_CATEGORY_ID, uuidv7 } from '@drawer/shared';
import { after, before, test } from 'node:test';
import { putBytes, setup } from './harness.ts';

let h: Awaited<ReturnType<typeof setup>>;
let a: Awaited<ReturnType<typeof h.device>>;
let b: Awaited<ReturnType<typeof h.device>>;
before(async () => {
  h = await setup();
  a = await (await h.user('a@example.com')).device('a-phone');
  b = await (await h.user('b@example.com')).device('b-phone');
});
after(() => h.teardown());

const now = () => new Date().toISOString();

test('items: invisible and untouchable across accounts, in reads, sync and search', async () => {
  const id = uuidv7();
  const created = await a.request('POST', '/v1/items', { id, kind: 'text', body: 'zebra secret', capturedAt: now() });
  assert.equal(created.statusCode, 201);

  assert.equal((await b.request('GET', `/v1/items/${id}`)).statusCode, 404);
  assert.equal((await b.request('PATCH', `/v1/items/${id}`, { title: 'mine now' })).statusCode, 404);
  assert.equal((await b.request('DELETE', `/v1/items/${id}`)).statusCode, 404);
  assert.equal((await b.request('POST', `/v1/items/${id}/share`)).statusCode, 404);
  // Upserting over someone else's id doesn't overwrite it.
  assert.equal(
    (await b.request('POST', '/v1/items', { id, kind: 'text', body: 'overwrite', capturedAt: now() })).statusCode,
    404,
  );
  assert.equal((await a.request('GET', `/v1/items/${id}`)).json().body, 'zebra secret');

  const bSync = (await b.request('GET', '/v1/sync?since=0')).json();
  assert.ok(!bSync.items.some((i: { id: string }) => i.id === id));
  assert.deepEqual((await b.request('GET', '/v1/search?q=zebra')).json().items, []);
  assert.equal((await a.request('GET', '/v1/search?q=zebra')).json().items.length, 1);
});

test('categories: each account has its own Inbox under the shared well-known id', async () => {
  const rename = await a.request('PATCH', `/v1/categories/${INBOX_CATEGORY_ID}`, { name: 'A’s inbox' });
  assert.equal(rename.statusCode, 200);

  const inbox = async (dev: typeof a) =>
    (await dev.request('GET', '/v1/categories')).json().categories.find((c: { id: string }) => c.id === INBOX_CATEGORY_ID)
      .name;
  assert.equal(await inbox(a), 'A’s inbox');
  assert.equal(await inbox(b), 'Inbox');

  // Sync ships only your own categories, even though the ids coincide.
  const cats = (await b.request('GET', '/v1/sync?since=0')).json().categories;
  assert.equal(cats.find((c: { id: string }) => c.id === INBOX_CATEGORY_ID).name, 'Inbox');
  assert.equal(new Set(cats.map((c: { id: string }) => c.id)).size, cats.length);

  // A category only one account has is out of reach of the other.
  const aOnly = uuidv7();
  await a.request('POST', '/v1/categories', { id: aOnly, name: 'Private', sortOrder: 9 });
  assert.equal((await b.request('PATCH', `/v1/categories/${aOnly}`, { name: 'x' })).statusCode, 404);
  assert.equal((await b.request('DELETE', `/v1/categories/${aOnly}`)).statusCode, 404);
  // …and filing an item under it is silently dropped, like any unknown category.
  const item = await b.request('POST', '/v1/items', {
    id: uuidv7(),
    kind: 'text',
    body: 'b',
    categoryIds: [aOnly, INBOX_CATEGORY_ID],
    capturedAt: now(),
  });
  assert.deepEqual(item.json().categoryIds, [INBOX_CATEGORY_ID]);
});

test('deleting your category leaves the other account’s same-id category and memberships alone', async () => {
  const memes = '00000000-0000-0000-0000-0000000000a2';
  const bItem = uuidv7();
  await b.request('POST', '/v1/items', { id: bItem, kind: 'text', body: 'meme', categoryIds: [memes], capturedAt: now() });
  assert.equal((await a.request('DELETE', `/v1/categories/${memes}`)).statusCode, 204);
  assert.deepEqual((await b.request('GET', `/v1/items/${bItem}`)).json().categoryIds, [memes]);
});

test('blobs: knowing a file’s hash gives you nothing of someone else’s', async () => {
  const { sha256, bytes, blobId } = await h.committedBlob(a, 'image/png');

  // No dedupe across accounts — B learns nothing, and must upload its own copy.
  const p = (await b.request('POST', '/v1/blobs/presign', { sha256, byteSize: bytes.length, mimeType: 'image/png' })).json();
  assert.equal(p.exists, false);
  assert.notEqual(p.blobId, blobId);

  // B can't attach A's bytes by hash before holding them…
  const early = await b.request('POST', '/v1/items', { id: uuidv7(), kind: 'image', blobSha256: sha256, capturedAt: now() });
  assert.equal(early.statusCode, 409);
  // …can't commit A's blob id…
  assert.equal((await b.request('POST', `/v1/blobs/${blobId}/commit`)).statusCode, 404);
  // …and B's commit of its own row isn't satisfied by A's object: separate keys.
  assert.equal((await b.request('POST', `/v1/blobs/${p.blobId}/commit`)).json().error, 'not_uploaded');

  assert.equal((await putBytes(p.uploadUrl, bytes)).status, 200);
  assert.equal((await b.request('POST', `/v1/blobs/${p.blobId}/commit`)).statusCode, 200);
  const keys = await h.pool.query<{ owner_id: string; storage_key: string }>(
    `SELECT owner_id, storage_key FROM blobs WHERE sha256 = decode($1, 'hex')`,
    [sha256],
  );
  assert.equal(keys.rows.length, 2);
  for (const r of keys.rows) assert.ok(r.storage_key.startsWith(`blobs/${r.owner_id}/`), r.storage_key);
});

test('the schema itself refuses cross-account references', async () => {
  const { blobId } = await h.committedBlob(a, 'image/png');
  const bOwner = (await b.request('GET', '/v1/auth/whoami')).json().ownerId;
  await assert.rejects(
    h.pool.query(
      `INSERT INTO items (id, owner_id, kind, blob_id, captured_at) VALUES ($1, $2, 'image', $3, now())`,
      [uuidv7(), bOwner, blobId],
    ),
    /items_blob_fkey/,
  );
});
