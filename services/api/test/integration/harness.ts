/**
 * Integration harness: a real app against the running `make up` stack.
 *
 * Each test file gets its own freshly migrated database (created on the dev
 * Postgres, dropped afterwards) and talks to the real Garage bucket through the
 * same presigned URLs a phone would use. Test blobs are random bytes, so their
 * content-addressed keys never collide with real data, and every key a test
 * creates is deleted on teardown.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import pg from 'pg';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { FIRST_OWNER_ID } from '../../src/db.ts';
import { createGoogleVerifier } from '../../src/google.ts';
import { migrate } from '../../src/migrate.ts';
import { createS3 } from '../../src/storage.ts';
import { generateEnrollCode, hashSecret, normalizeEnrollCode } from '../../src/tokens.ts';
import { inviteUser } from '../../src/users.ts';

/** The audience test ID tokens are issued for, standing in for the real Web client ID. */
export const GOOGLE_CLIENT_ID = 'drawer-test.apps.googleusercontent.com';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function setup() {
  const config = loadConfig();
  const dbName = `drawer_it_${process.pid}_${randomBytes(3).toString('hex')}`;
  await adminQuery(config.DATABASE_URL, `CREATE DATABASE ${dbName}`);

  const url = new URL(config.DATABASE_URL);
  url.pathname = `/${dbName}`;
  await migrate(url.toString());

  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  const s3 = createS3(config);

  // Google sign-in without Google: the real verifier, pointed at a key we hold.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] });
  const google = createGoogleVerifier(GOOGLE_CLIENT_ID, jwks);

  const app = buildApp({ pool, s3, shareBaseUrl: config.SHARE_BASE_URL, google, logger: false });

  /** A Google ID token as Google would sign it; override any claim (or the lifetime) to test rejections. */
  async function googleToken(claims: JWTPayload & { email?: string; nonce?: string }, expiresIn = '1h') {
    const payload = { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, email_verified: true, ...claims };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  /** A freshly invited account (with its default categories), and a way to enroll its devices. */
  async function user(email = `user-${randomBytes(4).toString('hex')}@example.com`) {
    const u = await inviteUser(pool, email);
    return { ownerId: u.id, email: u.email!, device: (name?: string) => device(name, u.id) };
  }

  /**
   * Enroll a device the way a phone does, returning a request helper bound to
   * its token. Defaults to the first account, which 001_init.sql seeds.
   */
  async function device(name = 'test device', ownerId = FIRST_OWNER_ID) {
    const code = generateEnrollCode();
    await pool.query(
      `INSERT INTO enroll_codes (code_hash, owner_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`,
      [hashSecret(normalizeEnrollCode(code)), ownerId],
    );
    const res = await app.inject({ method: 'POST', url: '/v1/auth/enroll', payload: { code, deviceName: name } });
    if (res.statusCode !== 201) throw new Error(`enroll failed: ${res.statusCode} ${res.body}`);
    const { token, deviceId } = res.json() as { token: string; deviceId: string };
    const request = (method: Method, path: string, payload?: object) =>
      app.inject({ method, url: path, payload, headers: { authorization: `Bearer ${token}` } });
    return { token, deviceId, request };
  }

  /** Random bytes plus their sha256. Whatever gets stored for them is deleted on teardown. */
  function randomBlob(size = 1024) {
    const bytes = randomBytes(size);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { bytes, sha256 };
  }

  /** A blob taken all the way through presign → PUT → commit, ready for an item to reference. */
  async function committedBlob(dev: Awaited<ReturnType<typeof device>>, mimeType = 'image/png') {
    const { bytes, sha256 } = randomBlob();
    const p = (await dev.request('POST', '/v1/blobs/presign', { sha256, byteSize: bytes.length, mimeType })).json();
    await putBytes(p.uploadUrl, bytes);
    const commit = await dev.request('POST', `/v1/blobs/${p.blobId}/commit`);
    if (commit.statusCode !== 200) throw new Error(`commit failed: ${commit.body}`);
    return { sha256, bytes, blobId: p.blobId as string };
  }

  async function teardown() {
    // Every key this database ever presigned; test blobs are random bytes, so none is shared with real data.
    const { rows } = await pool.query<{ storage_key: string }>('SELECT storage_key FROM blobs');
    await app.close();
    await pool.end();
    await Promise.all(
      rows.map(({ storage_key: Key }) =>
        s3.internal.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key })).catch(() => {}),
      ),
    );
    await adminQuery(config.DATABASE_URL, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  }

  return { app, pool, s3, user, device, googleToken, randomBlob, committedBlob, teardown };
}

async function adminQuery(databaseUrl: string, sql: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** PUT to a presigned URL exactly as the phone will: plain bytes, no extra headers. */
export async function putBytes(url: string, bytes: Buffer) {
  const res = await fetch(url, { method: 'PUT', body: bytes });
  return { status: res.status, body: await res.text() };
}
