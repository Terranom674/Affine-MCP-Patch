# AFFiNE MCP Patch

Dieses Repository baut ein eigenes AFFiNE-Docker-Image auf Basis des offiziellen Stable-Images und schaltet gezielt die vorhandenen MCP-Schreibfunktionen fuer Self-Hosted-Installationen frei, ohne `AFFINE_ENV=dev` zu setzen.

## Ziel

AFFiNE bleibt im Production-Namespace. Der Patch entfernt ausschliesslich die zusaetzliche Dev/Canary-Sperre fuer einen bereits explizit als `READ_WRITE` konfigurierten MCP-Zugang.

Die vorhandenen AFFiNE-Berechtigungspruefungen fuer Workspace und Dokumente bleiben unveraendert bestehen.

## Keine Versionsbindung

Der Patch ist absichtlich nicht an eine konkrete AFFiNE-Version oder einen Bundle-Hash gebunden.

Stattdessen prueft er bei jedem Build die tatsaechliche Struktur des gerade verwendeten offiziellen AFFiNE-Images:

1. `main.js.map` muss genau einen `plugins/copilot/mcp/provider.ts` enthalten.
2. Der Provider muss weiterhin den bekannten `READ_WRITE`-Gate sowie die Schreibwerkzeuge enthalten.
3. Im kompilierten Bundle muss dieser Gate genau einmal eindeutig gefunden werden.
4. Nur dann wird die Dev/Canary-Zusatzbedingung entfernt.
5. Wenn AFFiNE die interne Struktur aendert, bricht der Build ab, statt blind zu patchen.

Damit kann weiterhin `ghcr.io/toeverything/affine:stable` als Upstream verwendet werden.

## Sicherheitsprinzip

Der Patch arbeitet **fail closed**:

- Das offizielle Image bleibt die Basis.
- Keine feste AFFiNE-Versionsnummer ist erforderlich.
- Keine Hash-Liste muss gepflegt werden.
- Mehrdeutige oder geaenderte Upstream-Strukturen fuehren zum Build-Abbruch.
- Es gibt keine automatische GitHub Action und kein automatisches Deployment.
- Updates werden bewusst manuell gebaut und getestet.

## Dateien

- `Dockerfile` - baut das angepasste Image aus dem aktuellen Upstream-Image
- `patch-mcp.js` - erkennt und patcht den MCP-Write-Gate strukturbasiert
- `compose.example.yml` - Beispiel fuer die Einbindung in Docker Compose

## Build

```bash
docker build --pull -t affine-mcp-patched .
```

Bei einem normalen AFFiNE-Update wird derselbe Build erneut ausgefuehrt. Solange die relevante MCP-Struktur kompatibel bleibt, wird das neue Image gepatcht. Aendert AFFiNE diese Struktur, stoppt der Build und der Patch muss erst gegen den neuen Upstream geprueft werden.
