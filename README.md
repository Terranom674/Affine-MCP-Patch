# AFFiNE MCP Patch

Dieses Repository baut ein eigenes AFFiNE-Docker-Image auf Basis des offiziellen Stable-Images und schaltet den vorhandenen READ_WRITE-MCP fuer die Self-Hosted-Installation frei.

Zusaetzlich werden genau drei fehlende Dokument-Lifecycle-Werkzeuge in den bereits authentifizierten READ_WRITE-MCP-Kontext aufgenommen:

- `trash_document`
- `restore_document`
- `delete_document`

AFFiNE upstream bietet diese drei Operationen bereits nativ ueber `BackendRuntimeProvider.executeDomainCommandV1()` mit dem Domain-Command `apply_doc_lifecycle` an, veroeffentlicht sie aber nicht als Workspace-MCP-Tools. Der Patch verwendet fuer die drei Werkzeuge genau diesen vorhandenen nativen Lifecycle-Pfad und dieselben Berechtigungsaktionen wie AFFiNEs Sync-Gateway (`Doc.Trash`, `Doc.Restore`, `Doc.Delete`).

## Umfang des Patches

Der Patch aendert ausschliesslich den MCP-bezogenen Ausfuehrungspfad:

1. vorhandenen READ_WRITE-Gate fuer `AFFINE_MCP_WRITE_ENABLED=true` freischalten;
2. GraphQL-Verfuegbarkeitsflag und Credential-Guard an denselben Schalter anpassen;
3. die bereits von Nest erzeugte `BackendRuntimeProvider`-Instanz deterministisch fuer den MCP-Provider referenzierbar machen;
4. exakt `trash_document`, `restore_document` und `delete_document` im vorhandenen READ_WRITE-Zweig registrieren.

Nicht geaendert werden Datenbankschema, Migrationen, Authentifizierungsmodell, Permission-Modell, DocWriter-Logik oder normale AFFiNE-API-Endpunkte.

## Authentifizierung und Berechtigungen

Es gibt **keine zusaetzliche Benutzeranmeldung** fuer die Lifecycle-Werkzeuge.

Der vorhandene `aff_mcp_v1...`-Credential authentifiziert den Workspace-MCP. AFFiNE liefert dem MCP-Provider dabei bereits `userId`, `workspaceId` und `accessMode`. Vor jeder Lifecycle-Operation wird innerhalb dieses Kontextes die passende AFFiNE-Berechtigung geprueft. Danach wird AFFiNEs eigener nativer `apply_doc_lifecycle`-Befehl mit genau diesem Actor ausgefuehrt.

Damit gelten fuer Trash, Restore und Delete dieselben Rechte wie im nativen AFFiNE-Sync-Pfad.

## Fail-closed-Prinzip

Der Patch ist nicht an einen festen Bundle-Hash gebunden, prueft aber vor jeder Aenderung die erwartete Upstream-Struktur ueber `main.js.map` und eindeutige Marker im kompilierten Bundle.

Der Build bricht ab, wenn unter anderem:

- der Workspace-MCP-Provider nicht mehr eindeutig gefunden wird;
- der READ_WRITE-Gate seine Struktur geaendert hat;
- `BackendRuntimeProvider.executeDomainCommandV1` nicht eindeutig vorhanden ist;
- der vorhandene Write-Tool-Push nicht eindeutig gefunden wird;
- eine aufgezeichnete Ersetzung nicht exakt reversibel ist.

Es werden keine GitHub Actions und kein automatisches Deployment eingerichtet.

## Aktivierung

AFFiNE bleibt im Production-Namespace:

```yaml
environment:
  AFFINE_ENV: production
  AFFINE_MCP_WRITE_ENABLED: "true"
```

## Erwartete Workspace-MCP-Werkzeuge

Im READ_WRITE-Betrieb werden mindestens diese acht Dokumentwerkzeuge erwartet:

- `read_document`
- `doc_search`
- `create_document`
- `update_document`
- `update_document_meta`
- `trash_document`
- `restore_document`
- `delete_document`

## Dateien

- `Dockerfile` - baut das angepasste Image aus dem offiziellen Stable-Image
- `patch-mcp.js` - fail-closed MCP-Write- und Lifecycle-Patch
- `docker-compose.override.yml` - Produktions-Override der Self-Hosted-Installation
- `deploy.sh` - manuell auszufuehrendes Deployment

## Build

```bash
docker build --pull -t affine-mcp-patched .
```

Bei einem AFFiNE-Update wird derselbe Build erneut ausgefuehrt. Wenn die relevante MCP-/Runtime-Struktur nicht mehr eindeutig passt, stoppt der Build und muss zuerst geprueft werden.
