# Schreibtisch-Navigation & Touch-Bedienung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intuitive Schreibtisch-Navigation auf Maus/Trackpad UND iPad: Mausrad zoomt zum Cursor, ein sichtbares Bedienfeld unten (`−`/`+`/Übersicht + Vier-Wege-Pfeilpad), Karten per Finger verschiebbar, Zwei-Finger-Pinch-Zoom, Lang-Druck-Kontextmenü, plus ein `uid()`-Fallback für iPad-Upload über HTTP.

**Architecture:** Reine Zoom-/Pan-Mathematik bleibt in `packages/core/viewport.ts` (`zoomAt` vorhanden, `panBy` neu). Die gesamte Eingabe-Behandlung liegt in den Svelte-Komponenten: `Desktop.svelte` (Rad-Zoom, Pointer-Deltas aus `clientX/Y`, Zwei-Finger-Pinch/Pan, `touch-action: none`), neues `DeskControls.svelte` (Bedienfeld), `DocCard.svelte`/`StackCard.svelte` (Karten-Drag aus `clientX/Y`, Lang-Druck-Menü). Neuer Client-Helfer `uid.ts` ersetzt `crypto.randomUUID()`.

**Tech Stack:** TypeScript, `@digital-desktop/core`, Svelte 5 (Runes), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-schreibtisch-navigation-touch-design.md`

## Global Constraints

- Node ≥ 20; npm-Workspace-Monorepo; `packages/mcp` NICHT anfassen.
- Deutsch für UI-Texte/Kommentare/Commit-Messages; Commit-Präfixe `feat:`/`fix:`.
- Karten-/Stapel-Drag und Desk-Schwenk dürfen NICHT mehr `e.movementX/movementY` nutzen (auf Safari-Touch unzuverlässig) — Delta aus gemerkter `clientX/clientY`-Position, geteilt durch `vp.scale`.
- `touch-action: none` auf Schreibtischfläche UND Karten, sonst fängt der Browser Touch-Gesten ab.
- Zoom-Schrittfaktor Knöpfe: `1.25` (rein) bzw. `1/1.25` (raus). Pan-Schritt Pfeilpad: `120` Bildschirm-Pixel. `zoomAt` klemmt bereits auf `[0.15, 3]`.
- Tastatur-Pfeile bleiben dem aufgeschlagenen Dokument (Seiten-Blättern) vorbehalten — das Pfeilpad ist ein UI-Element, keine Tastenbindung.
- Tests: `npm test` (Vitest) nach jedem Task grün; `npm run check` ab dem ersten Client-Task ohne neue Fehler außer den vorbestehenden ARIA-/tabindex-Warnungen.

---

### Task 1: `panBy` in core + Test

**Files:**
- Modify: `packages/core/src/viewport.ts`
- Test: `packages/core/src/viewport.test.ts` (vorhanden — Fälle ergänzen; falls nicht vorhanden, neu anlegen mit dem Muster anderer core-Tests)

**Interfaces:**
- Consumes: `Viewport` aus `./viewport`.
- Produces: `panBy(vp: Viewport, dx: number, dy: number): Viewport` — verschiebt den Ursprung, Skala unverändert.

- [ ] **Step 1: Failing Test** — in `packages/core/src/viewport.test.ts` ergänzen:

```ts
import { describe, it, expect } from 'vitest';
import { panBy } from './viewport';

