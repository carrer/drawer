# Drawer — Implementation Plan

A personal capture archive. You hit **Share → Drawer** from anywhere on your phone and the
artifact (image, meme, link, PDF, screenshot, snippet of text) lands in a gallery you own,
filed under categories you define.

**Stack decisions (locked):** Expo / React Native · self-hosted Docker (Fastify + Postgres +
Garage S3) · single user · deterministic metadata enrichment, no AI in v1.

---

## 1. Principles

These three shape every decision below. Violating them is how this project gets abandoned.

1. **Sharing must never block on the network.** The share sheet gives you ~a second of
   attention. Capture writes to local SQLite + local disk and returns. Upload happens later,
   in the background, with retries. The item is visible in the gallery before the first byte
   leaves the phone.
2. **The phone is a cache; the server is the truth.** Every item is server-backed so you can
   wipe the phone, reinstall, and get your archive back. Local storage is an accelerator with
   an eviction policy, not the archive.
3. **Content-addressed blobs.** The SHA-256 of the bytes is the storage key. Dedupe is free,
   uploads are idempotent, retries are safe, and saving the same meme twice costs zero bytes.

---

## 2. Architecture

```
┌──────────────────────── Android / iOS ────────────────────────┐
│                                                               │
│  OS Share Sheet ──▶ Share target (intent-filter / extension)  │
│                          │                                     │
│                          ▼  copy bytes NOW (URI grant is transient)
│                     Capture screen  ──▶ local SQLite + FS      │
│                          │                    │                │
│                          │              Gallery UI (reads local)│
│                          ▼                                     │
│                  Sync engine (background task)                 │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTPS
              ┌────────────┴────────────┐
              │  Caddy (TLS, reverse    │
              │  proxy, rate limit)     │
              └────┬───────────────┬────┘
                   │               │
        ┌──────────▼─────┐   ┌─────▼──────────────────┐
        │  Fastify API   │   │ Garage (S3-compatible) │
        │  metadata only │   │  blobs + thumbnails    │
        └───┬────────┬───┘   └────────────────────────┘
            │        │            ▲
     ┌──────▼──┐  ┌──▼─────────┐  │ presigned PUT/GET
     │Postgres │  │ pg-boss    │  │ (client ⇄ storage direct,
     │ 16      │  │ worker     │──┘  API never proxies bytes)
     └─────────┘  └────────────┘
                   thumbs · link unfurl · PDF page 1 · EXIF
```

**The API never touches file bytes.** It issues presigned URLs; the phone talks to Garage
directly. This keeps Node out of the multipart-upload business and halves your bandwidth.

### Repo layout (monorepo, npm workspaces)

```
drawer/
├─ apps/mobile/          Expo app (TypeScript)
├─ services/api/         Fastify + Postgres + S3 presigning
├─ services/worker/      pg-boss consumers (thumbs, unfurl, EXIF)
├─ packages/shared/      zod schemas + types shared by app and API
├─ infra/
│  ├─ docker-compose.yml postgres · garage · api · worker · caddy
│  ├─ Caddyfile
│  └─ backup/            restic cron → offsite
└─ PLAN.md
```

**npm workspaces, not pnpm.** One less tool to install, and npm's hoisted
`node_modules` sidesteps the symlink resolution Metro still trips over in pnpm
monorepos. `metro.config.js` watches the workspace root so edits in
`packages/shared` hot-reload into the app.

---

## 3. Data model

