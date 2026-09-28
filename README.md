# Drawer

A personal capture archive. Share anything from your phone — a meme, a link, a PDF, a
screenshot, a stray thought — and it lands in a gallery you own, filed under categories you
define.

See **[PLAN.md](./PLAN.md)** for the architecture and the phase-by-phase roadmap.

Status: **Phase 0 complete** (scaffold + de-risk) apart from the on-device build, which needs
your Expo account. Phase 1 is the backend.

## Quickstart

```bash
cp infra/.env.example infra/.env            # then set S3_PUBLIC_ENDPOINT — see below
cp services/api/.env.example services/api/.env
make install
make up                                      # postgres + garage (S3), then applies migrations
make api                                     # http://localhost:8080/health
make check                                   # the Phase 0 gate: 11 real round-trips
```

> **Set `S3_PUBLIC_ENDPOINT` to your machine's LAN IP** (`make lan-ip`), not `localhost`.
> Presigned upload URLs are signed against that origin, and a phone's `localhost` is the
> phone. This is the single most common self-hosted S3 mistake; `make check` fails loudly
> on it.

### The app

```bash
cd apps/mobile
npx expo prebuild                            # generates android/ and ios/ from app.json
npx eas build --profile development -p android
# install the APK, then:
make mobile                                  # Metro for the dev build
```

Expo Go cannot run this — share targets need native manifest entries, so a development build
is required from the start.

## Deploying (Tailscale-only)

The production stack never binds a host port: a tailscale sidecar joins your tailnet as
`drawer`, and Caddy, running in its network namespace, serves the API on
`https://drawer.<tailnet>.ts.net` and storage on `:8443`, using certificates fetched from
tailscaled.

1. In the Tailscale admin console, enable **MagicDNS** and **HTTPS Certificates**, and
   create an auth key.
2. In `infra/.env`, set `DRAWER_HOST=drawer.<tailnet>.ts.net` and `TS_AUTHKEY=…`. Use a
   URL-safe `POSTGRES_PASSWORD`, because it gets embedded in a connection URL.
3. `make up PROD=1`, then `make enroll-code PROD=1`. `PROD=1` works on every operator
   target.

`TS_AUTHKEY` is only read on the first boot. After that, the node identity lives in the
`ts-state` volume.

## Layout

```
apps/mobile/      Expo app (SDK 57). src/capture.ts is the capture pipeline.
services/api/     Fastify. Issues presigned URLs; never touches file bytes.
services/worker/  pg-boss jobs: thumbnails, link unfurling, PDF page 1  (Phase 4)
packages/shared/  zod contracts, uuidv7, MIME sniffing — shared by app and API
infra/            docker-compose, Caddyfile, SQL migrations
scripts/          phase0-check.sh — the gate behind `make check`
```

## Commands

Run `make help` for the full list. The ones you'll use:

| | |
|---|---|
| `make up` / `make down` | start / stop Postgres + Garage |
| `make reset` | destroy local data and re-apply migrations (asks first) |
| `make db` | psql shell |
| `make migrate` | apply pending migrations |
| `make enroll-code` | mint a one-shot code to enroll a phone (`TTL=` minutes) |
| `make devices` / `make revoke ID=…` | list / revoke enrolled devices |
| `make check` | verify the whole local stack end to end |
| `make test` | unit tests, no database needed |
| `make test-integration` | API integration tests against the running stack |
| `make typecheck` | typecheck every workspace |
| `make lan-ip` | print the IP for `S3_PUBLIC_ENDPOINT` |

## Notes for anyone reading the code

- **stdout is not a log.** Nothing here proxies MCP, but the API's logger is pino on stderr
  and `make check` parses command output — keep stray `console.log` out of scripts.
- **Ports are off the defaults** (Postgres 5433, Garage S3 9010) because 5432 and 9000
  collide with almost everything. Nothing hardcodes a port.
- **The guard rails are in the database, not the client.** Read-only-ness, uniqueness and the
  revision counter are enforced by constraints and triggers in `infra/db/migrations/`
  so a buggy client cannot corrupt the archive.
