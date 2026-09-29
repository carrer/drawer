import assert from 'node:assert/strict';
import { uuidv7 } from '@drawer/shared';
import { after, before, test } from 'node:test';
import { setup } from './harness.ts';

let h: Awaited<ReturnType<typeof setup>>;
let dev: Awaited<ReturnType<typeof h.device>>;
before(async () => {
  h = await setup();
  dev = await h.device();
});
after(() => h.teardown());

/** An item backed by a real, committed blob in Garage. */
async function fileItem(title: string | null = 'Beach day') {
  const blob = await h.committedBlob(dev, 'image/png');
  const id = uuidv7();
  const res = await dev.request('POST', '/v1/items', {
    id,
    kind: 'image',
    title,
    blobSha256: blob.sha256,
    capturedAt: new Date().toISOString(),
  });
  assert.equal(res.statusCode, 201, res.body);
  return { id, bytes: blob.bytes };
}

const mint = (id: string) => dev.request('POST', `/v1/items/${id}/share`);
/** Redeem as a browser would, but look at the redirect instead of following it. */
const redeem = (url: string) => h.app.inject({ method: 'GET', url: new URL(url).pathname });

test('a share link downloads the original once, then is gone', async () => {
  const item = await fileItem();
  const res = await mint(item.id);
  assert.equal(res.statusCode, 200, res.body);
  const share = res.json();
  assert.equal(share.ttlSeconds, 30);
  assert.match(share.url, /\/s\/[A-Za-z0-9_-]{22}$/);
  const left = Date.parse(share.expiresAt) - Date.now();
  assert.ok(left > 25_000 && left <= 30_000, `expires in ${left}ms`);

  const first = await redeem(share.url);
  assert.equal(first.statusCode, 302);
  assert.equal(first.headers['cache-control'], 'no-store');

  // The redirect is a presigned GET straight to Garage, as a download.
  const download = await fetch(first.headers.location as string);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="Beach day\.png"/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), item.bytes);

  assert.equal((await redeem(share.url)).statusCode, 410);
});

test('concurrent scans of one code: exactly one wins', async () => {
  const item = await fileItem();
  const { url } = (await mint(item.id)).json();
  const results = await Promise.all(Array.from({ length: 8 }, () => redeem(url)));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [302, 410, 410, 410, 410, 410, 410, 410]);
});

test('an expired code, a deleted item and an unknown token all look the same', async () => {
  const expired = await fileItem();
  const a = (await mint(expired.id)).json();
  await h.pool.query(`UPDATE share_tokens SET expires_at = now() - interval '1 second'`);

  const deleted = await fileItem();
  const b = (await mint(deleted.id)).json();
  assert.equal((await dev.request('DELETE', `/v1/items/${deleted.id}`)).statusCode, 204);

  const unknown = a.url.replace(/\/s\/.*$/, `/s/${'A'.repeat(22)}`);
  const bodies = new Set<string>();
  for (const url of [a.url, b.url, unknown]) {
    const res = await redeem(url);
    assert.equal(res.statusCode, 410, url);
    bodies.add(res.body);
  }
  assert.equal(bodies.size, 1);
});

test('only items with a stored original can be shared, and only by their owner', async () => {
  const link = uuidv7();
  await dev.request('POST', '/v1/items', {
    id: link,
    kind: 'link',
    url: 'https://example.com',
    capturedAt: new Date().toISOString(),
  });
  assert.equal((await mint(link)).statusCode, 404);
  assert.equal((await mint(uuidv7())).statusCode, 404);
  assert.equal((await dev.request('POST', '/v1/items/not-a-uuid/share')).statusCode, 400);
});

test('tokens are stored hashed, and minting prunes long-expired ones', async () => {
  const item = await fileItem();
  const { url } = (await mint(item.id)).json();
  const token = url.split('/s/')[1];
  const { rows } = await h.pool.query(`SELECT 1 FROM share_tokens WHERE token_hash = convert_to($1, 'UTF8')`, [token]);
  assert.equal(rows.length, 0, 'plaintext token must not be stored');

  await h.pool.query(`UPDATE share_tokens SET expires_at = now() - interval '2 hours'`);
  await mint(item.id);
  const left = await h.pool.query(`SELECT count(*)::int AS n FROM share_tokens`);
  assert.equal(left.rows[0].n, 1);
});
