# Open-Source-Referenzmatrix für DigitalDesk

Datum: 2026-07-18. Zweck: Sechs Projekte als **Referenzbibliothek** untersuchen —
technische und konzeptionelle Muster, die für den bestehenden
SvelteKit-/Svelte-5-/Fastify-/SQLite-Stack nützlich sind. Ausdrücklich **kein**
Ziel: eines dieser Projekte übernehmen oder den bestehenden Stack neu bauen.

## Lizenz-Leitplanken (bindend)

- **Kein Code** aus AGPL-/GPL-/source-available-Projekten in das DigitalDesk-Repo
  — auch keine „übersetzten" 1:1-Portierungen von Strukturen/Algorithmen.
- **LeedPDF** (AGPL-3.0): nur konzeptionell, bis eine Lizenzentscheidung
  bewusst getroffen ist (kommerzielle Lizenz existiert).
- **tldraw** (proprietär/source-available, Produktionslizenz + Wasserzeichen bei
  Gratisnutzung): nur Architektur-/UX-Lehrbuch, keine Abhängigkeit.
- **Rnote** (GPL-3.0): nur konzeptionell.
- **Excalidraw** (MIT), **Drawnix/Plait** (MIT), **Papermerge** (Apache-2.0):
  erlauben Codeübernahme; wegen Stack-Mismatch (React/Angular/Python) ist
  Nachbau der Muster in eigenem Svelte-Code trotzdem der richtige Weg.

## Überblick (Lizenz · Rolle · wichtigste Lehre)

| Projekt | Lizenz | Verdikt | Wichtigste Lehre für DigitalDesk |
|---|---|---|---|
| Excalidraw | MIT | nur konzeptionell | Flaches Elementmodell, Fractional-Index-Z-Order, Delta-Undo, Zwei-Ebenen-Canvas, JSON-Format mit getrennter `files`-Ablage |
| LeedPDF | AGPL-3.0 | nur konzeptionell | Zwei-Canvas pro Seite (PDF + Zeichenebene), Annotationen in **Basiskoordinaten**, Sticky Notes als DOM-Overlay, `.lpdf`-ZIP + Zip-Slip-Validierung |
| tldraw | proprietär | nur Architektur-Referenz | Hybrid DOM+Canvas-Overlay, Records+Signals, **Pro-Typ-Migrationen**, ShapeUtil-Erweiterung, Diff-Undo mit Marks/Bail, Agent-Action-Schema |
| Drawnix/Plait | MIT | adaptieren (Muster) | „with"-Decorator-Plugins als Werkzeugkasten, WeakMap trennt Dokument- vs. Interaktionszustand |
| Rnote | GPL-3.0 | nur konzeptionell | Stroke = Bezier-Segmentliste + Druck pro Punkt, Prediction-Puffer fürs latenzarme Inking (Google `ink-stroke-modeler`, Apache-2.0, separat prüfbar) |
| Papermerge | Apache-2.0 | adaptieren (Konzepte) | OCR/teure Jobs als async Worker, DB-native Volltextsuche (SQLite **FTS5**), atomare Seitenoperationen, Dokumentversionierung |

---

## Excalidraw — technische Referenz (MIT)

