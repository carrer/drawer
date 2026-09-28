import { ItemPatchSchema, ItemUpsertSchema, Uuid, type Item, type ItemUrlResponse } from '@drawer/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError } from '../errors.ts';
import { deleteItem, getItem, patchItem, upsertItem } from '../items.ts';
import { presignGet, type Storage } from '../storage.ts';

/** Long enough to open a big video, short enough that a leaked link soon dies. */
const DOWNLOAD_URL_TTL_S = 5 * 60;

const IdParams = z.object({ id: Uuid });

export function itemRoutes(app: FastifyInstance, pool: pg.Pool, s3: Storage) {
  app.post('/items', async (req, reply): Promise<Item> => {
    const { item, created } = await upsertItem(pool, req.auth.ownerId, ItemUpsertSchema.parse(req.body));
    reply.code(created ? 201 : 200);
    return item;
  });

  /** Returns tombstones too: a device holding a stale copy needs to learn it's deleted. */
  app.get('/items/:id', async (req): Promise<Item> => {
    const { id } = IdParams.parse(req.params);
    const item = await getItem(pool, req.auth.ownerId, id);
    if (!item) throw new HttpError(404, 'not_found', 'no such item');
    return item;
  });

  app.patch('/items/:id', async (req): Promise<Item> => {
    const { id } = IdParams.parse(req.params);
    return patchItem(pool, req.auth.ownerId, id, ItemPatchSchema.parse(req.body));
  });

  app.delete('/items/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await deleteItem(pool, req.auth.ownerId, id);
    return reply.code(204).send();
  });

  app.get('/items/:id/url', async (req): Promise<ItemUrlResponse> => {
    const { id } = IdParams.parse(req.params);
    const { rows } = await pool.query<{ storage_key: string; mime_type: string }>(
      `SELECT b.storage_key, b.mime_type FROM items i JOIN blobs b ON b.id = i.blob_id
        WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL AND b.uploaded_at IS NOT NULL`,
      [id, req.auth.ownerId],
    );
    const blob = rows[0];
    if (!blob) throw new HttpError(404, 'not_found', 'no such item, or it has no stored original');
    return {
      url: await presignGet(s3, blob.storage_key, blob.mime_type, DOWNLOAD_URL_TTL_S),
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_S * 1000).toISOString(),
    };
  });
}
