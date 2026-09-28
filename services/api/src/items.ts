import type { Item, ItemPatch, ItemUpsert } from '@drawer/shared';
import type pg from 'pg';
import { withWriteTx, type Db } from './db.ts';
import { HttpError } from './errors.ts';
import { ITEM_SELECT, toItem, type ItemRow } from './rows.ts';

const BLOB_KINDS = new Set(['image', 'video', 'audio', 'document']);

/** Load full items. `where` refers to the `i` alias; `tail` is ORDER BY / LIMIT. */
export async function loadItems(db: Db, where: string, params: unknown[], tail = ''): Promise<Item[]> {
  const { rows } = await db.query<ItemRow>(`SELECT ${ITEM_SELECT} WHERE ${where} ${tail}`, params);
  return rows.map(toItem);
}

export async function getItem(db: Db, ownerId: string, id: string): Promise<Item | null> {
  const [item] = await loadItems(db, 'i.id = $1 AND i.owner_id = $2', [id, ownerId]);
  return item ?? null;
}

/** The kind decides which content field is required; the database only backstops link/text. */
function checkShape(u: ItemUpsert) {
  if (BLOB_KINDS.has(u.kind) !== !!u.blobSha256) {
    throw new HttpError(400, 'bad_request', BLOB_KINDS.has(u.kind)
      ? `a ${u.kind} item needs blobSha256`
      : `a ${u.kind} item has no blob`);
  }
  if (u.kind === 'link') {
    if (!u.url) throw new HttpError(400, 'bad_request', 'a link item needs url');
    // The app opens this URL and the unfurl worker will fetch it: web URLs only.
    if (!/^https?:$/.test(new URL(u.url).protocol)) {
      throw new HttpError(400, 'bad_request', 'url must be http or https');
    }
  }
  if (u.kind === 'text' && u.body == null) throw new HttpError(400, 'bad_request', 'a text item needs body');
}

async function resolveBlob(tx: pg.PoolClient, sha256: string): Promise<string> {
  const { rows } = await tx.query<{ id: string; uploaded: boolean }>(
    `SELECT id, uploaded_at IS NOT NULL AS uploaded FROM blobs WHERE sha256 = decode($1, 'hex')`,
    [sha256],
  );
  const blob = rows[0];
  if (!blob) throw new HttpError(409, 'blob_missing', 'no blob with that sha256 — presign and upload it first');
  if (!blob.uploaded) throw new HttpError(409, 'blob_not_committed', 'blob upload has not been committed');
  return blob.id;
}

/**
 * Replace an item's category set. Unknown and deleted categories are dropped
 * rather than rejected: a device that tagged something offline while another
 * deleted the category must not get a push that fails forever. The item that
 * comes back carries the set that actually applied.
 */