```sql
CREATE TYPE item_kind AS ENUM ('image','video','audio','document','link','text');

-- Content-addressed binary objects. One row per distinct byte sequence, ever.
CREATE TABLE blobs (
  id           uuid PRIMARY KEY,
  sha256       bytea NOT NULL UNIQUE,
  byte_size    bigint NOT NULL,
  mime_type    text NOT NULL,
  storage_key  text NOT NULL,          -- blobs/<ab>/<cd>/<hex>
  thumb_key    text,                   -- derived webp, 512px long edge
  width        int, height int,
  duration_ms  int,                    -- video/audio
  page_count   int,                    -- documents
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE items (
  id            uuid PRIMARY KEY,      -- uuidv7, generated ON THE CLIENT (offline creation)
  owner_id      uuid NOT NULL,
  kind          item_kind NOT NULL,
  title         text,                  -- user-editable display name
  note          text,                  -- your own annotation
  blob_id       uuid REFERENCES blobs(id),

  -- kind = 'link'
  url                 text,
  link_title          text,
  link_description    text,
  link_site_name      text,
  link_image_blob_id  uuid REFERENCES blobs(id),

  body          text,                  -- kind = 'text'
  extracted_text text,                 -- PDF text layer; OCR later if ever

  source_app    text,                  -- referrer package, e.g. com.instagram.android
  captured_at   timestamptz NOT NULL,  -- when YOU shared it
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,           -- soft delete, so deletions sync
  rev           bigint NOT NULL DEFAULT nextval('item_rev_seq'),  -- see §5
  tags          text[] NOT NULL DEFAULT '{}',

  search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
      setweight(to_tsvector('simple', coalesce(link_title,'')), 'A') ||
      setweight(to_tsvector('simple', coalesce(note,'')), 'B') ||
      setweight(to_tsvector('simple', coalesce(link_description,'')), 'C') ||
      setweight(to_tsvector('simple', coalesce(body,'')), 'C') ||
      setweight(to_tsvector('simple', coalesce(extracted_text,'')), 'D')
  ) STORED
);

CREATE TABLE categories (
  id         uuid PRIMARY KEY,
  owner_id   uuid NOT NULL,
  name       text NOT NULL,
  color      text,                     -- hex, for the chip
  icon       text,                     -- emoji or icon name
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  rev        bigint NOT NULL DEFAULT nextval('item_rev_seq'),
  UNIQUE (owner_id, lower(name))
);

-- Many-to-many: an item can live in several categories.
CREATE TABLE item_categories (
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, category_id)
);

CREATE TABLE devices (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL,
  name        text NOT NULL,
  token_hash  bytea NOT NULL,          -- sha256 of the opaque device token
  last_seen_at timestamptz,
  revoked_at  timestamptz
);

CREATE INDEX ON items (owner_id, captured_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ON items (owner_id, rev);
CREATE INDEX ON items USING GIN (search);
CREATE INDEX ON items USING GIN (tags);
CREATE INDEX ON item_categories (category_id, item_id);
```

**Why one `items` table and not table-per-type:** the gallery is a single reverse-chronological
feed mixing all kinds. Polymorphism in the query layer costs far more than a handful of
nullable columns.

The local SQLite schema on the phone is the same shape, minus `search`/`tsvector`, plus:

```sql
sync_state  TEXT  -- 'local' | 'uploading' | 'synced' | 'error'
local_path  TEXT  -- file:// path to the original bytes
upload_error TEXT
retry_after INTEGER
```

---

## 4. The capture pipeline (the part that actually matters)

**Android.** `expo-share-intent`'s config plugin injects the `<intent-filter>`s for
`ACTION_SEND` / `ACTION_SEND_MULTIPLE` across `image/*`, `video/*`, `application/pdf`,
`text/plain`, `*/*`, and sets `android:launchMode="singleTask"` on the main activity.

```
Share sheet tap
  └─▶ Activity launches (cold or onNewIntent)
      └─▶ Read intent extras
          ├─ EXTRA_STREAM (content:// URI)  →  COPY BYTES IMMEDIATELY to app cache
          │                                     (the URI grant dies with the activity)
          └─ EXTRA_TEXT                     →  is it a URL?  yes → kind='link'
                                                             no  → kind='text'
      └─▶ Hash bytes (SHA-256, streamed) → move into documents/blobs/<hex>
      └─▶ INSERT into local SQLite, sync_state='local', id = uuidv7()
      └─▶ Capture sheet: preview, title, category chips, note  [Save] [Save to Inbox]
      └─▶ Enqueue upload job; dismiss
```

