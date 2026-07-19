# Plan: Pencil-Zeichnen MVP (Teilprojekt E)

Spec: `docs/superpowers/specs/2026-07-18-pencil-zeichnen-design.md` · Branch `feature/inline-viewer`

### Task 1: core — Stroke-Modell und reine Funktionen (TDD)
`packages/core/src/ink.ts`: Typ `Stroke`, `addStroke(s, stroke)` (Validierung: docId
existiert, page ≥ 1 ganz, tool bekannt, ≥ 2 endliche Punkte, width > 0; id default uid()),
`removeStroke(s, strokeId)` (wirft bei unbekannter id), `strokesFor(s, docId, page)`.
`model.ts`: `strokes?: Stroke[]` am DesktopState, `emptyState()` mit `strokes: []`.
Tests `ink.test.ts`; Kompatibilitätstest: State ohne strokes-Feld funktioniert.

### Task 2: core — Commands registrieren (TDD)
`commands.ts`: Handler `addStroke`/`removeStroke` mit Payload-Validierung (stroke-Objekt
feldweise prüfen, CommandError-Wrap). Tests in bestehender Command-Testdatei ergänzen.

### Task 3: Client — inkMath (TDD)
`src/lib/inkMath.ts`: `toBase(p, renderedWidth, base)` / `toScreen(p, renderedWidth, base)`,
`distPointToSegment(p, a, b)`, `hitStroke(stroke, p, toleranz)`. Reine Funktionen mit Tests.

### Task 4: Client — PageRenderer meldet Basisgröße
Neuer optionaler Callback `onbasesize?: (s: Size) => void`, gefüllt aus
`pg.getViewport({ scale: 1 })`. Kein Verhaltensbruch für bestehende Nutzer.

### Task 5: Client — InkOverlay.svelte
Canvas-Overlay über `.page` (PageRenderer): rendert `strokesFor(state, docId, page)`
skaliert (Faktor renderedWidth/base.w × dpr), Marker mit globalAlpha 0.35. Aktives
Zeichnen: pointerdown (nur aktives Werkzeug) → capture, getCoalescedEvents sammeln,
Live-Vorschau; pointerup → `addStroke`. Radierer: hitStroke → `removeStroke`.
pointercancel verwirft die Vorschau. `desynchronized: true`, `touch-action: none`,
pointer-events nur bei aktivem Werkzeug.

### Task 6: Client — DocViewer-Werkzeugleiste
Tool-State (`'pen' | 'marker' | 'eraser' | null`), drei Toggle-Buttons im Kopf
(closest('button')-Guard deckt sie ab), InkOverlay in `.body` einbinden, Wisch-Blättern
bei aktivem Werkzeug unterdrücken.

### Task 7: Verifikation
`npm test`, `npm run check`, `npm run build`; Playwright-E2E: Stroke zeichnen → Command
auf dem Draht + persistiert nach Reload + zweites Fenster sieht ihn live; Radierer löscht;
Blättern zeigt seitenrichtige Strokes. UAT-Punkte in die Sammelliste (Block A6).
