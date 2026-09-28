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

const MEMES = '00000000-0000-0000-0000-0000000000a2';
const now = () => new Date().toISOString();
const textItem = (extra: object = {}) => ({ id: uuidv7(), kind: 'text', body: 'hello', capturedAt: now(), ...extra });

test('create is 201, an identical retry is 200 and does not advance rev', async () => {
  const input = textItem({ title: 'first', categoryIds: [INBOX_CATEGORY_ID] });
  const a = await dev.request('POST', '/v1/items', input);
  assert.equal(a.statusCode, 201);
  assert.deepEqual(a.json().categoryIds, [INBOX_CATEGORY_ID]);

  const b = await dev.request('POST', '/v1/items', input);
  assert.equal(b.statusCode, 200);
  assert.equal(b.json().rev, a.json().rev);
});

test('an upsert that changes editable fields or categories advances rev', async () => {
  const input = textItem();
  const a = (await dev.request('POST', '/v1/items', input)).json();
  const b = (await dev.request('POST', '/v1/items', { ...input, title: 'renamed' })).json();
  assert.ok(b.rev > a.rev);
  assert.equal(b.title, 'renamed');
  const c = (await dev.request('POST', '/v1/items', { ...input, title: 'renamed', categoryIds: [MEMES] })).json();
  assert.ok(c.rev > b.rev, 'a membership-only change still bumps the item');
  assert.deepEqual(c.categoryIds, [MEMES]);
});

test("what was shared can't change on upsert", async () => {
  const input = textItem();
  await dev.request('POST', '/v1/items', input);
  const res = await dev.request('POST', '/v1/items', { ...input, capturedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'immutable');
});

test('unknown categories are dropped, not rejected', async () => {
  const res = await dev.request('POST', '/v1/items', textItem({ categoryIds: [uuidv7(), MEMES] }));
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().categoryIds, [MEMES]);
});

test('media items need a committed blob, and embed it', async () => {
  const blob = await h.committedBlob(dev);
  const res = await dev.request('POST', '/v1/items', {
    id: uuidv7(),
    kind: 'image',
    blobSha256: blob.sha256,
    capturedAt: now(),
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().blob.id, blob.blobId);
  assert.equal(res.json().blob.byteSize, blob.bytes.length);

  // Download URL serves exactly the bytes, with the declared type.
  const url = (await dev.request('GET', `/v1/items/${res.json().id}/url`)).json().url;
  const got = await fetch(url);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), blob.bytes);

  const missing = await dev.request('POST', '/v1/items', {
    id: uuidv7(), kind: 'image', blobSha256: 'f'.repeat(64), capturedAt: now(),
  });
  assert.equal(missing.json().error, 'blob_missing');

  const { sha256, bytes } = h.randomBlob();
  await dev.request('POST', '/v1/blobs/presign', { sha256, byteSize: bytes.length, mimeType: 'image/png' });
  const uncommitted = await dev.request('POST', '/v1/items', {
    id: uuidv7(), kind: 'image', blobSha256: sha256, capturedAt: now(),
  });
  assert.equal(uncommitted.json().error, 'blob_not_committed');
});

test('shape rules per kind', async () => {
  const bad = [
    { kind: 'image' },
    { kind: 'text', body: undefined },
    { kind: 'text', blobSha256: 'a'.repeat(64) },
    { kind: 'link' },
    { kind: 'link', url: 'javascript:alert(1)' },
  ];
  for (const extra of bad) {
    const res = await dev.request('POST', '/v1/items', textItem(extra));
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
  }
  const link = await dev.request('POST', '/v1/items', textItem({ kind: 'link', body: undefined, url: 'https://example.com/a' }));
  assert.equal(link.statusCode, 201);
});

test('patch edits only what it names; a no-op patch keeps rev', async () => {
  const a = (await dev.request('POST', '/v1/items', textItem({ title: 't', note: 'n' }))).json();
  const b = (await dev.request('PATCH', `/v1/items/${a.id}`, { note: null, tags: ['x'] })).json();
  assert.equal(b.title, 't');
  assert.equal(b.note, null);
  assert.deepEqual(b.tags, ['x']);
  assert.ok(b.rev > a.rev);

  const c = (await dev.request('PATCH', `/v1/items/${a.id}`, { note: null, tags: ['x'] })).json();
  assert.equal(c.rev, b.rev);

  const d = (await dev.request('PATCH', `/v1/items/${a.id}`, { categoryIds: [MEMES] })).json();
  assert.ok(d.rev > c.rev);

  assert.equal((await dev.request('PATCH', `/v1/items/${a.id}`, { kind: 'image' })).statusCode, 400);
});

test('delete is soft, idempotent, and never undone by a stale create retry', async () => {
  const input = textItem();
  const created = (await dev.request('POST', '/v1/items', input)).json();
  assert.equal((await dev.request('DELETE', `/v1/items/${created.id}`)).statusCode, 204);
  assert.equal((await dev.request('DELETE', `/v1/items/${created.id}`)).statusCode, 204);

  const retry = await dev.request('POST', '/v1/items', { ...input, title: 'resurrect?' });
  assert.equal(retry.statusCode, 200);
  assert.ok(retry.json().deletedAt);
  assert.equal(retry.json().title, null);

  const got = (await dev.request('GET', `/v1/items/${created.id}`)).json();
  assert.ok(got.deletedAt && got.rev > created.rev);
  assert.equal((await dev.request('PATCH', `/v1/items/${created.id}`, { title: 'x' })).statusCode, 404);
  assert.equal((await dev.request('DELETE', `/v1/items/${uuidv7()}`)).statusCode, 404);
});