The capture sheet is a **bottom sheet over the share context**, not a full app launch. Default
action is one tap: "Save to Inbox". Category chips are right there for a second tap. Anything
slower and you'll stop using it.

**Kind detection** (in order): explicit MIME from the intent → magic-byte sniff of the copied
file → extension → fall back to `document`. Never trust the sender's MIME alone; Android apps
lie about it constantly (`application/octet-stream` for JPEGs is routine).

**iOS** (phase 6): a Share Extension target writing into a shared App Group container, which
the main app drains on next launch. `expo-share-intent` generates this too. The extension runs
under a hard memory cap (~120 MB) — copy the file handle, never decode or process in there.

---

## 5. Sync protocol

Single user, usually one device. No CRDTs, no vector clocks. **Last-write-wins on `updated_at`,
with a server-assigned revision cursor.**

```
GET /v1/sync?since=<rev>&limit=500
  → { items: [...], categories: [...], cursor: <max rev>, more: bool }
```

`item_categories` is not synced as a third table: an item's category set travels
inside the item and bumps that item's `rev`. One less table to reconcile, and
the membership can never arrive before the row it points at.

`rev` comes from a single Postgres sequence bumped on every write (trigger), **not wall-clock
time**. Wall clocks give you the classic boundary bug where two rows written in the same
millisecond straddle the cursor and one is silently dropped forever. A monotonic sequence
cannot.

Push is per-item and idempotent: the client generates the `id`, so `POST /v1/items` with an
existing id is an upsert. A retry after a timeout is always safe.

Deletes are soft (`deleted_at`) so they propagate. A nightly job hard-deletes rows soft-deleted
>30 days ago and garbage-collects blobs with no remaining referents.

### API surface

```
POST   /v1/auth/enroll          bootstrap code → opaque device token   (once per device)
GET    /v1/sync                 delta pull since rev
POST   /v1/blobs/presign        {sha256, size, mime} → {blobId, uploadUrl} | {blobId, exists:true}
POST   /v1/blobs/:id/commit     confirm upload; enqueues enrichment
POST   /v1/items                upsert (client-generated id)
PATCH  /v1/items/:id
DELETE /v1/items/:id            soft delete
GET    /v1/items/:id/url        short-TTL presigned GET for original
GET    /v1/search?q=            full-text over the tsvector
CRUD   /v1/categories
```

`presign` returning `exists: true` is the dedupe path: re-share the same meme and the save is
instant and free.

---

## 6. Enrichment worker (deterministic only)

Queue is **pg-boss** — Postgres-backed, so no Redis on the box. Jobs, triggered on blob commit:

| Job | Does | Tool |
|---|---|---|
| `thumb.image` | 512px long-edge WebP, EXIF orientation applied, EXIF GPS **stripped** | `sharp` (built with libheif for HEIC) |
| `thumb.video` | frame at 1s + duration/dimensions | `ffmpeg` |
| `thumb.document` | render page 1, extract text layer | `poppler-utils` (`pdftoppm`, `pdftotext`) |
| `link.unfurl` | fetch URL, parse `og:`/`twitter:`/`<title>`, store `og:image` as a blob | `undici` + `cheerio` |

**SSRF guard on `link.unfurl` is mandatory** — this endpoint fetches URLs you hand it, from
inside your network. Resolve DNS first and reject private/loopback/link-local ranges, cap
redirects at 3 (re-checking each hop), cap the response at 5 MB, 10s timeout, no auth headers
forwarded. Without this, "save a link" is a request-forgery primitive pointed at your own LAN.

The phone also generates a fast local thumbnail on capture so the grid is never empty while the
server catches up.

---

## 7. Phases

Effort figures assume focused evenings, and are a shape, not a commitment.

### Phase 0 — De-risk + scaffold ✅ scaffolded, one gate item left
The share intent is the riskiest integration in the project and the entire point of it.
Prove it before building anything around it.