- **Repo/Lizenz:** github.com/excalidraw/excalidraw · MIT (verifiziert `LICENSE`) · Lizenzrisiko: keins.
- **Pakete:** `packages/element` (Elementmodell, Bindings, Gruppen, Fractional-Indexing, Store/Delta), `packages/excalidraw` (React-Editor, Renderer, Scene, History), `packages/fractional-indexing`.
- **Rendering:** reines Canvas 2D; **zwei Ebenen** — `staticScene` (fertige Elemente, seltener neu) + `interactiveScene` (Selektion/Handles/Cursor, `throttleRAF` pro Pointer-Move). SVG nur beim Export.
- **Objektmodell:** **flache Liste**, `ExcalidrawElement` als geschlossene Discriminated Union; Basis mit x/y/w/h/angle, `version`/`versionNonce`, `index: FractionalIndex`, `groupIds[]`, `frameId`, `boundElements`, `customData?`. Scene mit `Map` für O(1)-Lookup.
- **Viewport:** Kamera als `scrollX/scrollY/zoom` im globalen AppState; Welt- vs. Bildschirmkoordinaten strikt getrennt; `setViewportRect()` mit Fit-Semantik.
- **Pointer/Stylus:** native Pointer Events, `pointerType` durchgereicht; eigenes leichtes `gesture.ts` (Pinch). **Kein** Tilt/Pencil-Pressure-Rendering — hier ist DigitalDesks Anspruch höher.
- **Auswahl/Z-Order/Bindings:** Auswahl im AppState; **Fractional Indexing** statt Array-Index (konfliktfreies Reorder); Bindings bidirektional (`startBinding`/`endBinding` ↔ `boundElements`), fixe Ankerpunkte.
- **Undo/Redo:** Delta-Modell über `Store` (`ElementsDelta`/`AppStateDelta`), `CaptureUpdateAction` = IMMEDIATELY/NEVER/EVENTUALLY steuert, was history-fähig ist. Sauberer als Vollzustands-Snapshots.
- **Dateiformat:** `.excalidraw` = JSON `{type, version, elements[], appState, files}`; Binärdaten separat in `files` (Elemente referenzieren nur `fileId`). **Direktes Vorbild für `.jdesk`-Kern.**
- **Custom Shapes:** **kein** Plugin-System; geschlossene Union → neuer Typ nur per Fork. `customData` nur Metadaten. → DigitalDesk von Anfang an offenes Elementmodell bauen.
- **PDF.js:** keine.
- **Einbettung:** `@excalidraw/excalidraw` ist **React-Komponente** (react peer dep) → in Svelte nicht einbettbar; nur API-Design-Vorbild.
- **Realtime:** Reconciliation über `version/versionNonce` (für lokale App Overkill).
- **Performance:** Zwei-Canvas-Trennung, `throttleRAF`, Fractional Index, Map-Lookup, deterministisches Rough.js-Seed-Caching.
- **Eignung/Empfehlung:** **nur konzeptionell.** Muster (flaches Modell, Fractional Index, Delta-Undo, Zwei-Ebenen-Canvas, JSON+files-Trennung) in eigenem Svelte-Code neu bauen; nicht einbetten, nicht forken.

## LeedPDF — konzeptionelle Referenz (AGPL-3.0, nur Konzept)

- **Repo/Lizenz:** github.com/rudi-q/leed_pdf_viewer · AGPL-3.0 (dual-lizenziert, kommerzielle Lizenz erhältlich) · Risiko: Netzwerk-Copyleft → **kein Code/keine abgeleiteten Snippets**.
- **Stack:** SvelteKit 2.61, Svelte 5.55, pdfjs-dist 5.7, Tauri 2, `pdf-lib`, `jszip`. Kern: `PDFViewer.svelte`, `drawingStore.ts`, `drawingUtils.ts`, `gestureUtils.ts`, `lpdfExport.ts`.
- **Rendering:** **zwei `<canvas>` pro sichtbarer Seite** — `pdfCanvas` (PDF.js `page.render`) + deckungsgleiche transparente `drawingCanvas` darüber. DPR-Skalierung (`canvas.width = viewport.width * outputScale`, `context.scale(...)`). Nur aktuelle Seite gerendert.
- **Annotationsebenen:** Zeichen-Canvas absolut deckungsgleich; zusätzliche **DOM-Overlays** (Sticky Notes/Text/Pfeile/Stempel) mit eigenen z-index. **Koordinaten in Basis-Viewport (Skalierung 1.0, Rotation 0)** + `relativeX/Y` (0–1); bidirektionale Transformation Pointer↔Basis. → **Kernkniff für zoom-/rotationsstabile Annotationen.**
- **Pointer/Stylus:** durchgängig Pointer Events, `setPointerCapture`; `pressure` gespeichert, aber **nicht** in Linienbreite verrechnet; **kein** `getCoalescedEvents`; Glättung per quadratischer Bezier + Douglas-Peucker; `touch-action: none`; robuste Pinch-Erkennung über feste Pointer-ID-Paare (gegen iPadOS-Ghost-Pointer).
- **Sticky Notes:** eigenes Modell mit Basis- + Relativkoordinaten, Rotationsausgleich; **DOM-Overlay statt Canvas** → natives Editieren/Resizing.
- **Zoom/Pan:** Rad+Ctrl, Pinch (rAF-gebatcht, Fokuspunkt-Erhalt), Zwei-Finger-Pan mit Inertia; während Geste nur CSS-Transform, Commit am Gestenende.
- **Undo/Redo:** einfacher Stack **nur für Zeichenpfade** (50); Notizen/Text/Pfeile **nicht** erfasst → reale Grenze des naiven Stacks; DigitalDesk braucht ein einheitliches Command-Modell über alle Objekttypen.
- **Persistenz/Format:** localStorage-Autosave + `.lpdf`-ZIP (`original.pdf` + `annotations.json`) mit **Zip-Slip-Schutz, Größenlimits, PDF-Header-Prüfung**. → Validierungs-Checkliste für `.jdesk`.
- **Tauri:** Desktop-Wrapper, `isTauri`-Feature-Detection, ein Codebase. Für DigitalDesk (Browser-only) nur konzeptionell.
- **Empfehlung:** **nur konzeptionell.** Zwei-Canvas-Muster, Basiskoordinaten, Pointer-Robustheit, DOM-Sticky-Notes, ZIP-Validierung als eigene Neuimplementierung.

