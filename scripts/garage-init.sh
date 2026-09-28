#!/usr/bin/env bash
# Idempotent Garage bootstrap, run by `make up` once the garage container is healthy:
#   1. assign this single node a storage role (a fresh node has none and refuses I/O)
#   2. import the access key from infra/.env — imported, not generated, so the
#      credentials are stable across `make reset` and services/api/.env never drifts
#   3. create the bucket and grant the key read/write/owner on it
# Every step checks before acting, so re-running is a no-op.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose --env-file infra/.env -f infra/docker-compose.yml)
set -a; . ./infra/.env; set +a

: "${S3_ACCESS_KEY:?set S3_ACCESS_KEY in infra/.env}"
: "${S3_SECRET_KEY:?set S3_SECRET_KEY in infra/.env}"
BUCKET="${S3_BUCKET:-drawer}"

garage() { "${COMPOSE[@]}" exec -T -e RUST_LOG=warn garage /garage "$@"; }

if garage status | grep -q 'NO ROLE ASSIGNED'; then
  node=$(garage node id -q | cut -d@ -f1)
  # Capacity is a placement weight across nodes, not a quota — with one node any
  # value works. Size it to the disk anyway so it reads honestly in `garage status`.
  garage layout assign -z local -c 10G "$node" >/dev/null
  garage layout apply --version 1 >/dev/null
  echo "garage: layout applied"
fi

if ! garage key info "$S3_ACCESS_KEY" >/dev/null 2>&1; then
  garage key import --yes -n drawer "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
  echo "garage: key imported"
fi

if ! garage bucket info "$BUCKET" >/dev/null 2>&1; then
  garage bucket create "$BUCKET" >/dev/null
  echo "garage: bucket created"
fi
garage bucket allow --read --write --owner "$BUCKET" --key "$S3_ACCESS_KEY" >/dev/null

echo "garage ready: bucket '$BUCKET'"