describe('panBy', () => {
  it('addiert das Delta auf x/y, lässt die Skala unverändert', () => {
    expect(panBy({ x: 10, y: 20, scale: 2 }, 5, -7)).toEqual({ x: 15, y: 13, scale: 2 });
  });
  it('ist bei Delta 0 identisch', () => {
    expect(panBy({ x: 3, y: 4, scale: 1.5 }, 0, 0)).toEqual({ x: 3, y: 4, scale: 1.5 });
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/core/src/viewport.test.ts`
Expected: FAIL — `panBy` existiert nicht.

- [ ] **Step 3: Implementierung** — in `packages/core/src/viewport.ts` ergänzen:

```ts
export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy };
}
```

- [ ] **Step 4: Test grün**

Run: `npx vitest run packages/core/src/viewport.test.ts && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/viewport.ts packages/core/src/viewport.test.ts
git commit -m "feat(core): panBy — Schreibtisch um ein Delta verschieben"
```

---

### Task 2: `uid()`-Fallback + Aufrufstellen ersetzen

**Files:**
- Create: `src/lib/uid.ts`
- Test: `src/lib/uid.test.ts` (neu)
- Modify: `src/lib/components/Desktop.svelte` (1 Stelle), `src/lib/components/DocCard.svelte` (2 Stellen), `src/lib/components/StackCard.svelte` (1 Stelle)

**Interfaces:**
- Consumes: nichts.
- Produces: `uid(): string` — im sicheren Kontext `crypto.randomUUID()`, sonst ein v4-UUID aus `crypto.getRandomValues` (überall verfügbar, auch auf `http://192.168…`).

- [ ] **Step 1: Failing Test** — `src/lib/uid.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { uid } from './uid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => vi.unstubAllGlobals());

describe('uid', () => {
  it('liefert ein gültiges v4-UUID-Format', () => {
    expect(uid()).toMatch(V4);
  });

  it('nutzt den Fallback, wenn crypto.randomUUID fehlt (unsicherer Kontext)', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }); // ohne randomUUID
    expect(uid()).toMatch(V4);
  });

  it('erzeugt unterschiedliche Werte', () => {
    expect(uid()).not.toBe(uid());
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/lib/uid.test.ts`
Expected: FAIL — `./uid` existiert nicht.

- [ ] **Step 3: Implementierung** — `src/lib/uid.ts`:

```ts
/** Stabile ID: crypto.randomUUID im sicheren Kontext, sonst v4 aus getRandomValues.
 *  crypto.randomUUID ist nur in sicheren Kontexten (https/localhost) verfügbar —
 *  getRandomValues dagegen überall, auch über http://<LAN-IP> (iPad im Heimnetz). */
export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // Version 4
  b[8] = (b[8] & 0x3f) | 0x80; // Variante
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}
```

- [ ] **Step 4: uid-Test grün**

Run: `npx vitest run src/lib/uid.test.ts`
Expected: PASS

- [ ] **Step 5: Aufrufstellen ersetzen** — in den drei Komponenten `crypto.randomUUID()` durch `uid()` ersetzen und `import { uid } from '../uid';` ergänzen:
- `src/lib/components/Desktop.svelte`: die `addDoc`-Zeile (`id: crypto.randomUUID()`).
- `src/lib/components/DocCard.svelte`: die `addLink`-Zeile und die `stackDocs`-Zeile.
- `src/lib/components/StackCard.svelte`: die `addLink`-Zeile.

Verifizieren: `grep -rn "crypto.randomUUID" src` → kein Treffer mehr.

- [ ] **Step 6: Tests + Typprüfung**

Run: `npm test && npm run check`
Expected: Vitest PASS; `svelte-check` ohne neue Fehler (nur vorbestehende Warnungen).

- [ ] **Step 7: Commit**

```bash
git add src/lib/uid.ts src/lib/uid.test.ts src/lib/components/Desktop.svelte src/lib/components/DocCard.svelte src/lib/components/StackCard.svelte
git commit -m "feat: uid()-Fallback statt crypto.randomUUID (iPad-Upload über HTTP)"
```

---

### Task 3: `DeskControls.svelte` + Eingabe-Umbau in `Desktop.svelte`

**Files:**
- Create: `src/lib/components/DeskControls.svelte`
- Modify: `src/lib/components/Desktop.svelte`

**Interfaces:**
- Consumes: `panBy`, `zoomAt`, `zoomToFit`, `allBoxes` aus core (Task 1 + vorhanden).
- Produces: `DeskControls.svelte` mit Props `{ onzoom: (factor: number) => void; onpan: (dx: number, dy: number) => void; onfit: () => void }`. `Desktop.svelte` behandelt Rad-Zoom, Pointer-Deltas, Zwei-Finger-Pinch/Pan und bindet `DeskControls` ein.

- [ ] **Step 1: `DeskControls.svelte` anlegen**

```svelte
<script lang="ts">
  let { onzoom, onpan, onfit }: { onzoom: (f: number) => void; onpan: (dx: number, dy: number) => void; onfit: () => void } = $props();
  const STEP = 120;
</script>

<div class="controls">
  <div class="pad">
    <button class="up" onclick={() => onpan(0, STEP)} aria-label="Nach oben">↑</button>
    <button class="left" onclick={() => onpan(STEP, 0)} aria-label="Nach links">←</button>
    <button class="right" onclick={() => onpan(-STEP, 0)} aria-label="Nach rechts">→</button>
    <button class="down" onclick={() => onpan(0, -STEP)} aria-label="Nach unten">↓</button>
  </div>
  <div class="zoom">
    <button onclick={() => onzoom(1 / 1.25)} aria-label="Verkleinern">−</button>
    <button onclick={onfit} aria-label="Übersicht">⤢</button>
    <button onclick={() => onzoom(1.25)} aria-label="Vergrößern">＋</button>
  </div>
</div>

<style>
  .controls { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 9000;
    display: flex; gap: 14px; align-items: center; }
  .pad { display: grid; grid-template-columns: repeat(3, 30px); grid-template-rows: repeat(2, 30px);
    gap: 3px; }
  .pad .up { grid-column: 2; grid-row: 1; }
  .pad .left { grid-column: 1; grid-row: 2; }
  .pad .down { grid-column: 2; grid-row: 2; }
  .pad .right { grid-column: 3; grid-row: 2; }
  .zoom { display: flex; gap: 4px; }
  button { border: none; background: rgba(255, 255, 255, .92); border-radius: 8px; cursor: pointer;
    width: 34px; height: 30px; font-size: 16px; line-height: 1; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  button:hover { background: #fff; }
  button:focus-visible { outline: 2px solid #2c5aa0; outline-offset: 2px; }
</style>
```

Hinweis zur Pan-Richtung: „Nach oben schauen" heißt, den Inhalt nach unten zu schieben → `vp.y` erhöhen → `onpan(0, +STEP)`. Analog „nach links" = `vp.x` erhöhen. Die Vorzeichen oben sind entsprechend gesetzt.

- [ ] **Step 2: `Desktop.svelte` — Rad-Zoom + Pointer-Deltas + Pinch + touch-action**

Script-Teil: `onWheel` und die Pointer-Handler ersetzen, `panBy` importieren, eine Pointer-Map + Helfer ergänzen. Neue/ersetzte Fassung der betroffenen Funktionen:

```ts
  import { freeDocs, screenToWorld, zoomAt, zoomToFit, allBoxes, panBy,
    type Vec2, type Viewport } from '@digital-desktop/core';
  // ... (übrige Importe unverändert) plus:
  import DeskControls from './DeskControls.svelte';

  // Mausrad zoomt zum Cursor (statt zu schwenken).
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    vp = zoomAt(vp, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.0015));
  }

  // Pointer-Verfolgung: Ein Finger/Maus schwenkt, zwei Finger pinchen+schwenken.
  const pointers = new Map<number, { x: number; y: number }>();
  let panLast: { x: number; y: number } | null = null;
  let pinchLast = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || e.target !== el) return;
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { panning = true; panLast = { x: e.clientX, y: e.clientY }; }
  }
  function onPointerMove(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && panLast) {
      vp = panBy(vp, e.clientX - panLast.x, e.clientY - panLast.y);
      panLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
      if (pinchLast) vp = zoomAt(vp, mid, dist / pinchLast);
      pinchLast = dist;
      panLast = null;
    }
  }
  function endPointer(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchLast = 0;
    if (pointers.size === 0) { panning = false; panLast = null; }
    else if (pointers.size === 1) { const p = Array.from(pointers.values())[0]; panLast = { x: p.x, y: p.y }; }
  }
```

Im Markup: `onpointerup`/`onpointercancel` auf `endPointer` legen, und das Bedienfeld einbinden. Die alte Toolbar behält den „＋ PDF"-Knopf, verliert aber „Übersicht" (wandert ins Bedienfeld). Konkret:
- `.desk`-Div: `onpointerup={endPointer} onpointercancel={endPointer}` (statt `onPointerUp`), Rest der Attribute unverändert; `onPointerUp` entfällt.
- Direkt nach `<DeskSwitcher />` einfügen:

```svelte
  <DeskControls
    onzoom={(f) => (vp = zoomAt(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, f))}
    onpan={(dx, dy) => (vp = panBy(vp, dx, dy))}
    onfit={fitAll}
  />
```
- In der `.toolbar` den „Übersicht"-Button entfernen (bleibt nur „＋ PDF").

- [ ] **Step 3: `touch-action: none`** — im `<style>` von `Desktop.svelte` die `.desk`-Regel ergänzen:

```css
  .desk { position: fixed; inset: 0; overflow: hidden; touch-action: none;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
```

- [ ] **Step 4: Typprüfung + Tests**

Run: `npm run check && npm test`
Expected: `svelte-check` ohne neue Fehler (die Bedienfeld-Buttons haben `aria-label`, erzeugen also keine neuen Warnungen); Vitest PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/DeskControls.svelte src/lib/components/Desktop.svelte
git commit -m "feat: Bedienfeld (Zoom/Pan) + Mausrad-Zoom, Zwei-Finger-Pinch, touch-action"
```

---

### Task 4: Karten-Drag robust + Lang-Druck-Kontextmenü

**Files:**
- Modify: `src/lib/menus.ts` (positionsbasierte Menü-Öffner)
- Modify: `src/lib/components/DocCard.svelte`
- Modify: `src/lib/components/StackCard.svelte`

**Interfaces:**
- Consumes: `showDocMenu`/`showStackMenu` (vorhanden).
- Produces: in `menus.ts` zusätzlich `showDocMenuAt(x: number, y: number, doc: Doc): void` und `showStackMenuAt(x: number, y: number, stack: Stack): void`; die bestehenden `showDocMenu(e, doc)`/`showStackMenu(e, stack)` rufen die `…At`-Variante mit `e.clientX/e.clientY`. Karten-Drag rechnet aus `clientX/Y`-Delta; Lang-Druck (~500 ms, Bewegung < 8 px, nur Touch/Pen) öffnet das Menü.

- [ ] **Step 1: `menus.ts` — positionsbasierte Öffner**

`showDocMenu` und `showStackMenu` so umbauen, dass die Item-Definition in einer `…At(x, y, …)`-Funktion liegt und die Event-Variante sie aufruft. Beispiel für Dokumente (analog für Stapel):

```ts
export function showDocMenuAt(x: number, y: number, doc: Doc): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Aufschlagen', action: () => void desktop.command('expandDoc', { id: doc.id }) },
      { label: 'In neuem Tab öffnen', action: () => void openDoc(doc) },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeDoc', { id: doc.id }) },
    ],
  };
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  showDocMenuAt(e.clientX, e.clientY, doc);
}
```

Für Stapel `showStackMenuAt(x, y, stack)` mit den bestehenden Stapel-Items, und `showStackMenu(e, stack) => showStackMenuAt(e.clientX, e.clientY, stack)`.

- [ ] **Step 2: `DocCard.svelte` — Drag auf clientX/Y-Delta + Lang-Druck**

Im `<script>`: `showDocMenuAt` zusätzlich importieren (`import { showDocMenu, showDocMenuAt } from '../menus';` — `openDoc` wurde in einem früheren Task entfernt, nicht wieder hinzufügen). Drag-Zustand um eine gemerkte Position und einen Lang-Druck-Timer erweitern und die Handler ersetzen:

```ts
  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== doc.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: doc.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === doc.id) { ui.linkingFromId = null; return; }
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
    if (e.pointerType !== 'mouse') {
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { dragging = false; showDocMenuAt(last.x, last.y, doc); }, 500);
    }
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    if (pressTimer && Math.hypot(e.clientX - last.x, e.clientY - last.y) > 8) { clearTimeout(pressTimer); pressTimer = undefined; }
    moved = true;
    const dx = (e.clientX - last.x) / vp.scale;
    const dy = (e.clientY - last.y) / vp.scale;
    last = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + dx, y: doc.position.y + dy }));
  }
  function onPointerUp() {
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    const center = { x: doc.position.x + CARD_W / 2, y: doc.position.y + CARD_H / 2 };
    const hit = hitTest(desktop.state, center, doc.id);
    if (hit) void desktop.command('stackDocs', { draggedId: doc.id, targetId: hit.id, id: uid() });
    else void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }
