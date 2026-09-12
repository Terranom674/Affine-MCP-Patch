#!/bin/sh
set -eu

AFFINE_DIR=/root/affine
PATCH_DIR=/root/Affine-MCP-Patch
CONFIG_FILE="$AFFINE_DIR/config/config.json"

if [ ! -d "$AFFINE_DIR" ]; then
  echo "AFFiNE directory not found: $AFFINE_DIR" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  printf '%s\n' '{"copilot":{"enabled":true}}' > "$CONFIG_FILE"
else
  docker exec affine_server node -e '
    const fs=require("fs");
    const p="/root/.affine/config/config.json";
    let c={};
    try { c=JSON.parse(fs.readFileSync(p,"utf8")); } catch (e) { console.error("Invalid config.json:", e.message); process.exit(1); }
    c.copilot = {...(c.copilot||{}), enabled:true};
    fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
  '
fi

cp -f "$PATCH_DIR/docker-compose.override.yml" "$AFFINE_DIR/docker-compose.override.yml"

cd "$AFFINE_DIR"
docker compose up -d --build --force-recreate
sleep 10

echo "--- AFFiNE status ---"
docker compose ps

echo "--- MCP response ---"
curl -i -sS -X POST "http://127.0.0.1:3010/api/workspaces/test/mcp/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"patch-test","version":"1.0"}}}'