- [x] npm workspace skeleton, `@drawer/shared` (zod contracts, uuidv7, MIME sniffing), CI.
- [x] `docker compose up` brings up Postgres + Garage (was MinIO, see §11); schema applies; object round-trip verified.
- [x] Expo SDK 57 app on `expo-share-intent` 8.x, plugin chain validated by `expo config --type prebuild`.
- [x] Capture pipeline (`apps/mobile/src/capture.ts`): single-pass streaming hash + magic-byte
      sniff, content-addressed move into `documents/blobs/<ab>/<cd>/<hex>`, dedupe on arrival.
- [x] `make check` — an 11-point gate that verifies the stack with real round-trips, not 200s.
- [ ] **Remaining:** `npx expo prebuild` + `eas build --profile development`, install on the
      phone, and share an image, a link and a PDF from three real apps. Needs your Expo
      account and a device, so it's the one step that can't be automated from here.

**Gate:** you can share a screenshot from Chrome and see its bytes on disk in the app. Nothing
else starts until this is true.

> **Expo Go will not work.** Share targets require native manifest entries. You need a
> development build from day one — budget for the EAS setup here rather than discovering it in
> Phase 3.

### Phase 1 — Backend core (~2–3 days)
- [ ] Migrations for §3 (`dbmate` or `node-pg-migrate`).
- [ ] Fastify + zod validation + pino; `/v1/auth/enroll` and device-token middleware.
- [ ] Blob presign/commit against Garage; content-addressed keys.
- [ ] Items + categories CRUD, upsert semantics, soft delete.
- [ ] `/v1/sync` with the `rev` cursor.
- [ ] Caddy in front, real TLS on your domain.
- [ ] Integration tests against throwaway Postgres + Garage containers.

### Phase 2 — Mobile local-first core (~3–4 days)
- [ ] `expo-sqlite` schema + migrations; typed repository layer.
- [ ] Gallery: `@shopify/flash-list` masonry grid, `expo-image` with disk caching.
- [ ] Category management; filter bar; item detail view per kind (image viewer, link card, PDF, text).
- [ ] Runs entirely offline against seeded local data. No server involved.

### Phase 3 — Capture + sync (~3–4 days)
- [ ] Full capture pipeline from §4, including streamed hashing and kind sniffing.
- [ ] Capture bottom sheet with one-tap Inbox save.
- [ ] Upload queue: exponential backoff, resumable, survives app kill (`expo-background-task`).
- [ ] Delta pull on foreground + periodic background task.
- [ ] Sync-state affordances in the UI (pending badge, error retry).

**Gate:** share from five different apps, kill the app mid-upload, reopen — nothing lost, nothing duplicated.

### Phase 4 — Enrichment + search (~2 days)
- [ ] pg-boss worker with the four job types from §6.
- [ ] SSRF-guarded unfurler, with unit tests for the blocked ranges.
- [ ] Search endpoint + a search bar that queries local SQLite FTS5 first, server second.

### Phase 5 — Livability (~2 days)
- [ ] Multi-select → bulk categorize / delete.
- [ ] Local cache eviction policy (keep thumbs forever, evict originals over N GB by LRU).
- [ ] `restic` backup cron for Postgres dumps + the Garage data and metadata dirs, offsite, with a **tested restore**.
- [ ] Export: one command that writes the whole archive to a plain folder tree of files + a JSON manifest.

### Phase 6 — Later, only if wanted
iOS share extension · a read-only web gallery reusing the same API · AI auto-tagging and OCR
(a `suggest.tags` job type slots straight into pg-boss) · shared categories with other people
(every row is already `owner_id`-scoped, so this is additive).

---

## 8. Known traps

1. **Presigned PUTs from AWS SDK v3 carry an empty-body checksum by default.** Since the
   SDK's 2025 "flexible checksums" change, `getSignedUrl(PutObjectCommand)` bakes
   `x-amz-checksum-crc32=AAAAAA==` into the URL — computed at signing time, over no body.
   Garage validates it and rejects every real upload with `InvalidDigest`; MinIO ignored it,
   which is how it hid. The presigner client sets `requestChecksumCalculation: 'WHEN_REQUIRED'`
   (`src/storage.ts`). Don't remove it; integrity is already guaranteed by SHA-256 keys.
