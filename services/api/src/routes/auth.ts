import {
  EnrollRequestSchema,
  GoogleSignInRequestSchema,
  type AuthConfigResponse,
  type EnrollResponseSchema,
  type NonceResponse,
  type WhoAmIResponse,
} from '@drawer/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import { withTx } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { GoogleVerifier } from '../google.ts';
import { generateDeviceToken, generateNonce, hashSecret, normalizeEnrollCode } from '../tokens.ts';
import { resolveGoogleUser } from '../users.ts';

type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

/** Long enough to get through Google's account picker; it's single-use anyway. */
const NONCE_TTL_S = 5 * 60;

async function createDevice(tx: pg.PoolClient, ownerId: string, name: string): Promise<EnrollResponse> {
  const token = generateDeviceToken();
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO devices (owner_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id',
    [ownerId, name, hashSecret(token)],
  );
  return { deviceId: rows[0]!.id, ownerId, token };
}

/**
 * Public: the ways a device gets a token. Google sign-in is the normal one;
 * an operator-minted enrollment code (`make enroll-code EMAIL=…`) is the
 * fallback that needs no Google at all.
 */
export function enrollRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  google: GoogleVerifier | null,
  googleClientId: string | null,
) {
  app.get('/auth/config', async (): Promise<AuthConfigResponse> => ({
    googleWebClientId: google ? googleClientId : null,
  }));

  app.post('/auth/enroll', async (req, reply) => {
    const body = EnrollRequestSchema.parse(req.body);
    const codeHash = hashSecret(normalizeEnrollCode(body.code));

    const res = await withTx(pool, async (tx) => {
      // Claiming the code and checking it are one statement, so two devices
      // racing the same code can't both win.
      const code = await tx.query<{ owner_id: string }>(
        `UPDATE enroll_codes c SET used_at = now()
           FROM users u
          WHERE c.code_hash = $1 AND c.used_at IS NULL AND c.expires_at > now()
            AND u.id = c.owner_id AND u.disabled_at IS NULL
          RETURNING c.owner_id`,
        [codeHash],
      );
      const ownerId = code.rows[0]?.owner_id;
      if (!ownerId) {
        throw new HttpError(401, 'invalid_code', 'enrollment code is invalid, expired, or already used');
      }
      const device = await createDevice(tx, ownerId, body.deviceName);
      await tx.query('UPDATE enroll_codes SET device_id = $1 WHERE code_hash = $2', [device.deviceId, codeHash]);
      return device;
    });

    req.log.info({ deviceId: res.deviceId }, 'device enrolled');
    return reply.code(201).send(res);
  });

  app.post('/auth/nonce', async (): Promise<NonceResponse> => {
    const nonce = generateNonce();
    const { rows } = await pool.query<{ expires_at: Date }>(
      `INSERT INTO auth_nonces (nonce_hash, expires_at) VALUES ($1, now() + make_interval(secs => $2))
       RETURNING expires_at`,
      [hashSecret(nonce), NONCE_TTL_S],
    );
    await pool.query(`DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 hour'`);
    return { nonce, expiresAt: rows[0]!.expires_at.toISOString() };
  });

  app.post('/auth/google', async (req, reply) => {
    if (!google) throw new HttpError(503, 'not_configured', 'Google sign-in is not set up on this drawer');
    const body = GoogleSignInRequestSchema.parse(req.body);
    const identity = await google(body.idToken);
    if (!identity.nonce) throw new HttpError(401, 'invalid_token', 'Google sign-in did not carry a nonce');
    const nonce = identity.nonce;

    const res = await withTx(pool, async (tx) => {
      // Consumed in the same transaction as the device is created: a failure
      // below leaves the nonce unused, and two racing exchanges can't both win.
      const used = await tx.query(
        `UPDATE auth_nonces SET used_at = now()
          WHERE nonce_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [hashSecret(nonce)],
      );
      if (!used.rowCount) throw new HttpError(401, 'invalid_token', 'sign-in expired or was already used; try again');
      const ownerId = await resolveGoogleUser(tx, identity);
      return createDevice(tx, ownerId, body.deviceName);
    });

    req.log.info({ deviceId: res.deviceId, ownerId: res.ownerId }, 'device signed in with Google');
    return reply.code(201).send(res);
  });
}

/** Authenticated: lets the app confirm its stored token still works, and whose it is. */
export function whoamiRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/auth/whoami', async (req): Promise<WhoAmIResponse> => req.auth);

  /** Sign out: this device's token stops working now, not whenever someone runs `make revoke`. */
  app.post('/auth/signout', async (req, reply) => {
    await pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [req.auth.deviceId]);
    req.log.info({ deviceId: req.auth.deviceId }, 'device signed out');
    return reply.code(204).send();
  });
}
