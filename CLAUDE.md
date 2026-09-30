# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Drawer — a personal, self-hosted capture archive. You share anything from your phone (image,
video, PDF, link, plain text) via the OS share sheet; it lands in a gallery you own. A handful of
invited accounts share one self-hosted box, signing in with Google (PLAN.md §5); accounts never
share rows.

See **PLAN.md** for the full architecture and phase-by-phase roadmap — it's the source of truth
for design decisions and known traps, not just a proposal.

Status: **Phase 0 complete** (scaffold + de-risk) apart from the on-device build, which needs an
Expo account. **Phase 1 (backend core) in progress:** migrations, enrollment/auth, blobs, items,
categories, sync and search are done and integration-tested; the production stack (Caddy +
Tailscale TLS, `infra/docker-compose.prod.yml`) is written but not yet run against a real tailnet. `services/worker/` in the target
architecture does not exist yet. **Phase 2 (mobile local-first core) is built** — SQLite, gallery,
categories, detail views — and bundles, but has not had an on-device pass yet. **Phase 3:** accounts
are done server-side (invites, Google sign-in, per-owner isolation) and the app has an account screen
(`app/account.tsx`, Google via `react-native-nitro-google-signin`, which needs a dev-client rebuild);
sync itself isn't built yet. `EXPO_PUBLIC_DRAWER_URL` pre-fills the drawer address on that screen.

**Deployment is Tailscale-only (decided 2026-09-28):** no public ports; the phone reaches the box over
the tailnet via its MagicDNS name. Don't design for public-internet exposure (see PLAN.md §10).

## Commands

```bash
cp infra/.env.example infra/.env            # then set S3_PUBLIC_ENDPOINT — see below
cp services/api/.env.example services/api/.env
make install                                 # npm install across the workspace
make up                                      # postgres + garage (S3); bucket/key setup + pending migrations
make api                                     # run the API with reload — http://localhost:8080/health
make check                                   # Phase 0 gate: 11 real round-trip checks, see below
make typecheck                               # tsc --noEmit across every workspace
make test                                    # unit tests, no database needed
make test-integration                        # API against the running stack (make up first)
make db                                      # psql shell
make migrate                                 # apply pending migrations (make up does this too)
make invite EMAIL=<email> [CLAIM=1]          # let an email sign in with Google (CLAIM=1: give it the pre-multi-user account)
make users / make disable EMAIL= / make enable EMAIL=   # list accounts / lock one out, reversibly
make enroll-code [EMAIL=…] [TTL=15]          # one-shot code to enroll a phone without Google
make devices [EMAIL=…] / make revoke ID=<uuid>   # list / revoke enrolled devices
make down / make reset                       # stop services / DESTROY local data + re-apply migrations (asks first)
make lan-ip                                  # print the LAN IP to put in S3_PUBLIC_ENDPOINT
make up PROD=1                               # production: + API image, Caddy, tailscale sidecar; no host ports
make enroll-code PROD=1                      # PROD=1 on any operator target runs it inside the api container
```

**Node 24 is required** (`.nvmrc`; use `nvm use`). The API and tests run `.ts` files directly via
Node's built-in type stripping — Ubuntu's `nodejs` package is built without it and fails with
`ERR_UNKNOWN_FILE_EXTENSION` / `ERR_NO_TYPESCRIPT`, even on 22.x. Type stripping only erases types, so
no enums, namespaces or constructor parameter properties — `erasableSyntaxOnly` in
`tsconfig.base.json` makes `make typecheck` reject them.

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

