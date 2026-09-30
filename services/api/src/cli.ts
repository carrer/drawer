/**
 * Operator commands, run on the server box:
 *
 *   migrate                              apply pending migrations
 *   invite <email> [--claim]             let <email> sign in with Google; --claim gives the
 *                                        pre-multi-user account (and its data) to <email>
 *   users                                list accounts
 *   disable <email> / enable <email>     lock an account out (all its devices) / let it back in
 *   enroll-code [--user <email>] [--ttl 15]
 *                                        mint a one-shot code (minutes) to type into the app —
 *                                        the fallback for signing in without Google
 *   devices [--user <email>]             list enrolled devices
 *   revoke <device-id>                   revoke a device's token immediately
 *
 * --user can be left out while there is only one account.
 *
 * Output goes to stdout because it is the point of the command; diagnostics go to stderr.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { migrate } from './migrate.ts';
import { generateEnrollCode, hashSecret, normalizeEnrollCode } from './tokens.ts';
import { inviteUser, normalizeEmail } from './users.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    ttl: { type: 'string', default: '15' },
    user: { type: 'string' },
    claim: { type: 'boolean', default: false },
  },
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

/** The account `--user` names, or the only account there is. */
async function ownerFor(pool: pg.Pool, email: string | undefined): Promise<{ id: string; email: string | null }> {
  if (email) {
    const { rows } = await pool.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE email = $1', [
      normalizeEmail(email),
    ]);
    if (!rows[0]) throw new Error(`no account for ${email} — see: make users`);
    return rows[0];
  }
  const { rows } = await pool.query<{ id: string; email: string | null }>('SELECT id, email FROM users LIMIT 2');
  if (rows.length !== 1) throw new Error('there are several accounts — say which: EMAIL=<email>');
  return rows[0]!;
}

const emailArg = (usage: string) => z.string({ required_error: usage }).min(3, usage).parse(rest[0]);

switch (command) {
  case 'migrate': {
    const applied = await migrate(databaseUrl);
    out(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    break;
  }

  case 'enroll-code': {
    const ttl = z.coerce.number().int().min(1).max(24 * 60).parse(values.ttl);
    const code = generateEnrollCode();
    const owner = await withPool(async (pool) => {
      const owner = await ownerFor(pool, values.user);
      await pool.query(
        `INSERT INTO enroll_codes (code_hash, owner_id, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [hashSecret(normalizeEnrollCode(code)), owner.id, ttl],
      );
      return owner;
    });
    out(code);
    process.stderr.write(`single use, expires in ${ttl} min — enter it in the app (account: ${owner.email ?? owner.id})\n`);
    break;
  }

  case 'devices': {
    const { rows } = await withPool((pool) =>
      pool.query<Record<string, string | null>>(
        `SELECT d.id, d.name, coalesce(u.email, u.id::text) AS account,
                to_char(d.created_at,   'YYYY-MM-DD HH24:MI') AS enrolled,
                to_char(d.last_seen_at, 'YYYY-MM-DD HH24:MI') AS last_seen,
                CASE WHEN d.revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status
           FROM devices d JOIN users u ON u.id = d.owner_id
          WHERE $1::text IS NULL OR u.email = $1
          ORDER BY u.email NULLS FIRST, d.created_at`,
        [values.user ? normalizeEmail(values.user) : null],
      ),
    );
    if (!rows.length) out('no devices enrolled — sign in from the app, or: make enroll-code');
    for (const r of rows) out([r.id, r.status, r.enrolled, r.last_seen ?? 'never', r.account, r.name].join('\t'));
    break;
  }

  case 'invite': {
    const email = emailArg('usage: invite <email> [--claim]');
    const user = await withPool((pool) => inviteUser(pool, email, { claimFirst: values.claim }));
    out(`${user.email}\t${user.id}`);
    process.stderr.write(
      values.claim
        ? 'the existing account is now theirs — sign in with Google as that address\n'
        : 'invited — they can now sign in with Google as that address\n',
    );
    break;
  }

  case 'users': {
    const { rows } = await withPool((pool) =>
      pool.query<Record<string, string | null>>(
        `SELECT u.id, coalesce(u.email, '(no email — make invite EMAIL=… CLAIM=1)') AS email,
                CASE WHEN u.disabled_at IS NOT NULL THEN 'disabled'
                     WHEN u.email IS NULL THEN 'unclaimed'
                     WHEN u.google_sub IS NULL THEN 'invited'
                     ELSE 'active' END AS status,
                (SELECT count(*) FROM devices d WHERE d.owner_id = u.id AND d.revoked_at IS NULL)::text AS devices,
                (SELECT count(*) FROM items i WHERE i.owner_id = u.id AND i.deleted_at IS NULL)::text AS items,
                coalesce(u.display_name, '') AS name
           FROM users u ORDER BY u.created_at`,
      ),
    );
    out(['id', 'status', 'devices', 'items', 'email', 'name'].join('\t'));
    for (const r of rows) out([r.id, r.status, r.devices, r.items, r.email, r.name].join('\t'));
    break;
  }

  case 'disable':
  case 'enable': {
    const email = normalizeEmail(emailArg(`usage: ${command} <email>`));
    const { rowCount } = await withPool((pool) =>
      // Disabling fails every device token at once (requireDevice checks the
      // account); tokens aren't revoked, so `enable` brings the devices back.
      pool.query(
        command === 'disable'
          ? 'UPDATE users SET disabled_at = now() WHERE email = $1 AND disabled_at IS NULL'
          : 'UPDATE users SET disabled_at = NULL WHERE email = $1 AND disabled_at IS NOT NULL',
        [email],
      ),
    );
    out(rowCount ? `${command}d ${email}` : `no ${command === 'disable' ? 'enabled' : 'disabled'} account ${email}`);
    if (!rowCount) process.exitCode = 1;
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
    process.stderr.write(
      'usage: cli.ts migrate | invite <email> [--claim] | users | disable <email> | enable <email>\n' +
        '              | enroll-code [--user <email>] [--ttl <min>] | devices [--user <email>] | revoke <device-id>\n',
    );
    process.exitCode = 2;
}
