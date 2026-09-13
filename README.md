# AFFiNE MCP Patch

Dieses Repository baut ein eigenes AFFiNE-Docker-Image auf Basis des offiziellen Stable-Images. Der Patch schaltet den vorhandenen READ_WRITE-MCP fuer Self-Hosted-Installationen frei und ergaenzt `delete_document` ausschliesslich als Adapter auf AFFiNEs eigene Lifecycle-Loeschlogik.

## Umfang

Der bestehende WRITE-Gate wird nur um `AFFINE_MCP_WRITE_ENABLED=true` erweitert. Die nativen Werkzeuge `read_document`, `doc_search`, `create_document`, `update_document` und `update_document_meta` bleiben unveraendert.

`delete_document` verwendet denselben authentifizierten MCP-Kontext. Vor dem Aufruf wird ueber AFFiNE `Doc.Delete` geprueft. Anschliessend delegiert der MCP-Adapter die eigentliche Loeschung an AFFiNEs vorhandenen Backend-Runtime-Befehl:

```text
BackendRuntimeProvider.executeDomainCommandV1
  -> command: apply_doc_lifecycle
  -> lifecycle: delete
```

Der Patch implementiert selbst keine Root-YDoc-, Snapshot-, History-, Grant- oder Datenbank-Loeschlogik.

## Fail closed

Der Patch akzeptiert nur einen AFFiNE-Core, in dem der offizielle Lifecycle-Pfad eindeutig vorhanden ist. Vor dem Schreiben von `dist/main.js` werden unter anderem geprueft:

- genau ein Workspace-MCP-Provider und Resolver
- die bekannten READ_WRITE-Gates
- `BackendRuntimeProvider` im Sync-Gateway
- genau ein `executeDomainCommandV1()`-Aufruf fuer `apply_doc_lifecycle`
- der authentifizierte `userId`-/`workspaceId`-Kontext des MCP-Providers
- genau ein passender Push der drei nativen Write-Tools
- `Doc.Delete` vor dem Lifecycle-Aufruf

Fehlt eine dieser Strukturen oder ist sie nicht eindeutig, bricht der Build ab. Es gibt keinen eigenen Delete-Fallback.

## Sicherheit

- offizielles `ghcr.io/toeverything/affine:stable` bleibt die Basis
- bestehender `aff_mcp_v1...`-Credential bleibt der einzige Authentifizierungspfad
- keine zusaetzlichen Logins, JWTs, Cookies oder Socket.IO-Pfade
- Permission-Pruefung bleibt bei AFFiNE
- die eigentliche Loeschung bleibt bei AFFiNE
- keine direkte Datenbankverbindung des Connectors
- keine GitHub Actions
- kein automatisches Deployment

## Aktivierung

```yaml
environment:
  AFFINE_ENV: production
  AFFINE_MCP_WRITE_ENABLED: "true"
```

## Erwartete MCP-Werkzeuge

- `read_document`
- `doc_search`
- `create_document`
- `update_document`
- `update_document_meta`
- `delete_document`

## Build

```bash
docker build --pull -t affine-mcp-patched .
```

Wenn der verwendete Stable-Core `apply_doc_lifecycle` noch nicht enthaelt, stoppt der Build absichtlich. Der Patch ersetzt AFFiNEs Lifecycle-Implementierung nicht durch eigene Loeschlogik.
