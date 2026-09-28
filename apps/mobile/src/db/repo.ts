import { INBOX_CATEGORY_ID, uuidv7, type ItemKind, type ItemPatch } from '@drawer/shared';
import type { SqlDb, SqlValue } from './sql.ts';

/**
 * Typed access to the local database. Everything the UI reads comes from here —
 * the gallery never waits on the network (PLAN.md §1, local-first).
 *
 * Every write that the server will need to hear about flips the row to
 * sync_state 'local'. Rows already mid-upload or in error keep their state:
 * they are pending anyway, and the Phase 3 sync engine pushes the row's
 * current contents, not the contents it had when it was queued.
 */

export type SyncState = 'local' | 'uploading' | 'synced' | 'error';

export type LocalItem = {
  id: string;
  kind: ItemKind;
  title: string | null;
  note: string | null;
  sha256: string | null;
  byteSize: number | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  url: string | null;
  linkTitle: string | null;
  linkDescription: string | null;
  linkSiteName: string | null;
  body: string | null;
  extractedText: string | null;
  sourceApp: string | null;
  tags: string[];
  categoryIds: string[];
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  rev: number | null;
  syncState: SyncState;
  localPath: string | null;
  uploadError: string | null;
};

export type LocalCategory = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  syncState: SyncState;
  /** Live items filed under it. */
  itemCount: number;
};

/** What capture (or the dev seed) hands the repository. */
export type NewItem = {
  id?: string;
  kind: ItemKind;
  title?: string | null;
  note?: string | null;
  sha256?: string | null;
  byteSize?: number | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  url?: string | null;
  linkTitle?: string | null;
  linkSiteName?: string | null;
  body?: string | null;
  sourceApp?: string | null;
  localPath?: string | null;
  capturedAt: string;
  /** Defaults to [Inbox] — a capture always lands somewhere visible. */
  categoryIds?: string[];
};

export type ItemFilter = {
  /** null/undefined = every category, including items in none. */
  categoryId?: string | null;
  kind?: ItemKind | null;
  /** Case-insensitive substring match over the text fields (see filterClause). */
  query?: string | null;
  order?: 'newest' | 'oldest';
  limit?: number;
};

/** A live category with this name (ignoring case) already exists. */
export class DuplicateCategoryError extends Error {
  constructor(name: string) {
    super(`a category named "${name}" already exists`);
    this.name = 'DuplicateCategoryError';
  }
}

export class InboxUndeletableError extends Error {
  constructor() {
    super('Inbox can be renamed but not deleted');
    this.name = 'InboxUndeletableError';
  }
}

type ItemRow = {
  id: string;
  kind: ItemKind;
  title: string | null;
  note: string | null;
  sha256: string | null;
  byte_size: number | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  url: string | null;
  link_title: string | null;
  link_description: string | null;
  link_site_name: string | null;
  body: string | null;
  extracted_text: string | null;
  source_app: string | null;
  tags: string;
  captured_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  rev: number | null;
  sync_state: SyncState;
  local_path: string | null;
  upload_error: string | null;
};

type CategoryRow = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  sync_state: SyncState;
  item_count: number;
};

const now = () => new Date().toISOString();

/** Pending again unless it already is. */
const MARK_DIRTY = `sync_state = CASE WHEN sync_state = 'synced' THEN 'local' ELSE sync_state END`;

function toItem(r: ItemRow, categoryIds: string[]): LocalItem {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // A corrupt tags cell shouldn't take the whole gallery down with it.
  }
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    note: r.note,
    sha256: r.sha256,
    byteSize: r.byte_size,
    mimeType: r.mime_type,
    width: r.width,
    height: r.height,
    url: r.url,
    linkTitle: r.link_title,
    linkDescription: r.link_description,
    linkSiteName: r.link_site_name,
    body: r.body,
    extractedText: r.extracted_text,
    sourceApp: r.source_app,
    tags,
    categoryIds,
    capturedAt: r.captured_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    rev: r.rev,
    syncState: r.sync_state,
    localPath: r.local_path,
    uploadError: r.upload_error,
  };
}

/** One query for all the memberships of a page, rather than one per tile. */
function attachCategories(db: SqlDb, rows: ItemRow[]): LocalItem[] {
  if (rows.length === 0) return [];
  const byItem = new Map<string, string[]>(rows.map((r) => [r.id, []]));
  const links = db.all<{ item_id: string; category_id: string }>(
    `SELECT ic.item_id, ic.category_id
       FROM item_categories ic JOIN categories c ON c.id = ic.category_id
      WHERE c.deleted_at IS NULL AND ic.item_id IN (${rows.map(() => '?').join(',')})
      ORDER BY c.sort_order, lower(c.name)`,
    rows.map((r) => r.id),
  );
  for (const l of links) byItem.get(l.item_id)?.push(l.category_id);
  return rows.map((r) => toItem(r, byItem.get(r.id) ?? []));
}

