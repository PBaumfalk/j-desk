# Design: Weitere Dateitypen — Bilder nativ, Vorschau-PDF via Euro-Office (2026-07-18)

Branch: `feature/inline-viewer` · Muster: Core-Modul + Commands, generische Command-Route,
Svelte-Komponenten; Server-Caches nach dem jlcache-Vorbild.
Kontext: Bisher ist alles strikt PDF (Upload prüft Magic-Bytes, pdfjs rendert). Im
j-lawyer-Modus bekommen Nicht-PDF-Dokumente zwar Karten, zeigen aber nur den Fehlerzustand.

## Entscheidungen (Nutzer, 2026-07-18)

1. **Alle Dateitypen mit echter Vorschau**, umgesetzt als **Vorschau-PDF-Konvertierung
   via Euro-Office DocumentServer** (https://github.com/euro-office — OnlyOffice-Fork,
   AGPL, eigener Docker-Container). Kein eingebetteter Editor/iframe: Die Vorschau läuft
   durch die bestehende PDF-Pipeline, damit ALLE Schreibtisch-Werkzeuge funktionieren.
2. **Bilder nativ** (JPG/PNG/GIF/WebP) — ohne Konvertierung, volle Qualität.
3. **Upload wird generisch**; der Toolbar-Knopf wird ein einzelnes **„＋"** mit Menü
   „Datei…" / „Zettel…".
4. **Reine Vorschau, kein Bearbeiten.** Die Editor-Fähigkeit des Containers ist bewusst
   NICHT Teil dieser Runde.

## Datei-Arten (`kind`)

Klassifizierung serverseitig aus Magic-Bytes, Fallback Dateiendung:

- `pdf` — wie bisher.
- `image` — JPG, PNG, GIF, WebP. Nativ dargestellt.
- `convertible` — ODT, ODS, ODP, DOCX, XLSX, PPTX, RTF, TXT, CSV, HTML, EML
  (die vom DocumentServer unterstützten Eingangsformate; Liste in `convert.ts` zentral).
- `other` — alles Übrige (ZIP, MSG, unbekannt). Generische Karte, keine Vorschau.

`kind` wird Teil des `Doc`-Objekts im `DesktopState` (Feld `kind?: FileKind`, Default
`'pdf'` für Alt-States — abwärtskompatibel wie `cutouts`). Der Server setzt es beim
Upload und beim j-lawyer-Abgleich; `addDoc`-Command nimmt es optional entgegen.

## Server

