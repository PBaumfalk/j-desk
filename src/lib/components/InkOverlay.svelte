<script lang="ts">
  import {
    strokesFor, uid, type Size, type Stroke, type StrokeTool, type Vec2,
  } from '@j-desk/core';
  import { clientToBase, toScreen, hitStroke, strichbreiteMitDruck } from '../inkMath';
  import { desktop } from '../store.svelte';

  export type InkTool = StrokeTool | 'eraser' | 'line';

  const TOOL_STYLE: Record<StrokeTool, { color: string; width: number; alpha: number }> = {
    pen: { color: '#1d3557', width: 1.5, alpha: 1 },        // Kugelschreiber
    marker: { color: '#ffd166', width: 9, alpha: 0.35 },     // Textmarker
    pencil: { color: '#5c6672', width: 1.2, alpha: 0.9 },    // Bleistift
  };
  const ERASE_TOLERANCE = 6; // Basiskoordinaten

  let { docId, page, base, renderedWidth, tool, colors }:
    { docId: string; page: number; base: Size | null; renderedWidth: number; tool: InkTool | null;
      colors?: { pen: string; marker: string } } = $props();

  /** Der Lineal-Modus zeichnet mit Kugelschreiber-Optik, begradigt aber zur Geraden. */
  function styleFor(t: Exclude<InkTool, 'eraser'>): { tool: StrokeTool; color: string; width: number } {
    const kind: StrokeTool = t === 'line' ? 'pen' : t;
    const st = TOOL_STYLE[kind];
    const farbe = colors && (kind === 'pen' || kind === 'marker') ? colors[kind] : st.color;
    return { tool: kind, color: farbe, width: st.width };
  }

  let canvas = $state<HTMLCanvasElement | null>(null);
  let drawing: Vec2[] | null = null; // aktive Vorschau in Basiskoordinaten
  let activePointer: number | null = null;
  // Druckabtastung der laufenden Geste (MOBILE-01, Pencil). Bewusst kein $state — beeinflusst kein
  // Rendern, nur die Breitenberechnung beim Abschluss (onPointerUp).
  let gestenZeigertyp: string | null = null;
  let gestenHoechstdruck: number | undefined;

  const strokes = $derived(strokesFor(desktop.state, docId, page));
  const dpr = window.devicePixelRatio || 1;
  const height = $derived(base ? Math.round((renderedWidth * base.h) / base.w) : 0);

  function ctx(): CanvasRenderingContext2D | null {
    return canvas?.getContext('2d', { desynchronized: true }) ?? null;
  }

  function drawStroke(c: CanvasRenderingContext2D, points: Vec2[], toolKind: StrokeTool, color: string, width: number) {
    if (!base || points.length < 2) return;
    const style = TOOL_STYLE[toolKind];
    c.globalAlpha = style.alpha;
    c.strokeStyle = color;
    c.lineWidth = width * (renderedWidth / base.w) * dpr;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    const first = toScreen(points[0], renderedWidth, base);
    c.moveTo(first.x * dpr, first.y * dpr);
    for (const p of points.slice(1)) {
      const sp = toScreen(p, renderedWidth, base);
      c.lineTo(sp.x * dpr, sp.y * dpr);
    }
    c.stroke();
    c.globalAlpha = 1;
  }

  function redraw() {
    const c = ctx();
    if (!c || !canvas || !base) return;
    canvas.width = Math.round(renderedWidth * dpr);
    canvas.height = Math.round(height * dpr);
    c.clearRect(0, 0, canvas.width, canvas.height);
    for (const st of strokes) drawStroke(c, st.points, st.tool, st.color, st.width);
    if (drawing && tool && tool !== 'eraser') {
      const style = styleFor(tool);
      drawStroke(c, drawing, style.tool, style.color, style.width);
    }
  }

  $effect(() => {
    strokes; base; renderedWidth; page;
    redraw();
  });

  function localPoint(e: PointerEvent): Vec2 | null {
    if (!canvas || !base) return null;
    // getBoundingClientRect liefert die ECHTE Bildschirmgröße (inkl. Welt-Zoom) —
    // nur damit landet der Strich exakt unter dem Cursor.
    const r = canvas.getBoundingClientRect();
    if (r.width === 0) return null;
    return clientToBase({ x: e.clientX, y: e.clientY }, r, base);
  }

  function onPointerDown(e: PointerEvent) {
    if (!tool || e.button !== 0 || activePointer !== null) return;
    e.stopPropagation();
    const p = localPoint(e);
    if (!p) return;
    activePointer = e.pointerId;
    // Frische Abtastung je Geste: Zeigertyp merken, Höchstdruck auf den Startwert zurücksetzen.
    gestenZeigertyp = e.pointerType;
    gestenHoechstdruck = e.pressure;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* Komfort */ }
    if (tool === 'eraser') {
      eraseAt(p);
    } else {
      drawing = [p];
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== activePointer || !tool) return;
    // Koaleszierte Punkte mitnehmen — glattere Striche bei hoher Eingaberate (Pencil)
    const events = typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length > 0
      ? e.getCoalescedEvents()
      : [e];
    if (tool === 'eraser') {
      for (const ev of events) {
        const p = localPoint(ev as PointerEvent);
        if (p) eraseAt(p);
      }
      return;
    }
    if (!drawing) return;
    for (const ev of events) {
      const p = localPoint(ev as PointerEvent);
      // Höchstdruck über die koaleszierten Bewegungsereignisse mitziehen — NICHT beim Loslassen
      // abtasten: das Loslass-Ereignis meldet typischerweise Druck 0, ein daraus abgeleiteter
      // Faktor wäre systematisch falsch und würde jeden Strich gleich dünn machen.
      gestenHoechstdruck = Math.max(gestenHoechstdruck ?? 0, ev.pressure);
      if (!p) continue;
      if (tool === 'line') {
        drawing = [drawing[0], p];
      } else {
        drawing.push(p);
      }
    }
    redraw();
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (!tool || tool === 'eraser' || !drawing) { drawing = null; return; }
    const points = drawing;
    drawing = null;
    if (points.length >= 2 && tool !== null) {
      const st = styleFor(tool);
      // Die gesamte Rechnung — Rückfallwert bei fehlendem Druck, Klemmung und der Ausschluss des
      // Textmarkers — liegt bewusst im geprüften Modul (inkMath.ts); die Komponente reicht nur den
      // gemessenen Rohwert (Zeigertyp, Höchstdruck der Geste) weiter. So bleibt MOBILE-01
      // automatisiert abgedeckt, obwohl die Komponente selbst nicht testbar ist.
      const breite = strichbreiteMitDruck(st.width, st.tool, gestenZeigertyp ?? '', gestenHoechstdruck);
      void desktop.command('addStroke', {
        stroke: { id: uid(), docId, page, tool: st.tool, color: st.color, width: breite, points } satisfies Stroke,
      });
    } else {
      redraw(); // Ein-Punkt-Tipper verwerfen
    }
    gestenZeigertyp = null;
    gestenHoechstdruck = undefined;
  }

  function onPointerCancel(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    drawing = null;
    // Abgebrochene Geste darf den nächsten Strich nicht verfälschen.
    gestenZeigertyp = null;
    gestenHoechstdruck = undefined;
    redraw();
  }

  function eraseAt(p: Vec2) {
    const victim = [...strokes].reverse().find((st) => hitStroke(st, p, ERASE_TOLERANCE));
    if (victim) void desktop.command('removeStroke', { strokeId: victim.id });
  }
</script>

{#if base}
  <canvas
    bind:this={canvas}
    class="ink"
    class:active={tool !== null}
    style:width="{renderedWidth}px"
    style:height="{height}px"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
  ></canvas>
{/if}

<style>
  .ink { position: absolute; left: 0; top: 0; pointer-events: none; touch-action: none; }
  .ink.active { pointer-events: auto; cursor: crosshair; }
</style>
