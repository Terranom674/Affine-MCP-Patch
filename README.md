# AFFiNE MCP Patch

Dieses Repository baut ein eigenes AFFiNE-Docker-Image auf Basis des offiziellen Stable-Images. Der Patch schaltet den vorhandenen READ_WRITE-MCP fuer Self-Hosted-Installationen frei und ergaenzt `delete_document` so, dass es die gleiche permanente Loeschsemantik wie AFFiNE Stable selbst verwendet.

## Was AFFiNE Stable beim permanenten Loeschen macht

In der untersuchten Stable-Version wird eine Seite im Frontend ueber `workspace.docCollection.removeDoc(pageId)` geloescht.

Dieser AFFiNE-Pfad entfernt:

- den Dokumenteintrag aus `meta.pages` des Workspace-Root-Dokuments
- den Legacy-Subdoc-Verweis aus `spaces`

Der vorhandene Server-Endpunkt `space:delete-doc` prueft zwar `Doc.Delete`, aber `PgWorkspaceDocStorageAdapter.deleteDoc()` ist in dieser Stable-Version fuer Workspace-Dokumente leer. Deshalb fuehrt Stable beim permanenten Loeschen selbst keine zusaetzliche Snapshot-/History-/Datenbankbereinigung aus.

Der MCP-Patch bildet deshalb genau die Stable-`removeDoc()`-Semantik auf dem Server ab und erfindet keine weitergehende Loeschlogik.

## MCP-Verhalten

Die nativen Werkzeuge bleiben unveraendert:

- `read_document`
- `doc_search`
- `create_document`
- `update_document`
- `update_document_meta`

Zusaetzlich wird `delete_document` in denselben authentifizierten READ_WRITE-MCP-Kontext aufgenommen.

Vor jeder Loeschung wird ueber AFFiNE selbst `Doc.Delete` geprueft. Erst danach wird das Workspace-Root-Dokument geladen, die gleiche Root-Dokument-Aenderung wie bei AFFiNEs `removeDoc()` erzeugt und ueber AFFiNEs vorhandenen `DocWriter`-/Storage-Pfad gespeichert und broadcastet.

Es gibt keine direkte Datenbankverbindung und keine zusaetzliche Snapshot-, History-, Grant- oder Tabellenloeschung.

## Fail closed

Der Patch prueft vor jeder Aenderung die erwartete Stable-Struktur. Unter anderem muessen vorhanden sein:

- genau ein Workspace-MCP-Provider und Resolver
- die bekannten READ_WRITE-Gates
- `DocWriter` mit Root-Dokument-Lese-/Schreibpfad
- der bestehende `space:delete-doc`-Pfad mit `Doc.Delete`
- der in Stable absichtlich leere `PgWorkspaceDocStorageAdapter.deleteDoc()`-Pfad
- genau ein passender Push der drei nativen Write-Tools

Passt eine dieser Annahmen nicht eindeutig, bricht der Build ab. `dist/main.js` wird dann nicht geschrieben.

## Yjs

AFFiNE Stable fuehrt `removeDoc()` als Yjs-Aenderung am Workspace-Root-Dokument aus. Fuer genau diese Operation installiert das Patch-Image `yjs@13.6.21` fest unter `/opt/affine-mcp-patch/node_modules/yjs`.

## Sicherheit

- offizielles `ghcr.io/toeverything/affine:stable` bleibt die Basis
- bestehender `aff_mcp_v1...`-Credential bleibt der einzige Authentifizierungspfad
- keine zusaetzlichen Logins, JWTs, Cookies oder Socket.IO-Nebenwege
- `Doc.Delete` bleibt die AFFiNE-Berechtigungspruefung
- keine direkte Datenbankverbindung
- keine zusaetzliche eigene Cleanup-Logik
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

Aendert AFFiNE die Stable-Loeschsemantik oder die geprueften Core-Strukturen, stoppt der Build und der Patch muss zuerst an den neuen Stable-Core angepasst werden.
