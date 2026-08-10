# J-Desk API

> Stand: Commit `bb4e2c9` — bei API-Änderungen mitpflegen.

J-Desk ist ein Client-Server-System: Der Server (`packages/server`) hält den gesamten Zustand
(Schreibtische, Dateien, Konten) und stellt ihn über eine REST-API plus WebSocket bereit. Die
mitgelieferte Browser-App (`src/`) ist selbst nur ein Client dieser API — jede Aktion, die die
App ausführen kann, ist auch über die hier dokumentierten Endpunkte erreichbar.

## Inhaltsverzeichnis

- [REST-Referenz](rest.md) — alle HTTP-Routen
- [Command-Referenz](commands.md) — die Payloads für `POST /api/v1/desks/:id/commands`
- [WebSocket-Protokoll](websocket.md) — Live-Updates eines Schreibtischs
- [MCP-Server](mcp.md) — anonymisierter KI-Zugriff
- [OpenAPI 3.1 Spec](openapi.yaml) — maschinenlesbar

## Basis-URL und Versionierung

Standard-Port `4810` (überschreibbar per `PORT`-Umgebungsvariable), alle Routen unter dem
Präfix `/api/v1`:

```
http://localhost:4810/api/v1
```

Quelle: `packages/server/src/main.ts` (`const port = Number(process.env.PORT ?? 4810);`) und
die Routen-Präfixe in `packages/server/src/app.ts`.

## Betriebsmodi

Der Server läuft in genau einem von zwei Modi, die sich in der API-Oberfläche direkt
auswirken. Der aktuelle Modus steht im `mode`-Feld von `GET /api/v1/auth/status`
(`packages/server/src/app.ts`, Zeile 154–159).

**`standalone`** — kein `jlawyerUrl` konfiguriert (weder per `JLAWYER_URL`-Env noch per
gespeichertem Setup-Setting). Der Server verwaltet eigene Benutzerkonten
(`auth/setup`/`auth/login` prüfen gegen die lokale SQLite-Datenbank). Dateien werden über
`POST /api/v1/files` in die eigene, inhaltsadressierte Ablage hochgeladen und über
`GET /api/v1/files/:id` wieder ausgeliefert. Die `/api/v1/cases*`-Routen existieren in diesem
Modus gar nicht.

**`jlawyer`** — `jlawyerUrl` ist gesetzt (Env `JLAWYER_URL` hat Vorrang, sonst das per
`POST /api/v1/setup/jlawyer` gespeicherte Setting). Anmeldung reicht Benutzername/Passwort an
j-lawyer durch (`validateLogin`); es gibt keine eigene Kontenverwaltung, `auth/setup` ist
gesperrt (`403`). Eigene Datei-Uploads sind deaktiviert — `POST /api/v1/files` liefert immer
`400` mit dem Hinweis, stattdessen `POST /api/v1/cases/:id/documents` zu nutzen. `GET
/api/v1/files/:id` liefert in diesem Modus den Akteninhalt aus j-lawyer (per Sitzungs-
Credentials abgerufen und lokal gecacht), zusätzlich existieren die `/api/v1/cases*`-Routen für
Aktenliste, Aktensynchronisation auf einen Schreibtisch und Dokument-Upload in die Akte.

Der Moduswechsel selbst läuft über die Setup-Routen: `POST /api/v1/setup/jlawyer-test` prüft
eine j-lawyer-URL vorab (ohne sie zu speichern), `POST /api/v1/setup/jlawyer` speichert sie und
löst intern einen Server-Neuaufbau aus (Routen sind modusabhängig registriert). Beide sind nur
erreichbar, solange noch kein Modus konfiguriert ist (`setupGesperrt` in `app.ts`).

## Auth

Alle `/api/`-Routen außer den öffentlichen Pfaden verlangen ein Bearer-Token im
`authorization`-Header:

```
authorization: Bearer <TOKEN>
```

