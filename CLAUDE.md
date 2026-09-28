# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Drawer — a personal, self-hosted capture archive. You share anything from your phone (image,
video, PDF, link, plain text) via the OS share sheet; it lands in a gallery you own. Single-user
by design (see PLAN.md §1); multi-user is deferred but every row is already owner-scoped so it's
additive later.

See **PLAN.md** for the full architecture and phase-by-phase roadmap — it's the source of truth
for design decisions and known traps, not just a proposal.

Status: **Phase 0 complete** (scaffold + de-risk) apart from the on-device build, which needs an
Expo account. Phase 1 (backend core) is next. `services/worker/` in the target architecture does
not exist yet.

## Commands

```bash
cp infra/.env.example infra/.env            # then set S3_PUBLIC_ENDPOINT — see below
cp services/api/.env.example services/api/.env
make install                                 # npm install across the workspace
make up                                      # postgres + garage (S3); schema, bucket and key set up on first boot
make api                                     # run the API with reload — http://localhost:8080/health
make check                                   # Phase 0 gate: 11 real round-trip checks, see below
make typecheck                               # tsc --noEmit across every workspace
make test                                    # unit tests, no database needed
make db                                      # psql shell
make down / make reset                       # stop services / DESTROY local data + re-apply migrations (asks first)
make lan-ip                                  # print the LAN IP to put in S3_PUBLIC_ENDPOINT
```

**Node 24 is required** (`.nvmrc`; use `nvm use`). The API and tests run `.ts` files directly via
Node's built-in type stripping — Ubuntu's `nodejs` package is built without it and fails with
`ERR_UNKNOWN_FILE_EXTENSION` / `ERR_NO_TYPESCRIPT`, even on 22.x.

Single test file / single test (per-workspace, plain `node --test`):

```bash
node --test packages/shared/src/id.test.ts
node --test --test-name-pattern="uuidv7" packages/shared/src/kinds.test.ts
```

**`make check` (`scripts/phase0-check.sh`) is the real integration gate** — it verifies containers
are up, all 7 tables exist with seeded default categories, the generated `tsvector` column
actually indexes a row, the `rev` trigger advances on UPDATE, and does a genuine SigV4-signed S3 put→get→delete
round-trip against Garage. Run it after touching the schema or storage wiring, not just `make typecheck`.

**`S3_PUBLIC_ENDPOINT` must be your machine's LAN IP (`make lan-ip`), never `localhost`.** Presigned
upload URLs are signed against that origin; a phone's `localhost` is the phone itself, not your
dev machine. This is the single most common self-hosted S3 mistake and `make check` fails loudly
on it.

### Mobile app

```bash
cd apps/mobile
npx expo prebuild            # generates android/ and ios/ from app.json — rerun after changing app.json plugins
npx eas build --profile development -p android
make mobile                  # Metro for the dev build, from repo root
```

Expo Go cannot run this app — share-target support needs native manifest entries (intent
filters), so a development build is required from the start.

## Architecture

```
Share Sheet → app copies bytes immediately → local SQLite + FS → gallery UI (reads local)
                                                    │
                                          Sync engine (background)
                                                    │ HTTPS
                                          Caddy (TLS, reverse proxy)
                                          │                    │
                                   Fastify API          Garage (S3-compatible)
                                   (metadata only)        blobs + thumbnails
                                   │           │               ▲
                              Postgres 16   pg-boss worker ────┘ presigned PUT/GET
                                            (not built yet)  (client ⇄ storage direct;
                                                               API never proxies bytes)
```

