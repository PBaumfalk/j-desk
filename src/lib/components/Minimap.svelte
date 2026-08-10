<script lang="ts">
  /**
   * Minikarte (UX-03, 13-05 Task 2): gedrosselte Canvas-Ableitung aus bereits geladenem Zustand —
   * kein eigener Serverpfad (13-RESEARCH.md Anti-Pattern „DOM/SVG-Kartenpunkte"). Canvas-Muster
   * 1:1 aus InkOverlay.svelte (dpr-Skalierung, `getContext('2d', { desynchronized: true })`);
   * die reine Skalierungs-/Projektionsrechnung liegt getestet in `minimap.ts`.
   *
   * Repaint-Disziplin (P8, T-13-05-04): der Fit (Skalierung/Versatz) hängt AUSSCHLIESSLICH von
   * `boxes`/`zonen` ab (Objekt-Geometrie) — ein Viewport-Tick (`vp`-Änderung) liest `fit` unverändert
   * und löst KEINE Fit-Neurechnung aus (Svelte-Abhängigkeitsverfolgung: `fit` referenziert `vp`
   * nirgends). Das eigentliche Canvas-Zeichnen ist zusätzlich per `requestAnimationFrame`
   * gedrosselt, damit auch häufige Viewport-Ticks (Pan/Zoom) nicht mehrfach pro Frame neu malen.
   */
  import { allBoxes, type Box, type Viewport, type Zone } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { aufzeichnen, labelFuer } from '../verlauf';
  import { MINIMAP_W, MINIMAP_H, fitFuerMinikarte, viewportRectFuer, punktZuViewport, type MinikarteFit } from '../minimap';

  let { vp = $bindable(), viewW, viewH }: { vp: Viewport; viewW: number; viewH: number } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  const dpr = window.devicePixelRatio || 1;

  const boxes = $derived(allBoxes(desktop.state));
  const zonen = $derived(desktop.state.zones ?? []);
  // Fit hängt bewusst NUR von boxes ab (kein vp-Zugriff hier) — P8-Trennung Geometrie vs. Tick.
  const fit = $derived(fitFuerMinikarte(boxes, MINIMAP_W, MINIMAP_H));
  const rect = $derived(viewportRectFuer(vp, viewW, viewH, fit));

  function ctx(): CanvasRenderingContext2D | null {
    return canvas?.getContext('2d', { desynchronized: true }) ?? null;
  }

  /** Liest eine CSS-Custom-Property live vom Canvas-Element (theme-sicher: erbt den
   *  Hell/Dunkel-Wert des umgebenden Glass-Themes, kann Canvas nicht direkt per `var()` nutzen). */
  function cssVar(name: string, fallback: string): string {
    if (!canvas) return fallback;
    const v = getComputedStyle(canvas).getPropertyValue(name).trim();
    return v || fallback;
  }

  function projiziere(x: number, y: number): { x: number; y: number } {
    return { x: x * fit.scale + fit.offsetX, y: y * fit.scale + fit.offsetY };
  }

  function redraw(): void {
    const c = ctx();
    if (!c || !canvas) return;
    canvas.width = Math.round(MINIMAP_W * dpr);
    canvas.height = Math.round(MINIMAP_H * dpr);
    c.clearRect(0, 0, canvas.width, canvas.height);

    // Kartenpunkte: 2px-Rects am Kartenmittelpunkt, Secondary-Ton, kein Inhalt/Titel (UI-SPEC).
    c.fillStyle = cssVar('--glass-text-secondary', 'rgba(120,130,140,.6)');
    for (const b of boxes) {
      const p = projiziere(b.x + b.w / 2, b.y + b.h / 2);
      c.fillRect(Math.round(p.x * dpr) - dpr, Math.round(p.y * dpr) - dpr, 2 * dpr, 2 * dpr);
    }

    // Zonen: Outline + hart abgeschnittener Name (E3/long-text) — 1px, Border-Ton.
    c.strokeStyle = cssVar('--glass-border', 'rgba(150,160,170,.6)');
    c.lineWidth = 1 * dpr;
    c.font = `${9 * dpr}px sans-serif`;
    c.fillStyle = cssVar('--glass-text', '#333');
    c.textBaseline = 'top';
    for (const z of zonen as Zone[]) {
      const tl = projiziere(z.rect.x, z.rect.y);
      const br = projiziere(z.rect.x + z.rect.w, z.rect.y + z.rect.h);
      const x = Math.min(tl.x, br.x) * dpr;
      const y = Math.min(tl.y, br.y) * dpr;
      const w = Math.abs(br.x - tl.x) * dpr;
      const h = Math.abs(br.y - tl.y) * dpr;
      if (w <= 0 || h <= 0) continue;
      c.strokeRect(x, y, w, h);
      // Harte Textklemmung (kein Umbruch): der Name endet exakt an der Zonenbreite.
      c.save();
      c.beginPath();
      c.rect(x, y, w, Math.min(h, 10 * dpr));
      c.clip();
      c.fillText(z.name, x + 2 * dpr, y + 1 * dpr, Math.max(0, w - 4 * dpr));
      c.restore();
    }

    // Viewport-Rechteck: 2px Accent — muss auf dichtem Tisch sofort auffindbar sein (E3-Backstop).
    c.strokeStyle = cssVar('--brand-blue', '#1372D3');
    c.lineWidth = 2 * dpr;
    c.strokeRect(rect.x * dpr, rect.y * dpr, Math.max(rect.w * dpr, 2 * dpr), Math.max(rect.h * dpr, 2 * dpr));
  }

  let rafPending = false;
  function planeRepaint(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      redraw();
    });
  }

  $effect(() => {
    // Repaint-Trigger: Geometrie (boxes/zonen) UND Viewport-Rechteck (rect, pro Tick neu) — die
    // teure Zeichenoperation selbst bleibt rAF-gedrosselt (P8), egal wie oft vp sich ändert.
    boxes; zonen; rect;
    planeRepaint();
  });

  // ---- Interaktion (UI-SPEC): Klick/Tipp zentriert instant, Ziehen am Viewport-Rechteck
  //      schiebt den Ausschnitt instant — beides ohne Tween (Bestands-Sprungkonvention) und
  //      erzeugt je EINEN Verlaufseintrag „Minikarte-Sprung" (bei Drag erst am Gesten-Ende). ----
  let dragStart: { x: number; y: number; vp: Viewport } | null = null;

  function localPoint(e: PointerEvent): { x: number; y: number } | null {
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: ((e.clientX - r.left) / r.width) * MINIMAP_W, y: ((e.clientY - r.top) / r.height) * MINIMAP_H };
  }

  function zentriereAuf(mx: number, my: number): void {
    const welt = punktZuViewport(mx, my, fit);
    vp = { scale: vp.scale, x: viewW / 2 - welt.x * vp.scale, y: viewH / 2 - welt.y * vp.scale };
  }

  function zeichneMinikartenSprungAuf(): void {
    ui.verlauf = aufzeichnen(ui.verlauf, { vp, ausloeser: 'minikarte', label: labelFuer({ ausloeser: 'minikarte' }) });
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = localPoint(e);
    if (!p) return;
    e.stopPropagation();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* Komfort */ }
    const innerhalb = p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
    if (innerhalb) {
      dragStart = { x: p.x, y: p.y, vp: { ...vp } };
    } else {
      zentriereAuf(p.x, p.y);
      zeichneMinikartenSprungAuf();
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragStart) return;
    const p = localPoint(e);
    if (!p) return;
    const dxWelt = (p.x - dragStart.x) / fit.scale;
    const dyWelt = (p.y - dragStart.y) / fit.scale;
    vp = { ...dragStart.vp, x: dragStart.vp.x - dxWelt * dragStart.vp.scale, y: dragStart.vp.y - dyWelt * dragStart.vp.scale };
  }

  function onPointerUp(): void {
    if (!dragStart) return;
    dragStart = null;
    zeichneMinikartenSprungAuf(); // EINMALIG am Gesten-Ende, nicht pro Bewegung (Lärm-Regel).
  }
</script>

<div class="minikarte-wrap">
  <canvas
    bind:this={canvas}
    class="minikarte"
    style:width="{MINIMAP_W}px"
    style:height="{MINIMAP_H}px"
    aria-label="Minikarte des Schreibtischs — Klick zentriert, Ziehen am Viewport-Rechteck verschiebt den Ausschnitt"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
  ></canvas>
</div>

<style>
  /* Feste Ecke links unten (MINIMAP_W/H, 16px Abstand) — Spiegelung von TrashCan.svelte
     (dort rechts unten). z-index unterhalb der Papierkorb-Panel-Ebene (9400), aber über dem Tisch. */
  .minikarte-wrap { position: fixed; left: 16px; bottom: 16px; z-index: 9000;
                    border-radius: 10px; overflow: hidden; border: 1px solid var(--glass-border);
                    background: var(--glass-card-bg);
                    backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
                    box-shadow: var(--glass-shadow); }
  .minikarte { display: block; cursor: pointer; touch-action: none; }
</style>