```

(`uid` ist aus Task 2 bereits importiert.) Im Markup des `.card`-Div zusätzlich `onpointercancel={onPointerUp}` ergänzen, damit ein abgebrochener Zeiger den Timer räumt.

- [ ] **Step 3: `DocCard.svelte` — touch-action** — im `<style>` die `.card`-Regel um `touch-action: none;` ergänzen.

- [ ] **Step 4: `StackCard.svelte` — analog** — dieselbe Umstellung: `showStackMenuAt` importieren; `onPointerDown`/`onPointerMove`/`onPointerUp` auf `last`/`clientX-Delta`/Lang-Druck umstellen (Lang-Druck ruft `showStackMenuAt(last.x, last.y, stack)`), `moveStack` statt `moveDoc`, `addLink`-`id: uid()`; im Markup `onpointercancel={onPointerUp}`; `.card`-Style `touch-action: none`. Der `fanPointerDown`-Block bleibt unverändert (nutzt schon `clientX/Y`).

- [ ] **Step 5: Typprüfung + Tests**

Run: `npm run check && npm test && grep -rn "movementX\|movementY" src && echo TREFFER || echo SAUBER`
Expected: `svelte-check` ohne neue Fehler; Vitest PASS; letzte Ausgabe `SAUBER` (kein `movementX/Y` mehr in `src/`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/menus.ts src/lib/components/DocCard.svelte src/lib/components/StackCard.svelte
git commit -m "fix: Karten per Touch verschiebbar (clientX-Delta), Lang-Druck-Kontextmenü, touch-action"
```

