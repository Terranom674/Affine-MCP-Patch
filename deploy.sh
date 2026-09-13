#!/bin/sh
set -eu

AFFINE_DIR=/root/affine
PATCH_DIR=/root/Affine-MCP-Patch
CONFIG_FILE="$AFFINE_DIR/config/config.json"
COMPOSE_FILE="$AFFINE_DIR/docker-compose.yml"
POSTGRES_IMAGE="pgvector/pgvector:pg16-trixie"
MANTICORE_IMAGE="manticoresearch/manticore:29.0.2"
MANTICORE_CONTAINER="affine_manticore"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [ ! -d "$AFFINE_DIR" ]; then
  fail "AFFiNE directory not found: $AFFINE_DIR"
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  fail "AFFiNE compose file not found: $COMPOSE_FILE"
fi

cd "$AFFINE_DIR"

# The running container is named affine_postgres, but the Compose service itself
# is not necessarily called affine_postgres. Resolve the real service name from
# Docker's Compose label instead of guessing it.
POSTGRES_SERVICE="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' affine_postgres 2>/dev/null || true)"
[ -n "$POSTGRES_SERVICE" ] || fail "could not resolve PostgreSQL Compose service from container affine_postgres"
echo "PostgreSQL Compose service: $POSTGRES_SERVICE"

cp -f "$COMPOSE_FILE" "$COMPOSE_FILE.bak-before-mcp-upgrade"

echo "--- Upgrade PostgreSQL/pgvector base ---"
docker pull "$POSTGRES_IMAGE"
python3 - "$COMPOSE_FILE" "$POSTGRES_IMAGE" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
image = sys.argv[2]
text = path.read_text()
updated, count = re.subn(r'(?m)^(\s*image:\s*)pgvector/pgvector:[^\s#]+(\s*(?:#.*)?)$', rf'\1{image}\2', text)
if count != 1:
    raise SystemExit(f"expected exactly one pgvector image entry, found {count}")
path.write_text(updated)
PY

grep -n "pgvector/pgvector" "$COMPOSE_FILE"

echo "--- Stop AFFiNE application services ---"
docker stop affine_server >/dev/null 2>&1 || true
docker stop affine_migration_job >/dev/null 2>&1 || true

echo "--- Recreate PostgreSQL on Debian 13 / Trixie ---"
docker compose up -d --force-recreate "$POSTGRES_SERVICE"

for i in $(seq 1 60); do
  if docker exec affine_postgres pg_isready >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec affine_postgres pg_isready >/dev/null 2>&1 || fail "PostgreSQL did not become ready"

GLIBC_VERSION="$(docker exec affine_postgres sh -lc "ldd --version | head -n1 | awk '{print \$NF}'")"
echo "glibc: $GLIBC_VERSION"
[ "$GLIBC_VERSION" = "2.41" ] || fail "expected glibc 2.41 after Trixie upgrade, got $GLIBC_VERSION"

DB="$(docker exec affine_postgres printenv POSTGRES_DB 2>/dev/null || true)"
DB_USER="$(docker exec affine_postgres printenv POSTGRES_USER 2>/dev/null || true)"
DB="${DB:-affine}"
DB_USER="${DB_USER:-postgres}"

echo "--- Rebuild collation-dependent indexes on 2.41 ---"
docker exec affine_postgres psql -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "REINDEX DATABASE \"$DB\";" \
  -c "ALTER DATABASE \"$DB\" REFRESH COLLATION VERSION;"

COLLATION_STATUS="$(docker exec affine_postgres psql -U "$DB_USER" -d "$DB" -At -F '|' -c "SELECT datcollversion,pg_database_collation_actual_version(oid) FROM pg_database WHERE datname=current_database();")"
echo "collation: $COLLATION_STATUS"
STORED="$(printf '%s' "$COLLATION_STATUS" | cut -d'|' -f1)"
ACTUAL="$(printf '%s' "$COLLATION_STATUS" | cut -d'|' -f2)"
[ -n "$STORED" ] && [ "$STORED" = "$ACTUAL" ] || fail "collation version mismatch remains: $COLLATION_STATUS"
[ "$ACTUAL" = "2.41" ] || fail "expected database collation 2.41, got $ACTUAL"

