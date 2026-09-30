import { HeadBucketCommand } from '@aws-sdk/client-s3';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { requireDevice } from './auth.ts';
import { errorHandler } from './errors.ts';
import type { GoogleVerifier } from './google.ts';
import { enrollRoutes, whoamiRoutes } from './routes/auth.ts';
import { blobRoutes } from './routes/blobs.ts';
import { categoryRoutes } from './routes/categories.ts';
import { itemRoutes } from './routes/items.ts';
import { shareMintRoutes, shareRedeemRoutes } from './routes/share.ts';
import { syncRoutes } from './routes/sync.ts';
import type { Storage } from './storage.ts';

export interface AppDeps {
  pool: pg.Pool;
  s3: Storage;
  /** SHARE_BASE_URL: the origin QR share links point at. */
  shareBaseUrl: string;
  /** Verifies Google ID tokens; null when GOOGLE_CLIENT_ID isn't configured. */
  google?: GoogleVerifier | null;
  logger?: FastifyServerOptions['logger'];
}

/** Build the app without listening, so tests can drive it through `app.inject()`. */
export function buildApp({ pool, s3, shareBaseUrl, google = null, logger = true }: AppDeps) {
  const app = Fastify({
    logger,
    bodyLimit: 2 * 1024 * 1024, // metadata only; bytes go straight to S3
  });

  app.decorateRequest('auth', null as never);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: 'not_found', message: `no route for ${req.method} ${req.url}` }),
  );

  /**
   * Proves the API can reach both stateful dependencies and that the schema
   * actually applied. Checks are real round-trips, not a hardcoded 200.
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

  // The one route that works without a device token: redeeming a QR share code.
  shareRedeemRoutes(app, pool, s3);

  app.register(
    async (v1) => {
      enrollRoutes(v1, pool, google);

      // Everything else under /v1 needs a device token. Encapsulated, so the
      // hook can't leak onto the public routes above.
      v1.register(async (authed) => {
        authed.addHook('onRequest', requireDevice(pool));
        whoamiRoutes(authed);
        blobRoutes(authed, pool, s3);
        itemRoutes(authed, pool, s3);
        shareMintRoutes(authed, pool, shareBaseUrl);
        categoryRoutes(authed, pool);
        syncRoutes(authed, pool);
      });
    },
    { prefix: '/v1' },
  );

  return app;
}
