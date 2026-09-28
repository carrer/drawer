import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../infra/db/migrations', import.meta.url));

/**
 * Apply every pending migration in infra/db/migrations, in one transaction.
 *
 * Phase 0 databases had 001_init.sql applied by the postgres image's initdb
 * hook, so they have the schema but no migrations table. Those are detected
 * and 001 is recorded as already run instead of being replayed onto itself.
 */
export async function migrate(databaseUrl: string): Promise<string[]> {
  const log = (msg: string) => process.stderr.write(`${msg}\n`);
  const common = {
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up' as const,
    checkOrder: true,
    log,
  };

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let baseline = false;
  try {
    const { rows } = await client.query<{ tracked: boolean; schema: boolean }>(
      `SELECT to_regclass('public.pgmigrations') IS NOT NULL AS tracked,
              to_regclass('public.items') IS NOT NULL AS schema`,
    );
    baseline = !rows[0]?.tracked && !!rows[0]?.schema;
  } finally {
    await client.end();
  }

  if (baseline) {
    log('schema predates migration tracking: recording 001_init as applied');
    await runner({ ...common, count: 1, fake: true });
  }

  const applied = await runner({ ...common, singleTransaction: true });
  return applied.map((m) => m.name);
}
