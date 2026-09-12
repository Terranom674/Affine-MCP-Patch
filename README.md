# AFFiNE MCP Patch

Dieses Repository baut ein eigenes AFFiNE-Docker-Image auf Basis des offiziellen Stable-Images und soll gezielt die MCP-Schreibfunktionen fuer Self-Hosted-Installationen freischalten, ohne `AFFINE_ENV=dev` zu setzen.

## Ziel

AFFiNE bleibt im Production-Namespace. Der Patch soll ausschliesslich die vorhandenen MCP-Schreibwerkzeuge (`create_document`, `update_document`, `update_document_meta`) fuer einen explizit konfigurierten READ_WRITE-MCP-Zugang nutzbar machen.

## Sicherheitsprinzip

Der Patch arbeitet **fail closed**:

- Das offizielle Image bleibt die Basis.
- Vor jeder Aenderung wird geprueft, ob die erwartete AFFiNE-Version bzw. Patch-Signatur passt.
- Wenn AFFiNE den relevanten Code aendert, bricht der Build ab.
- Es gibt keine automatische GitHub Action und kein automatisches Deployment.
- Ein Update wird bewusst manuell gebaut und danach getestet.

## Struktur

- `Dockerfile` - baut das angepasste Image
- `patch-mcp.js` - kontrollierter, versionsbewusster Patch
- `versions.json` - bekannte und gepruefte AFFiNE-Versionen/Signaturen
- `compose.example.yml` - Beispiel fuer die Einbindung in Docker Compose

## Aktueller Stand

Basis fuer die erste Implementierung ist AFFiNE `0.27.4`.

Der eigentliche Runtime-Patch wird erst aktiviert, sobald die exakte Bundle-Signatur des laufenden `0.27.4`-Images erfasst und in `versions.json` hinterlegt ist. Bis dahin bricht der Build absichtlich ab, statt einen unsicheren Blind-Patch vorzunehmen.

## Geplanter Ablauf

```text
docker build --pull -t affine-mcp-patched .
```

Wenn die Upstream-Version oder die erwartete Signatur nicht mehr stimmt, stoppt der Build. Dann wird die neue AFFiNE-Version zuerst analysiert und anschliessend die Signatur bewusst aktualisiert.