## tldraw — Architektur-/UX-Referenz (proprietär, keine Abhängigkeit)

- **Repo/Lizenz:** github.com/tldraw/tldraw · tldraw Proprietary License (Produktion nur mit Key; Gratis = Wasserzeichen) · Risiko: für Anwaltssoftware inakzeptabel → **kein install, kein Copy-Paste**.
- **Pakete:** `editor`, `tlschema` (Records/Validierung/Migrationen), `store`, `state`/`state-react` (Signals), `tldraw` (React-UI), `sync*`.
- **Rendering (Hybrid — Kernvorbild):** persistente Shapes als **HTML/SVG (React)** in CSS-transformiertem Layer (z-index 300); transiente/hochfrequente UI (Brush, Handles, Snaps, Cursor, Scribble) auf **Canvas-Overlay** (z-index 500). Off-screen = `display:none` (kein DOM-Rebuild); **R-Tree**-Culling, „Bounds Epoch" gegen unnötige Neubewertung.
- **Records/Store:** Records = Source of Truth; `TLStore` + Signals (feingranular, lazy). Trennung Document-State (persistiert) vs. Session-State (Kamera/Selektion, ephemer). Framework-agnostischer Kern → **günstig für Svelte-5-Runes** (konzeptionell nah an Signals).
- **Migrationen (Vorbild `.jdesk`):** **kein globaler Versionszähler**, sondern **pro Record-Typ eigene benannte Migrationssequenz**; Snapshots tragen Schema-Info; Validierungsfehler → `onValidationFailure`-Recovery statt Hard-Fail.
- **Custom Shapes:** `ShapeUtil`-Subklasse mit `getDefaultProps`/`getGeometry`/`component`/`getIndicatorPath`; `BaseBoxShapeUtil`; typsichere Registry per Modul-Augmentation. → Vorbild für `PageInstanceUtil`/`CutoutUtil`/`NotizzettelUtil`/`SchnurUtil`.
- **Bindings:** eigene Records (`fromId`/`toId`) mit `BindingUtil`; **normalisierte Anker (0–1)**. → direkt für „Schnüre".
- **Undo/Redo (Vorbild MCP):** **diff-basiert**, `RecordsDiff` (added/updated/removed), nur `source:'user'` getrackt; `HistoryManager` mit `run()`/`batch()`-Transaktionen, benannte **Marks**, `bailToMark()` (Abbruch ohne Redo-Push), `squashToMark()`. → Blaupause für rückgängig machbare, atomare Agent-Aktionen.
- **Assets:** Shape referenziert nur `assetId` → `TLAsset`-Record; `TLAssetStore`-Interface mit Base64/IndexedDB/S3. → PDF-Blobs/Seiten-Renderings hinter Interface im `.jdesk`/SQLite.
- **Agenten:** offizielles Muster (`agent-template`): Zod-Action-Schemas + `sanitizeAction()` (LLM-Fehler korrigieren) + `applyAction()`; Streaming; Kontext = Screenshot + strukturierte Shape-Daten; läuft durch dieselbe History → automatisch undo-fähig. → **direkte Blaupause für MCP-Commands.**
- **Performance:** R-Tree + `display:none`, Signal-Reaktivität, Batching, stabilisierter Zoom, Geometrie-Caching, Level-of-Detail.
- **Empfehlung:** **nur Architektur-/UX-Referenz.** Muster in Svelte nachbauen; kommerzielle Lizenz nur als bewusste separate Kaufentscheidung.

## Drawnix / Plait (x-plait) — Werkzeug-Architektur (MIT)

- **Repo/Lizenz:** github.com/plait-board/drawnix + x-plait · beide MIT · Risiko: keins.
- **Kernmuster:** Slate-artige **„with"-Decorator-Plugins**: `PlaitPlugin = (board) => board` — überschreibt gezielt Board-Methoden (z. B. nur `pointerDown`/`pointerMove` eines Zeichenwerkzeugs), ruft Original weiter; Werkzeuge = **Verhaltensinjektion via Funktionskomposition**, keine Klassen-Registry. Offenes `PlaitElement`-Interface. **WeakMap** hält Werkzeug-/Interaktionszustand außerhalb des Dokumentmodells.
- **Eignung/Empfehlung:** **adaptieren.** Das Decorator-Muster passt gut zu Svelte 5s funktionalem Stil für den heterogenen Werkzeugkasten (Hand/Enthefter/Schere/Textmarker); WeakMap-Trennung Dokument- vs. Interaktionszustand übernehmen. Wegen React/Angular-APIs Nachbau statt Portierung.