/** The same fields the server's tsvector weighs, plus the URL. */
const SEARCHED = ['title', 'note', 'body', 'url', 'link_title', 'link_description', 'link_site_name', 'extracted_text', 'tags'];

function filterClause(filter: ItemFilter): { where: string; params: SqlValue[] } {
  const conds = ['i.deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (filter.categoryId) {
    conds.push('EXISTS (SELECT 1 FROM item_categories ic WHERE ic.item_id = i.id AND ic.category_id = ?)');
    params.push(filter.categoryId);
  }
  if (filter.kind) {
    conds.push('i.kind = ?');
    params.push(filter.kind);
  }
  const q = filter.query?.trim();
  if (q) {
    // Plain LIKE until Phase 4's FTS5 index: fine at personal-archive scale, and
    // substring matching finds partial words a tokenizer wouldn't. LIKE is
    // case-insensitive for ASCII only; `%` and `_` in the query match literally.
    const text = SEARCHED.map((c) => `coalesce(i.${c}, '')`).join(` || ' ' || `);
    conds.push(`(${text}) LIKE ? ESCAPE '\\'`);
    params.push(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  return { where: conds.join(' AND '), params };
}

/**
 * The gallery feed: newest capture first. The id breaks ties so the order is
 * stable across reloads — only stable, not capture order: uuidv7 is
 * millisecond-precise, so a multi-file share's items can come out in any order.
 */
export function listItems(db: SqlDb, filter: ItemFilter = {}): LocalItem[] {
  const { where, params } = filterClause(filter);
  const dir = filter.order === 'oldest' ? 'ASC' : 'DESC';
  const rows = db.all<ItemRow>(
    `SELECT i.* FROM items i WHERE ${where} ORDER BY i.captured_at ${dir}, i.id ${dir} LIMIT ?`,
    [...params, filter.limit ?? 100],
  );
  return attachCategories(db, rows);
}

export function countItems(db: SqlDb, filter: Omit<ItemFilter, 'limit'> = {}): number {
  const { where, params } = filterClause(filter);
  return db.get<{ n: number }>(`SELECT count(*) AS n FROM items i WHERE ${where}`, params)?.n ?? 0;
}

/** Returns deleted items too, so a detail screen open during a delete can tell what happened. */
export function getItem(db: SqlDb, id: string): LocalItem | null {
  const row = db.get<ItemRow>('SELECT * FROM items WHERE id = ?', [id]);
  return row ? attachCategories(db, [row])[0]! : null;
}

/** Drops ids that aren't live categories, and duplicates. */
function liveCategoryIds(db: SqlDb, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const live = db.all<{ id: string }>(
    `SELECT id FROM categories WHERE deleted_at IS NULL AND id IN (${unique.map(() => '?').join(',')})`,
    unique,
  );
  const ok = new Set(live.map((r) => r.id));
  return unique.filter((id) => ok.has(id));
}

function setCategories(db: SqlDb, itemId: string, categoryIds: string[]): void {
  db.run('DELETE FROM item_categories WHERE item_id = ?', [itemId]);
  for (const cid of liveCategoryIds(db, categoryIds)) {
    db.run('INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)', [itemId, cid]);
  }
}

/**
 * Inserts captured items in one transaction and returns their ids.
 *
 * Idempotent on id, like the server's upsert: re-inserting an existing id is a
 * no-op, so a capture retried after a crash can't double up.
 */
export function insertItems(db: SqlDb, items: NewItem[]): string[] {
  const ids: string[] = [];
  const ts = now();
  db.tx(() => {
    for (const it of items) {
      const id = it.id ?? uuidv7();
      ids.push(id);
      const { changes } = db.run(
        `INSERT OR IGNORE INTO items
           (id, kind, title, note, sha256, byte_size, mime_type, width, height, url, link_title,
            link_site_name, body, source_app, local_path, captured_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, it.kind, it.title ?? null, it.note ?? null, it.sha256 ?? null, it.byteSize ?? null,
          it.mimeType ?? null, it.width ?? null, it.height ?? null, it.url ?? null, it.linkTitle ?? null,
          it.linkSiteName ?? null, it.body ?? null, it.sourceApp ?? null, it.localPath ?? null,
          it.capturedAt, ts, ts,
        ],
      );
      if (changes > 0) setCategories(db, id, it.categoryIds ?? [INBOX_CATEGORY_ID]);
    }
  });
  return ids;
}

/**
 * Edits after capture, same contract as the server's ItemPatch: omitted fields
 * are untouched, null clears, categoryIds replaces the whole set. Returns false
 * if there is no live item with that id.
 */
export function updateItem(db: SqlDb, id: string, patch: ItemPatch): boolean {
  let found = false;
  db.tx(() => {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(blankToNull(patch.title));
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      params.push(blankToNull(patch.note));
    }
    if (patch.body !== undefined) {
      sets.push('body = ?');
      params.push(patch.body);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(patch.tags));
    }
    sets.push('updated_at = ?', MARK_DIRTY);
    params.push(now());

    const { changes } = db.run(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [
      ...params,
      id,
    ]);
    found = changes > 0;
    if (found && patch.categoryIds !== undefined) setCategories(db, id, patch.categoryIds);
  });
  return found;
}

function blankToNull(v: string | null): string | null {
  return v === null || v.trim() === '' ? null : v;
}

/**
 * Soft delete, so the deletion can sync. The bytes stay on disk: another item
 * may share the blob, and reclaiming space is the eviction policy's job (Phase 5).
 */
export function deleteItem(db: SqlDb, id: string): void {
  const ts = now();
  db.run(`UPDATE items SET deleted_at = ?, updated_at = ?, ${MARK_DIRTY} WHERE id = ? AND deleted_at IS NULL`, [
    ts,
    ts,
    id,
  ]);
}

/**
 * Pixel size, learned when an image first renders. Derived data the server
 * computes for itself, so this deliberately leaves sync_state alone.
 */
export function setImageSize(db: SqlDb, id: string, width: number, height: number): void {
  if (!(width > 0 && height > 0)) return;
  db.run('UPDATE items SET width = ?, height = ? WHERE id = ? AND (width IS NOT ? OR height IS NOT ?)', [
    Math.round(width),
    Math.round(height),
    id,
    Math.round(width),
    Math.round(height),
  ]);
}

// ── categories ────────────────────────────────────────────────────────────────

export function listCategories(db: SqlDb): LocalCategory[] {
  return db
    .all<CategoryRow>(
      `SELECT c.id, c.name, c.color, c.icon, c.sort_order, c.created_at, c.updated_at, c.sync_state,
              (SELECT count(*) FROM item_categories ic JOIN items i ON i.id = ic.item_id
                WHERE ic.category_id = c.id AND i.deleted_at IS NULL) AS item_count
         FROM categories c
        WHERE c.deleted_at IS NULL
        ORDER BY c.sort_order, lower(c.name)`,
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      syncState: r.sync_state,
      itemCount: r.item_count,
    }));
}

/** SQLite reports a violated unique index the same way on both engines. */
function rethrowDuplicate(err: unknown, name: string): never {
  if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) throw new DuplicateCategoryError(name);
  throw err;
}

export function createCategory(
  db: SqlDb,
  input: { name: string; icon?: string | null; color?: string | null },
): string {
  const id = uuidv7();
  const name = input.name.trim();
  const ts = now();
  try {
    db.run(
      `INSERT INTO categories (id, name, icon, color, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, (SELECT coalesce(max(sort_order), -1) + 1 FROM categories WHERE deleted_at IS NULL), ?, ?)`,
      [id, name, blankToNull(input.icon ?? null), input.color ?? null, ts, ts],
    );
  } catch (err) {
    rethrowDuplicate(err, name);
  }
  return id;
}

export function updateCategory(
  db: SqlDb,
  id: string,
  patch: { name?: string; icon?: string | null; color?: string | null },
): void {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name.trim());
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?');
    params.push(blankToNull(patch.icon));
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    params.push(patch.color);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?', MARK_DIRTY);
  params.push(now());
  try {
    db.run(`UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, id]);
  } catch (err) {
    rethrowDuplicate(err, patch.name?.trim() ?? '');
  }
}

/**
 * Soft delete, mirroring the server: its items lose the membership, and since a
 * category set travels inside the item, each of those items changes too.
 */
export function deleteCategory(db: SqlDb, id: string): void {
  if (id === INBOX_CATEGORY_ID) throw new InboxUndeletableError();
  const ts = now();
  db.tx(() => {
    const { changes } = db.run(
      `UPDATE categories SET deleted_at = ?, updated_at = ?, ${MARK_DIRTY} WHERE id = ? AND deleted_at IS NULL`,
      [ts, ts, id],
    );
    if (changes === 0) return;
    db.run(
      `UPDATE items SET updated_at = ?, ${MARK_DIRTY}
        WHERE id IN (SELECT item_id FROM item_categories WHERE category_id = ?)`,
      [ts, id],
    );
    db.run('DELETE FROM item_categories WHERE category_id = ?', [id]);
  });
}

/**
 * Move one step up (-1) or down (+1). Renumbers the whole list 0..n-1 so the
 * order stays well-defined even if two categories arrived with equal sort_order.
 */
export function moveCategory(db: SqlDb, id: string, direction: -1 | 1): void {
  db.tx(() => {
    const ids = listCategories(db).map((c) => c.id);
    const from = ids.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    const ts = now();
    ids.forEach((cid, order) => {
      db.run(
        `UPDATE categories SET sort_order = ?, updated_at = ?, ${MARK_DIRTY} WHERE id = ? AND sort_order <> ?`,
        [order, ts, cid, order],
      );
    });
  });
}
