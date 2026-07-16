# Digital Desktop v2 — Benutzerverwaltung & Teilen pro Schreibtisch (Teilprojekt 3)

**Datum:** 2026-07-16
**Status:** Vom Nutzer freigegeben
**Baut auf:** Teilprojekt 1 (Spec `2026-07-16-desk-server-design.md`) und Teilprojekt 2 (Spec `2026-07-16-mehrschreibtisch-ui-design.md`), beide auf `main` gemergt

## Ziel

Mehrere Benutzerkonten auf dem Server, echte Rechteprüfung pro Schreibtisch und Teilen von Schreibtischen mit anderen Benutzern. Bisher prüft der Server nur „eingeloggt ja/nein"; `desks.owner_id` und die Tabelle `desk_members` existieren, werden aber nicht ausgewertet. Neue Konten entstehen über den Admin oder über einmalige Einladungscodes (optional mit angehängtem Schreibtisch).

Getroffene Grundsatzentscheidungen:

- Das Setup-Konto ist Admin. Der Admin verwaltet **Konten**, nicht Inhalte — er sieht fremde Schreibtische nicht.
- Mitglieder eines geteilten Schreibtischs bearbeiten voll (Karten bewegen, hinzufügen, löschen …); nur der Besitzer darf umbenennen, löschen und Mitglieder/Einladungen verwalten. Kein Nur-Lesen-Modus (YAGNI).
- Datei-Downloads sind desk-gebunden (Ansatz „Gründlich"): Teilen pro Schreibtisch ist eine echte Grenze, keine Kosmetik.

## Datenmodell & Migration

Schema-Änderungen (SQLite):

```
users         + is_admin INTEGER NOT NULL DEFAULT 0
files         + uploader_id TEXT NULL REFERENCES users(id)
invites       token TEXT PRIMARY KEY (32-Byte-Zufall, hex),
              created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              desk_id TEXT NULL REFERENCES desks(id) ON DELETE CASCADE,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
desk_members  unverändert (existiert seit TP1); der Besitzer steht NICHT darin,
              Besitz ergibt sich aus desks.owner_id
```

Einladungen sind einmalig verwendbar (beim Einlösen gelöscht) und verfallen nach 14 Tagen. Wird der angehängte Schreibtisch gelöscht, verfällt die Einladung mit (CASCADE).

**Migration:** Der Server bekommt einen minimalen Migrationsmechanismus über `PRAGMA user_version` (bisher nur `CREATE TABLE IF NOT EXISTS`). Migration v1:

1. Spalten `users.is_admin` und `files.uploader_id` anlegen, Tabelle `invites` erzeugen.
2. Alle bestehenden Benutzer auf `is_admin = 1` setzen (heute kann nur das Setup-Konto existieren — es wird damit der Admin).
3. Bestehende Dateien dem Setup-Konto als Uploader zuschreiben.

## Rechteregeln

Zentrale Frage „darf Benutzer U auf Schreibtisch D?" — als Guard-Helfer im Server (`requireDeskAccess`, `requireDeskOwner`, `requireAdmin`), am Anfang jeder betroffenen Route, keine verstreuten Einzelprüfungen:

- **Zugriff** (Liste, Zustand, Kommandos, WebSocket): U ist Besitzer **oder** Mitglied. Sonst 403 „Kein Zugriff"; 404 nur, wenn der Desk nicht existiert.
- **Verwalten** (umbenennen, löschen, Mitglieder/Einladungen): nur Besitzer.
- **Admin:** verwaltet Konten und darf reine Konto-Einladungen erstellen; kein impliziter Zugriff auf fremde Schreibtische.
- **Datei-Download:** erlaubt, wenn U die Datei selbst hochgeladen hat (`uploader_id`, deckt das Fenster zwischen Upload und `addDoc` ab) **oder** die Datei in einem für U zugänglichen Schreibtisch referenziert ist.
- **Einladung erstellen:** mit `deskId` → nur der Besitzer dieses Desks; ohne `deskId` (reines Konto) → nur Admin.

**Konto-Löschung** (Admin, Kaskade in einer Transaktion): Sessions, Mitgliedschaften und erstellte Einladungen des Benutzers löschen; seine eigenen Schreibtische löschen (Bestätigungsdialog listet sie vorher auf); `files.uploader_id` auf NULL setzen (Dateien bleiben — sha256-Dedup, andere können sie referenzieren). Der Admin kann sein eigenes Konto nicht löschen (400).

## HTTP-API (Prefix `/api/v1`, Auth wie bisher)

Rechte auf bestehenden Routen:

```
GET    /desks               nur eigene + geteilte; Einträge neu mit ownerName, isOwner
PATCH  /desks/:id           nur Besitzer (sonst 403)
DELETE /desks/:id           nur Besitzer (sonst 403)
GET/POST /desks/:id/state | /commands | /ws    nur Besitzer/Mitglied
GET    /files/:id           Datei-Download-Regel (sonst 403)
POST   /files               setzt uploader_id
```

Neue Routen:

```
— Mitglieder —
GET    /desks/:id/members          Besitzer + Mitglieder sehen die Liste
POST   /desks/:id/members          {username} — nur Besitzer; Besitzer selbst
                                   oder Duplikat → 400
DELETE /desks/:id/members/:userId  Besitzer entfernt jeden; jeder darf sich
                                   selbst entfernen („verlassen")

— Benutzer —
GET    /users               id, username, isAdmin — für alle Eingeloggten
                            (der Teilen-Dialog braucht die Namensliste)
POST   /users               Admin: {username, password} → Konto anlegen
PATCH  /users/:id           Admin: {username} umbenennen
POST   /users/:id/password  Admin: {password} zurücksetzen; löscht alle
                            Sessions des Betroffenen
DELETE /users/:id           Admin: Konto löschen (Kaskade s. o.); eigenes → 400
POST   /auth/password       Selbst: {oldPassword, newPassword}; andere eigene
                            Sessions bleiben gültig

— Einladungen —
POST   /invites             {deskId?} → {token, expiresAt}
GET    /invites             eigene erstellte (Admin: alle), mit deskName
DELETE /invites/:token      Ersteller oder Admin (widerrufen)
GET    /auth/invite/:token  ohne Auth: Gültigkeit prüfen → {deskName?}
POST   /auth/redeem         ohne Auth: {token, username, password} → Konto
                            anlegen, ggf. Mitgliedschaft, → {token} (Session —
                            direkt eingeloggt)
```

`/auth/invite/:token` und `/auth/redeem` kommen zu den PUBLIC_PATHS. Für `redeem` gelten dieselben Validierungen wie beim Setup (Benutzername nicht leer/eindeutig, Passwort ≥ 8 Zeichen); abgelaufene oder verbrauchte Codes → 400 mit klarer Meldung, es wird kein Konto angelegt.

## WebSocket

Beim Verbinden wird der Desk-Zugriff geprüft (sonst sofortiges Close). Die Broadcast-Registry merkt sich zusätzlich die `userId` pro Socket. Zwei Server-Ereignisse schließen betroffene Sockets aktiv mit typisiertem Close-Code:

- **Desk gelöscht** → Close `4001` (`desk-deleted`) an alle Sockets des Desks — löst den TP2-Backlog-Punkt „fremder Client auf gelöschtem Desk".
- **Mitglied entfernt / Konto gelöscht** → Close `4003` (`access-revoked`) nur an die Sockets des Betroffenen.

Der Client unterscheidet diese Codes vom Netz-Abriss: **kein** Reconnect, sondern Toast („Schreibtisch wurde gelöscht" / „Zugriff wurde entzogen"), Desk-Liste neu laden, zum ersten verfügbaren Schreibtisch wechseln.

## Client-UI

- **Konto-Menü** (neu, Toolbar oben rechts): Button mit eigenem Benutzernamen öffnet Dropdown: *Passwort ändern…*, *Benutzerverwaltung…* (nur Admin), *Abmelden* (bisher ohne UI — `api.logout()` existiert ungenutzt).
- **Benutzerverwaltung** (Dialog, nur Admin): Tabelle aller Konten (Name, Admin-Kennzeichen); pro Zeile umbenennen, Passwort zurücksetzen, löschen (Bestätigungsdialog listet vorher die mitzulöschenden Schreibtische — der Client holt sie vor dem Löschen vom Server). Oben: *Neues Konto* (Name + Anfangspasswort) und *Konto-Einladung erstellen* → Code zum Kopieren; Liste offener Einladungen mit Widerrufen.
- **Teilen-Dialog** (pro Desk, nur Besitzer; Eintrag *Teilen…* an der Desk-Zeile im DeskSwitcher): Mitgliederliste (entfernen per ✕), *Mitglied hinzufügen* als Auswahl aus `GET /users` (ohne Besitzer und bestehende Mitglieder), *Einladung für diesen Schreibtisch erstellen* → Code zum Kopieren; offene Einladungen des Desks mit Widerrufen.
- **DeskSwitcher:** fremde (geteilte) Desks mit Zusatz „von *ownerName*"; dort ersetzt *Verlassen* die Besitzer-Aktionen (Umbenennen/Löschen/Teilen entfallen).
- **Login-Maske:** dritter Modus „Einladung einlösen": Server-URL + Einladungscode, dann Wunsch-Benutzername + Passwort. `GET /auth/invite/:token` validiert vorab und zeigt ggf. „Du wirst zu Schreibtisch ‚X' eingeladen". Nach `redeem` direkt eingeloggt.

## Fehlerbehandlung & Randfälle

- **403 auf beliebiger Desk-Route** (Zugriff zwischenzeitlich entzogen, WS-Close verpasst): gleiche Recovery-Routine wie bei den Close-Codes 4001/4003 — Toast, Desk-Liste neu laden, zum ersten verfügbaren Desk wechseln.
- **Kein Desk mehr verfügbar:** bestehendes Verhalten nach Login greift — Client legt automatisch „Schreibtisch 1" an.
- **Passwort-Reset durch Admin** killt die Sessions des Betroffenen → dessen Client läuft in 401 → bestehender Pfad zurück zur Login-Maske.
- **Einladungscode ungültig/abgelaufen/verbraucht:** klare Meldung in der Maske, kein Konto angelegt.

## Tests

Vitest, `fastify.inject()`, In-Memory-SQLite (wie bisher):

- Migration v1 auf einer Bestands-DB: Setup-Konto wird Admin, Dateien bekommen Uploader.
- Zugriffsmatrix Besitzer/Mitglied/Fremder/Admin für jede Desk-Route inkl. WS-Connect.
- Datei-Guard: Uploader ✓, in zugänglichem Desk referenziert ✓, fremd → 403.
- Mitglieder-CRUD inkl. „selbst verlassen"; Besitzer/Duplikat → 400.
- Invite-Lebenszyklus: erstellen (Rechte je Variante), einlösen, doppelt einlösen → 400, Verfall, Widerruf, Desk-Löschung kaskadiert.
- Konto-Kaskade (Desks, Sessions, Mitgliedschaften, Invites weg; uploader_id NULL); eigenes Konto → 400.
- Passwort ändern (falsches altes → 400) und Admin-Reset inkl. Session-Invalidierung.
- WS-Close-Codes 4001/4003 mit zwei Clients.
- Client: pure Logik (Close-Code-Unterscheidung, Recovery-Routine) als Modul-Tests; Dialoge manuell per UAT.

## Nicht im Umfang (Teilprojekt 3)

- Nur-Lesen-Rechte / Rollen pro Mitglied
- Mehrere Admins, Admin-Beförderung, Besitz-Übertragung von Schreibtischen
- E-Mail-Versand von Einladungen (Code wird manuell weitergegeben)
- Offline-Editing, Web-Client (unverändert spätere Teilprojekte)
