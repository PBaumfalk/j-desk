<script lang="ts">
  import {
    CARD_W, CARD_H, moveDoc, hitTest, type Doc, type Viewport,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { showDocMenu, openDoc } from '../menus';
  import { getThumbnail } from '../thumbnails';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let thumb = $state<string | null>(null);
  $effect(() => {
    doc.fileId;
    if (desktop.api) void getThumbnail(desktop.api, doc).then((t) => (thumb = t));
  });

  let dragging = false;
  let moved = false;
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== doc.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: doc.id });
      return;
    }
    if (ui.linkingFromId === doc.id) {
      ui.linkingFromId = null;
      return;
    }
    dragging = true;
    moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.applyLocal((s) =>
      moveDoc(s, doc.id, { x: doc.position.x + e.movementX / vp.scale, y: doc.position.y + e.movementY / vp.scale }),
    );
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    const center = { x: doc.position.x + CARD_W / 2, y: doc.position.y + CARD_H / 2 };
    const hit = hitTest(desktop.state, center, doc.id);
    if (hit) void desktop.command('stackDocs', { draggedId: doc.id, targetId: hit.id });
    else void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }

</script>

<div class="card"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px"
     style:z-index={doc.zIndex} style:transform="rotate({doc.rotation}deg)"
     style:width="{CARD_W}px" style:height="{CARD_H}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}
     ondblclick={() => void openDoc(doc)}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, doc); }}>
  <div class="body">
    {#if thumb}
      <img src={thumb} alt="" draggable="false" />
    {:else}
      <div class="fallback">PDF</div>
    {/if}
  </div>
  <div class="name">{doc.name}</div>
</div>

<style>
  .card { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 4px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, .35); cursor: grab; user-select: none; }
  .body { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden;
          border-radius: 4px 4px 0 0; }
  img { width: 100%; height: 100%; object-fit: cover; object-position: top; pointer-events: none; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  .name { padding: 4px 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          background: rgba(255, 255, 255, .9); border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
</style>
