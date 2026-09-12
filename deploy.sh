#!/bin/sh
set -eu

AFFINE_DIR=/root/affine
PATCH_DIR=/root/Affine-MCP-Patch
CONFIG_FILE="$AFFINE_DIR/config/config.json"
COMPOSE_FILE="$AFFINE_DIR/docker-compose.yml"
POSTGRES_IMAGE="pgvector/pgvector:pg16-trixie"

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

# MCP doc_search uses AFFiNE's IndexerService. The indexer is disabled by
# default, even though self-hosted installations have an embedded search
# provider available. Enable that embedded provider explicitly so document
# search is usable without an external Elasticsearch/Manticore service.
if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$(dirname "$CONFIG_FILE")"
  printf '%s\n' '{"copilot":{"enabled":true},"indexer":{"enabled":true,"provider":{"type":"embedded"}}}' > "$CONFIG_FILE"
else
  docker run --rm -v "$AFFINE_DIR/config:/config" --entrypoint node ghcr.io/toeverything/affine:stable -e '
    const fs=require("fs");
    const p="/config/config.json";
    let c={};
    try { c=JSON.parse(fs.readFileSync(p,"utf8")); } catch (e) { console.error("Invalid config.json:", e.message); process.exit(1); }
    c.copilot = {...(c.copilot||{}), enabled:true};
    c.indexer = {...(c.indexer||{}), enabled:true, provider:{...(c.indexer?.provider||{}), type:"embedded"}};
    fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
  '
fi

echo "--- AFFiNE runtime config ---"
cat "$CONFIG_FILE"

cp -f "$PATCH_DIR/docker-compose.override.yml" "$AFFINE_DIR/docker-compose.override.yml"

echo "--- Build and start patched AFFiNE stack ---"
docker compose up -d --build --force-recreate
sleep 10

echo "--- AFFiNE status ---"
docker compose ps

echo "--- Final PostgreSQL check ---"
docker exec affine_postgres sh -lc "cat /etc/os-release | grep '^PRETTY_NAME='; ldd --version | head -n1"
docker exec affine_postgres psql -U "$DB_USER" -d "$DB" -At -F '|' -c "SELECT datname,datcollversion,pg_database_collation_actual_version(oid) FROM pg_database WHERE datname=current_database();"

echo "--- MCP response ---"
curl -i -sS -X POST "http://127.0.0.1:3010/api/workspaces/test/mcp/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"patch-test","version":"1.0"}}}'
