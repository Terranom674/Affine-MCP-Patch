# AFFiNE MCP Patch

Dieses Repository baut ein eigenes AFFiNE-Docker-Image auf Basis des offiziellen Stable-Images und schaltet gezielt die bereits vorhandenen MCP-Schreibfunktionen fuer Self-Hosted-Installationen frei, ohne `AFFINE_ENV=dev` zu setzen.

## Harte Regel

Am AFFiNE-Core wird **nichts** geaendert ausser genau der vorhandenen MCP-Write-Bedingung.

Sinngemaess wird nur:

```ts
accessMode === McpAccessMode.READ_WRITE &&
(env.dev || env.namespaces.canary)
```

zu:

```ts
accessMode === McpAccessMode.READ_WRITE &&
(
  env.dev ||
  env.namespaces.canary ||
  process.env.AFFINE_MCP_WRITE_ENABLED === 'true'
)
```

Alle bestehenden AFFiNE-Berechtigungspruefungen, Authentifizierung, DocWriter-Logik, GraphQL, Datenbanklogik, Migrationen und MCP-Tools bleiben unveraendert.

## Keine Versionsbindung

Der Patch ist absichtlich nicht an eine konkrete AFFiNE-Version oder einen Bundle-Hash gebunden.

Bei jedem Build wird die tatsaechliche Struktur des verwendeten offiziellen AFFiNE-Images geprueft:

1. `main.js.map` muss genau einen `plugins/copilot/mcp/provider.ts` enthalten.
2. Der Provider muss weiterhin den bekannten `READ_WRITE`-Gate und die vorhandenen Schreibwerkzeuge enthalten.
3. Im kompilierten Bundle muss dieser Gate genau einmal eindeutig gefunden werden.
4. Nur diese eine Bedingung wird um `AFFINE_MCP_WRITE_ENABLED` erweitert.
5. Danach wird bytegenau geprueft, dass der gesamte restliche Bundle-Inhalt unveraendert geblieben ist.
6. Wenn die Struktur nicht mehr eindeutig passt, bricht der Build ab.

## Sicherheitsprinzip

Der Patch arbeitet **fail closed**:

- offizielles `ghcr.io/toeverything/affine:stable` bleibt die Basis
- keine feste AFFiNE-Version
- keine Hash-Liste
- keine Aenderungen an Auth, Permissions, DocWriter, GraphQL, Datenbank oder Migrationen
- keine neuen MCP-Funktionen
- keine automatische GitHub Action
- kein automatisches Deployment
- bei unklarer Upstream-Struktur: Build-Abbruch

## Dateien

- `Dockerfile` - baut das angepasste Image aus dem aktuellen Upstream-Image
- `patch-mcp.js` - erkennt und aendert ausschliesslich den MCP-Write-Gate
- `compose.example.yml` - Beispiel fuer die Einbindung in Docker Compose

## Aktivierung

AFFiNE bleibt im Production-Namespace. Die Schreibfreigabe erfolgt separat:

```yaml
environment:
  AFFINE_ENV: production
  AFFINE_MCP_WRITE_ENABLED: "true"
```

Ohne `AFFINE_MCP_WRITE_ENABLED=true` verhaelt sich der gepatchte Gate wie der originale Production-Gate.

## Build

```bash
docker build --pull -t affine-mcp-patched .
```

Bei einem AFFiNE-Update wird derselbe Build erneut ausgefuehrt. Solange die relevante MCP-Struktur kompatibel bleibt, wird das neue Image gepatcht. Aendert AFFiNE diese Struktur, stoppt der Build und muss zuerst geprueft werden.
