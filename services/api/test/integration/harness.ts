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
import pg from 'pg';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { OWNER_ID } from '../../src/db.ts';
import { migrate } from '../../src/migrate.ts';
import { createS3, storageKey } from '../../src/storage.ts';
import { generateEnrollCode, hashSecret, normalizeEnrollCode } from '../../src/tokens.ts';

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
  const app = buildApp({ pool, s3, logger: false });
  const keys = new Set<string>();

  /** Enroll a device the way a phone does, returning a request helper bound to its token. */
  async function device(name = 'test device') {
    const code = generateEnrollCode();
    await pool.query(
      `INSERT INTO enroll_codes (code_hash, owner_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`,
      [hashSecret(normalizeEnrollCode(code)), OWNER_ID],
    );
    const res = await app.inject({ method: 'POST', url: '/v1/auth/enroll', payload: { code, deviceName: name } });
    if (res.statusCode !== 201) throw new Error(`enroll failed: ${res.statusCode} ${res.body}`);
    const { token, deviceId } = res.json() as { token: string; deviceId: string };
    const request = (method: Method, path: string, payload?: object) =>
      app.inject({ method, url: path, payload, headers: { authorization: `Bearer ${token}` } });
    return { token, deviceId, request };
  }

  /** Random bytes plus their sha256; the resulting storage key is cleaned up on teardown. */
  function randomBlob(size = 1024) {
    const bytes = randomBytes(size);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    keys.add(storageKey(sha256));
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
    await app.close();
    await pool.end();
    await Promise.all(
      [...keys].map((Key) => s3.internal.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key })).catch(() => {})),
    );
    await adminQuery(config.DATABASE_URL, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  }

  return { app, pool, s3, device, randomBlob, committedBlob, teardown };
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