- **`packages/server/src/convert.ts`** kapselt die Konvertierung (Interface bewusst
  konverter-agnostisch — Plan B LibreOffice headless bliebe API-gleich):
  - Konfiguration `EUROOFFICE_URL` + `EUROOFFICE_JWT_SECRET` (Env). **Ohne Konfiguration
    ist Konvertierung deaktiviert** — `convertible` verhält sich wie `other`, die UI
    zeigt einen Hinweis („Vorschau-Dienst nicht konfiguriert").
  - Ablauf: OnlyOffice-kompatible ConvertService-API (JSON, JWT-signiert, async mit
    Polling). Der DocumentServer lädt die Quelldatei über eine **kurzlebige
    Einmal-Ticket-URL** unseres Servers (Muster ws-ticket: 60 s TTL, einmalig,
    ungeauthentifizierter GET nur mit gültigem Ticket — Docker-Netz-tauglich).
    Ergebnis-PDF wird heruntergeladen und gecacht.
  - **Cache** auf Platte: `dataDir/convcache/<fileId>-<contentHash>.pdf`; im
    j-lawyer-Modus Schlüssel `<docId>-<changeDate>` (wie jlcache). Konvertierung beim
    ersten Vorschau-Abruf; parallele Anfragen dedupliziert (In-Flight-Map).
- **`GET /api/v1/files/:id/preview`** liefert das Vorschau-PDF:
  - `pdf` → Original (Redirect-frei, gleiche Bytes).
  - `convertible` → Cache oder Konvertierung anstoßen; solange sie läuft `202` mit
    `{ status: 'converting' }` (Client pollt), bei Fehler/deaktiviert `409` mit Grund.
  - `image`/`other` → `404` (Bilder brauchen keine Vorschau, other hat keine).
  - Berechtigung wie `GET /files/:id` (Desk-Bindung bzw. j-lawyer-Metadatenprüfung).
- **Upload** (`POST /files` bzw. j-lawyer-Upload): Magic-Byte-Prüfung wird zur
  Klassifizierung (nichts wird mehr abgelehnt außer Größenlimit); Antwort enthält `kind`.
- **j-lawyer-Abgleich:** neue Karten bekommen `kind` aus dem Dateinamen der Akte
  (Endung; Magic-Bytes erst beim ersten Inhaltsabruf nachgeschärft, falls abweichend).

## Core

- `Doc.kind?: 'pdf' | 'image' | 'convertible' | 'other'` (Default pdf); `addDoc` nimmt
  `kind` optional; `isValidState` toleriert das Feld. Keine weitere Core-Logik —
  Werkzeuge bleiben kind-agnostisch (sie arbeiten auf Seiten/Basiskoordinaten).
- Bild-Dokumente: `pageCount` ist konzeptionell 1; `extractPage`/Konvolut behandeln
  Bilder als Ein-Seiten-Dokumente (Basiskoordinaten = Bildpixel).

## Client

- **„＋"-Knopf:** ersetzt „＋ PDF" und „＋ Zettel" durch ein Menü (Muster Zettel-Typwahl):
  „Datei…" (öffnet den generischen Datei-Dialog, multiple) / „Zettel…" (bisheriges
  Typwahl-Menü). Drag-and-drop akzeptiert dieselben Typen.
- **DocCard:** verzweigt nach `kind` — `image`: `<img>`-Miniatur direkt aus
  `getFileUrl`; `convertible`: Thumbnail aus dem Vorschau-PDF (bestehende
  thumbnails.ts-Pipeline mit preview-Quelle), solange die Konvertierung läuft
  Platzhalter „Vorschau wird erstellt…" mit Poll; `other`: generische Karte mit
  Typ-Icon (Endung groß, dezentes Blatt-Symbol) — Doppelklick öffnet NICHT, Kontextmenü
  ohne „Aufschlagen".
- **Viewer:** `image` → Bildansicht als eine „Seite" (Bildmaße = Basiskoordinaten;
  Zeichnen/Stempel/Fahnen/Tipp-Ex/Schwärzung/Schere funktionieren; Pager entfällt wie
  bei `pageOnly`); `convertible` → bestehender PDF-Viewer mit preview-Quelle (dazu
  bekommt PageRenderer/fileCache einen optionalen `source: 'original' | 'preview'`).
- **Fehlerbilder:** Konverter nicht konfiguriert/down → Karte wie `other` plus Toast
  beim Aufschlag-Versuch („Vorschau-Dienst nicht erreichbar"); nächster Versuch
  konvertiert erneut.

## MCP

`get_document_text` (OCR/Anonymisierung, PDF-only) nutzt für `convertible` das
Vorschau-PDF; `image` und `other` liefern eine klare Fehlermeldung („kein Text-Inhalt
verfügbar" — die Anonymisierung ist bewusst PDF-only, Bild-OCR wäre eine eigene Runde).
`get_desk` liefert `kind` mit (nicht anonymisiert).

## Deployment

`docs/deployment/` bekommt ein Compose-Beispiel für den Euro-Office DocumentServer
(Container + JWT-Secret + gemeinsames Netz mit dem Digital-Desktop-Server) inklusive
Hinweis auf Größe und darauf, dass ohne den Container alles außer der
Konvertierungs-Vorschau normal funktioniert.

## Tests

- Server: convert.ts gegen einen **Fake-DocumentServer** (node:http, Muster
  testJLawyer.ts) — Happy Path, Async-Polling, JWT, Ticket-Einmaligkeit, Ausfall,
  deaktiviert; preview-Route je kind; Klassifizierung (Magic-Bytes-Fixtures).
- Core: `kind`-Feld (Default, Validierung, addDoc-Durchreichung).
- Client: bestehendes Muster (keine Komponententests) — check/build + Chrome-E2E-Runde;
  UAT-Block A10.

## Nicht in dieser Runde

Bearbeiten im Euro-Office-Editor; HEIC/TIFF (Browser-Support unklar — `other`);
serverseitige Bild-Thumbnails (Client skaliert selbst); Konvertierungs-Vorab-Lauf für
ganze Akten (Konvertierung bleibt lazy beim ersten Anschauen).
