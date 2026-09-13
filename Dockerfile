ARG AFFINE_BASE=ghcr.io/toeverything/affine:stable
FROM ${AFFINE_BASE}

USER root

COPY patch-mcp.js /opt/affine-mcp-patch/patch-mcp.js

RUN sh -c 'node /opt/affine-mcp-patch/patch-mcp.js > /tmp/affine-mcp-patch.log 2>&1 || { echo "--- AFFiNE MCP PATCH FAILED ---"; tail -n 80 /tmp/affine-mcp-patch.log; exit 1; }; cat /tmp/affine-mcp-patch.log; node --check ./dist/main.js'

LABEL org.opencontainers.image.title="AFFiNE MCP Patch"
LABEL org.opencontainers.image.description="AFFiNE stable with self-hosted MCP write enablement and native document lifecycle tools"