# AFFiNE 0.27.4 does not have an embedded search provider. Its supported
# self-hosted default is ManticoreSearch. Configure the exact provider type and
# the Docker-internal endpoint used by the service in our compose override.
mkdir -p "$(dirname "$CONFIG_FILE")"
python3 - "$CONFIG_FILE" <<'PY'
import json, os, sys
path = sys.argv[1]
config = {}
if os.path.exists(path):
    with open(path, encoding='utf-8') as f:
        config = json.load(f)
config['copilot'] = {**config.get('copilot', {}), 'enabled': True}
indexer = dict(config.get('indexer', {}))
provider = dict(indexer.get('provider', {}))
provider.update({
    'type': 'manticoresearch',
    'endpoint': 'http://manticore:9308',
})
indexer.update({'enabled': True, 'provider': provider})
config['indexer'] = indexer
with open(path, 'w', encoding='utf-8') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
PY

echo "--- AFFiNE runtime config ---"
cat "$CONFIG_FILE"

cp -f "$PATCH_DIR/docker-compose.override.yml" "$AFFINE_DIR/docker-compose.override.yml"

echo "--- Start ManticoreSearch ---"
docker pull "$MANTICORE_IMAGE"
docker compose up -d manticore
for i in $(seq 1 60); do
  STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$MANTICORE_CONTAINER" 2>/dev/null || true)"
  [ "$STATUS" = "healthy" ] && break
  [ "$STATUS" = "unhealthy" ] && { docker logs --tail 100 "$MANTICORE_CONTAINER" >&2 || true; fail "ManticoreSearch became unhealthy"; }
  sleep 2
done
STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$MANTICORE_CONTAINER" 2>/dev/null || true)"
[ "$STATUS" = "healthy" ] || fail "ManticoreSearch did not become healthy"
echo "ManticoreSearch: healthy"

START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "--- Build and start patched AFFiNE stack ---"
docker compose up -d --build --force-recreate
sleep 10

echo "--- AFFiNE status ---"
docker compose ps

echo "--- Final PostgreSQL check ---"
docker exec affine_postgres sh -lc "cat /etc/os-release | grep '^PRETTY_NAME='; ldd --version | head -n1"
docker exec affine_postgres psql -U "$DB_USER" -d "$DB" -At -F '|' -c "SELECT datname,datcollversion,pg_database_collation_actual_version(oid) FROM pg_database WHERE datname=current_database();"

echo "--- Wait for AFFiNE auto-index ---"
sleep 40
if docker logs --since "$START_TS" affine_server 2>&1 | grep -q 'search_provider_not_found'; then
  docker logs --since "$START_TS" affine_server 2>&1 | grep -E 'search_provider_not_found|indexer\.indexWorkspace|IndexerJob' | tail -n 100 >&2 || true
  fail "AFFiNE still reports search_provider_not_found"
fi

echo "--- ManticoreSearch tables ---"
TABLES="$(docker exec "$MANTICORE_CONTAINER" sh -lc "wget -qO- --post-data='SHOW TABLES' 'http://127.0.0.1:9308/sql?mode=raw'")"
printf '%s\n' "$TABLES"
printf '%s\n' "$TABLES" | grep -q 'block' || fail "ManticoreSearch block table was not created"
printf '%s\n' "$TABLES" | grep -q 'doc' || fail "ManticoreSearch doc table was not created"

echo "--- MCP auth protection check ---"
MCP_BODY="$(mktemp)"
trap 'rm -f "$MCP_BODY"' EXIT
MCP_STATUS="$(curl -sS -o "$MCP_BODY" -w '%{http_code}' -X POST "http://127.0.0.1:3010/api/workspaces/test/mcp/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"patch-test","version":"1.0"}}}')"
printf 'HTTP %s\n' "$MCP_STATUS"
cat "$MCP_BODY"
printf '\n'
[ "$MCP_STATUS" = "401" ] || fail "expected unauthenticated MCP request to be rejected with HTTP 401, got $MCP_STATUS"
grep -q 'Authentication failed' "$MCP_BODY" || fail "MCP endpoint returned 401 without the expected authentication failure payload"
echo "MCP endpoint reachable; unauthenticated access correctly rejected."
