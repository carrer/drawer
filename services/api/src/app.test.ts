import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { buildApp } from './app.ts';
import type { Storage } from './storage.ts';

// No database: these paths must all reject before a query is ever issued. Loading
// the real module graph also catches syntax Node's type stripping can't run.
const pool = {
  query: () => assert.fail('unexpected query'),
  connect: () => assert.fail('unexpected connect'),
} as unknown as pg.Pool;
const app = buildApp({ pool, s3: {} as Storage, shareBaseUrl: 'http://drawer.test', logger: false });

test('authed routes reject a missing or malformed token without touching the db', async () => {
  for (const authorization of [undefined, 'Basic Zm9vOmJhcg==', 'Bearer ']) {
    const res = await app.inject({
      url: '/v1/auth/whoami',
      headers: authorization ? { authorization } : {},
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'unauthorized', message: 'missing or invalid device token' });
  }
});

test('enroll validates its body before touching the db', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/enroll', payload: { code: 'x' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_request');
  assert.match(res.json().message, /deviceName/);
});

test('malformed JSON is a 400, not a 500', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/enroll',
    headers: { 'content-type': 'application/json' },
    payload: '{nope',
  });
  assert.equal(res.statusCode, 400);
});

test('unknown routes 404 in the error shape', async () => {
  const res = await app.inject({ url: '/v1/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('share redemption rejects malformed tokens without touching the db, and never answers HEAD', async () => {
  for (const token of ['nope', 'x'.repeat(23), '%00'.repeat(8)]) {
    const res = await app.inject({ url: `/s/${token}` });
    assert.equal(res.statusCode, 410);
    assert.match(res.headers['content-type'] as string, /^text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  const head = await app.inject({ method: 'HEAD', url: `/s/${'a'.repeat(22)}` });
  assert.equal(head.statusCode, 404);
});

test('minting a share link needs a device token', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/items/01926f3e-7a2b-7c00-8000-000000000000/share' });
  assert.equal(res.statusCode, 401);
});

test('Google sign-in answers 503, without touching the db, when GOOGLE_CLIENT_ID is unset', async () => {
  const bad = await app.inject({ method: 'POST', url: '/v1/auth/google', payload: {} });
  assert.equal(bad.statusCode, 503);
  assert.equal(bad.json().error, 'not_configured');
});