2. **Presigned URLs must be signed for the externally reachable hostname.** If the API
   signs against `http://garage:3900` (the Docker-internal name), the phone gets an unreachable
   host or a signature mismatch. `S3_PUBLIC_ENDPOINT` must be the origin the device dials, and
   Caddy must forward the original `Host` (its default — never add `header_up Host`). Garage
   checks signatures against the Host it receives. This is the single most common self-hosted
   S3 bug and it will cost you an evening if unanticipated.
3. **`android:launchMode`.** With `standard`, every share spawns a new activity instance and
   your state is wrong; with `singleTask` you must handle `onNewIntent` for warm launches.
   Test cold launch, warm launch, and share-while-app-is-foregrounded separately.
4. **The content URI grant is transient.** Copy bytes inside the handler. Don't stash the URI
   and read it later — it'll be revoked.
5. **Never load a shared video into memory.** A 4K video will OOM a naive whole-file
   read. SDK 57's `expo-file-system` `File` implements `Blob`, so `readableStream()`
   hashes in constant memory (`src/capture.ts` does the hash and the magic-byte
   sniff in the same single pass), and `File.upload(presignedUrl)` streams natively
   — Phase 3 never has to hold a payload in JS at all.
6. **HEIC/HEIF.** Modern phone cameras emit it; `sharp` needs libheif compiled in, or every
   photo thumbnail silently fails. Verify in the Docker image, not on your laptop.
7. **Strip EXIF GPS on derived thumbnails.** Your screenshots are one thing; your photos carry
   home coordinates.
8. **Backups are the whole product.** Postgres is small and trivially dumped; the blobs are the
   archive. An untested restore is not a backup — do one restore drill in Phase 5.
9. **Blob GC must be reference-counted**, not "delete blobs older than X". Dedupe means one blob
   can back many items.

## 9. Explicitly out of scope for v1

Tags UI (the column exists, expose it later) · video transcoding · web app · full-text
highlighting · multi-user · AI anything · end-to-end encryption (the box is yours; disk
encryption at the VPS level is the proportionate answer).

---

## 10. Open items to confirm before Phase 1

- Domain name / VPS for the box (and whether it's behind Tailscale instead of public TLS —
  Tailscale-only would simplify auth and remove the SSRF blast radius, at the cost of needing
  the VPN on to save anything).
- Storage budget — drives the cache eviction threshold and the backup target.
- The object store — see §11.

---

## 11. The object store: Garage (decided 2026-09-28)

Phase 0 originally ran on MinIO, but MinIO Inc. wound down its community edition: Docker Hub
stopped serving `minio/minio`, and by September 2026 `quay.io/minio/*` returned 401 even for
the last public build, so `make up` could no longer pull it at all. A personal archive meant to
last years shouldn't sit on a storage server that no longer ships images or patches.

Drawer now runs **Garage** (`dxflrs/garage`, pinned in `infra/docker-compose.yml`): one Rust
binary, ~100 MB RSS, actively released, and it covers everything Drawer uses — PUT/GET/HEAD/
DELETE, presigned URLs, multipart. What changed:

- `infra/garage.toml` is the node config; `GARAGE_RPC_SECRET` comes from `infra/.env`.
- `scripts/garage-init.sh` (run by `make up`) assigns the single-node layout, *imports* the
  `S3_ACCESS_KEY`/`S3_SECRET_KEY` pair from `infra/.env` (Garage formats: `GK` + 24 hex, 64 hex),
  creates the bucket and grants the key. It's idempotent.
- No bucket versioning (Garage doesn't implement it). Nothing relied on it: soft deletes plus
  content addressing are the recovery story, and the nightly GC must stay reference-counted.
- No web console; use `docker compose exec garage /garage …` instead.
- `s3_region` in `garage.toml` must equal `S3_REGION`.

The code only sees `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET`, and
`src/storage.ts` is the only file that touches the SDK. Moving to another store later is
`rclone sync s3-a: s3-b:`, because keys are pure functions of the bytes.
