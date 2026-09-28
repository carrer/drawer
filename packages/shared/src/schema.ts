import { z } from 'zod';
import { ITEM_KINDS } from './kinds.ts';

export const Uuid = z.string().uuid();
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');
export const Iso = z.string().datetime({ offset: true });

export const ItemKindSchema = z.enum(ITEM_KINDS);

export const BlobSchema = z.object({
  id: Uuid,
  sha256: Sha256Hex,
  byteSize: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
  thumbKey: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  pageCount: z.number().int().positive().nullable(),
});
export type Blob = z.infer<typeof BlobSchema>;

export const CategorySchema = z.object({
  id: Uuid,
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  icon: z.string().max(8).nullable(),
  sortOrder: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
  deletedAt: Iso.nullable(),
  rev: z.number().int().nonnegative(),
});
export type Category = z.infer<typeof CategorySchema>;

export const ItemSchema = z.object({
  id: Uuid,
  kind: ItemKindSchema,
  title: z.string().max(512).nullable(),
  note: z.string().max(8192).nullable(),
  blob: BlobSchema.nullable(),

  url: z.string().url().nullable(),
  linkTitle: z.string().nullable(),
  linkDescription: z.string().nullable(),
  linkSiteName: z.string().nullable(),
  linkImage: BlobSchema.nullable(),

  body: z.string().nullable(),
  extractedText: z.string().nullable(),

  sourceApp: z.string().nullable(),
  categoryIds: z.array(Uuid),
  tags: z.array(z.string()),

  capturedAt: Iso,
  createdAt: Iso,
  updatedAt: Iso,
  deletedAt: Iso.nullable(),
  rev: z.number().int().nonnegative(),
});
export type Item = z.infer<typeof ItemSchema>;

/**
 * What the client sends when creating or updating an item. The id is generated
 * on the device (uuidv7) so capture works offline and retries are idempotent:
 * POSTing the same id twice is an upsert, never a duplicate.
 */
export const ItemUpsertSchema = z.object({
  id: Uuid,
  kind: ItemKindSchema,
  title: z.string().max(512).nullish(),
  note: z.string().max(8192).nullish(),
  blobSha256: Sha256Hex.nullish(),
  url: z.string().url().nullish(),
  body: z.string().max(1_000_000).nullish(),
  sourceApp: z.string().max(256).nullish(),
  categoryIds: z.array(Uuid).max(64).default([]),
  tags: z.array(z.string().max(64)).max(64).default([]),
  capturedAt: Iso,
});
export type ItemUpsert = z.infer<typeof ItemUpsertSchema>;

export const CategoryUpsertSchema = z.object({
  id: Uuid,
  name: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  icon: z.string().max(8).nullish(),
  sortOrder: z.number().int().default(0),
});
export type CategoryUpsert = z.infer<typeof CategoryUpsertSchema>;
