<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    konvolutPages, moveStack, setStackPage, uid, DEFAULT_OPEN_SIZE,
    type KonvolutPage, type Size, type Stack, type Viewport,
  } from '@digital-desktop/core';
  import { debounce } from '../debounce';
  import { desktop } from '../store.svelte';
  import { getPageCount } from '../pageCounts';
  import PageRenderer from './PageRenderer.svelte';
  import InkOverlay, { type InkTool } from './InkOverlay.svelte';
  import MarkLayer from './MarkLayer.svelte';
  import StampLayer from './StampLayer.svelte';
  import StampPopover from './StampPopover.svelte';

  let { stack, vp }: { stack: Stack; vp: Viewport } = $props();

  // Seitenzahlen aller Mitglieder laden -> pages ist null, bis alles bekannt ist
  let pageCounts = $state<Record<string, number>>({});
  $effect(() => {
    const api = desktop.api;
    if (!api) return;
    for (const docId of stack.docIds) {
      const d = desktop.state.docs.find((x) => x.id === docId);
      if (!d || d.pageOnly !== undefined || pageCounts[d.fileId] !== undefined) continue;
      void getPageCount(api, d.fileId).then((n) => { pageCounts = { ...pageCounts, [d.fileId]: n }; });
    }
  });
  const pages = $derived(konvolutPages(desktop.state, stack, pageCounts));
  const globalPage = $derived(Math.min(stack.page ?? 1, pages?.length ?? 1));
  const aktuelle = $derived<KonvolutPage | null>(pages?.[globalPage - 1] ?? null);
  const size = $derived(stack.openSize ?? DEFAULT_OPEN_SIZE);
  const pageWidth = $derived(Math.round(size.w - 20));
  let baseSize = $state<Size | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  let lichttisch = $state(false);
  let inkTool = $state<InkTool | 'tippex' | 'redact' | null>(null);
  const rectTool = $derived(inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null);
  function toggleTool(t: InkTool | 'tippex' | 'redact') { inkTool = inkTool === t ? null : t; }

  onMount(() => wrapEl?.focus({ preventScroll: true }));

  // Blättern: sofort lokal, debounced zum Server (Muster DocViewer)
  let pendingPage: number | null = null;
  const sendPage = debounce(350, (p: number) => { pendingPage = null; void desktop.command('setStackPage', { id: stack.id, page: p }); });
  onDestroy(() => {
    sendPage.cancel();
    if (pendingPage !== null && desktop.status === 'online') void desktop.command('setStackPage', { id: stack.id, page: pendingPage });
  });
  function turn(delta: number) {
    if (!pages) return;
    const next = globalPage + delta;
    if (next < 1 || next > pages.length) return;
    desktop.applyLocal((s) => setStackPage(s, stack.id, next));
    pendingPage = next;
    sendPage(next);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Kopf-Drag (Muster DocViewer, aber moveStack + taped-Guard)
  let dragging = false, moved = false, headLast = { x: 0, y: 0 };
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0 || stack.taped) return;
    e.stopPropagation();
    dragging = true; moved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: stack.id });
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    const dx = (e.clientX - headLast.x) / vp.scale;
    const dy = (e.clientY - headLast.y) / vp.scale;
    headLast = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveStack(s, stack.id, { x: stack.position.x + dx, y: stack.position.y + dy }));
  }
  function onHeaderPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveStack', { stackId: stack.id, position: { ...stack.position } });
  }

  // Wischen + Anfasser: identisches Muster wie DocViewer
  let swipeX = 0, swiping = false;
  function onBodyPointerDown(e: PointerEvent) { if (inkTool) return; if (e.pointerType === 'touch') { swiping = true; swipeX = e.clientX; } }
  function onBodyPointerUp(e: PointerEvent) {
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }
  let resizing = false, gripLast = { x: 0, y: 0 };
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true; gripLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const dx = (e.clientX - gripLast.x) / vp.scale;
    const dy = (e.clientY - gripLast.y) / vp.scale;
    gripLast = { x: e.clientX, y: e.clientY };
    const w = Math.max(220, size.w + dx);
    const h = Math.max(280, size.h + dy);
    desktop.applyLocal((s) => ({ ...s, stacks: s.stacks.map((x) => x.id === stack.id ? { ...x, openSize: { w, h } } : x) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeStack', { id: stack.id, size: { w: size.w, h: size.h } });
  }

  // Stempel (Muster DocViewer, wirkt auf das Mitglieds-Dokument der aktuellen Seite)
  let stampMenu = $state(false);
  let stampChoice = $state<{ text: string; color: 'red' | 'blue'; withDate?: boolean } | null>(null);
  function pickStamp(wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) {
    stampMenu = false; stampChoice = wahl; inkTool = null;
  }
  function pagePoint(e: PointerEvent): { x: number; y: number } | null {
    const wrap = (e.currentTarget as HTMLElement).closest('.pagewrap');
    if (!wrap || !baseSize) return null;
    const r = wrap.getBoundingClientRect();
    const f = baseSize.w / pageWidth;
    return { x: (e.clientX - r.left) * f, y: (e.clientY - r.top) * f };
  }
  function stampAt(e: PointerEvent) {
    if (!stampChoice || !aktuelle || !baseSize) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    const heute = new Date().toISOString().slice(0, 10);
    void desktop.command('addStamp', {
      stamp: {
        id: uid(), docId: aktuelle.docId, page: aktuelle.page, x: p.x, y: p.y,
        angle: Math.random() * 12 - 6, text: stampChoice.text, color: stampChoice.color,
        ...(stampChoice.withDate ? { date: heute } : {}),
        baseW: baseSize.w, baseH: baseSize.h,
      },
    });
  }

  // Tipp-Ex/Schwärzung: Rechteck auf der Seite aufziehen (kein Schere-Werkzeug im Konvolut)
  let schnitt = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  let schnittPointer: number | null = null;
  function schnittDown(e: PointerEvent) {
    if (e.button !== 0 || schnittPointer !== null) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    schnittPointer = e.pointerId;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* Komfort */ }
    schnitt = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
  function schnittMove(e: PointerEvent) {
    if (e.pointerId !== schnittPointer || !schnitt) return;
    const p = pagePoint(e);
    if (p) schnitt = { ...schnitt, x1: p.x, y1: p.y };
  }
  function schnittUp(e: PointerEvent) {
    if (e.pointerId !== schnittPointer) return;
    schnittPointer = null;
    const sn = schnitt;
    schnitt = null;
    if (!sn || !aktuelle) return;
    const rect = {
      x: Math.min(sn.x0, sn.x1), y: Math.min(sn.y0, sn.y1),
      w: Math.abs(sn.x1 - sn.x0), h: Math.abs(sn.y1 - sn.y0),
    };
    if (rect.w < 12 || rect.h < 12) return; // Mini-Wischer verwerfen
    if (rectTool) {
      // Tipp-Ex/Schwärzung: Werkzeug bleibt aktiv (mehrere Flächen nacheinander)
      void desktop.command('addMark', { mark: { id: uid(), docId: aktuelle.docId, page: aktuelle.page, rect, kind: rectTool } });
    }
  }
  const schnittCss = $derived.by(() => {
    if (!schnitt || !baseSize) return null;
    const f = pageWidth / baseSize.w; // Basiskoordinaten -> Overlay-Pixel
    return {
      left: Math.min(schnitt.x0, schnitt.x1) * f,
      top: Math.min(schnitt.y0, schnitt.y1) * f,
      w: Math.abs(schnitt.x1 - schnitt.x0) * f,
      h: Math.abs(schnitt.y1 - schnitt.y0) * f,
    };
  });
</script>

<svelte:window onkeydown={(e) => { if (document.activeElement === wrapEl) onKey(e); }} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- bewusst fokussierbar: Pfeiltasten blättern -->
<div class="viewer" class:licht={lichttisch} role="group" aria-label={stack.name || 'Konvolut'} bind:this={wrapEl} tabindex="0"
     style:left="{stack.position.x}px" style:top="{stack.position.y}px" style:z-index={stack.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" role="toolbar" tabindex="-1" aria-label="Konvolutleiste" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}>
    <span class="title">📎 {stack.name || 'Konvolut'}</span>
    <span class="tools">
      <button class:on={inkTool === 'pencil'} onclick={() => toggleTool('pencil')} aria-pressed={inkTool === 'pencil'} aria-label="Bleistift" title="Bleistift">✏</button>
      <button class:on={inkTool === 'pen'} onclick={() => toggleTool('pen')} aria-pressed={inkTool === 'pen'} aria-label="Kugelschreiber" title="Kugelschreiber">✎</button>
      <button class:on={inkTool === 'marker'} onclick={() => toggleTool('marker')} aria-pressed={inkTool === 'marker'} aria-label="Textmarker" title="Textmarker"><span class="marker-chip"></span></button>
      <button class:on={inkTool === 'line'} onclick={() => toggleTool('line')} aria-pressed={inkTool === 'line'} aria-label="Lineal" title="Lineal">⟍</button>
      <button class:on={inkTool === 'eraser'} onclick={() => toggleTool('eraser')} aria-pressed={inkTool === 'eraser'} aria-label="Radierer" title="Radierer">⌫</button>
      <span class="sep"></span>
      <button class:on={inkTool === 'tippex'} onclick={() => toggleTool('tippex')} aria-pressed={inkTool === 'tippex'} aria-label="Tipp-Ex" title="Tipp-Ex"><span class="tippex-chip"></span></button>
      <button class:on={inkTool === 'redact'} onclick={() => toggleTool('redact')} aria-pressed={inkTool === 'redact'} aria-label="Schwärzung" title="Schwärzung">■</button>
      <span class="sep"></span>
      <button class:on={stampChoice !== null || stampMenu} onclick={() => { if (stampChoice) { stampChoice = null; } else { stampMenu = !stampMenu; } }} aria-label="Stempel" title="Stempel">✪</button>
      <button class:on={lichttisch} onclick={() => (lichttisch = !lichttisch)} aria-pressed={lichttisch} aria-label="Lichttisch" title="Lichttisch">◐</button>
    </span>
    <span class="pager">
      <button onclick={() => turn(-1)} disabled={!pages || globalPage <= 1} aria-label="Zurück">‹</button>
      <span class="pos">{globalPage}{#if pages} / {pages.length}{/if}</span>
      <button onclick={() => turn(1)} disabled={!pages || globalPage >= pages.length} aria-label="Weiter">›</button>
    </span>
    <button class="close" onclick={() => void desktop.command('collapseStack', { id: stack.id })} aria-label="Schließen">✕</button>
  </div>
  {#if stampMenu}<StampPopover onpick={pickStamp} onclose={() => (stampMenu = false)} />{/if}
  <div class="body" role="presentation" onwheel={(e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }} onpointerdown={onBodyPointerDown} onpointerup={onBodyPointerUp}>
    {#if desktop.api && aktuelle}
      <div class="pagewrap">
        <PageRenderer api={desktop.api} fileId={aktuelle.fileId} page={aktuelle.page} targetWidth={pageWidth} onbasesize={(s) => (baseSize = s)} />
        <InkOverlay docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth}
                    tool={inkTool === 'tippex' || inkTool === 'redact' ? null : inkTool} />
        {#if rectTool && baseSize}
          <div class="schnittflaeche" role="presentation"
               onpointerdown={schnittDown} onpointermove={schnittMove} onpointerup={schnittUp}
               onpointercancel={() => { schnittPointer = null; schnitt = null; }}>
            {#if schnittCss}
              <div class="schnittrahmen" class:tippex={rectTool === 'tippex'} class:redact={rectTool === 'redact'}
                   style:left="{schnittCss.left}px" style:top="{schnittCss.top}px"
                   style:width="{schnittCss.w}px" style:height="{schnittCss.h}px"></div>
            {/if}
          </div>
        {/if}
        <MarkLayer docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth}
                   active={inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null} />
        {#if stampChoice && baseSize}
          <div class="stempelflaeche" role="presentation" onpointerdown={stampAt}></div>
        {/if}
        <StampLayer docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth} active={stampChoice !== null} />
      </div>
    {:else}
      <div class="laden">Seiten werden gezählt…</div>
    {/if}
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
</div>

<style>
  /* CSS 1:1 vom DocViewer übernommen (bewusste Duplikation, Bestandsmuster) — plus .laden für den Ladezustand. */
  .viewer { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 6px;
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; touch-action: none; }
  .viewer:focus { outline: 2px solid #2c5aa0; }
  /* Lichttisch: Papier wird durchscheinend, darunterliegende Seiten schimmern durch */
  .viewer.licht { opacity: .58; }
  .viewer.licht .body { background: transparent; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #f2f4f8;
          border-bottom: 1px solid #e4e8ef; cursor: grab; user-select: none; }
  .title { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pager { display: flex; align-items: center; gap: 6px; }
  .tools { display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .tools button { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 13px; line-height: 1;
          display: inline-flex; align-items: center; justify-content: center; }
  .tools button.on { background: #2c5aa0; color: #fff; }
  .sep { width: 1px; height: 16px; background: #d3d9e3; margin: 0 2px; flex: none; }
  .marker-chip { width: 12px; height: 12px; border-radius: 3px; background: #ffd166; display: inline-block; }
  .tools button.on .marker-chip { outline: 2px solid #fff; }
  .tippex-chip { width: 12px; height: 12px; border-radius: 3px; background: #fff; border: 1px solid #b8c0cc; display: inline-block; }
  .pagewrap { position: relative; width: fit-content; }
  .pager button, .close { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 15px; line-height: 1; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pos { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .body { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start;
          background: #52616b; padding: 10px; }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
  .schnittflaeche { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
  .stempelflaeche { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
  .schnittrahmen { position: absolute; border: 2px dashed #c0392b; background: rgba(192, 57, 43, .08);
                   pointer-events: none; }
  .schnittrahmen.tippex { border-color: #8a94a3; background: rgba(255, 255, 255, .35); }
  .schnittrahmen.redact { border-color: #111; background: rgba(0, 0, 0, .18); }
  .laden { color: #dfe5ee; font-size: 13px; padding: 40px; }
</style>
