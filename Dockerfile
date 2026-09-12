ARG AFFINE_BASE=ghcr.io/toeverything/affine:stable
FROM ${AFFINE_BASE}

USER root

COPY patch-mcp.js /opt/affine-mcp-patch/patch-mcp.js
COPY versions.json /opt/affine-mcp-patch/versions.json

RUN node /opt/affine-mcp-patch/patch-mcp.js

LABEL org.opencontainers.image.title="AFFiNE MCP Patch"
LABEL org.opencontainers.image.description="AFFiNE stable with narrowly-scoped MCP write enablement"
