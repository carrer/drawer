/**
 * Operator commands, run on the server box:
 *
 *   migrate                  apply pending migrations
 *   enroll-code [--ttl 15]   mint a one-shot code (minutes) to type into the app
 *   devices                  list enrolled devices
 *   revoke <device-id>       revoke a device's token immediately
 *
 * Output goes to stdout because it is the point of the command; diagnostics go to stderr.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { OWNER_ID } from './db.ts';
import { migrate } from './migrate.ts';
import { generateEnrollCode, hashSecret, normalizeEnrollCode } from './tokens.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { ttl: { type: 'string', default: '15' } },
});
const [command, ...rest] = positionals;

// Bad input is a usage mistake, not a crash: print the reason, not a stack.
process.on('uncaughtException', (err) => {
  const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : err.message;
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});

const databaseUrl = z.string().min(1, 'DATABASE_URL is required').parse(process.env.DATABASE_URL);
const out = (line = '') => process.stdout.write(`${line}\n`);

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

switch (command) {
  case 'migrate': {
    const applied = await migrate(databaseUrl);
    out(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    break;
  }

  case 'enroll-code': {
    const ttl = z.coerce.number().int().min(1).max(24 * 60).parse(values.ttl);
    const code = generateEnrollCode();
    await withPool((pool) =>
      pool.query(
        `INSERT INTO enroll_codes (code_hash, owner_id, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [hashSecret(normalizeEnrollCode(code)), OWNER_ID, ttl],
      ),
    );
    out(code);
    process.stderr.write(`single use, expires in ${ttl} min — enter it in the app\n`);
    break;
  }

  case 'devices': {
    const { rows } = await withPool((pool) =>
      pool.query<Record<string, string | null>>(
        `SELECT id, name,
                to_char(created_at,   'YYYY-MM-DD HH24:MI') AS enrolled,
                to_char(last_seen_at, 'YYYY-MM-DD HH24:MI') AS last_seen,
                CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status
           FROM devices WHERE owner_id = $1 ORDER BY created_at`,
        [OWNER_ID],
      ),
    );
    if (!rows.length) out('no devices enrolled — run: make enroll-code');
    for (const r of rows) out([r.id, r.status, r.enrolled, r.last_seen ?? 'never', r.name].join('\t'));
    break;
  }

  case 'revoke': {
    const usage = 'usage: revoke <device-id> (see: make devices)';
    const id = z.string({ required_error: usage }).uuid(usage).parse(rest[0]);
    const { rowCount } = await withPool((pool) =>
      pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]),
    );
    out(rowCount ? `revoked ${id}` : `no active device ${id}`);
    if (!rowCount) process.exitCode = 1;
    break;
  }

  default:
    process.stderr.write('usage: cli.ts migrate | enroll-code [--ttl <min>] | devices | revoke <device-id>\n');
    process.exitCode = 2;
}
