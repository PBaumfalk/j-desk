<script lang="ts">
  import { moveDoc, type Doc, type Viewport } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import PageRenderer from './PageRenderer.svelte';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let pageCount = $state<number | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  const page = $derived(doc.page ?? 1);
  const size = $derived(doc.openSize ?? { w: 560, h: 720 });

  let dragging = false, moved = false;
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return; // Klicks auf ‹ › ✕ nicht als Drag verschlucken
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true; moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + e.movementX / vp.scale, y: doc.position.y + e.movementY / vp.scale }));
  }
  function onHeaderPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }

  function turn(delta: number) {
    const next = page + delta;
    if (next < 1 || (pageCount !== null && next > pageCount)) return;
    void desktop.command('setDocPage', { id: doc.id, page: next });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Wischen zum Blättern (horizontal)
  let swipeX = 0, swiping = false;
  function onBodyPointerDown(e: PointerEvent) { if (e.pointerType === 'touch') { swiping = true; swipeX = e.clientX; } }
  function onBodyPointerUp(e: PointerEvent) {
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }

  // Größe ziehen (Anfasser unten rechts)
  let resizing = false;
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const w = Math.max(220, size.w + e.movementX / vp.scale);
    const h = Math.max(280, size.h + e.movementY / vp.scale);
    desktop.applyLocal((s) => ({ ...s, docs: s.docs.map((d) => d.id === doc.id ? { ...d, openSize: { w, h } } : d) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeDoc', { id: doc.id, size: { w: size.w, h: size.h } });
  }
</script>

<svelte:window onkeydown={(e) => { if (document.activeElement === wrapEl) onKey(e); }} />

<div class="viewer" bind:this={wrapEl} tabindex="0"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px" style:z-index={doc.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp}>
    <span class="title">{doc.name}</span>
    <span class="pager">
      <button onclick={() => turn(-1)} disabled={page <= 1} aria-label="Zurück">‹</button>
      <span class="pos">{page}{#if pageCount} / {pageCount}{/if}</span>
      <button onclick={() => turn(1)} disabled={pageCount !== null && page >= pageCount} aria-label="Weiter">›</button>
    </span>
    <button class="close" onclick={() => void desktop.command('collapseDoc', { id: doc.id })} aria-label="Schließen">✕</button>
  </div>
  <div class="body" onwheel={(e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }} onpointerdown={onBodyPointerDown} onpointerup={onBodyPointerUp}>
    {#if desktop.api}
      <PageRenderer api={desktop.api} fileId={doc.fileId} {page} targetWidth={Math.round(size.w - 20)} onpagecount={(n) => (pageCount = n)} />
    {/if}
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} aria-hidden="true"></div>
</div>

<style>
  .viewer { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 6px;
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; }
  .viewer:focus { outline: 2px solid #2c5aa0; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #f2f4f8;
          border-bottom: 1px solid #e4e8ef; cursor: grab; user-select: none; }
  .title { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pager { display: flex; align-items: center; gap: 6px; }
  .pager button, .close { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 15px; line-height: 1; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pos { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .body { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start;
          background: #52616b; padding: 10px; }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
</style>
