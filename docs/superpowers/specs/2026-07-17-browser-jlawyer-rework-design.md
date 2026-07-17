# Design: Browser-Rework mit j-lawyer-Anbindung

Datum: 2026-07-17
Status: entworfen, vom Auftraggeber abschnittsweise freigegeben

## Ziel

Digital Desktop wird von einer Tauri-Mac-App mit eigener PDF-Ablage zu einer
reinen Browser-Anwendung, die auf einem zentralen Server in der Kanzlei läuft
und **j-lawyer als einzige Dokumentquelle** nutzt. Nutzer melden sich mit ihrem
j-lawyer-Konto an, jede j-lawyer-Akte hat genau einen Schreibtisch, neue
Dokumente werden per Browser-Upload in die Akte zugespeichert.

## Entscheidungen (mit Auftraggeber geklärt)

| Frage | Entscheidung |
|---|---|
| Zielplattform | Nur Browser; Tauri wird entfernt |
| Dokumentquelle | j-lawyer ausschließlich; keine eigene PDF-Ablage mehr |
| Anmeldung | Login mit j-lawyer-Konto; Rechte bleiben in j-lawyer |
| Akten-Modell | Ein Schreibtisch pro Akte |
| Zuspeichern | Upload im Browser (Drag-and-drop / Dateiauswahl) in die Akte |
| Mandanten | Eine Installation pro Kanzlei, eine j-lawyer-Instanz pro Installation |
| Branding | Später (eigenes Teilprojekt); jetzt neutrale Optik |
| Altdaten | Keine Migration; Installationen starten frisch |

## Verifizierte j-lawyer-API-Fakten

Quelle: https://github.com/jlawyerorg/j-lawyer-org (Modul
`j-lawyer-server/j-lawyer-io`).

- Gesamte REST-API über **HTTP Basic Auth** (`web.xml`: `auth-method BASIC`,
  Realm `jlawyerRealm`, rollenbasierte Absicherung; mindestens `loginRole`).
- Basis-URL: `http(s)://<jlawyer-host>:8080/j-lawyer-io/`, Swagger-UI unter
  `/j-lawyer-io/swagger-ui/`.
- Benötigte Endpunkte (v1 vorhanden, neuere Versionen bis v7 verfügbar):
  - `GET /v1/cases/list` — Aktenliste
  - `GET /v1/cases/{id}` — Aktendetails
  - `GET /v1/cases/{id}/documents` — Dokumentliste einer Akte
  - `GET /v1/cases/document/{id}/content` — Dokumentinhalt
  - `PUT /v1/cases/document/create` — Dokument in Akte anlegen
  - `PUT /v1/cases/document/update`, `DELETE /v1/cases/document/{id}/delete`
- Offen bis zum API-Spike: exakte Feldnamen, Kodierung des Inhalts
  (Base64 vs. binär), Wahl der API-Version (v1 vs. v7) je Endpunkt.

## Architektur

Eine Installation pro Kanzlei = ein Node-Server (Node ≥ 20 oder Docker) im
Kanzleinetz mit drei Aufgaben:

1. **Web-App ausliefern.** Der SvelteKit-Client wird weiterhin statisch gebaut
   (`adapter-static`) und vom Server unter `/` ausgeliefert. `src-tauri/` und
   alle `@tauri-apps/*`-Abhängigkeiten werden entfernt.
2. **j-lawyer-Gateway.** Der Browser spricht ausschließlich mit unserem Server;
   der Server reicht Anfragen mit den Credentials der jeweiligen Sitzung an die
   j-lawyer-REST-API weiter. Das vermeidet CORS-Probleme und hält die
   j-lawyer-Adresse aus dem Browser heraus. Die j-lawyer-URL steht in der
   Server-Konfiguration (Umgebungsvariable bzw. Konfigdatei) und muss vor dem
   ersten Login feststehen.