**The API never touches file bytes.** It issues presigned S3 URLs; the phone/app talks to Garage
directly. `services/api/src/storage.ts` intentionally creates *two* S3 clients: `internal` (talks
to Garage over the Docker network for HEAD/stat/delete) and `presigner` (signs URLs against the
*public* origin, because the signature covers the Host header and the phone sends whatever host
it actually dialled — signing with the internal name is the #1 self-hosted S3 bug, see PLAN.md §8).

- **`apps/mobile/`** — Expo (SDK 57) app using `expo-router` and `expo-share-intent`. `src/capture.ts`
  is the capture pipeline: on share, copy bytes out of the transient `content://` URI immediately
  (the grant dies with the activity), hash with SHA-256 in a single streaming pass alongside a
  magic-byte MIME sniff, then write into local SQLite before syncing.
- **`services/api/`** — Fastify. Issues presigned URLs and manages metadata; never streams file
  bytes itself. `src/config.ts` fails loudly at boot naming every missing env var (zod-validated),
  matching the "fail at startup, not first request" pattern.
- **`services/worker/`** — planned pg-boss consumers (thumbnails, link unfurl, PDF page-1 render,
  EXIF strip) — Phase 4, not yet implemented.
- **`packages/shared/`** — zod schemas and pure logic shared by app and API, dependency-free and
  deterministic so the same classification runs offline on-device and again server-side:
  - `id.ts` — UUIDv7 generation (client-generated ids so offline capture and idempotent
    upsert-on-retry both work; ids sort chronologically, keeping Postgres inserts append-mostly).
  - `kinds.ts` — MIME→kind mapping, magic-byte sniffing (never trust a sender's declared MIME;
    Android routinely lies), and text/link classification for shared plain text.
  - `schema.ts` / `api.ts` — row schemas and the sync/presign/enroll API contracts.
- **`infra/`** — `docker-compose.yml` (Postgres 16 + Garage, non-default ports to avoid collisions —
  see `infra/.env.example`), `Caddyfile`, and `db/migrations/001_init.sql` (applied automatically
  by the Postgres image on first boot of an empty volume; **do not edit this file** once real data
  exists — use a proper migration tool for changes).
- **`scripts/phase0-check.sh`** — the gate behind `make check`.
- **`scripts/garage-init.sh`** — idempotent Garage bootstrap run by `make up` (layout → import the
  `S3_ACCESS_KEY`/`S3_SECRET_KEY` pair from `infra/.env` → bucket + grant). The garage image has no
  shell, so all setup goes through `docker compose exec garage /garage …`. Keys are imported, not
  generated, so they must be Garage-formatted (`GK` + 24 hex / 64 hex) and match `services/api/.env`.

### Data model and sync (infra/db/migrations/001_init.sql, PLAN.md §3–5)

- Content-addressed `blobs`: one row per distinct SHA-256, ever. Re-sharing an already-saved file
  costs zero bytes — `POST /v1/blobs/presign` returns `{exists: true}` and the client skips upload.
- A single Postgres sequence (`drawer_rev_seq`) is the sync cursor, bumped by trigger
  (`drawer_bump_rev`) on every `items`/`categories` write. **Never wall-clock time** — two rows
  written in the same millisecond would straddle a time-based cursor and one would be silently
  dropped forever; a sequence can't do that. `GET /v1/sync?since=<rev>` is the delta-pull endpoint.
- `item_categories` (the item↔category many-to-many) is not synced as its own table — an item's
  category set travels inside the item and bumps the item's `rev`.
- Deletes are soft (`deleted_at`) so they propagate through sync; a nightly job is planned to
  hard-delete rows >30 days soft-deleted and GC blobs with no remaining referents (must be
  reference-counted, not age-based — dedupe means one blob can back many items).
- `items.search` is a generated `tsvector` column (weighted: title/link_title > note >
  description/body > extracted_text) backing `GET /v1/search`.

### Known traps worth re-reading before touching related code (PLAN.md §8)

- Presigned URLs must be signed for the externally-reachable hostname, not the Docker-internal
  one — same failure mode as `S3_PUBLIC_ENDPOINT` above.
- The presigner must keep `requestChecksumCalculation: 'WHEN_REQUIRED'`. AWS SDK v3's default
  flexible checksums bake an empty-body CRC32 into presigned PUT URLs; Garage rejects every real
  upload against them with `InvalidDigest` (MinIO silently ignored it).
- `android:launchMode="singleTask"` means warm launches arrive via `onNewIntent`, not a fresh
  activity — test cold launch, warm launch, and share-while-foregrounded as separate cases.
- The shared `content://` URI grant is transient — copy bytes inside the handler, never stash the
  URI for later.
- Never load a shared video fully into memory; stream the hash/sniff pass and stream the upload.
- Thumbnailing HEIC/HEIF (default iPhone photo format) needs `sharp` built with libheif — verify
  in the actual Docker image, not just locally.
- Strip EXIF GPS from derived thumbnails.
- A planned `link.unfurl` worker job fetches arbitrary user-supplied URLs from inside your network
  — it must have an SSRF guard (resolve DNS first, reject private/loopback/link-local ranges, cap
  redirects and response size) before it's implemented.
