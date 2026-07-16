# Digital Desktop

Ein grafischer Schreibtisch für PDF-Dateien: Karten frei anordnen, verknüpfen, stapeln —
als Mac-App (Tauri) mit einem Server im Netzwerk (Node + SQLite).

## Struktur

- `packages/core` — pure Zustandslogik (von Server und Client genutzt)
- `packages/server` — HTTP-API + WebSocket + SQLite + PDF-Ablage
- Wurzel — Tauri-Client (Svelte)

## Entwicklung

    npm install
    npm run server        # Server auf http://localhost:4810 (Daten: packages/server/data/)
    npm run tauri dev     # Client (zweites Terminal)
    npm test              # alle Tests (core + server + Client-Module)

Beim ersten Start legt die App über die Ersteinrichtungs-Maske das erste Konto an.

## Server im Heimnetz / auf dem NAS

Direkt mit Node (≥ 20):

    PORT=4810 DATA_DIR=/pfad/zu/daten npm run server

Oder mit Docker:

    docker build -f packages/server/Dockerfile -t digital-desktop-server .
    docker run -d -p 4810:4810 -v dd-data:/data digital-desktop-server

In der App als Server-URL dann `http://<host>:4810` eintragen.

**Zugriff übers Internet:** nur hinter einem HTTPS-Reverse-Proxy (z. B. Caddy:
`reverse_proxy localhost:4810` mit automatischem TLS).

## Bekannte Einschränkungen

- Offline-Editing gibt es nicht: ohne Serververbindung sind Aktionen gesperrt.
- Gleichzeitige Bearbeitung: letzter Schreiber gewinnt (für Kartenpositionen unkritisch).
- Benutzerverwaltung/Teilen und Mehrschreibtisch-UI folgen in späteren Ausbaustufen
  (API und Datenmodell sind vorbereitet).