3. **Schreibtisch-Zustand speichern.** SQLite hält nur noch, was j-lawyer nicht
   kennt: Kartenpositionen, Stapel, Verknüpfungen, Ansichtszustand — pro Akte,
   geteilt von allen Nutzern der Kanzlei. Wer die Akte in j-lawyer sehen darf,
   sieht ihren Schreibtisch.

**Entfällt im Server:** eigene Kontenverwaltung (`users.ts`, `invites.ts`,
`members.ts`), eigene PDF-Ablage (`files.ts` in heutiger Form),
Einladungs-/Mitgliederlogik.
**Bleibt:** `deskStore`, WebSocket-Broadcast (Live-Sync bei gemeinsam
geöffneter Akte), Backup.
**Neu:** Modul `jlawyer.ts` als einziger Ort mit Kenntnis der j-lawyer-API:
Login-Prüfung, Aktenliste, Dokumentliste, Dokumentinhalt (mit Platten-Cache),
Dokument-Upload.
**Unverändert:** `packages/core` (quellenunabhängige Zustandslogik) und der
Großteil der Svelte-Komponenten. `packages/mcp` wird in diesem Rework nicht
angefasst (siehe Folgearbeiten).

## Anmeldung und Datenfluss

- **Login:** `POST /api/login` mit Benutzername + Passwort. Der Server
  validiert per Testaufruf gegen j-lawyer (Basic Auth). Bei Erfolg: zufälliges
  Session-Token als httpOnly-Cookie; die Basic-Auth-Credentials der Sitzung
  werden ausschließlich im Arbeitsspeicher gehalten, nie persistiert.
  Konsequenz: Nach Server-Neustart müssen sich alle neu anmelden (bewusst in
  Kauf genommen).
- **Aktenliste:** `GET /api/cases` → Server ruft `/v1/cases/list` ab und reicht
  gefilterte Felder durch (ID, Aktenzeichen, Rubrum). Suche zunächst
  clientseitig; serverseitig nachrüstbar.
- **Akte öffnen:** `GET /api/cases/{id}/desk` → Server holt Dokumentliste aus
  j-lawyer und Schreibtisch-Zustand aus SQLite und gleicht ab: neue Dokumente
  bekommen automatisch eine Karte in einem „Eingang“-Bereich; Karten gelöschter
  Dokumente werden entfernt. j-lawyer ist führend, der Schreibtisch ist eine
  Sicht darauf.
- **PDF anzeigen:** `GET /api/documents/{id}/content` → Server prüft die
  Berechtigung per j-lawyer-Metadatenabruf mit den Credentials der Sitzung und
  liefert den Inhalt aus dem Platten-Cache (Schlüssel: Dokument-ID +
  Änderungsdatum) oder holt ihn frisch.
- **Upload:** `POST /api/cases/{id}/documents` → Server legt das Dokument per
  `document/create` in der Akte ab und antwortet mit der neuen Karte. Keine
  optimistische Anzeige: Die Karte erscheint erst nach bestätigtem Anlegen.
- **Live-Sync:** WebSocket-Broadcast wie bisher für Karten- und
  Positionsänderungen an alle Nutzer mit derselben offenen Akte.

## Browser-Port des Clients

Die elf Dateien mit Tauri-Abhängigkeiten erhalten Browser-Äquivalente:

- `api.ts` / `session.ts`: Tauri-HTTP → natives `fetch` mit
  `credentials: 'include'`. Keine Server-URL-Einstellung mehr im Client — die
  App kommt vom selben Origin, alle Aufrufe gehen relativ an `/api/...`.
- WebSocket-Plugin → nativer `WebSocket` (gleicher Origin, `wss://` hinter dem
  Reverse-Proxy).
- `fileCache.ts` / `thumbnails.ts`: Dateisystem-Cache → IndexedDB (PDF-Blobs
  und Vorschaubilder) mit Größenlimit und Verdrängung nach Alter;
  `pdfjs-dist` unverändert.
- Datei-Dialoge → `<input type="file">` und Drag-and-drop auf das
  Schreibtisch-Element.
