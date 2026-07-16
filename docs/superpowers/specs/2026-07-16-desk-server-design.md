# Digital Desktop v2 — Server-Fundament & Client-Umbau (Teilprojekt 1)

**Datum:** 2026-07-16
**Status:** Vom Nutzer freigegeben
**Baut auf:** v1 (Tauri-App, Spec `2026-07-16-digital-desktop-design.md`), vollständig auf `main` gemergt

## Zielbild (Gesamtvorhaben v2)

Digital Desktop wird eine Client-Server-Anwendung: Ein Node-Server im Netzwerk (Mac/NAS) besitzt Benutzer, Schreibtische, Karten-Zustand und die PDF-Ablage; die bestehende Tauri-App wird zum Mac-Client mit voller Desktop-Integration (Finder-Drop, Vorschau). Später: Web-Client von beliebigen Geräten. Zerlegung:

1. **Teilprojekt 1 (diese Spec):** Server-Fundament & Client-Umbau — Feature-Parität mit v1 über den Server, Login mit einem Konto
2. Teilprojekt 2: Mehrschreibtisch-UI (Auswahl-Leiste)
3. Teilprojekt 3: Benutzerverwaltung & Teilen pro Schreibtisch (Besitzer lädt ein)
4. Teilprojekt 4: MCP-Server für KI-Anbindung (spricht dieselbe API)

Getroffene Grundsatzentscheidungen: Server verwaltet PDF-Kopien (Upload beim Ablegen, Originale bleiben unberührt); Login von Anfang an; API von Anfang an mehrschreibtisch-fähig (`/desks/…`); Tauri-App bleibt der Client (kein Swift-Neubau).

## Architektur & Projektstruktur

Monorepo mit npm-Workspaces:

```
packages/core      Pure Zustandsmodule (bisher src/lib/state) + Typen.
                   Genutzt von Server UND Client. Tests ziehen mit um.
packages/server    Node/TypeScript: Fastify (HTTP-API), WebSocket (ws),
                   SQLite (better-sqlite3). data/-Ordner: SQLite-Datei,
                   files/-Verzeichnis (PDF-Ablage), backup/.
(Wurzel)           Bestehende Tauri-App als Client (src/, src-tauri/).
```

- Server = einzige Quelle der Wahrheit. Client rendert, sendet Kommandos, empfängt Live-Updates via WebSocket.
- Transiente Drag-Bewegungen bleiben client-lokal; erst beim Loslassen geht ein Kommando an den Server (bisheriges `transient`-Muster).
- Betrieb: `npm run server` (Standard-Port 4810, konfigurierbar via ENV `PORT`, `DATA_DIR`); Dockerfile wird mitgeliefert.

## Datenmodell

Kern-Änderung in `packages/core`: Dokumente referenzieren Server-Dateien statt lokaler Pfade.

```
Doc:   id, fileId, name, position {x,y}, rotation, zIndex
       (path und missing entfallen)
Link:  id, fromId, toId, note            (unverändert)
Stack: id, name, docIds, position, zIndex (unverändert)
```

SQLite-Tabellen:

```
users         id, username, password_hash (argon2id), created_at
sessions      token, user_id, created_at, last_used_at
desks         id, name, owner_id, state (JSON: docs/links/stacks), rev, created_at
desk_members  desk_id, user_id      (Schema jetzt, Nutzung ab Teilprojekt 3)
files         id, sha256, original_name, size, created_at
```

- Karten-Zustand pro Schreibtisch als JSON-Spalte (`desks.state`): die puren core-Funktionen arbeiten unverändert (Zustand rein → raus → speichern); keine Nachbildung der Logik in SQL. Bei ~50 Dokumenten/Schreibtisch unkritisch.
- PDFs als Dateien unter `data/files/<sha256>.pdf` — inhaltsgleiche Uploads werden dedupliziert.

## HTTP-API (JSON, Prefix `/api/v1`, Auth: `Authorization: Bearer <token>`)

```
GET  /auth/status     → {needsSetup: boolean}   (ohne Auth aufrufbar)
POST /auth/setup      Erstes Konto anlegen — nur solange 0 Benutzer existieren
POST /auth/login      {username, password} → {token}
POST /auth/logout

GET   /desks          Liste (id, name, owner)
POST  /desks          {name}
PATCH /desks/:id      {name}
DELETE /desks/:id

GET  /desks/:id/state → {rev, state}
POST /desks/:id/commands  {type, payload} → {rev, state}
     Typen: addDoc | moveDoc | bringToFront | removeDoc | addLink |
            setLinkNote | removeLink | stackDocs | removeFromStack |
            dissolveStack | renameStack | moveStack | removeStack
     (1:1-Abbildung auf die puren core-Funktionen)

POST /files           PDF-Upload (multipart) → {fileId}
                      Nur .pdf/application/pdf, Limit 100 MB
GET  /files/:id       PDF-Bytes
```

**WebSocket:** `WS /desks/:id/ws?token=…` — bei jeder Änderung sendet der Server `{rev, state}` an alle Clients des Schreibtischs (kompletter Zustand statt Diffs; `rev` schützt gegen veraltete Nachrichten).

