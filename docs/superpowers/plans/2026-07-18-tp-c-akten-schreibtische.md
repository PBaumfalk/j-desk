# Plan: TP-C Akten-Schreibtische (j-lawyer als führende Dokumentquelle)

Spec: `docs/superpowers/specs/2026-07-17-browser-jlawyer-rework-design.md` · Branch `feature/inline-viewer`
Voraussetzung: TP-B-Kern ist gebaut (jlawyer.ts, Login-Modus, /api/v1/cases — Commit 26bdf17).

> **BLOCKER für den Start: API-Spike gegen eine echte j-lawyer-Instanz.** Der Nutzer stellt
> Zugangsdaten einer Test-Instanz bereit; ein Wegwerf-Skript klärt exakte Feldnamen der
> cases/documents-Antworten, Inhalts-Kodierung (Base64 vs. binär) und die beste API-Version
> je Endpunkt (v1 … v7). Erkenntnisse fließen in `jlawyer.ts` ein. Ohne Spike kein Task 2+.

### Task 1: Aktenliste im Client
Nach j-lawyer-Login (JLAWYER_URL-Modus) ersetzt eine Aktenliste den DeskSwitcher:
`GET /api/v1/cases`, clientseitige Suche über Aktenzeichen/Rubrum, Klick öffnet den
Akten-Schreibtisch. Ohne JLAWYER_URL bleibt der bisherige DeskSwitcher.

### Task 2: jlawyer.ts erweitern (nach Spike)
`listDocuments(caseId)`, `getDocumentContent(docId)` (mit Platten-Cache: Schlüssel
Dokument-ID + Änderungsdatum), `createDocument(caseId, name, bytes)`. Fake-j-lawyer
in den Tests entsprechend ausbauen.

### Task 3: Desk pro Akte + Abgleich
`GET /api/v1/cases/:id/desk`: Desk wird über die Akten-ID adressiert (deskStore:
desks.id = j-lawyer-Akten-ID, bei Erstöffnung angelegt). Abgleich bei jedem Öffnen:
neue j-lawyer-Dokumente bekommen Karten im „Eingang"-Bereich (Spalte links, gestaffelt);
Karten gelöschter Dokumente werden entfernt (inkl. Strokes/Links via removeDoc).
j-lawyer ist führend; docs referenzieren Dokument-ID + Änderungsdatum + Dateiname.

### Task 4: Dokumentinhalt und Upload über den Server
`GET /api/v1/documents/:id/content` (Berechtigungsprüfung per j-lawyer-Metadatenabruf
mit Session-Credentials, Platten-Cache); Upload `POST /api/v1/cases/:id/documents`
per document/create — Karte erst nach bestätigtem Anlegen (kein Optimismus).
Client: fileId → j-lawyer-Dokument-ID, fileCache-Schlüssel um Änderungsdatum ergänzen.

### Task 5: Fehlerbilder
j-lawyer nicht erreichbar → Banner „j-lawyer nicht erreichbar" (Offline-Sperr-Muster),
gecachte PDFs bleiben lesbar; 401 mitten in der Sitzung → Logout mit Hinweis;
Dokument extern gelöscht → saubere Meldung im Viewer.

### Task 6: E2E-Verifikation gegen den Fake + UAT-Checkliste gegen die echte Instanz
Playwright gegen Fake-j-lawyer (Login → Aktenliste → Akte öffnen → Karte aus Eingang
ziehen → PDF ansehen → Upload → zweites Fenster live). Manuelle UAT-Punkte für die
echte Instanz in die Sammelliste (Block D).