- `menus.ts` (native Menüs) → entfällt; Aktionen über die UI bzw. ein kleines
  App-Menü im Kopfbereich.
- `+layout.ts` / `+page.svelte`: Tauri-Erkennung entfällt. Neue UI-Flächen:
  Login-Maske und Aktenliste (ersetzen Ersteinrichtung und `DeskSwitcher`);
  `UserAdmin.svelte` entfällt.

## Datenmodell (SQLite)

- `desks`: ein Datensatz pro j-lawyer-Akten-ID mit dem Schreibtisch-Zustand im
  bestehenden `deskStore`-Format; Karten referenzieren die
  j-lawyer-Dokument-ID plus zuletzt bekanntes Änderungsdatum und Dateinamen
  (statt eines Dateipfads).
- `settings`: wenige Server-Einstellungen (z. B. Cache-Limit). Die
  j-lawyer-URL liegt bewusst nicht in der Datenbank.
- Entfernt werden: `users`, `invites`, `members`, `files` samt Modulen.
  Keine Datenmigration aus Altbeständen.

## Fehlerbehandlung

- **j-lawyer nicht erreichbar / 5xx:** klarer Fehlercode an den Browser;
  Banner „j-lawyer nicht erreichbar“, Aktionen gesperrt (bestehendes
  Offline-Sperr-Muster wird wiederverwendet). Gecachte PDFs bleiben lesbar.
- **401 mitten in der Sitzung** (Passwort in j-lawyer geändert): Sitzung wird
  beendet, Login-Maske mit Hinweis.
- **Upload-Fehler:** keine Karte ohne bestätigtes `document/create`;
  Fehlermeldung mit Wiederholen-Knopf.
- **Dokument extern gelöscht:** Karte verschwindet beim nächsten Abgleich;
  Inhaltsabruf liefert eine saubere „nicht mehr vorhanden“-Meldung.

## Tests

- `packages/core`: bestehende Tests unverändert.
- Server: **Fake-j-lawyer** in den Tests (kleiner Node-HTTP-Server mit Basic
  Auth und den benutzten Endpunkten) für Login, Abgleich, Cache und Upload;
  Fortführung des Musters aus `testUtils.ts`.
- Client-Module: Vitest wie bisher; IndexedDB über `fake-indexeddb`.
- **API-Spike zu Beginn:** Wegwerf-Skript gegen eine echte j-lawyer-Instanz
  (Login, Aktenliste, Dokument laden, Dokument anlegen). Erkenntnisse fließen
  in den Adapter ein. Benötigt Zugangsdaten zu einer Test-Instanz.

## Teilprojekte

1. **TP-A Browser-Port:** Tauri raus, Browser-APIs rein, Server liefert die
   App aus. Ende: heutige Funktionalität komplett im Browser, noch mit eigener
   Kontenverwaltung.
2. **TP-B j-lawyer-Kern:** API-Spike, Adapter `jlawyer.ts`, Login-Umstellung,
   eigene Kontenverwaltung entfernen. Ende: Anmeldung mit j-lawyer-Konto,
   Aktenliste sichtbar.
3. **TP-C Akten-Schreibtische:** ein Schreibtisch pro Akte, Abgleich,
   PDF-Cache, Upload, Entfernen der Ablage-Reste. Ende: Zielbild komplett.

Jedes Teilprojekt bekommt einen eigenen Implementierungsplan.

## Folgearbeiten (außerhalb dieses Reworks)

- `packages/mcp` an die neue Authentifizierung anpassen (der MCP-Server nutzt
  heute die eigene Kontenverwaltung).
- Branding-Teilprojekt (Produktname, Logo, Primärfarbe pro Installation).
- Entscheidung über die offenen Branches TP3 (`feature/mcp-server`) und TP4
  (pending UAT): Der Rework startet ab `main`; Merges dieser Branches vor
  TP-B vermeiden Konflikte in der Kontenverwaltung.
