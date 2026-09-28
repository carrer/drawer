import { INBOX_CATEGORY_ID } from '@drawer/shared';
import type { SqlDb } from './sql.ts';

/**
 * The on-device schema: the server's shape (infra/db/migrations/001_init.sql)
 * minus `search`, plus local-only sync bookkeeping (PLAN.md §3).
 *
 * Differences from the server, on purpose:
 * - Blob fields live inline on the item. The server needs a separate `blobs`
 *   table for dedupe across items; the phone gets dedupe from the content-
 *   addressed file layout instead, and a join per tile would be pure cost.
 * - Timestamps are ISO-8601 UTC strings from `toISOString()` — one fixed
 *   format, so they sort correctly as text. Anything arriving from the server
 *   must be normalised through `new Date(x).toISOString()` before it lands here.
 * - `rev` is the server's cursor value, NULL until the row has been synced.
 *
 * Append-only, like the server's: never edit an entry that has shipped, add the
 * next one. Applied in order and tracked by `PRAGMA user_version`.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE categories (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
    color       TEXT,
    icon        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    rev         INTEGER,
    sync_state  TEXT NOT NULL DEFAULT 'local' CHECK (sync_state IN ('local', 'synced', 'error'))
  );
  -- Same rule as the server: names are unique among live categories, ignoring case.
  CREATE UNIQUE INDEX categories_name_uniq ON categories (lower(name)) WHERE deleted_at IS NULL;

  CREATE TABLE items (
    id                TEXT PRIMARY KEY,   -- uuidv7, generated here
    kind              TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document', 'link', 'text')),
    title             TEXT,
    note              TEXT,

    sha256            TEXT,               -- lowercase hex; the blob's name on disk and on the server
    byte_size         INTEGER,
    mime_type         TEXT,
    width             INTEGER,            -- images: learned on first render, drives the masonry tile height
    height            INTEGER,

    url               TEXT,
    link_title        TEXT,
    link_description  TEXT,
    link_site_name    TEXT,

    body              TEXT,
    extracted_text    TEXT,
    source_app        TEXT,
    tags              TEXT NOT NULL DEFAULT '[]',  -- JSON array

    captured_at       TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    rev               INTEGER,

    sync_state        TEXT NOT NULL DEFAULT 'local'
                      CHECK (sync_state IN ('local', 'uploading', 'synced', 'error')),
    local_path        TEXT,               -- file:// URI of the original bytes, if we hold them
    upload_error      TEXT,
    retry_after       INTEGER             -- epoch ms
  );
  CREATE INDEX items_feed_idx ON items (captured_at DESC, id DESC) WHERE deleted_at IS NULL;
  CREATE INDEX items_sync_idx ON items (sync_state) WHERE sync_state <> 'synced';

  CREATE TABLE item_categories (
    item_id      TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    category_id  TEXT NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, category_id)
  );
  CREATE INDEX item_categories_cat_idx ON item_categories (category_id, item_id);

  -- The server seeds these same four rows with these same ids, so they are
  -- already 'synced': the first pull reconciles them instead of duplicating.
  INSERT INTO categories (id, name, icon, sort_order, created_at, updated_at, rev, sync_state) VALUES
    ('${INBOX_CATEGORY_ID}',                    'Inbox',      '📥', 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 0, 'synced'),
    ('00000000-0000-0000-0000-0000000000a2', 'Memes',      '😂', 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 0, 'synced'),
    ('00000000-0000-0000-0000-0000000000a3', 'Read later', '📖', 2, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 0, 'synced'),
    ('00000000-0000-0000-0000-0000000000a4', 'Reference',  '📎', 3, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 0, 'synced');
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Applies every pending migration, each in its own transaction with its version bump. */
export function migrate(db: SqlDb): void {
  // Per-connection, and off by default in SQLite — without it ON DELETE CASCADE is inert.
  db.exec('PRAGMA foreign_keys = ON');
  const current = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(`database is at schema v${current}, newer than this build (v${MIGRATIONS.length})`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.tx(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
