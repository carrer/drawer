import { EnrollRequestSchema, type EnrollResponseSchema } from '@drawer/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import { withTx } from '../db.ts';
import { HttpError } from '../errors.ts';
import { generateDeviceToken, hashSecret, normalizeEnrollCode } from '../tokens.ts';

/** Public: trade a one-shot enrollment code for a device token. */
export function enrollRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.post('/auth/enroll', async (req, reply) => {
    const body = EnrollRequestSchema.parse(req.body);
    const codeHash = hashSecret(normalizeEnrollCode(body.code));
    const token = generateDeviceToken();

    const res = await withTx(pool, async (tx) => {
      // Claiming the code and checking it are one statement, so two devices
      // racing the same code can't both win.
      const code = await tx.query<{ owner_id: string }>(
        `UPDATE enroll_codes SET used_at = now()
          WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING owner_id`,
        [codeHash],
      );
      const ownerId = code.rows[0]?.owner_id;
      if (!ownerId) {
        throw new HttpError(401, 'invalid_code', 'enrollment code is invalid, expired, or already used');
      }

      const device = await tx.query<{ id: string }>(
        'INSERT INTO devices (owner_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id',
        [ownerId, body.deviceName, hashSecret(token)],
      );
      const deviceId = device.rows[0]!.id;
      await tx.query('UPDATE enroll_codes SET device_id = $1 WHERE code_hash = $2', [deviceId, codeHash]);
      return { deviceId, ownerId, token } satisfies z.infer<typeof EnrollResponseSchema>;
    });

    req.log.info({ deviceId: res.deviceId }, 'device enrolled');
    return reply.code(201).send(res);
  });
}

/** Authenticated: lets the app confirm its stored token still works. */
export function whoamiRoutes(app: FastifyInstance) {
  app.get('/auth/whoami', async (req) => req.auth);
}
