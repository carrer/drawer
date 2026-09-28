#!/usr/bin/env bash
# Phase 0 gate. Verifies the local stack is genuinely wired up — every check is a
# real round-trip, so a pass means the thing actually works.
set -uo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose --env-file infra/.env -f infra/docker-compose.yml)
pass=0 fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -f infra/.env ] || { echo "infra/.env missing — cp infra/.env.example infra/.env"; exit 1; }
set -a; . ./infra/.env; set +a

head_ "Containers"
for svc in postgres garage; do
  state=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2}')
  [ "$state" = running ] && ok "$svc running" || bad "$svc not running (state: ${state:-absent})" "run: make up"
done

head_ "Postgres schema"
sql() { "${COMPOSE[@]}" exec -T postgres psql -qtAX -U "${POSTGRES_USER:-drawer}" -d "${POSTGRES_DB:-drawer}" -c "$1" 2>/dev/null; }
tables=$(sql "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('items','categories','blobs','devices','item_categories','users','enroll_codes');")
[ "${tables:-0}" = 7 ] && ok "all 7 tables present" || bad "expected 7 tables, found ${tables:-0}" "run: make reset"

cats=$(sql "SELECT count(*) FROM categories;")
[ "${cats:-0}" -ge 4 ] 2>/dev/null && ok "default categories seeded ($cats)" || bad "default categories missing"

# The generated tsvector is the fiddliest bit of the schema — prove it indexes.
sql "INSERT INTO items (id, owner_id, kind, body, captured_at) VALUES ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000001','text','phase zero smoke test', now()) ON CONFLICT (id) DO NOTHING;" >/dev/null
hit=$(sql "SELECT count(*) FROM items WHERE search @@ to_tsquery('simple','smoke') AND id='11111111-1111-1111-1111-111111111111';")
[ "${hit:-0}" = 1 ] && ok "full-text generated column works" || bad "tsvector column did not index the row"

# Prove the rev trigger advances on update — the sync cursor depends on it.
r1=$(sql "SELECT rev FROM items WHERE id='11111111-1111-1111-1111-111111111111';")
sql "UPDATE items SET title='touched' WHERE id='11111111-1111-1111-1111-111111111111';" >/dev/null
r2=$(sql "SELECT rev FROM items WHERE id='11111111-1111-1111-1111-111111111111';")
[ -n "$r1" ] && [ -n "$r2" ] && [ "$r2" -gt "$r1" ] 2>/dev/null \
  && ok "rev trigger advances on update ($r1 → $r2)" || bad "rev did not advance on update ($r1 → $r2)"
sql "DELETE FROM items WHERE id='11111111-1111-1111-1111-111111111111';" >/dev/null

head_ "S3 (Garage) object round-trip"
BUCKET="${S3_BUCKET:-drawer}"
S3="http://localhost:${S3_PORT:-9000}"
# Real SigV4-signed requests from the host through the published port — the same
# path the API's internal client takes. Region must match garage.toml s3_region.
s3() { curl -sS --max-time 10 --aws-sigv4 "aws:amz:us-east-1:s3" \
         --user "${S3_ACCESS_KEY:-}:${S3_SECRET_KEY:-}" "$@"; }
key=".phase0-check"

if [ "$(s3 -o /dev/null -w '%{http_code}' -I "$S3/$BUCKET" 2>/dev/null)" = 200 ]; then
  ok "bucket '$BUCKET' exists and the key can reach it"
  nonce="phase0-$RANDOM$RANDOM"
  s3 -o /dev/null -X PUT --data-binary "$nonce" "$S3/$BUCKET/$key" 2>/dev/null
  got=$(s3 "$S3/$BUCKET/$key" 2>/dev/null)
  if [ "$got" = "$nonce" ]; then
    ok "put → get round-trip (content verified)"
  else
    bad "round-trip content mismatch" "wrote '$nonce', read back '$got'"
  fi
  s3 -o /dev/null -X DELETE "$S3/$BUCKET/$key" 2>/dev/null
  if [ "$(s3 -o /dev/null -w '%{http_code}' -I "$S3/$BUCKET/$key" 2>/dev/null)" = 404 ]; then
    ok "delete works (object gone)"
  else
    bad "delete failed — object still present"
  fi
else
  bad "bucket '$BUCKET' unreachable with S3_ACCESS_KEY" "run: make up"
fi

head_ "Presign origin (the #1 self-hosted S3 trap)"
pub="${S3_PUBLIC_ENDPOINT:-}"
if [ -z "$pub" ]; then
  bad "S3_PUBLIC_ENDPOINT unset" "presigned URLs would be signed for the wrong origin"
elif [[ "$pub" =~ localhost|127\.0\.0\.1 ]]; then
  bad "S3_PUBLIC_ENDPOINT is $pub" "a phone's localhost is the phone — use \`make lan-ip\`"
else
  # DHCP hands out a new LAN IP now and then; a stale one looks fine until the
  # phone times out. Only IP literals are compared — a production hostname isn't.
  lan=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
  host=$(sed -E 's#^[a-z]+://([^:/]+).*#\1#' <<<"$pub")
  if [[ "$host" =~ ^[0-9.]+$ ]] && [ -n "$lan" ] && [ "$host" != "$lan" ]; then
    bad "S3_PUBLIC_ENDPOINT host $host is not this machine's LAN IP ($lan)" \
        "update it in infra/.env AND services/api/.env — see \`make lan-ip\`"
  else
    # Any HTTP status means something answered; 000 means nothing did.
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$pub" 2>/dev/null)
    [ "${code:-000}" != 000 ] && ok "S3_PUBLIC_ENDPOINT answers ($pub)" \
      || bad "S3_PUBLIC_ENDPOINT unreachable ($pub)" "is garage up, and is that address right?"
  fi
fi

# The API keeps its own copy of these; drift means SignatureDoesNotMatch or 403
# from the API even though everything above passed. Values are never printed.
if [ -f services/api/.env ]; then
  for var in S3_PUBLIC_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY; do
    api_val=$(sed -n "s/^$var=//p" services/api/.env | tail -1)
    [ "$api_val" = "${!var:-}" ] \
      || bad "services/api/.env $var differs from infra/.env" "copy it across so the API signs with what garage knows"
  done
fi

head_ "API"
if curl -fsS --max-time 5 "http://localhost:${PORT:-8080}/health" >/dev/null 2>&1; then
  ok "GET /health returned 200"
else
  printf '  \033[33m-\033[0m API not responding on :%s (start it with \`make api\`)\n' "${PORT:-8080}"
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