async function setCategories(tx: pg.PoolClient, ownerId: string, itemId: string, ids: string[]): Promise<boolean> {
  const { rows } = await tx.query<{ wanted: string[]; current: string[] }>(
    `SELECT
       coalesce((SELECT array_agg(id ORDER BY id) FROM categories
                  WHERE owner_id = $1 AND deleted_at IS NULL AND id = ANY($3::uuid[])), '{}') AS wanted,
       coalesce((SELECT array_agg(category_id ORDER BY category_id) FROM item_categories
                  WHERE item_id = $2), '{}') AS current`,
    [ownerId, itemId, ids],
  );
  const { wanted, current } = rows[0]!;
  if (wanted.join() === current.join()) return false;

  await tx.query('DELETE FROM item_categories WHERE item_id = $1 AND NOT (category_id = ANY($2::uuid[]))', [
    itemId,
    wanted,
  ]);
  await tx.query(
    `INSERT INTO item_categories (item_id, category_id)
     SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [itemId, wanted],
  );
  return true;
}

/** Membership lives in another table, so a membership-only change must still bump the item's rev. */
async function touch(tx: pg.PoolClient, itemId: string) {
  await tx.query('UPDATE items SET updated_at = now() WHERE id = $1', [itemId]);
}

/**
 * Idempotent create-or-update keyed by the client's id. A retry after a lost
 * response is always safe, and one that changes nothing doesn't advance rev.
 *
 * What was shared (kind, blob, url, capturedAt) is the item's identity and can't
 * change; the rest is last-write-wins by arrival. A deleted item stays deleted —
 * a stale create retry must not resurrect it — and is returned as a tombstone.
 */
export async function upsertItem(
  pool: pg.Pool,
  ownerId: string,
  u: ItemUpsert,
): Promise<{ item: Item; created: boolean }> {
  checkShape(u);
  return withWriteTx(pool, async (tx) => {
    const blobId = u.blobSha256 ? await resolveBlob(tx, u.blobSha256) : null;
    const editable = [u.title ?? null, u.note ?? null, u.body ?? null, u.sourceApp ?? null, u.tags];

    const inserted = await tx.query(
      `INSERT INTO items (id, owner_id, kind, blob_id, url, captured_at, title, note, body, source_app, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, ownerId, u.kind, blobId, u.url ?? null, u.capturedAt, ...editable],
    );
    if (inserted.rowCount) {
      await setCategories(tx, ownerId, u.id, u.categoryIds);
      return { item: (await getItem(tx, ownerId, u.id))!, created: true };
    }

    const { rows } = await tx.query<{
      owner_id: string;
      deleted: boolean;
      kind: string;
      blob_id: string | null;
      url: string | null;
      same_capture: boolean;
    }>(
      `SELECT owner_id, deleted_at IS NOT NULL AS deleted, kind, blob_id, url,
              captured_at = $2::timestamptz AS same_capture
         FROM items WHERE id = $1 FOR UPDATE`,
      [u.id, u.capturedAt],
    );
    const existing = rows[0]!;
    if (existing.owner_id !== ownerId) throw new HttpError(404, 'not_found', 'no such item');
    if (!existing.deleted) {
      if (
        existing.kind !== u.kind ||
        existing.blob_id !== blobId ||
        existing.url !== (u.url ?? null) ||
        !existing.same_capture
      ) {
        throw new HttpError(409, 'immutable', "an item's kind, blob, url and capturedAt can't change");
      }
      const updated = await tx.query(
        `UPDATE items SET title = $2, note = $3, body = $4, source_app = $5, tags = $6
          WHERE id = $1 AND (title, note, body, source_app, tags) IS DISTINCT FROM ($2, $3, $4, $5, $6::text[])`,
        [u.id, ...editable],
      );
      const recategorized = await setCategories(tx, ownerId, u.id, u.categoryIds);
      if (recategorized && !updated.rowCount) await touch(tx, u.id);
    }
    return { item: (await getItem(tx, ownerId, u.id))!, created: false };
  });
}

/** Partial edit of a live item. Omitted fields are untouched. */
export async function patchItem(pool: pg.Pool, ownerId: string, id: string, p: ItemPatch): Promise<Item> {
  return withWriteTx(pool, async (tx) => {
    const { rows } = await tx.query<{ kind: string }>(
      'SELECT kind FROM items WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [id, ownerId],
    );
    const existing = rows[0];
    if (!existing) throw new HttpError(404, 'not_found', 'no such item');
    if (p.body !== undefined && existing.kind !== 'text') {
      throw new HttpError(400, 'bad_request', 'only text items have a body');
    }

    // Column names come from this fixed list, never from the request.
    const cols: string[] = [];
    const params: unknown[] = [id];
    for (const key of ['title', 'note', 'body', 'tags'] as const) {
      if (p[key] === undefined) continue;
      cols.push(key);
      params.push(p[key]);
    }

    let changed = false;
    if (cols.length) {
      const vals = cols.map((_, n) => `$${n + 2}`);
      // Compare before writing, so a no-op PATCH (e.g. a retry) doesn't advance rev.
      const res = await tx.query(
        `UPDATE items SET ${cols.map((c, n) => `${c} = ${vals[n]}`).join(', ')}
          WHERE id = $1 AND ROW(${cols.join(', ')}) IS DISTINCT FROM ROW(${vals.join(', ')})`,
        params,
      );
      changed = !!res.rowCount;
    }
    if (p.categoryIds && (await setCategories(tx, ownerId, id, p.categoryIds)) && !changed) await touch(tx, id);
    return (await getItem(tx, ownerId, id))!;
  });
}

/** Soft delete, so the deletion syncs. Deleting twice is fine; deleting what never existed is a 404. */
export async function deleteItem(pool: pg.Pool, ownerId: string, id: string): Promise<void> {
  await withWriteTx(pool, async (tx) => {
    const { rows } = await tx.query<{ deleted: boolean }>(
      'SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [id, ownerId],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'no such item');
    if (!rows[0].deleted) await tx.query('UPDATE items SET deleted_at = now() WHERE id = $1', [id]);
  });
}
