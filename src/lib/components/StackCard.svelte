<script lang="ts">
  import {
    CARD_W, CARD_H, findDoc, moveStack, screenToWorld, type Stack, type Viewport,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { showDocMenu, showStackMenu, openDoc } from '../menus';
  import { getThumbnail } from '../thumbnails';

  let { stack, vp }: { stack: Stack; vp: Viewport } = $props();
  const fanned = $derived(ui.fannedStackId === stack.id);

  const topDoc = $derived(findDoc(desktop.state, stack.docIds[stack.docIds.length - 1]));
  let thumb = $state<string | null>(null);
  $effect(() => {
    if (topDoc && desktop.api) void getThumbnail(desktop.api, topDoc).then((t) => (thumb = t));
    else thumb = null;
  });

  let dragging = false;
  let moved = false;
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== stack.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: stack.id });
      return;
    }
    if (ui.linkingFromId === stack.id) {
      ui.linkingFromId = null;
      return;
    }
    dragging = true;
    moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: stack.id });
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.applyLocal((s) =>
      moveStack(s, stack.id, { x: stack.position.x + e.movementX / vp.scale, y: stack.position.y + e.movementY / vp.scale }),
    );
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveStack', { stackId: stack.id, position: { x: stack.position.x, y: stack.position.y } });
    else ui.fannedStackId = fanned ? null : stack.id;
  }

  /** Gefächerter Eintrag: >30 px ziehen = herausnehmen, sonst Klick = öffnen. */
  function fanPointerDown(e: PointerEvent, docId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const cleanup = () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
    };
    const onUp = (up: PointerEvent) => {
      cleanup();
      if (Math.hypot(up.clientX - startX, up.clientY - startY) > 30) {
        const w = screenToWorld(vp, { x: up.clientX, y: up.clientY });
        void desktop.command('removeFromStack', {
          docId,
          position: { x: w.x - CARD_W / 2, y: w.y - CARD_H / 2 },
        });
      } else {
        const d = findDoc(desktop.state, docId);
        if (d) void openDoc(d);
      }
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  }
</script>

<div class="stack" style:left="{stack.position.x}px" style:top="{stack.position.y}px" style:z-index={stack.zIndex}
     style:width="{CARD_W + 24}px" style:height="{CARD_H + 24}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showStackMenu(e, stack); }}>
  <div class="sheet s2"></div>
  <div class="sheet s1"></div>
  <div class="sheet top">
    {#if thumb}
      <img src={thumb} alt="" draggable="false" />
    {:else}
      <div class="fallback">PDF</div>
    {/if}
  </div>
  <div class="badge">{stack.docIds.length}</div>
  {#if ui.editingStackId === stack.id}
    <input class="name" value={stack.name} placeholder="Stapelname"
           onpointerdown={(e) => e.stopPropagation()}
           onchange={(e) => { const name = (e.currentTarget as HTMLInputElement).value; void desktop.command('renameStack', { stackId: stack.id, name }); ui.editingStackId = null; }} />
  {:else if stack.name}
    <div class="name label">{stack.name}</div>
  {/if}

  {#if fanned}
    <div class="fan">
      {#each stack.docIds as docId (docId)}
        {@const d = findDoc(desktop.state, docId)}
        {#if d}
          <div class="fan-card" onpointerdown={(e) => fanPointerDown(e, docId)}
               oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, d); }}>
            {d.name}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .stack { position: absolute; cursor: grab; user-select: none; }
  .sheet { position: absolute; width: 180px; height: 240px; background: #fff; border-radius: 4px;
           box-shadow: 0 6px 18px rgba(0, 0, 0, .35); overflow: hidden; }
  .sheet.s2 { left: 16px; top: 16px; transform: rotate(2deg); }
  .sheet.s1 { left: 8px; top: 8px; transform: rotate(-1.5deg); }
  .sheet.top { left: 0; top: 0; display: flex; align-items: center; justify-content: center; }
  .sheet img { width: 100%; height: 100%; object-fit: cover; object-position: top; pointer-events: none; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  .badge { position: absolute; top: -10px; right: 2px; min-width: 22px; height: 22px; border-radius: 11px;
           background: #d9534f; color: #fff; font-size: 12px; font-weight: 700;
           display: flex; align-items: center; justify-content: center; padding: 0 5px; }
  .name { position: absolute; left: 0; bottom: -26px; width: 100%; text-align: center; font-size: 12px; }
  .name.label { color: #fdf9ec; text-shadow: 0 1px 3px rgba(0, 0, 0, .7); }
  input.name { box-sizing: border-box; border-radius: 6px; border: none; padding: 3px 6px; }
  .fan { position: absolute; left: 0; top: 100%; margin-top: 34px; display: flex; flex-direction: column;
         gap: 4px; width: 220px; background: rgba(255, 255, 255, .95); border-radius: 10px; padding: 6px;
         box-shadow: 0 8px 30px rgba(0, 0, 0, .35); }
  .fan-card { padding: 7px 9px; border-radius: 6px; background: #fff; border: 1px solid #e5e5e5;
              font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .fan-card:hover { background: #eef3ff; }
</style>