## Rnote — Ink-/Stroke-Modell (GPL-3.0, nur Konzept)

- **Repo/Lizenz:** github.com/flxzt/rnote · GPL-3.0 · Risiko: hoch → **nur konzeptionell**, kein Code/keine portierten Strukturen.
- **Kernkonzepte:** Stroke = `Element` (Position + `pressure ∈ [0,1]`) + Folge von **`Segment`s als Enum** (`LineTo`/`QuadBezTo`/`CubBezTo`) → **Bezier-Segmentpfad statt Punktwolke** (glatter, sparsamer, skalierbar). Drei austauschbare Builder (`simple`/`curved`/`modeled`); `modeled` nutzt Googles **`ink-stroke-modeler`** (Apache-2.0) mit **Prediction-Puffer** (feste vs. vorläufige Segmente, zeitstempelbasiert). Pen-Handling als Zustandsmaschine.
- **Eignung/Empfehlung:** **nur konzeptionell.** Ziel-Datenmodell für die Canvas-Ink-Ebene: „Stroke = Bezier-Segmentliste + Druck pro Punkt + optionaler Prediction-Anhang". Falls prädiktive Glättung gewünscht: `ink-stroke-modeler` (Apache-2.0) **separat** und unabhängig von Rnote als Bibliothek prüfen.

## Papermerge — Backend-/DMS-Konzepte (Apache-2.0)

- **Repo/Lizenz:** github.com/papermerge/papermerge-core · Apache-2.0 (ocr-worker MIT) · Risiko: gering.
- **Kernkonzepte:** Feature-Modul-Architektur (`features/<domain>/{router,db,schema}`); **OCR als entkoppelter async Worker** (Celery/Redis, Tesseract/OCRmyPDF); **Volltextsuche DB-nativ** (Postgres `tsvector` + Trigger, keine externe Suchmaschine); **atomare Seitenoperationen** (löschen/umordnen/ausschneiden/verschieben/extrahieren) auf Seitenebene; **Dokumentversionierung** statt In-Place-Mutation.
- **Eignung/Empfehlung:** **adaptieren (Konzepte).** DigitalDesk nutzt J-Lawyer als DMS — Papermerge ist Inspirationsquelle: (a) teure Jobs (OCR/Rendering) als async Worker statt im Request; (b) lokale Volltextsuche über Notizzettel/Ausschnitte via **SQLite FTS5** (direkte Entsprechung zum tsvector+Trigger-Muster); (c) atomare Seitenoperationen als Domänenmodell; (d) Versionierung statt Mutation. Nachbau, kein Import (Python/Django-Mismatch).

---

## Was DigitalDesk ausdrücklich SELBST baut

Der fachliche Kern darf nicht von einem Whiteboard-Framework diktiert werden.
Eigenständig (das eigentliche Domänenmodell, framework-unabhängig als Source of
Truth): `DocumentReference`, `DocumentInstance`, `PageInstance`, virtuelle
Heftung/Entheftung, Seitenauszüge, quellengebundene `Cutout`s, Dokumentstapel
mit Seitenreihenfolge, Büroklammern/Ordner, J-Lawyer-Referenzen, `.jdesk`-Container,
Workspace-Revisionen, KI-Commands, rückgängig machbare Agentenaktionen.

Ein Papier auf dem Tisch ist eben nicht `{type:"rectangle", x, y}`, sondern trägt
Quellbezug (caseId/documentId/documentRevision/pageNumber/sourceHash), Platzierung
und Bindung. Das ist die Differenzierung, für die es keine fertige Komponente gibt.

## Zielarchitektur (Kurzform, Details in `../architecture/canvas-decision.md`)

```
DigitalDesk-Domänenmodell (framework-agnostisch, Source of Truth)
  ├── Workspace-Commands (auch von MCP-Agenten genutzt)
  ├── .jdesk-Serialisierung (Pro-Typ-Migrationen, Excalidraw+tldraw-Vorbild)
  ├── J-Lawyer-Referenzen
  ├── Dokument-/Seitenmodell (atomare Seitenoperationen, Papermerge-Vorbild)
  └── Agenten-API (Command-Schema + Sanitize + Transaktion/Mark, tldraw-Vorbild)
        │
        ▼
Rendering-/Interaktions-Layer (austauschbare Projektion des Modells)
  ├── DOM/Svelte für Karten, Text, Bedienelemente, PDF.js-Seiten
  ├── Canvas-Overlay (desynchronized) für Freihand/Textmarker/Schnüre/Auswahl
  └── PDF.js — Zwei-Canvas pro Seite (LeedPDF-Vorbild), Annotationen in Basiskoordinaten
```
