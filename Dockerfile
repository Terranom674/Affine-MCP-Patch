ARG AFFINE_BASE=ghcr.io/toeverything/affine:stable
FROM ${AFFINE_BASE}

USER root

COPY patch-mcp.js /opt/affine-mcp-patch/patch-mcp.js

RUN node /opt/affine-mcp-patch/patch-mcp.js \
 && node --check ./dist/main.js

LABEL org.opencontainers.image.title="AFFiNE MCP Patch"
LABEL org.opencontainers.image.description="AFFiNE stable with self-hosted MCP write enablement and native document lifecycle tools"