---

### Task 5: End-to-End-Verifikation

**Files:** keine — Verifikation; gefundene Fehler als eigene `fix:`-Commits.

- [ ] **Step 1: Automatisiert**

Run: `npm test && npm run check && npm run build && ls build/index.html`
Expected: alles grün; `build/index.html` existiert.

- [ ] **Step 2: Browser-Checkliste (Mac) unter `http://localhost:4810`**

1. Mausrad über dem Schreibtisch → zoomt zum Cursor (rein/raus).
2. Bedienfeld unten: `−`/`＋` zoomen, `⤢` passt alles ein, Pfeilpad ↑↓←→ schwenkt.
3. Karte mit der Maus ziehen → folgt sauber; loslassen speichert Position.
4. Rechtsklick auf Karte → Kontextmenü.

- [ ] **Step 3: iPad-Checkliste (über HTTPS-Tunnel oder `http://<LAN-IP>:4810`)**

5. Ein Finger auf freier Fläche → schwenkt; auf einer Karte → verschiebt die Karte.
6. Zwei Finger → Pinch-Zoom + Schwenken.
7. Lang-Druck auf eine Karte → Kontextmenü.
8. Über HTTP: ein PDF hinzufügen → erscheint (uid-Fallback greift, kein Fehler).

- [ ] **Step 4: Abschluss**

Run: `npm test && npm run check`
Expected: PASS — Navigation/Touch fertig für Review/UAT. Gefundene Punkte als `fix:`-Commits.
