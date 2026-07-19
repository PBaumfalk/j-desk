# Rendering-Architektur: Entscheidungsmatrix

Datum: 2026-07-18. Frage: Wie rendert DigitalDesk seinen „Papier-Schreibtisch" —
bestehendes DOM fortführen, hybrides DOM/Canvas-Modell, eine Canvas-Engine
(Konva/PixiJS/Fabric), eingebetteter Excalidraw-Editor, oder eigener
Canvas-Renderer? Baut auf `../vision/2026-07-18-spike-dom-vs-canvas.md`
(DOM-Decke, Framework-Entkopplung, Inking) und
`../research/open-source-reference-matrix.md` (Muster echter Projekte).

## Empirische Ausgangslage (aus dem Spike, belegt)

- DOM-Decke bei kontinuierlichem Pan/Zoom: ~500–1.000 Knoten. 200 gleichzeitig
  sichtbar liegt darunter — **mit** Culling/Virtualisierung.
- Eine Canvas-Engine erzwingt **kein** React (Konva `svelte-konva`, PixiJS
  `svelte-pixi` sind framework-agnostisch). Die Divergenzen „React" und „Canvas"
  sind entkoppelt.
- Freihand-Inking braucht ohnehin eine eigene `desynchronized`-Canvas-Ebene —
  unabhängig davon, wie Karten gerendert werden.
- Alle untersuchten Ernstfall-Tools (Figma, tldraw, Excalidraw, Miro) nutzen
  Canvas/WebGL für die **dichte** Ebene; tldraw ist der explizite **Hybrid**
  (DOM/SVG für Shapes, Canvas-Overlay für transiente UI).

## Kriterien (gewichtet nach DigitalDesk-Bedarf)

200–1.000 sichtbare Objekte · mehrseitige PDFs · hochauflösende PDF-Tiles ·
Freihand mit Apple Pencil · Dokumente mit DOM-Text/Bedienelementen (Editieren,
A11y) · Touch/Maus/Trackpad · Barrierefreiheit · `.jdesk`-Serialisierung
(Domänenmodell-Unabhängigkeit) · KI-Agenten über Commands · bestehende
Svelte-5-App (Migrationsaufwand) · Wartbarkeit · Lizenzrisiko.

## Bewertung (++ sehr gut · + gut · o neutral · − schwach · −− kritisch)

| Kriterium | DOM weiter | **Hybrid DOM+Canvas** | Konva | PixiJS | Fabric.js | Excalidraw eingebettet | eigener Canvas-Renderer |
|---|---|---|---|---|---|---|---|
| 200–1000 Objekte | − (Culling nötig, Decke naht) | **+** | ++ | ++ | + | ++ | ++ |
| mehrseitige PDFs (PDF.js) | ++ | **++** | o (PDF bleibt DOM-Canvas) | o | o | −− (kein PDF) | + |
| hochauflösende PDF-Tiles | + | **++** | o | + (WebGL-Texturen) | o | −− | + |
| Freihand / Apple Pencil | − (DOM/SVG zu träge) | **++** (eigene Ink-Canvas) | + | ++ | o | − | ++ |
| DOM-Text / Bedienelemente / Editieren | ++ | **++** | −− (alles Canvas) | −− | −− | − (React-DOM) | −− |
| Touch/Maus/Trackpad | + | **+** | + | + | + | + | + |
| Barrierefreiheit | ++ | **++** (Karten bleiben DOM) | −− | −− | −− | o | −− |
| `.jdesk` / Domänenmodell-Unabhängigkeit | + | **++** (Renderer = Projektion) | − (Konva-Objektbaum) | + | −− (Fabric-Objektmodell drängt sich auf) | −− (fremdes Schema) | ++ |
| KI-Agenten über Commands | + | **++** (Commands ans Modell, nicht ans DOM) | o | o | − | o | ++ |
| bestehende Svelte-5-App | ++ (kein Umbau) | **++** (additiv) | + (`svelte-konva`) | + (`svelte-pixi`) | o | −− (React) | + |
| Wartbarkeit | + | **+** (zwei Ebenen synchron halten) | + | o (WebGL-Komplexität) | o | − (fremde Roadmap) | −− (viel Eigenbau) |
| Lizenzrisiko | ++ | **++** | ++ (MIT) | ++ (MIT) | ++ (MIT) | ++ (MIT, aber React) | ++ |

## Kritische Prüfung der Hybrid-Annahme

Die Vermutung „Hybrid ist richtig" hält der Prüfung stand, hat aber zwei reale
Risiken, die das Design adressieren muss:

1. **Koordinaten-Synchronität zweier Ebenen.** DOM-Karten und Canvas-Overlay
   müssen exakt dieselbe Welt-Transform (Pan/Zoom) teilen, sonst „schwimmen"
   Schnüre/Tinte gegenüber den Karten. Gegenmittel: **eine einzige Kamera-/
   Welt-Transform** als reaktive Quelle (Svelte-5-Rune), die beide Ebenen lesen;
   die Canvas-Ebene zeichnet mit `ctx.setTransform(...)` aus demselben Wert, den
   der DOM-Layer als CSS-`transform` nutzt.
2. **Hit-Testing über Ebenen.** Klicks müssen ans richtige Objekt gehen, egal ob
   es DOM (Karte) oder Canvas (Schnur/Tinte) ist. Gegenmittel: **Domänenmodell
   als Source of Truth** mit Geometrie/Hit-Test pro Objekttyp (ShapeUtil-artig,
   tldraw-Vorbild); der Renderer ist nur Projektion, Treffer werden gegen das
   Modell aufgelöst, nicht gegen DOM-Knoten.

