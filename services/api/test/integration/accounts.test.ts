import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { INBOX_CATEGORY_ID } from '@drawer/shared';
import { after, before, test } from 'node:test';
import { inviteUser } from '../../src/users.ts';
import { setup } from './harness.ts';

let h: Awaited<ReturnType<typeof setup>>;
before(async () => {
  h = await setup();
});
after(() => h.teardown());

const sub = () => `google-${randomBytes(6).toString('hex')}`;
const nonce = async () => (await h.app.inject({ method: 'POST', url: '/v1/auth/nonce' })).json().nonce as string;
const signIn = (idToken: string, deviceName = 'Pixel') =>
  h.app.inject({ method: 'POST', url: '/v1/auth/google', payload: { idToken, deviceName } });
const whoami = (token: string) =>
  h.app.inject({ url: '/v1/auth/whoami', headers: { authorization: `Bearer ${token}` } });

test('an invited email signs in with Google, gets a working device, and its default categories', async () => {
  const u = await h.user('Ada@Example.com'); // stored lowercased
  const res = await signIn(await h.googleToken({ sub: sub(), email: 'ada@example.com', name: 'Ada', nonce: await nonce() }));
  assert.equal(res.statusCode, 201, res.body);
  const { token, ownerId, deviceId } = res.json();
  assert.equal(ownerId, u.ownerId);

  assert.deepEqual((await whoami(token)).json(), { deviceId, ownerId, deviceName: 'Pixel', email: 'ada@example.com' });
  const cats = await h.app.inject({ url: '/v1/categories', headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(
    cats.json().categories.map((c: { id: string; name: string }) => c.name),
    ['Inbox', 'Memes', 'Read later', 'Reference'],
  );
  assert.equal(cats.json().categories[0].id, INBOX_CATEGORY_ID);
});

test('the Google account, not the email, is the identity once bound', async () => {
  const u = await h.user();
  const id = sub();
  assert.equal((await signIn(await h.googleToken({ sub: id, email: u.email, nonce: await nonce() }))).statusCode, 201);

  // Their Google address changed: same account, found by sub.
  const again = await signIn(await h.googleToken({ sub: id, email: 'renamed@example.com', nonce: await nonce() }));
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().ownerId, u.ownerId);

  // A different Google account presenting the original address can't take it over.
  const other = await signIn(await h.googleToken({ sub: sub(), email: u.email, nonce: await nonce() }));
  assert.equal(other.statusCode, 403);
  assert.equal(other.json().error, 'not_invited');
});

test('no invite, no account; an unverified email can’t claim an invite', async () => {
  const stranger = await signIn(await h.googleToken({ sub: sub(), email: 'stranger@example.com', nonce: await nonce() }));
  assert.equal(stranger.statusCode, 403);
  assert.equal(stranger.json().error, 'not_invited');

  const u = await h.user();
  const unverified = await signIn(
    await h.googleToken({ sub: sub(), email: u.email, email_verified: false, nonce: await nonce() }),
  );
  assert.equal(unverified.statusCode, 403);
  // …and the invite is still there for the real owner.
  assert.equal((await signIn(await h.googleToken({ sub: sub(), email: u.email, nonce: await nonce() }))).statusCode, 201);
});

test('nonces are required, single-use and expire', async () => {
  const u = await h.user();
  const id = sub();
  assert.equal((await signIn(await h.googleToken({ sub: id, email: u.email }))).statusCode, 401, 'no nonce');
  assert.equal(
    (await signIn(await h.googleToken({ sub: id, email: u.email, nonce: 'made-up-nonce-000000' }))).statusCode,
    401,
    'nonce the server never issued',
  );

  const token = await h.googleToken({ sub: id, email: u.email, nonce: await nonce() });
  assert.equal((await signIn(token)).statusCode, 201);
  assert.equal((await signIn(token)).statusCode, 401, 'replayed ID token');

  const stale = await nonce();
  await h.pool.query(`UPDATE auth_nonces SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
  assert.equal((await signIn(await h.googleToken({ sub: id, email: u.email, nonce: stale }))).statusCode, 401);
});

test('a failed sign-in leaves the nonce unused', async () => {
  const n = await nonce();
  const email = `late-${randomBytes(3).toString('hex')}@example.com`;
  assert.equal((await signIn(await h.googleToken({ sub: sub(), email, nonce: n }))).statusCode, 403);
  await inviteUser(h.pool, email);
  assert.equal((await signIn(await h.googleToken({ sub: sub(), email, nonce: n }))).statusCode, 201);
});

test('tokens with a bad signature, audience, issuer or expiry are rejected', async () => {
  const u = await h.user();
  const good = { sub: sub(), email: u.email };

  const tampered = (await h.googleToken({ ...good, nonce: await nonce() })).replace(/\.[^.]+$/, '.AAAA');
  const expired = await h.googleToken({ ...good, nonce: await nonce() }, '-2 minutes');
  const wrongAud = await h.googleToken({ ...good, aud: 'someone-else.apps.googleusercontent.com', nonce: await nonce() });
  const wrongIss = await h.googleToken({ ...good, iss: 'https://evil.example', nonce: await nonce() });
  for (const [label, t] of Object.entries({ tampered, expired, wrongAud, wrongIss, garbage: 'not.a.jwt' })) {
    const res = await signIn(t);
    assert.equal(res.statusCode, 401, label);
    assert.equal(res.json().error, 'invalid_token', label);
  }
});

test('disabling an account locks out its devices, its sign-in and its codes; enabling restores them', async () => {
  const u = await h.user();
  const dev = await u.device();
  const id = sub();
  assert.equal((await signIn(await h.googleToken({ sub: id, email: u.email, nonce: await nonce() }))).statusCode, 201);

  await h.pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [u.ownerId]);
  assert.equal((await whoami(dev.token)).statusCode, 401);
  const blocked = await signIn(await h.googleToken({ sub: id, email: u.email, nonce: await nonce() }));
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'disabled');
  await assert.rejects(u.device(), /enroll failed: 401/);

  await h.pool.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [u.ownerId]);
  assert.equal((await whoami(dev.token)).statusCode, 200);
});

test('inviting: emails are normalized and unique, and the first account can be claimed once', async () => {
  await assert.rejects(inviteUser(h.pool, 'not-an-email'), /not an email/);
  await inviteUser(h.pool, 'dup@example.com');
  await assert.rejects(inviteUser(h.pool, ' DUP@example.com '), /already has an account/);

  const first = await inviteUser(h.pool, 'owner@example.com', { claimFirst: true });
  assert.equal(first.id, '00000000-0000-0000-0000-000000000001');
  await assert.rejects(inviteUser(h.pool, 'second@example.com', { claimFirst: true }), /already has an email/);
});

test('the app learns the Web client ID from the box, before signing in', async () => {
  const res = await h.app.inject({ url: '/v1/auth/config' });
  assert.deepEqual(res.json(), { googleWebClientId: 'drawer-test.apps.googleusercontent.com' });
});

test('signing out revokes only this device', async () => {
  const u = await h.user();
  const [one, two] = [await u.device('one'), await u.device('two')];
  assert.equal((await one.request('POST', '/v1/auth/signout')).statusCode, 204);
  assert.equal((await one.request('GET', '/v1/auth/whoami')).statusCode, 401);
  assert.equal((await two.request('GET', '/v1/auth/whoami')).statusCode, 200);
});
