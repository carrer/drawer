import pg from 'pg';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createS3 } from './storage.ts';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
const s3 = createS3(config);
const app = buildApp({ pool, s3, shareBaseUrl: config.SHARE_BASE_URL, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
