import type { Blob, Category, Item, ItemKind } from '@drawer/shared';

/** Columns every blob query selects, aliased to what `toBlob` reads. `p` is the table alias. */
export const blobColumns = (p: string) => `
  ${p}.id, encode(${p}.sha256, 'hex') AS sha256, ${p}.byte_size, ${p}.mime_type, ${p}.storage_key,
  ${p}.thumb_key, ${p}.width, ${p}.height, ${p}.duration_ms, ${p}.page_count, ${p}.uploaded_at`;

/** The same fields as one JSON object (or NULL), for embedding a blob in an item row. */
const blobJson = (p: string) => `
  CASE WHEN ${p}.id IS NULL THEN NULL ELSE json_build_object(
    'id', ${p}.id, 'sha256', encode(${p}.sha256, 'hex'), 'byte_size', ${p}.byte_size,
    'mime_type', ${p}.mime_type, 'storage_key', ${p}.storage_key, 'thumb_key', ${p}.thumb_key,
    'width', ${p}.width, 'height', ${p}.height, 'duration_ms', ${p}.duration_ms,
    'page_count', ${p}.page_count, 'uploaded_at', ${p}.uploaded_at) END`;

export interface BlobRow {
  id: string;
  sha256: string;
  byte_size: string | number; // bigint: a string from a column, a number from json_build_object
  mime_type: string;
  storage_key: string;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  page_count: number | null;
  uploaded_at: Date | string | null;
}

export function toBlob(r: BlobRow): Blob {
  return {
    id: r.id,
    sha256: r.sha256,
    byteSize: Number(r.byte_size),
    mimeType: r.mime_type,
    thumbKey: r.thumb_key,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    pageCount: r.page_count,
  };
}

/**
 * Select full items: `SELECT ${ITEM_SELECT} WHERE ...`. The alias is `i`.
 * Blobs arrive embedded and the category set as a sorted array, so an item is
 * always one self-contained row — exactly what sync ships.
 */
export const ITEM_SELECT = `
  i.id, i.kind, i.title, i.note, i.url, i.link_title, i.link_description, i.link_site_name,
  i.body, i.extracted_text, i.source_app, i.tags, i.captured_at, i.created_at, i.updated_at,
  i.deleted_at, i.rev,
  ${blobJson('b')} AS blob,
  ${blobJson('lb')} AS link_image,
  coalesce((SELECT array_agg(ic.category_id ORDER BY ic.category_id)
              FROM item_categories ic WHERE ic.item_id = i.id), '{}') AS category_ids
  FROM items i
  LEFT JOIN blobs b  ON b.id  = i.blob_id
  LEFT JOIN blobs lb ON lb.id = i.link_image_blob_id`;

export interface ItemRow {
  id: string;
  kind: ItemKind;
  title: string | null;
  note: string | null;
  url: string | null;
  link_title: string | null;
  link_description: string | null;
  link_site_name: string | null;
  body: string | null;
  extracted_text: string | null;
  source_app: string | null;
  tags: string[];
  captured_at: Date;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  rev: string;
  blob: BlobRow | null;
  link_image: BlobRow | null;
  category_ids: string[];
}

export function toItem(r: ItemRow): Item {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    note: r.note,
    blob: r.blob && toBlob(r.blob),
    url: r.url,
    linkTitle: r.link_title,
    linkDescription: r.link_description,
    linkSiteName: r.link_site_name,
    linkImage: r.link_image && toBlob(r.link_image),
    body: r.body,
    extractedText: r.extracted_text,
    sourceApp: r.source_app,
    categoryIds: r.category_ids,
    tags: r.tags,
    capturedAt: r.captured_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at?.toISOString() ?? null,
    rev: Number(r.rev),
  };
}

export const CATEGORY_COLUMNS = `id, name, color, icon, sort_order, created_at, updated_at, deleted_at, rev`;

export interface CategoryRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  rev: string;
}

export function toCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    sortOrder: r.sort_order,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    deletedAt: r.deleted_at?.toISOString() ?? null,
    rev: Number(r.rev),
  };
}
