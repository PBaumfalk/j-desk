# Spike: DOM vs. Canvas für den DigitalDesk-Client

Datum: 2026-07-18. Anlass: Vor der Grundsatzentscheidung „bestehenden
Svelte/DOM-Stand evolvieren vs. Neubau auf Vision-Stack (React+Konva)" sollte
der eigentliche technische Knackpunkt geklärt werden: Reicht DOM-Rendering für
die Vision (200+ sichtbare Objekte, Freihand mit Apple Pencil), oder braucht es
eine Canvas-Engine — und erzwingt „Canvas" einen Wechsel zu React?

## Ergebnis (Kurzfassung)

1. **DOM reicht für den aktuellen Bedarf.** Empirische Decke DOM-basierter
   Infinite-Canvases: spürbare Framedrops ab ~500 (React Flow) bis ~1.000
   (rohe divs) Knoten bei kontinuierlichem Pan/Zoom. Das Vision-Ziel „200
   gleichzeitig sichtbar" liegt klar darunter — **sofern** Culling/
   Virtualisierung genutzt wird (nur sichtbare Karten im DOM).
2. **Canvas erzwingt NICHT React.** Konva, PixiJS und Fabric.js sind
   framework-agnostisch. Konva hat sogar first-party Svelte-Bindings
   (`svelte-konva`, inkl. SvelteKit-Anleitung), PixiJS `svelte-pixi`. Svelte
   `use:`-Actions binden imperative Libs sauber an den Lifecycle. → Die zwei
   Vision-Divergenzen „React" und „Canvas" sind **entkoppelt**.
3. **Der Zielweg ist ein Hybrid (tldraw-Modell).** DOM/Svelte für Karten und
   Text (natives Text-Rendering, A11y, eingebettete Inhalte „gratis"), plus
   eine **Canvas-Overlay-Ebene** für die dichte/hochfrequente Zeichenebene
   (Freihand, Textmarker, Schnüre, Auswahl-Handles). Das ist ein
   inkrementeller Migrationspfad, kein Full-Rewrite.
4. **Inking braucht ohnehin eine eigene Canvas-Ebene** — unabhängig vom Rest.
   Standard: `<canvas>`-Overlay mit `getContext('2d', { desynchronized: true })`,
   Pointer Events, `touch-action: none`, `getCoalescedEvents()` für glatte
   Linien, `getPredictedEvents()` für gefühlte Latenz, Apple-Pencil `pressure`.

## Konsequenz für die Grundsatzentscheidung

Die inkrementelle Evolution des bestehenden Svelte/DOM-Stands ist **tragfähig
bis in die Vision hinein**. Der einzige sachlich zwingende Canvas-Bedarf
(dichte Zeichenebene + Stift-Inking) ist als additive Overlay-Ebene auf Svelte
lösbar — ohne React, ohne Neubau. Ein React/Konva-Neubau ist damit nicht
technisch erzwungen, sondern wäre eine reine Präferenzentscheidung, die
funktionierenden, getesteten Code verwerfen würde.

## Wichtige Randbedingungen / Backlog

- **iPadOS-Mindestanforderung:** `getCoalescedEvents()`/`getPredictedEvents()`
  erst ab **Safari 18.2** (Ende 2024). Ältere iPads zeichnen funktionsfähig,
  aber ohne die glättenden Zwischenpunkte — bei der Stift-UX einplanen.
- **DOM-Skalierung braucht Disziplin:** Sobald sichtbare Kartenzahl Richtung
  ~500 geht, Culling/Virtualisierung (nur sichtbare Karten mounten,
  `content-visibility: auto`, `will-change: transform` sparsam) einführen —
  sonst greift die DOM-Decke. Der heutige Client rendert alle freien Karten
  ohne Culling; das ist bei kleinen Schreibtischen ok, bei großen nachzurüsten.
- **Level-of-Detail:** beim Auszoomen komplexe Karten durch Platzhalter
  ersetzen (semantic zoom).

## Belege

- Figma-Renderer (WebGL/WebGPU): figma.com/blog/building-a-professional-design-tool-on-the-web/
- tldraw Hybrid (DOM-Shapes + Canvas-Overlay, Off-screen `display:none`):
  tldraw.dev/sdk-features/performance
- Excalidraw (Canvas 2D, Zwei-Ebenen): deepwiki.com/zsviczian/excalidraw
- Miro (Canvas/WebGL, „browsers struggle with tens of thousands of DOM nodes"):
  educative.io/blog/miro-system-design
- DOM-Decke ~500–1000 Knoten: reactflow.dev/learn/advanced-use/performance ,
  dev.to/alanscodelog/handling-thousands-cards-on-an-infinite-canvas-4gea
- svelte-konva: konvajs.org/docs/svelte/ · svelte-pixi: svelte-pixi.com
- Inking: developer.chrome.com/blog/desynchronized ,
  developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents
  (Safari 18.2+: caniuse.com/mdn-api_pointerevent_getcoalescedevents)

## Interaktiver Benchmark

Eigenständige Messseite (DOM vs. Canvas, Live-FPS, Apple-Pencil-Latenz) zum
Selbstmessen auf Kanzlei-PC und iPad:
https://claude.ai/code/artifact/195ac6f7-5ef8-4dc3-a69d-b03d854d24df
