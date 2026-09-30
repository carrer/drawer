import { INBOX_CATEGORY_ID } from '@drawer/shared';
import type pg from 'pg';
import { withWriteTx, FIRST_OWNER_ID } from './db.ts';
import { HttpError } from './errors.ts';

/**
 * Every account starts with the same four categories, under the same ids the
 * app seeds locally (apps/mobile/src/db/migrations.ts) — category ids are unique
 * per owner, so the first sync reconciles them instead of duplicating.
 */
const DEFAULT_CATEGORIES = [
  { id: INBOX_CATEGORY_ID, name: 'Inbox', icon: '📥', sort_order: 0 },
  { id: '00000000-0000-0000-0000-0000000000a2', name: 'Memes', icon: '😂', sort_order: 1 },
  { id: '00000000-0000-0000-0000-0000000000a3', name: 'Read later', icon: '📖', sort_order: 2 },
  { id: '00000000-0000-0000-0000-0000000000a4', name: 'Reference', icon: '📎', sort_order: 3 },
];

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export type UserRow = { id: string; email: string | null; google_sub: string | null; disabled_at: Date | null };

/**
 * Invite an email: creates the account (with default categories) so that the
 * first Google sign-in with that verified address can claim it. Nobody gets an
 * account without an invite.
 *
 * `claimFirst` instead puts the email on the account that existed before
 * multi-user (FIRST_OWNER_ID), so its data belongs to whoever signs in with it.
 */
export async function inviteUser(pool: pg.Pool, email: string, { claimFirst = false } = {}): Promise<UserRow> {
  const e = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new HttpError(400, 'bad_request', `not an email address: ${email}`);

  return withWriteTx(pool, async (tx) => {
    const taken = await tx.query('SELECT 1 FROM users WHERE email = $1', [e]);
    if (taken.rowCount) throw new HttpError(409, 'exists', `${e} already has an account`);

    if (claimFirst) {
      const { rows } = await tx.query<UserRow>(
        `UPDATE users SET email = $2 WHERE id = $1 AND email IS NULL
         RETURNING id, email, google_sub, disabled_at`,
        [FIRST_OWNER_ID, e],
      );
      if (!rows[0]) throw new HttpError(409, 'claimed', 'the first account already has an email');
      return rows[0];
    }

    const { rows } = await tx.query<UserRow>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id, email, google_sub, disabled_at',
      [e],
    );
    const user = rows[0]!;
    await tx.query(
      `INSERT INTO categories (id, owner_id, name, icon, sort_order)
       SELECT d.id, $1, d.name, d.icon, d.sort_order
         FROM jsonb_to_recordset($2::jsonb) AS d(id uuid, name text, icon text, sort_order int)`,
      [user.id, JSON.stringify(DEFAULT_CATEGORIES)],
    );
    return user;
  });
}

export type GoogleIdentity = { sub: string; email: string; emailVerified: boolean; name: string | null };

/**
 * The account a verified Google identity signs in to. `sub` is the identity —
 * emails can change and be reassigned — so an email match is only used once, to
 * bind an invited account that no Google account has claimed yet.
 */
export async function resolveGoogleUser(tx: pg.PoolClient, id: GoogleIdentity): Promise<string> {
  const known = await tx.query<UserRow>(
    'SELECT id, email, google_sub, disabled_at FROM users WHERE google_sub = $1',
    [id.sub],
  );
  let user = known.rows[0];

  if (!user) {
    // An unverified address proves nothing about who owns it.
    if (!id.emailVerified) throw new HttpError(403, 'not_invited', 'this Google account’s email is not verified');
    const bound = await tx.query<UserRow>(
      `UPDATE users SET google_sub = $2, display_name = coalesce(display_name, $3)
        WHERE email = $1 AND google_sub IS NULL
       RETURNING id, email, google_sub, disabled_at`,
      [normalizeEmail(id.email), id.sub, id.name],
    );
    user = bound.rows[0];
  }

  if (!user) {
    throw new HttpError(403, 'not_invited', `${normalizeEmail(id.email)} hasn’t been invited to this drawer`);
  }
  if (user.disabled_at) throw new HttpError(403, 'disabled', 'this account has been disabled');
  return user.id;
}
