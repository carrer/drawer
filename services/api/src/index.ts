import { HeadBucketCommand } from '@aws-sdk/client-s3';
import Fastify from 'fastify';
import pg from 'pg';
import { loadConfig } from './config.ts';
import { createS3 } from './storage.ts';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
const s3 = createS3(config);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 2 * 1024 * 1024, // metadata only; bytes go straight to S3
});

/**
 * Phase 0 gate: proves the API can reach both stateful dependencies and that the
 * schema actually applied. Checks are real round-trips, not a hardcoded 200.
 */
app.get('/health', async (_req, reply) => {
  const checks: Record<string, string> = {};
  let ok = true;

  try {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('items','categories','blobs','devices')`,
    );
    const found = Number(rows[0]?.n ?? 0);
    checks.postgres = found === 4 ? 'ok' : `schema incomplete (${found}/4 tables)`;
    if (found !== 4) ok = false;
  } catch (err) {
    checks.postgres = `error: ${(err as Error).message}`;
    ok = false;
  }

  try {
    await s3.internal.send(new HeadBucketCommand({ Bucket: s3.bucket }));
    checks.s3 = 'ok';
  } catch (err) {
    checks.s3 = `error: ${(err as Error).message}`;
    ok = false;
  }

  return reply.code(ok ? 200 : 503).send({ ok, checks });
});

// Phase 1 mounts /v1/* here: enroll, sync, blobs/presign, items, categories.

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
