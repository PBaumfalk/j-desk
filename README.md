# Digital Desktop

Ein grafischer Schreibtisch für PDF-Dateien: Karten frei anordnen, verknüpfen, stapeln —
als Web-App im Browser, ausgeliefert von einem Server im Netzwerk (Node + SQLite).

## Struktur

- `packages/core` — pure Zustandslogik (von Server und Client genutzt)
- `packages/server` — HTTP-API + WebSocket + SQLite + PDF-Ablage + Auslieferung der Web-App
- Wurzel — Web-Client (SvelteKit/Svelte, statisch gebaut)

## Entwicklung

    npm install
    npm run server        # Server auf http://localhost:4810 (Daten: packages/server/data/)
    npm run dev           # Client mit Proxy auf den Server (zweites Terminal)
    npm test              # alle Tests (core + server + Client-Module)

Beim ersten Start legt die App über die Ersteinrichtungs-Maske das erste Konto an.

## Betrieb

    npm run build         # Web-App nach build/
    PORT=4810 DATA_DIR=/pfad/zu/daten npm run server

Der Server liefert die gebaute Web-App unter http://<host>:4810 aus
(`WEB_DIR` überschreibt den Pfad zur Web-App).

Oder mit Docker (baut die Web-App mit ein):

    docker build -f packages/server/Dockerfile -t digital-desktop-server .
    docker run -d -p 4810:4810 -v dd-data:/data digital-desktop-server

**Zugriff übers Internet:** nur hinter einem HTTPS-Reverse-Proxy (z. B. Caddy:
`reverse_proxy localhost:4810` mit automatischem TLS).

### Vorschau-Dienst (Euro-Office)

Für die Konvertier-Vorschau von Dokumenten bindet der Server optional einen
Euro-Office-DocumentServer an (ONLYOFFICE-kompatibler Fork). Beispiel-Compose:
`docs/deployment/eurooffice-compose.yaml`.

| Variable                 | Zweck                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `EUROOFFICE_URL`         | Basis-URL des DocumentServers (im Docker-Netz: Service-Name, nicht `localhost`)          |
| `EUROOFFICE_JWT_SECRET`  | Gemeinsames JWT-Secret zwischen Digital-Desktop-Server und DocumentServer                |
| `PUBLIC_URL`             | Basis-URL, unter der dieser Server selbst für den DocumentServer erreichbar ist          |

**Ohne Konfiguration** (eine der beiden `EUROOFFICE_*`-Variablen fehlt) ist die
Konvertier-Vorschau deaktiviert — alles andere läuft normal weiter.

## Bekannte Einschränkungen

- Offline-Editing gibt es nicht: ohne Serververbindung sind Aktionen gesperrt.
- Gleichzeitige Bearbeitung: letzter Schreiber gewinnt (für Kartenpositionen unkritisch).
- Benutzerverwaltung/Teilen und Mehrschreibtisch-UI folgen in späteren Ausbaustufen
  (API und Datenmodell sind vorbereitet).