Quelle: `bearerToken()` und der globale `onRequest`-Hook in `packages/server/src/app.ts`
(Zeile 51–55, 126–151). Das Token wird ausgestellt von `POST /api/v1/auth/login` (bzw. im
Standalone-Modus zusätzlich von `POST /api/v1/auth/setup`, das Kontoerstellung und Login in
einem Schritt erledigt).

Öffentlich — ohne Token erreichbar — sind laut Auth-Hook:

- `GET /api/v1/auth/status`, `POST /api/v1/auth/login`, `POST /api/v1/auth/setup` (fest verdrahtete `PUBLIC_PATHS`)
- alles unter `/api/v1/setup/` (`SETUP_PREFIX`, solange der Betriebsmodus noch nicht konfiguriert ist — die Routen sperren sich danach selbst)
- alles unter `/api/v1/convert-source/` (`CONVERT_SOURCE_PREFIX`, das Einmal-Ticket in der URL ersetzt die Auth)
- `GET /api/v1/desks/:id/ws` — Browser-WebSockets können keine Header setzen; hier gilt statt Bearer-Token ein Einmal-Ticket in der Query (`?ticket=…`, ausgestellt von `POST /api/v1/ws-ticket`)
- alle nicht-`/api/`-Pfade (statische Auslieferung der Browser-App)

## Schnellstart

```bash
BASE=http://localhost:4810/api/v1

# 1. Modus und Ersteinrichtungsstatus prüfen
curl -s $BASE/auth/status

# 2. Anmelden (Standalone-Modus; im jlawyer-Modus identisch, aber gegen j-lawyer geprüft)
TOKEN=$(curl -s -X POST $BASE/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"anna","password":"geheim-123"}' | jq -r .token)

# 3. Schreibtische auflisten
curl -s $BASE/desks -H "authorization: Bearer $TOKEN"

# 4. Command ausführen (Zettel auf einen Schreibtisch legen)
curl -s -X POST $BASE/desks/<DESK_ID>/commands \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"addNote","payload":{"id":"n1","position":{"x":100,"y":100},"text":"Wiedervorlage","kind":"notiz"}}'

# 5. Datei abrufen
curl -s $BASE/files/<FILE_ID> -H "authorization: Bearer $TOKEN" -o datei.pdf
```

Details zu den einzelnen Schritten stehen in [rest.md](rest.md), die vollständige Liste der
Command-Typen (inkl. `addNote`-Pflichtfelder) in [commands.md](commands.md).

## Umgebungsvariablen

Quelle: `packages/server/src/main.ts`.

| Variable | Default | Bedeutung |
|---|---|---|
| `PORT` | `4810` | Port, auf dem der Server hört |
| `DATA_DIR` | `./data` | Verzeichnis für SQLite-Datenbank, Datei-Ablage und Caches |
| `WEB_DIR` | `../../../build` relativ zum Server-Paket | Verzeichnis der gebauten Browser-App (statische Auslieferung); fehlt es, läuft der Server ohne Web-App |
| `JLAWYER_URL` | — | Basis-URL der j-lawyer-REST-API; gesetzt aktiviert den `jlawyer`-Modus und hat Vorrang vor dem per Setup-Dialog gespeicherten Setting |
| `EUROOFFICE_URL` | — | Basis-URL des Euro-Office-DocumentServers für die Vorschau-Konvertierung |
| `EUROOFFICE_JWT_SECRET` | — | Signierschlüssel für die JWT-Authentifizierung gegenüber dem DocumentServer; nur zusammen mit `EUROOFFICE_URL` wirksam (beide gesetzt = Konverter aktiv) |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Basis-URL, unter der dieser Server für den DocumentServer erreichbar ist (z. B. Containername statt `localhost` im Docker-Netz) — wird für `/convert-source`-Tickets verwendet |

## Fehlerformat

Fehlerantworten sind durchgängig `{ "error": string }` mit einem für Menschen lesbaren
(deutschen) Text — Details je Route in [rest.md](rest.md).
