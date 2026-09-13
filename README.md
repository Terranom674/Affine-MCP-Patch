# AFFiNE MCP Patch

Dieses Repository baut ein eigenes AFFiNE-Docker-Image auf Basis des offiziellen Stable-Images. Der Patch schaltet den vorhandenen READ_WRITE-MCP fuer Self-Hosted-Installationen frei und ergaenzt genau ein fehlendes Werkzeug: `delete_document`.

## Umfang

Der bestehende WRITE-Gate wird nur um `AFFINE_MCP_WRITE_ENABLED=true` erweitert. Die nativen Werkzeuge `read_document`, `doc_search`, `create_document`, `update_document` und `update_document_meta` bleiben unveraendert.

Zusaetzlich wird `delete_document` in denselben bereits authentifizierten READ_WRITE-MCP-Kontext aufgenommen. Der Aufruf verwendet die vorhandenen `userId`- und `workspaceId`-Werte und prueft vor jeder Aenderung ueber AFFiNE selbst `Doc.Delete`.

Beim Delete wird der Dokumenteintrag aus `meta.pages` des Workspace-Root-Dokuments entfernt und danach AFFiNEs vorhandenes `DocModel.delete(workspaceId, docId)` fuer Snapshots, Updates und Historien verwendet.

## Fail closed

Der Patch fuehrt vor jeder Aenderung harte Strukturpruefungen gegen Source Map und kompiliertes Bundle aus. Erwartet werden unter anderem:

- genau ein Workspace-MCP-Provider und Resolver
- die bekannten drei READ_WRITE-Gates
- die unveraenderte `DocWriter`-/Workspace-Adapter-Struktur
- die vorhandene `DocModel.delete()`-Implementierung
- die vorhandene Permission-Builder-Struktur fuer `Doc.Delete`
- genau ein passender Write-Tool-Push im MCP-Provider

Passt eine dieser Annahmen nicht exakt, bricht der Build ab. `main.js` wird erst nach allen Pruefungen geschrieben. Alle vorgenommenen Bundle-Aenderungen werden vor dem Schreiben vorwaerts und rueckwaerts rekonstruiert und muessen exakt aufgehen.

## Yjs

Fuer die gezielte Aenderung des Root-Dokuments installiert das Patch-Image `yjs@13.6.21` fest unter `/opt/affine-mcp-patch/node_modules/yjs`. Dadurch ist die verwendete Laufzeit nicht von zufaellig vorhandenen Node-Modulen des AFFiNE-Images abhaengig.

## Sicherheit

- offizielles `ghcr.io/toeverything/affine:stable` bleibt die Basis
- bestehender `aff_mcp_v1...`-Credential bleibt der einzige Authentifizierungspfad
- keine zusaetzlichen Logins, JWTs, Cookies oder Socket.IO-Pfade
- Permission-Pruefung bleibt bei AFFiNE
- kein Trash-/Restore-Patch
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

Aendert ein AFFiNE-Update die gepruefte Struktur, stoppt der Build und der Patch muss zuerst an den neuen Stable-Core angepasst werden.
