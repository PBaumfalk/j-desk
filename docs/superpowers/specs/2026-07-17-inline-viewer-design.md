# Design: Inline-Viewer (PDF im selben Fenster aufschlagen)

Datum: 2026-07-17
Status: entworfen, vom Auftraggeber abschnittsweise freigegeben

## Kontext

Erstes von mehreren „kreativen Schreibtisch"-Teilprojekten, die auf der
Browser-Web-App (TP-A) aufsetzen — vor der j-lawyer-Anbindung. Ziel dieser
Ausbaustufe: Dokumente nicht mehr in einem neuen Browser-Tab öffnen, sondern
direkt auf dem Schreibtisch „aufschlagen" — als große, lesbare Karte an ihrer
Position. Fundament für spätere Teilprojekte (Notizzettel, Freihand/Textmarker),
weil deren Bühne die aufgeschlagene Seite ist.

Übergeordnete Feature-Vision (eigene, spätere Teilprojekte, hier NICHT enthalten):
- B · weitere Formate im Viewer (JPEG, Markdown, DOCX, ODT)
- C · Seiten auffächern (einzelne PDF-Seiten als eigene Karten)
- D · Notizzettel auf Schreibtisch/Seiten kleben
- E · Freihand & Textmarker (mit Apple Pencil auf dem iPad)
- F · bestehende Links als „Schnüre" visuell aufwerten

## Entscheidungen (mit Auftraggeber geklärt)

| Frage | Entscheidung |
|---|---|
| Darstellung | Große Karte an Ort und Stelle (kein Overlay, kein Panel) |
| Mehrere gleichzeitig offen | Ja — mehrere Dokumente unabhängig aufgeschlagen |
| Persistenz | Offen-Zustand, Größe und aktuelle Seite sind Teil des gespeicherten Schreibtischs, live synchronisiert |
| Blättern | Eine Seite groß; Pfeil-Buttons, Pfeiltasten, Wischen (Touch/iPad) |
| Formate in dieser Stufe | Nur PDF |
| „In neuem Tab öffnen" | Bleibt als separater Kontextmenü-Eintrag erhalten |

## Umfang und Abgrenzung

**Enthalten:** PDF auf dem Schreibtisch aufschlagen (Karte wächst an ihrer
Position zu großer, lesbarer Karte); eine Seite groß sichtbar; blättern per
Pfeil-Buttons, Wischen (Touch/iPad) und Pfeiltasten; Größe durch Ziehen an
einer Ecke verstellbar; Schließen per ✕ (zurück zur Miniatur); mehrere
gleichzeitig offen; Offen-Zustand, Größe und aktuelle Seite pro Schreibtisch
gespeichert und live synchronisiert.

**Nicht enthalten (spätere Teilprojekte):** andere Formate als PDF, Seiten
auffächern, Notizzettel, Freihand/Textmarker, Schnüre aufhübschen. Der Viewer
wird aber so gebaut, dass D und E später sauber andocken (die aufgeschlagene
Seite ist ihre Bühne — `PageRenderer` als wiederverwendbarer Seiten-Hintergrund).

**Ersetzt:** Der heutige „Öffnen"-Weg (Doppelklick/Kontextmenü → neues
Browser-Tab, aus TP-A) wird durch das Aufschlagen ersetzt. „In neuem Tab
öffnen" bleibt als separater Kontextmenü-Eintrag für das rohe PDF.

## Datenmodell

`Doc` in `packages/core/src/model.ts` erhält drei OPTIONALE Felder:

- `open?: boolean` — aufgeschlagen (true) oder Miniatur (undefined/false)
- `openSize?: { w: number; h: number }` — Größe der großen Karte in
  Weltkoordinaten; verstellbar durch Ziehen an der Ecke
- `page?: number` — aktuell sichtbare Seite, 1-basiert

Optional heißt: bestehende Schreibtische bleiben gültig (fehlt das Feld →
Dokument zu, Seite 1). `isValidState` bleibt unverändert kompatibel (prüft die
neuen Felder nicht hart; sie sind rein additiv). Keine Datenmigration.

Die Seitenzahl des PDFs (Gesamtzahl) kommt clientseitig aus pdfjs beim Laden und
ist reiner Anzeige-/Grenzwert — sie wandert NICHT ins Kernmodell.

## Commands

Vier neue Commands in `packages/core/src/commands.ts`, server-validiert wie alle
anderen; Namen kollidieren bewusst nicht mit der Client-Funktion `openDoc` in
`menus.ts`:

- `expandDoc { id }` — aufschlagen: `open=true`, `openSize` auf Standardgröße
  falls noch nicht gesetzt, `page` auf 1 falls noch nicht gesetzt
- `collapseDoc { id }` — zuklappen: `open=false` (Größe/Seite bleiben erhalten,
  damit erneutes Aufschlagen den Zustand wiederherstellt)
- `setDocPage { id, page }` — Seite wechseln; Kernmodell lehnt `page < 1` ab
  (Obergrenze klemmt der Client anhand der pdfjs-Seitenzahl)
- `resizeDoc { id, size }` — `openSize` setzen (positive Maße erzwungen)

Reine Zustandslogik in neuem Modul `packages/core/src/viewer.ts` (analog zu
`documents.ts`/`stacks.ts`), voll ohne Browser unit-testbar. Alle vier
Handler lehnen ein unbekanntes `id` sauber mit `CommandError` ab.

## Synchronisation

