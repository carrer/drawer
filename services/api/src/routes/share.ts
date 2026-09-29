import { Uuid, type ShareResponse } from '@drawer/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError } from '../errors.ts';
import { presignGet, type Storage } from '../storage.ts';
import { generateShareToken, hashSecret, isShareToken } from '../tokens.ts';

/**
 * Share-as-QR. The phone mints a token (device-authed), shows
 * `<SHARE_BASE_URL>/s/<token>` as a QR code, and whoever scans it gets the
 * original once. `/s/*` is the only route that works without a device token, so
 * it is written as if it faced the public internet even while it doesn't: it
 * reveals nothing about why a token failed, and it can't be made to do anything
 * but redeem.
 */

/** How long a code is scannable. The phone mints a fresh one when it runs out. */
export const SHARE_TTL_S = 30;

/**
 * How long the redirect target lives once a token is redeemed. The browser
 * follows the redirect at once and expiry is only checked when a GET *starts*,
 * so this just has to cover a retry — not the whole download.
 */
const REDEEMED_URL_TTL_S = 60;

/** Redemptions per minute across everyone — see `fixedWindowLimiter`. */
const REDEEM_LIMIT_PER_MIN = 60;

const IdParams = z.object({ id: Uuid });
const TokenParams = z.object({ token: z.string() });

/** Mounted behind `requireDevice`. */
export function shareMintRoutes(app: FastifyInstance, pool: pg.Pool, shareBaseUrl: string) {
  app.post('/items/:id/share', async (req): Promise<ShareResponse> => {
    const { id } = IdParams.parse(req.params);
    const { ownerId, deviceId } = req.auth;

    const token = generateShareToken();
    // One statement: the token only exists if the item has a stored original
    // right now. Deleting the item later still kills it (checked on redeem).
    const { rows } = await pool.query<{ expires_at: Date }>(
      `INSERT INTO share_tokens (token_hash, owner_id, item_id, device_id, expires_at)
       SELECT $1, i.owner_id, i.id, $4, now() + make_interval(secs => $5)
         FROM items i JOIN blobs b ON b.id = i.blob_id
        WHERE i.id = $2 AND i.owner_id = $3 AND i.deleted_at IS NULL AND b.uploaded_at IS NOT NULL
       RETURNING expires_at`,
      [hashSecret(token), id, ownerId, deviceId, SHARE_TTL_S],
    );
    const minted = rows[0];
    if (!minted) throw new HttpError(404, 'not_found', 'no such item, or it has no stored original');

    // A QR sheet left open mints one every 30 s; prune as we go rather than
    // needing a job for it. Indexed, and almost always a no-op.
    await pool.query(`DELETE FROM share_tokens WHERE expires_at < now() - interval '1 hour'`);

    return {
      url: `${shareBaseUrl}/s/${token}`,
      expiresAt: minted.expires_at.toISOString(),
      ttlSeconds: SHARE_TTL_S,
    };
  });
}

/** Public: mounted at the root, outside `/v1` and its auth hook. */
export function shareRedeemRoutes(app: FastifyInstance, pool: pg.Pool, s3: Storage) {
  const allow = fixedWindowLimiter(REDEEM_LIMIT_PER_MIN, 60_000);

  app.route({
    method: 'GET',
    url: '/s/:token',
    // Fastify would otherwise answer HEAD by running this handler — and a link
    // checker's HEAD would burn the token before the person's GET arrives.
    exposeHeadRoute: false,
    handler: async (req, reply) => {
      reply.headers({
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      });
      if (!allow()) return page(reply, 429, 'Too many requests', 'Wait a minute, then scan a fresh code.');

      const { token } = TokenParams.parse(req.params);
      if (!isShareToken(token)) return gone(reply);

      // Redeem and look up in one statement. Concurrent scans of the same code
      // serialize on the row lock, and the loser re-checks redeemed_at and gets
      // nothing — single use holds without a transaction.
      const { rows } = await pool.query<{
        item_id: string;
        title: string | null;
        storage_key: string;
        mime_type: string;
      }>(
        `UPDATE share_tokens t SET redeemed_at = now()
           FROM items i JOIN blobs b ON b.id = i.blob_id
          WHERE t.token_hash = $1 AND t.redeemed_at IS NULL AND t.expires_at > now()
            AND i.id = t.item_id AND i.owner_id = t.owner_id
            AND i.deleted_at IS NULL AND b.uploaded_at IS NOT NULL
         RETURNING i.id AS item_id, i.title, b.storage_key, b.mime_type`,
        [hashSecret(token)],
      );
      const hit = rows[0];
      if (!hit) return gone(reply);

      const filename = downloadFilename(hit.title, hit.item_id, hit.mime_type);
      const url = await presignGet(s3, hit.storage_key, hit.mime_type, REDEEMED_URL_TTL_S, contentDisposition(filename));
      return reply.redirect(url, 302);
    },
  });
}

/** Unknown, expired, used, or its item deleted: one answer, so a probe learns nothing. */
function gone(reply: FastifyReply) {
  return page(reply, 410, 'This code has expired', 'Share codes work once, for 30 seconds. Ask for a new one.');
}

/** Whoever scanned is in a browser, not an API client — give them a page, not JSON. */
function page(reply: FastifyReply, status: number, title: string, message: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · drowa</title>` +
        `<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;` +
        `background:#F4F5FA;color:#0F1B3D}main{max-width:22rem;padding:24px;text-align:center}` +
        `h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#5B6478}</style></head>` +
        `<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
    );
}

/**
 * A global fixed-window counter, deliberately not per-IP: behind Caddy every
 * request arrives from Caddy's address, and trusting X-Forwarded-For would let a
 * caller pick their own bucket. A single person's drawer never legitimately
 * needs anywhere near this many redemptions a minute.
 */
export function fixedWindowLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  let windowStart = -Infinity;
  let count = 0;
  return (): boolean => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    return ++count <= limit;
  };
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
};

/**
 * What the recipient's browser saves the file as: the item's title if it has
 * one, else `drowa-<id prefix>`, with an extension from the stored MIME type
 * unless the title already ends in it.
 */
export function downloadFilename(title: string | null, itemId: string, mimeType: string): string {
  const ext = EXTENSIONS[mimeType.split(';')[0]!.trim().toLowerCase()];
  const base =
    (title ?? '')
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || `drowa-${itemId.slice(0, 8)}`;
  if (!ext || base.toLowerCase().endsWith(`.${ext}`)) return base;
  return `${base}.${ext}`;
}

/** RFC 6266: an ASCII fallback for old clients plus the exact UTF-8 name. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
