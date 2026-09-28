import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from './errors.ts';
import { hashSecret, parseBearer } from './tokens.ts';

export interface AuthContext {
  deviceId: string;
  ownerId: string;
  deviceName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireDevice`; only meaningful on routes registered behind it. */
    auth: AuthContext;
  }
}

/**
 * onRequest hook: resolve `Authorization: Bearer <token>` to a live device.
 * Revoked devices fail exactly like unknown tokens, and every failure gets the
 * same message so the response doesn't reveal whether a token ever existed.
 */
export function requireDevice(pool: pg.Pool) {
  return async (req: FastifyRequest) => {
    const token = parseBearer(req.headers.authorization);
    if (!token) throw new HttpError(401, 'unauthorized', 'missing or invalid device token');

    const { rows } = await pool.query<{ id: string; owner_id: string; name: string; stale: boolean }>(
      `SELECT id, owner_id, name,
              (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes') AS stale
         FROM devices
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashSecret(token)],
    );
    const device = rows[0];
    if (!device) throw new HttpError(401, 'unauthorized', 'missing or invalid device token');

    // Throttled so that authenticating a request doesn't cost a write every time.
    if (device.stale) {
      await pool.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id]);
    }
    req.auth = { deviceId: device.id, ownerId: device.owner_id, deviceName: device.name };
  };
}
