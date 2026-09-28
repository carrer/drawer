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
const app = buildApp({ pool, s3: {} as Storage, logger: false });

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