Kein neuer Speichermechanismus — die neuen Felder reisen im bestehenden
`DesktopState` über den vorhandenen Command-/Live-Sync-Weg. Beim Blättern und
Größe-Ziehen wird die Änderung lokal SOFORT angewandt und der finale Wert
ENTPRELLT (debounced) ans Backend geschickt — dasselbe Muster wie beim
Verschieben von Karten in `store.svelte.ts` (`applyLocal` + späterer
`command`). „Letzter Schreiber gewinnt" bei konkurrierendem Blättern, wie bei
Kartenpositionen.

## Komponenten (Client)

- **`PageRenderer.svelte`** (neu) — Props: `fileId`, `page`, Zielbreite.
  Rendert genau diese PDF-Seite scharf via pdfjs auf ein Canvas. Nutzt den
  bestehenden IndexedDB-PDF-Cache (Bytes wie in `thumbnails.ts`/`fileCache.ts`)
  plus einen kleinen In-Memory-Cache der zuletzt gerenderten Seite für flüssiges
  Blättern. Einzige Stelle mit pdfjs-Seitenrendering; später von Teilprojekt E
  (Annotationen) als Hintergrund wiederverwendbar. Fehlerpfad: ruhiger
  Platzhalter statt Absturz.
- **`DocViewer.svelte`** (neu) — die große aufgeschlagene Karte: rahmt den
  `PageRenderer`, zeigt Blätter-Pfeile + Seitenanzeige („3 / 12"), ✕ zum
  Schließen, Anfasser unten rechts zum Größe-Ziehen. Verschieben wie jede Karte
  (nutzt vorhandene `Doc.position`).
- **`DocCard.svelte`** (geändert) — rendert je nach `doc.open` entweder die
  Miniatur (wie bisher) oder delegiert an `DocViewer`. Doppelklick auf die
  Miniatur löst `expandDoc` aus. Im Kontextmenü (`menus.ts`) wird „Öffnen" zu
  „Aufschlagen"; neuer Eintrag „In neuem Tab öffnen" behält den bisherigen
  `window.open`-Weg auf das rohe PDF.

## Interaktion

- Blättern: Pfeil-Buttons, `←`/`→`-Tasten (wenn die Karte den Fokus hat),
  horizontales Wischen auf Touch/iPad.
- „Größer sehen" = Karte größer ziehen (kein separater Zoom-Regler — YAGNI; die
  Seite füllt immer die Kartenbreite). Der Schreibtisch-Zoom (Pinch/Trackpad)
  wirkt weiter auf die ganze Fläche.
- Öffnen: Doppelklick auf Miniatur bzw. Kontextmenü „Aufschlagen".
- Schließen: ✕ an der großen Karte → zurück zur Miniatur.

## Performance

Mehrere gleichzeitig offene PDFs rendern nur ihre aktuelle Seite und nur, wenn
sie im sichtbaren Bereich liegen; die gerenderte Seite wird gecacht und erst bei
Seiten- oder Größenwechsel neu gezeichnet.

## Fehlerbehandlung

- **Seite nicht renderbar / PDF defekt:** ruhiger Platzhalter („Seite kann nicht
  angezeigt werden"), Karte bleibt bedien- und schließbar.
- **PDF nicht geladen (offline / Server weg):** Ladehinweis; bleibt es aus,
  Platzhalter. Gecachte PDFs schlagen normal auf. Aufschlagen ist ein
  synchronisiertes Command und unterliegt der bestehenden Offline-Sperre.
- **`page` außerhalb des Bereichs:** Client klemmt auf 1…Seitenzahl; das
  Kernmodell verhindert `page < 1` bereits im Command.
- **Konkurrierendes Blättern:** „letzter Schreiber gewinnt", wie bei
  Kartenpositionen; Zustand bleibt konsistent.

## Tests

- **`packages/core`:** Unit-Tests für `viewer.ts` und die vier Commands —
  aufschlagen/zuklappen, Seite setzen mit Grenzprüfung (`page < 1` abgelehnt),
  Größe setzen (positive Maße), `expandDoc` auf unbekanntem Dokument schlägt
  sauber fehl. Zusätzlich: alte Zustände ohne die neuen Felder bleiben gültig
  (Abwärtskompatibilität).
- **Client-Module:** In-Memory-Seiten-Cache des `PageRenderer` als reine
  Funktion testbar (richtige Seite angefragt; Cache-Treffer bei Wiederholung);
  pdfjs gemockt wie in bestehenden Client-Tests.
- **Manuelle UAT-Checkliste:** aufschlagen; blättern per Pfeil/Taste/Wischen;
  Größe ziehen; mehrere gleichzeitig; Neuladen → alles liegt wieder gleich da;
  zweites Fenster → Live-Sync von Aufschlagen/Blättern; iPad-Touch.

## Folgearbeiten (außerhalb dieses Teilprojekts)

- Teilprojekte B–F (siehe Kontext). `PageRenderer` ist bewusst als
  wiederverwendbarer Baustein für E (Annotationen) angelegt.
- Architektur-Leitplanke aus dem Spike `docs/vision/2026-07-18-spike-dom-vs-canvas.md`:
  Freihand/Textmarker kommen später als eigene, über die Seite gelegte
  `desynchronized`-Canvas-Ebene (Hybrid nach tldraw-Vorbild, Svelte bleibt).
  Der `PageRenderer` soll die gerenderte Seite deshalb in einem klar
  abgegrenzten Element halten, über das sich eine solche Overlay-Ebene später
  deckungsgleich legen lässt (gleiche Zielbreite/Seitengeometrie). In dieser
  Stufe wird die Overlay-Ebene NICHT gebaut — nur die Struktur nicht verbaut.
