ARG AFFINE_BASE=ghcr.io/toeverything/affine:stable
FROM ${AFFINE_BASE}

USER root

COPY patch-mcp.js /opt/affine-mcp-patch/patch-mcp.js

RUN npm install --prefix /opt/affine-mcp-patch --omit=dev --no-package-lock yjs@13.6.21 \
 && node --check /opt/affine-mcp-patch/patch-mcp.js \
 && node /opt/affine-mcp-patch/patch-mcp.js \
 && node --check ./dist/main.js

LABEL org.opencontainers.image.title="AFFiNE MCP Patch"
LABEL org.opencontainers.image.description="AFFiNE stable with MCP write enablement and fail-closed stable removeDoc adapter"
