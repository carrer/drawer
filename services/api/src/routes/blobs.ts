import { PresignRequestSchema, Uuid, type CommitResponse, type PresignResponse } from '@drawer/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { HttpError } from '../errors.ts';
import { blobColumns, toBlob, type BlobRow } from '../rows.ts';
import { presignPut, statObject, storageKey, type Storage } from '../storage.ts';

/**
 * The URL only has to be valid when the PUT *starts*, but a phone on a flaky
 * connection may retry a while later — an hour covers that without a re-presign.
 */
const UPLOAD_URL_TTL_S = 60 * 60;

const IdParams = z.object({ id: Uuid });

/**
 * Blobs are content-addressed per owner: one row per (owner, sha256). Dedupe
 * never crosses accounts — `exists: true` for someone else's file would confirm
 * they hold it, and would let you reference bytes you never had
 * (005_multi_user.sql).
 */
export function blobRoutes(app: FastifyInstance, pool: pg.Pool, s3: Storage) {
  app.post('/blobs/presign', async (req): Promise<PresignResponse> => {
    const body = PresignRequestSchema.parse(req.body);
    const ownerId = req.auth.ownerId;
    const key = storageKey(ownerId, body.sha256);

    // One statement, so two devices presigning the same bytes converge on one
    // row. An uncommitted row takes the latest declared size/type — an earlier
    // attempt may have been wrong, and nothing has been verified yet.
    const { rows } = await pool.query<{ id: string; uploaded: boolean }>(
      `INSERT INTO blobs (owner_id, sha256, byte_size, mime_type, storage_key)
       VALUES ($5, decode($1, 'hex'), $2, $3, $4)
       ON CONFLICT (owner_id, sha256) DO UPDATE SET
         byte_size = CASE WHEN blobs.uploaded_at IS NULL THEN EXCLUDED.byte_size ELSE blobs.byte_size END,
         mime_type = CASE WHEN blobs.uploaded_at IS NULL THEN EXCLUDED.mime_type ELSE blobs.mime_type END
       RETURNING id, uploaded_at IS NOT NULL AS uploaded`,
      [body.sha256, body.byteSize, body.mimeType, key, ownerId],
    );
    const blob = rows[0]!;
    if (blob.uploaded) return { exists: true, blobId: blob.id };

    const uploadUrl = await presignPut(s3, key, body.sha256, body.byteSize, UPLOAD_URL_TTL_S);
    return {
      exists: false,
      blobId: blob.id,
      uploadUrl,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_S * 1000).toISOString(),
    };
  });

  app.post('/blobs/:id/commit', async (req): Promise<CommitResponse> => {
    const { id } = IdParams.parse(req.params);
    const { rows } = await pool.query<BlobRow>(
      `SELECT ${blobColumns('b')} FROM blobs b WHERE b.id = $1 AND b.owner_id = $2`,
      [id, req.auth.ownerId],
    );
    const blob = rows[0];
    if (!blob) throw new HttpError(404, 'not_found', 'no such blob');
    if (blob.uploaded_at) return toBlob(blob);

    // Garage already refused any PUT whose bytes didn't match the signed length
    // and checksum; this proves the PUT happened at all.
    const stat = await statObject(s3, blob.storage_key);
    if (!stat) throw new HttpError(409, 'not_uploaded', 'blob has not been uploaded yet');
    if (stat.byteSize !== Number(blob.byte_size) || (stat.sha256Hex && stat.sha256Hex !== blob.sha256)) {
      // Only reachable if the object was written some other way. Refuse it; the
      // client's next presign + PUT overwrites it with the right bytes.
      throw new HttpError(409, 'upload_mismatch', 'stored object does not match the declared size or hash');
    }

    const updated = await pool.query<BlobRow>(
      `UPDATE blobs b SET uploaded_at = coalesce(uploaded_at, now()) WHERE b.id = $1 RETURNING ${blobColumns('b')}`,
      [id],
    );
    // Phase 4: enqueue thumbnail / metadata jobs for this blob here.
    return toBlob(updated.rows[0]!);
  });
}
