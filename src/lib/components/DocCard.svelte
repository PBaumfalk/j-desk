<script lang="ts">
  import { CARD_W, CARD_H, type Doc } from '../state/model';
  import type { Viewport } from '../state/viewport';
  import { desktop } from '../store.svelte';
  import { moveDoc, bringToFront } from '../state/documents';
  import { openPath } from '@tauri-apps/plugin-opener';
  import { getThumbnail } from '../thumbnails';
  import { addLink } from '../state/links';
  import { ui } from '../ui.svelte';
  import { showDocMenu } from '../menus';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let thumb = $state<string | null>(null);
  $effect(() => {
    doc.path; // Abhängigkeit: nach „Neu verknüpfen“ neu rendern
    if (doc.missing) { thumb = null; return; }
    void getThumbnail(doc).then((t) => (thumb = t));
  });

  let dragging = false;
  let moved = false;
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== doc.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      desktop.apply((s) => addLink(s, from, doc.id));
      return;
    }
    if (ui.linkingFromId === doc.id) {
      ui.linkingFromId = null;
      return;
    }
    dragging = true;
    moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    desktop.apply((s) => bringToFront(s, doc.id));
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.apply(
      (s) => moveDoc(s, doc.id, { x: doc.position.x + e.movementX / vp.scale, y: doc.position.y + e.movementY / vp.scale }),
      { transient: true },
    );
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) desktop.apply((s) => s); // persistiert die Endposition
  }
</script>

<div class="card" class:missing={doc.missing}
     style:left="{doc.position.x}px" style:top="{doc.position.y}px"
     style:z-index={doc.zIndex} style:transform="rotate({doc.rotation}deg)"
     style:width="{CARD_W}px" style:height="{CARD_H}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}
     ondblclick={() => { if (!doc.missing) void openPath(doc.path); }}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, doc); }}>
  <div class="body">
    {#if doc.missing}
      <div class="warn">⚠️<br />Datei fehlt</div>
    {:else if thumb}
      <img src={thumb} alt="" draggable="false" />
    {:else}
      <div class="fallback">PDF</div>
    {/if}
  </div>
  <div class="name">{doc.path.split('/').pop()}</div>
</div>

<style>
  .card { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 4px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, .35); cursor: grab; user-select: none; }
  .card.missing { opacity: .55; filter: grayscale(1); }
  .body { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden;
          border-radius: 4px 4px 0 0; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  img { width: 100%; height: 100%; object-fit: cover; object-position: top; pointer-events: none; }
  .warn { text-align: center; font-size: 14px; }
  .name { padding: 4px 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          background: rgba(255, 255, 255, .9); border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
</style>