**Run Expo commands from `apps/mobile/` (or via `make`), never from the repo root.** At the root,
Expo treats the whole monorepo as the app: it adds `expo`/`react`/`react-native` to the root
`package.json`, writes a root `app.json` with a placeholder `com.anonymous.*` package, generates root
`android/`+`ios/`, and reinstalls packages out of sync with the lockfile. `make android` pins JDK 17
and `ANDROID_HOME` (RN's Gradle breaks on newer JDKs; Gradle won't find the SDK unaided). Metro uses
Expo's default monorepo-aware config — don't re-add `disableHierarchicalLookup`, it hides packages
npm nests and the app crashes on launch with "Unable to resolve module".

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
  Local data lives in `src/db/` (SQLite schema, migrations, typed repository). Everything there
  talks to a tiny `SqlDb` interface (`src/db/sql.ts`); only `src/db/expo.ts` imports `expo-sqlite`,
  and `src/db/testing.ts` backs it with `node:sqlite` so `npm test` covers the repository with no
  device. Keep Expo imports out of `src/db/` and use relative `.ts` imports there (Node can't
  resolve the `@/` alias). UI writes go through `useWrite()` (`src/data/store.tsx`), which bumps a
  change counter that every live query hook re-reads on — a write that bypasses it leaves stale
  screens.
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
  see `infra/.env.example`); `docker-compose.prod.yml`, an overlay that `!reset`s those ports and adds
  the API (`services/api/Dockerfile`, build context = repo root), a `tailscale` sidecar (node name
  `drawer`) and Caddy running in the sidecar's network namespace, which gets `*.ts.net` certs from
  tailscaled over the shared socket. In prod `S3_PUBLIC_ENDPOINT` is derived as
  `https://$DRAWER_HOST:8443`, never configured separately. `Caddyfile`, and `db/migrations/NNN_*.sql`, applied in order by
  `node-pg-migrate` (`make migrate`, tracked in `pgmigrations`). **Never edit an applied migration —
  add the next numbered file.** Migrations are deliberately *not* mounted into the Postgres image's
  initdb hook: both would run and replay everything after 001.
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
- `rev` order must equal commit order or the cursor skips rows: `003_rev_commit_order.sql` makes the
  trigger take an advisory lock (`DRAWER_REV_LOCK`) before drawing a rev, and API writes use
  `withWriteTx` (`services/api/src/db.ts`), which takes it *first* so it can't deadlock with row
  locks. `test/integration/sync.test.ts` proves it.
- Deletes are soft (`deleted_at`) so they propagate through sync; a nightly job is planned to
  hard-delete rows >30 days soft-deleted and GC blobs with no remaining referents (must be
  reference-counted, not age-based — dedupe means one blob can back many items).
- Accounts (`005_multi_user.sql`, PLAN.md §5): invite-only, Google sign-in binds an invited email to
  `users.google_sub`. **Category ids are unique per owner, not globally** — every account has the
  same `INBOX_CATEGORY_ID` — so any query that selects categories by id must also filter on
  `owner_id`. Blobs are per owner too (no cross-account dedupe; knowing a hash must never grant
  bytes). Composite `(id, owner_id)` foreign keys make cross-account references impossible;
  `test/integration/isolation.test.ts` proves it. Tests sign their own Google ID tokens against a
  local JWKS (`harness.ts` `googleToken`), so nothing needs a real Google project.
- Share-as-QR (PLAN.md §5): `POST /v1/items/:id/share` mints a 30 s single-use token and
  `GET /s/:token` (`services/api/src/routes/share.ts`, the one unauthenticated route besides sign-in)
  redeems it with a 302 to a presigned GET. Share links are built on `SHARE_BASE_URL`, which in
  prod is derived from `DRAWER_HOST` like `S3_PUBLIC_ENDPOINT`. Keep `/s/*` written as if it faced the
  public internet: every failure is the same 410, and `exposeHeadRoute: false` stops a link
  checker's HEAD from burning the token.
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
- `expo-sharing` (used only to share *out*) ships a "share into" feature that, when its config
  plugin enables it (`android.enabled`), rewrites incoming `SEND` intents to `VIEW` on cold start —
  which would break `expo-share-intent` capture. It's deliberately not in `app.json` plugins; keep it out.
- The shared `content://` URI grant is transient — copy bytes inside the handler, never stash the
  URI for later.
- Never load a shared video fully into memory; stream the hash/sniff pass and stream the upload.
- Thumbnailing HEIC/HEIF (default iPhone photo format) needs `sharp` built with libheif — verify
  in the actual Docker image, not just locally.
- Strip EXIF GPS from derived thumbnails.
- A planned `link.unfurl` worker job fetches arbitrary user-supplied URLs from inside your network
  — it must have an SSRF guard (resolve DNS first, reject private/loopback/link-local ranges, cap
  redirects and response size) before it's implemented.
