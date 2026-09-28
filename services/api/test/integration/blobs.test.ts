import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { putBytes, setup } from './harness.ts';

let h: Awaited<ReturnType<typeof setup>>;
let dev: Awaited<ReturnType<typeof h.device>>;
before(async () => {
  h = await setup();
  dev = await h.device();
});
after(() => h.teardown());

const presign = (sha256: string, byteSize: number, mimeType = 'image/png') =>
  dev.request('POST', '/v1/blobs/presign', { sha256, byteSize, mimeType });

test('presign → PUT → commit, then the same bytes dedupe to exists:true', async () => {
  const { bytes, sha256 } = h.randomBlob(4096);

  const first = await presign(sha256, bytes.length);
  assert.equal(first.statusCode, 200);
  const p = first.json();
  assert.equal(p.exists, false);
  assert.ok(new URL(p.uploadUrl));

  assert.equal((await putBytes(p.uploadUrl, bytes)).status, 200);

  const commit = await dev.request('POST', `/v1/blobs/${p.blobId}/commit`);
  assert.equal(commit.statusCode, 200);
  assert.deepEqual(
    { id: commit.json().id, sha256: commit.json().sha256, byteSize: commit.json().byteSize },
    { id: p.blobId, sha256, byteSize: 4096 },
  );

  const again = await presign(sha256, bytes.length);
  assert.deepEqual(again.json(), { exists: true, blobId: p.blobId });
});

test('commit is idempotent', async () => {
  const { bytes, sha256 } = h.randomBlob();
  const p = (await presign(sha256, bytes.length)).json();
  await putBytes(p.uploadUrl, bytes);
  const a = await dev.request('POST', `/v1/blobs/${p.blobId}/commit`);
  const b = await dev.request('POST', `/v1/blobs/${p.blobId}/commit`);
  assert.equal(b.statusCode, 200);
  assert.deepEqual(b.json(), a.json());
});

test('commit before upload is a 409 and leaves the blob uncommitted', async () => {
  const { bytes, sha256 } = h.randomBlob();
  const p = (await presign(sha256, bytes.length)).json();
  const res = await dev.request('POST', `/v1/blobs/${p.blobId}/commit`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'not_uploaded');
  assert.equal((await presign(sha256, bytes.length)).json().exists, false);
});

test('storage refuses bytes that do not match the presigned hash or length', async () => {
  const { bytes, sha256 } = h.randomBlob();
  const p = (await presign(sha256, bytes.length)).json();

  const tampered = Buffer.from(bytes);
  tampered[0] = tampered[0]! ^ 0xff;
  assert.equal((await putBytes(p.uploadUrl, tampered)).status, 400, 'same length, wrong content');
  assert.equal((await putBytes(p.uploadUrl, Buffer.concat([bytes, bytes]))).status, 403, 'wrong length');

  assert.equal((await dev.request('POST', `/v1/blobs/${p.blobId}/commit`)).json().error, 'not_uploaded');
});

test('an abandoned upload can be re-presigned with a corrected size', async () => {
  const { bytes, sha256 } = h.randomBlob(2000);
  const wrong = (await presign(sha256, 1999)).json();
  const right = (await presign(sha256, 2000)).json();
  assert.equal(right.blobId, wrong.blobId);
  assert.equal((await putBytes(right.uploadUrl, bytes)).status, 200);
  assert.equal((await dev.request('POST', `/v1/blobs/${right.blobId}/commit`)).json().byteSize, 2000);
});

test('concurrent presigns of the same bytes converge on one blob', async () => {
  const { bytes, sha256 } = h.randomBlob();
  const results = await Promise.all(Array.from({ length: 8 }, () => presign(sha256, bytes.length)));
  assert.equal(new Set(results.map((r) => r.json().blobId)).size, 1);
});

test('input validation and auth', async () => {
  assert.equal((await presign('ABC', 10)).statusCode, 400);
  assert.equal((await presign('a'.repeat(64), 0)).statusCode, 400);
  assert.equal((await dev.request('POST', '/v1/blobs/not-a-uuid/commit')).statusCode, 400);
  assert.equal(
    (await dev.request('POST', '/v1/blobs/00000000-0000-7000-8000-000000000000/commit')).statusCode,
    404,
  );
  const anon = await h.app.inject({ method: 'POST', url: '/v1/blobs/presign', payload: {} });
  assert.equal(anon.statusCode, 401);
});
