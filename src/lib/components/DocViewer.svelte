<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { moveDoc, setDocPage, DEFAULT_OPEN_SIZE, type Doc, type Size, type Viewport } from '@digital-desktop/core';
  import { debounce } from '../debounce';
  import { desktop } from '../store.svelte';
  import PageRenderer from './PageRenderer.svelte';
  import InkOverlay, { type InkTool } from './InkOverlay.svelte';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let pageCount = $state<number | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  const page = $derived(doc.page ?? 1);
  const size = $derived(doc.openSize ?? DEFAULT_OPEN_SIZE);
  const pageWidth = $derived(Math.round(size.w - 20));

  // Zeichenwerkzeuge (Teilprojekt E): aktives Werkzeug gilt pro Viewer
  let inkTool = $state<InkTool | null>(null);
  let baseSize = $state<Size | null>(null);
  function toggleTool(t: InkTool) {
    inkTool = inkTool === t ? null : t;
  }

  // Aufgeschlagene Karte direkt fokussieren, damit die Pfeiltasten sofort blättern.
  onMount(() => wrapEl?.focus({ preventScroll: true }));

  let dragging = false, moved = false;
  let headLast = { x: 0, y: 0 };
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return; // Klicks auf ‹ › ✕ nicht als Drag verschlucken
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true; moved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    const dx = (e.clientX - headLast.x) / vp.scale;
    const dy = (e.clientY - headLast.y) / vp.scale;
    headLast = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + dx, y: doc.position.y + dy }));
  }
  function onHeaderPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }

  // Blättern wirkt sofort lokal; der Server bekommt gebündelt nur die letzte Seite.
  let pendingPage: number | null = null;
  const sendPage = debounce(350, (p: number) => {
    pendingPage = null;
    void desktop.command('setDocPage', { id: doc.id, page: p });
  });
  onDestroy(() => {
    sendPage.cancel();
    if (pendingPage !== null && desktop.status === 'online') {
      void desktop.command('setDocPage', { id: doc.id, page: pendingPage });
    }
  });

  function turn(delta: number) {
    const next = page + delta;
    if (next < 1 || (pageCount !== null && next > pageCount)) return;
    desktop.applyLocal((s) => setDocPage(s, doc.id, next));
    pendingPage = next;
    sendPage(next);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Wischen zum Blättern (horizontal) — bei aktivem Zeichenwerkzeug deaktiviert
  let swipeX = 0, swiping = false;
  function onBodyPointerDown(e: PointerEvent) { if (inkTool) return; if (e.pointerType === 'touch') { swiping = true; swipeX = e.clientX; } }
  function onBodyPointerUp(e: PointerEvent) {
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }

  // Größe ziehen (Anfasser unten rechts)
  let resizing = false;
  let gripLast = { x: 0, y: 0 };
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true;
    gripLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const dx = (e.clientX - gripLast.x) / vp.scale;
    const dy = (e.clientY - gripLast.y) / vp.scale;
    gripLast = { x: e.clientX, y: e.clientY };
    const w = Math.max(220, size.w + dx);
    const h = Math.max(280, size.h + dy);
    desktop.applyLocal((s) => ({ ...s, docs: s.docs.map((d) => d.id === doc.id ? { ...d, openSize: { w, h } } : d) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeDoc', { id: doc.id, size: { w: size.w, h: size.h } });
  }
</script>

<svelte:window onkeydown={(e) => { if (document.activeElement === wrapEl) onKey(e); }} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- der Viewer ist bewusst fokussierbar: Pfeiltasten blättern -->
<div class="viewer" role="group" aria-label={doc.name} bind:this={wrapEl} tabindex="0"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px" style:z-index={doc.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" role="toolbar" tabindex="-1" aria-label="Dokumentleiste" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}>
    <span class="title">{doc.name}</span>
    <span class="tools">
      <button class:on={inkTool === 'pen'} onclick={() => toggleTool('pen')} aria-pressed={inkTool === 'pen'} aria-label="Stift" title="Stift">✎</button>
      <button class:on={inkTool === 'marker'} onclick={() => toggleTool('marker')} aria-pressed={inkTool === 'marker'} aria-label="Textmarker" title="Textmarker"><span class="marker-chip"></span></button>
      <button class:on={inkTool === 'eraser'} onclick={() => toggleTool('eraser')} aria-pressed={inkTool === 'eraser'} aria-label="Radierer" title="Radierer">⌫</button>
    </span>
    <span class="pager">
      <button onclick={() => turn(-1)} disabled={page <= 1} aria-label="Zurück">‹</button>
      <span class="pos">{page}{#if pageCount} / {pageCount}{/if}</span>
      <button onclick={() => turn(1)} disabled={pageCount !== null && page >= pageCount} aria-label="Weiter">›</button>
    </span>
    <button class="close" onclick={() => void desktop.command('collapseDoc', { id: doc.id })} aria-label="Schließen">✕</button>
  </div>
  <div class="body" role="presentation" onwheel={(e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }} onpointerdown={onBodyPointerDown} onpointerup={onBodyPointerUp}>
    {#if desktop.api}
      <div class="pagewrap">
        <PageRenderer api={desktop.api} fileId={doc.fileId} {page} targetWidth={pageWidth}
          onpagecount={(n) => (pageCount = n)} onbasesize={(s) => (baseSize = s)} />
        <InkOverlay docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} tool={inkTool} />
      </div>
    {/if}
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
</div>

<style>
  .viewer { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 6px;
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; touch-action: none; }
  .viewer:focus { outline: 2px solid #2c5aa0; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #f2f4f8;
          border-bottom: 1px solid #e4e8ef; cursor: grab; user-select: none; }
  .title { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pager { display: flex; align-items: center; gap: 6px; }
  .tools { display: flex; align-items: center; gap: 4px; }
  .tools button { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 13px; line-height: 1;
          display: inline-flex; align-items: center; justify-content: center; }
  .tools button.on { background: #2c5aa0; color: #fff; }
  .marker-chip { width: 12px; height: 12px; border-radius: 3px; background: #ffd166; display: inline-block; }
  .tools button.on .marker-chip { outline: 2px solid #fff; }
  .pagewrap { position: relative; width: fit-content; }
  .pager button, .close { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 15px; line-height: 1; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pos { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .body { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start;
          background: #52616b; padding: 10px; }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
</style>