## Login & Sicherheit

- Passwörter: argon2id. Ersteinrichtung über `POST /auth/setup` (Client zeigt Setup-Maske, wenn der Server 0 Benutzer meldet); verweigert ab dem ersten Konto.
- Sitzungen: zufälliges 32-Byte-Token in `sessions`; jeder Request aktualisiert `last_used_at`; Verfall nach 30 Tagen Inaktivität; Logout löscht das Token (serverseitig widerrufbar).
- Client speichert Server-URL + Token im AppData-Ordner. Start: Token gültig → verbinden, sonst Login-Maske (Server-URL, Benutzername, Passwort).
- Transport: HTTP im Heimnetz; für Internet-Zugriff HTTPS via Reverse-Proxy (Caddy/Traefik), im Deployment-Doc beschrieben, nicht im Node-Code.
- Rechte in Teilprojekt 1: jeder eingeloggte Benutzer sieht alle Schreibtische (es existiert nur ein Konto); Owner-/Mitglieder-Prüfung kommt in Teilprojekt 3.

## Client-Umbau

Oberfläche (Canvas, Karten, Linien, Stapel, Menüs) bleibt unangetastet; getauscht wird das Rückgrat:

- `store.svelte.ts`: `desktop.apply(...)` sendet das Kommando an die API; maßgeblicher Zustand kommt über WebSocket. Transiente Drags lokal, Kommando beim Loslassen.
- **Finder-Drop:** Tauri liest die Datei → `POST /files` → `addDoc` an der Wurfposition. Original bleibt unberührt.
- **Doppelklick:** `GET /files/:id` in lokalen Cache-Ordner (einmalig pro fileId), dann Öffnen in Vorschau. „Im Finder zeigen" entfällt; neu im Kontextmenü: „Herunterladen…" (Speichern-Dialog).
- **Miniaturen:** pdf.js rendert aus den Server-Bytes; lokaler PNG-Cache bleibt (Schlüssel: fileId).
- **Verbindungsstatus:** Banner „Verbindung getrennt — verbinde neu…" mit automatischem Reconnect (Backoff); offline sind Aktionen gesperrt (kein Offline-Editing in dieser Stufe). Nach Reconnect: kompletter Zustand via `GET /state`.
- **Login-/Setup-Maske** vor dem Schreibtisch (Server-URL, Benutzername, Passwort; Setup-Variante, wenn `GET /auth/status` `needsSetup: true` meldet).
- **Nach dem Login:** Der Client lädt den ersten Schreibtisch aus `GET /desks`; existiert keiner, legt er automatisch „Schreibtisch 1" an (bzw. der v1-Import erzeugt ihn).

## Übernahme der v1-Daten

Nach dem ersten Login prüft die App auf eine lokale v1-`desktop.json`. Falls vorhanden, einmaliges Angebot „Vorhandenen Schreibtisch auf den Server übernehmen?": alle referenzierten PDFs hochladen, Schreibtisch mit identischen Positionen, Verknüpfungen, Notizen und Stapeln anlegen, lokale Datei als importiert markieren (nicht löschen). Lokal fehlende Dateien werden übersprungen und aufgelistet.

## Fehlerbehandlung

- **Server:** Kommando anwenden + `rev`-Inkrement + Speichern in einer SQLite-Transaktion; Kommandos pro Schreibtisch serialisiert; „letzter gewinnt" bei gleichzeitigen Clients. Ungültige Kommandos → 400 mit klarer Meldung; No-Ops geben den Zustand unverändert zurück. Uploads: erst temporär schreiben, dann umbenennen (keine halben Dateien). Backup: SQLite-Datei bei Serverstart nach `data/backup/` rotieren (letzte 5 Stände).
- **Client:** API-Fehler als kurze deutsche Toast-Meldung; WS-Reconnect lädt den vollständigen Zustand; `rev` verhindert Überschreiben durch veraltete Nachrichten.

## Tests

- `packages/core`: vorhandene 42 Tests ziehen mit um (Anpassung `path` → `fileId`).
- `packages/server`: Vitest, In-Memory-SQLite, `fastify.inject()`: Setup/Login/Logout/Token-Verfall; jedes Kommando einmal über die API; Upload/Download inkl. Dedup und Validierung; WS-Broadcast mit zwei Clients; Transaktions-/rev-Verhalten.
- Client: Canvas-Interaktionen manuell; API-Client-Logik (Login, Kommandos, Reconnect) als pure Module mit Vitest, wo ohne Browser sinnvoll testbar.

## Nicht im Umfang (Teilprojekt 1)

- Mehrschreibtisch-UI (Teilprojekt 2) — die API kann es, der Client zeigt vorerst den ersten/einzigen Schreibtisch
- Benutzerverwaltung, Teilen, Rechteprüfung (Teilprojekt 3)
- MCP-Server (Teilprojekt 4)
- Offline-Editing / Konfliktauflösung jenseits „letzter gewinnt"
- Web-Client im Browser (Architektur ist darauf vorbereitet)
- HTTPS im Node-Code (läuft über Reverse-Proxy)