Beide Risiken sind mit dem Muster „framework-agnostisches Domänenmodell +
austauschbarer Renderer" beherrschbar — genau der Weg, den die Referenzanalyse
(Excalidraw-Elementmodell, tldraw-Records/ShapeUtil, Plait-Decorator) nahelegt.

## Verworfene Optionen (mit Grund)

- **Reines DOM fortführen:** an der Objekt-/Werkzeugdichte der Vision (Freihand,
  100+ Schnüre, viele Seiten) läuft es in die DOM-Decke; SVG-Freihand ist zu träge.
  DOM bleibt aber die richtige Ebene für Karten/Text.
- **PixiJS:** WebGL-Mächtigkeit (Texturen, 60k+ Objekte) ist für den aktuellen
  Bedarf Overkill und bringt WebGL-Komplexität/Wartungslast; erst erwägen, wenn
  Objektzahlen die Canvas-2D-Grenze sprengen.
- **Fabric.js:** bringt ein eigenes Objektmodell mit, das mit unserem
  fachlichen Domänenmodell konkurriert — widerspricht „Modell ist Source of
  Truth, Renderer ist Projektion".
- **Eingebetteter Excalidraw-Editor:** React-Komponente (Stack-Bruch), kein
  PDF, fremdes geschlossenes Schema — nicht für ein juristisches
  Dokument-Domänenmodell geeignet.
- **tldraw als Abhängigkeit:** Produktionslizenz/Wasserzeichen (siehe
  Referenzmatrix) — ausgeschlossen; nur Architektur-Vorbild.
- **Eigener Vollcanvas-Renderer (alles Canvas):** verliert natives Text-Rendering,
  Editieren und Barrierefreiheit der Karten; hoher Eigenbau. Nur die
  **Overlay**-Ebene wird selbst gezeichnet, nicht die Karten.

## Entscheidung

**Hybrides Modell mit eigenem, framework-agnostischem Domänenmodell als Source of
Truth; der Renderer ist eine austauschbare Projektion.**

- **DOM/Svelte** für Karten, Notizzettel, Text, Bedienelemente und **PDF.js-Seiten**
  (Zwei-Canvas pro Seite nach LeedPDF-Vorbild: PDF-Canvas + transparente
  Annotations-Canvas; Annotationen in **Basiskoordinaten** speichern).
- **Canvas-Overlay** (`getContext('2d', { desynchronized: true })`) für die dichte,
  hochfrequente Ebene: Freihand/Textmarker (Apple Pencil), Schnüre,
  Auswahlrahmen. Vorerst **rohes Canvas 2D ohne Bibliothek**; wächst diese Ebene,
  ist **Konva via `svelte-konva`** (MIT, first-party Svelte) der Kandidat — PixiJS
  bleibt Reserve für den Fall extremer Objektzahlen.
- **Eine geteilte Kamera-/Welt-Transform** (Svelte-5-Rune) speist beide Ebenen.
- **Domänenmodell** trägt Geometrie/Hit-Test pro Objekttyp; MCP-Commands und
  Nutzer-Interaktion mutieren dasselbe Modell (undo-fähig, tldraw-Vorbild).

## Konsequenzen für laufende/nächste Arbeit

- **Inline-Viewer (aktuelles Teilprojekt):** Der `PageRenderer` wird bereits so
  gebaut, dass die PDF-Seite in einem klar abgegrenzten Element liegt — passend
  für die spätere deckungsgleiche Annotations-Canvas (LeedPDF-Muster). Keine
  Overlay-Ebene in dieser Stufe, nur Struktur offenhalten.
- **Domänenmodell:** `packages/core` wird schrittweise vom heutigen
  `Doc`/`Link`/`Stack` Richtung offenes, diskriminiertes Objektmodell
  (`PageInstance`, `Cutout`, `StickyNote`, `StringRelation`, `ThinkingObject`)
  erweitert — als framework-agnostische Source of Truth.
- **.jdesk-Format:** Pro-Objekttyp-Migrationssequenzen (tldraw), JSON-Kern mit
  getrennter Asset-Ablage (Excalidraw `files`), ZIP-Validierung (LeedPDF `.lpdf`).
- **Ink-Datenmodell:** Bezier-Segmentpfade + Druck pro Punkt (Rnote-Konzept);
  ggf. Googles `ink-stroke-modeler` (Apache-2.0) separat prüfen.
- **Undo/MCP:** Diff-/Transaktions-Modell mit benannten Marks + Bail
  (tldraw-Vorbild) als gemeinsame Basis für Nutzer- und Agentenaktionen.
- **Backlog:** Culling/Virtualisierung im DOM-Kartenlayer nachrüsten, bevor
  Schreibtische Richtung ~500 sichtbare Objekte wachsen; Level-of-Detail beim
  Auszoomen.

## Benchmarks (zum Selbstmessen)

- v1 (DOM vs. Canvas, Rechtecke): https://claude.ai/code/artifact/195ac6f7-5ef8-4dc3-a69d-b03d854d24df
- v2 (realistische Szene: 50 Dokumente, 200 Seiten, 50 Notizzettel, 100 Schnüre,
  Stapel, Freihand, Gruppen-Bewegung, Tile-Nachladen, Pencil-Latenz):
  https://claude.ai/code/artifact/60102d79-ae1e-400a-a823-277120c3c3ee
