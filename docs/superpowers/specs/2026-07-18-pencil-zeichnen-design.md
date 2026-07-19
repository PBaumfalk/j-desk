# Teilprojekt E: Pencil-Zeichnen — Stift & Textmarker auf PDF-Seiten (MVP)

**Datum:** 2026-07-18 · **Branch:** `feature/inline-viewer` · **Status:** autonom aus der
Vision abgeleitet (docs/vision/2026-07-18-digitaldesk-vision.md, Spike dom-vs-canvas,
LeedPDF-Muster aus der Referenzmatrix); Produktentscheidungen unten sind im UAT zu bestätigen.

## Ziel

Auf einer aufgeschlagenen Karte (DocViewer) kann mit Stift oder Textmarker direkt auf der
PDF-Seite gezeichnet werden — nicht destruktiv (das PDF bleibt unverändert), pro Seite
gespeichert, live auf andere Fenster synchronisiert, auf iPad mit Apple Pencil und Finger.

## Nicht-Ziele (MVP)

Kein Undo/Redo-System (Radierer löscht strichweise), keine Farbwahl (feste Werkzeugfarben),
keine Strokes auf Miniaturen/Thumbnails, kein Export der Zeichnungen ins PDF, keine
Druckstärke-Modulation (Pencil-Pressure später), kein Lasso/Verschieben von Strichen.

## Datenmodell (core, LeedPDF-Muster: Basiskoordinaten)

```ts
export interface Stroke {
  id: string;
  docId: string;
  page: number;              // 1-basiert
  tool: 'pen' | 'marker';
  color: string;             // Hex, vom Werkzeug vorgegeben
  width: number;             // Strichbreite in Basiskoordinaten
  points: Vec2[];            // >= 2 Punkte, PDF-Seitenraum bei scale = 1 (Punkte)
}
// DesktopState.strokes?: Stroke[]  — optional: alte gespeicherte States haben das Feld nicht.
```

Basiskoordinaten = PDF-Viewport bei `scale: 1`. Damit sind Strokes unabhängig von
Viewer-Größe und devicePixelRatio; beim Rendern skaliert der Faktor
`renderedWidth / baseWidth`.

## Commands (generische Route, kein Server-Produktivcode)

- `addStroke { stroke }` — validiert: docId existiert, page ≥ 1 (Ganzzahl), tool bekannt,
  points ≥ 2 mit endlichen Koordinaten, width > 0. id default `uid()`.
- `removeStroke { strokeId }` — unbekannte id wirft (Konsistenz mit removeLink).

Beide laufen wie alle Commands optimistisch lokal + server-maßgeblich; WS-Broadcast
verteilt sie live.

## UI (Client)

- **Werkzeugleiste im DocViewer-Kopf:** drei Toggle-Knöpfe „✎" (Stift, dunkelblau #1d3557,
  Breite 1.5), „▆" (Marker, gelb #ffd166, Breite 9, halbtransparent gezeichnet), „⌫"
  (Radierer). Aktives Werkzeug ist hervorgehoben; erneuter Klick deaktiviert (= normale
  Bedienung: Wischen blättert, Kopf zieht).
- **InkOverlay.svelte:** absolut positioniertes Canvas exakt über dem Seiten-Canvas des
  PageRenderer. `pointer-events` nur bei aktivem Werkzeug; Canvas-Kontext mit
  `desynchronized: true`; Punkte via `getCoalescedEvents` (iPad-Latenz); `touch-action: none`.
  Während des Zeichnens lokale Vorschau; bei pointerup ein `addStroke`-Command.
  Radierer: Treffer = Abstand Punkt→Strichsegment < Schwelle (in Basiskoordinaten),
  löscht per `removeStroke`.
- **Blättern-Konflikt:** bei aktivem Werkzeug ist das Wisch-Blättern im Body deaktiviert;
  Seitenwechsel weiter über ‹/›/Pfeiltasten. Strokes wechseln mit der Seite.
- **PageRenderer** meldet zusätzlich die Basisgröße der Seite (`onbasesize`), damit das
  Overlay den Skalierungsfaktor kennt.

## Zu bestätigende Produktentscheidungen (UAT)

1. Feste Werkzeugfarben (blau/gelb) ohne Farbwahl — reicht das fürs Erste?
2. Radierer löscht ganze Striche (kein pixelweises Radieren) — akzeptabel?
3. Zeichnen nur bei explizit aktiviertem Werkzeug (kein automatischer Pencil-Modus) — ok?
   (Apple-Pencil-Erkennung `pointerType === 'pen'` als automatischer Stift wäre Ausbaustufe.)
