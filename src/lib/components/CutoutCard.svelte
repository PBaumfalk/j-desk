<script lang="ts">
  import { moveCutout, rotationFor, type Cutout, type Viewport } from '@digital-desktop/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import PageRenderer from './PageRenderer.svelte';

  let { cutout, vp }: { cutout: Cutout; vp: Viewport } = $props();

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;

  function menue(x: number, y: number) {
    ui.menu = {
      x, y,
      items: [
        { label: 'Verknüpfen…', action: () => { ui.linkingFromId = cutout.id; } },
        { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeCutout', { id: cutout.id }) },
      ],
    };
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (ui.deskPointers > 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== cutout.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: cutout.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === cutout.id) { ui.linkingFromId = null; return; }
    if (activePointer !== null && (e.currentTarget as HTMLElement).hasPointerCapture(activePointer)) return;
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: cutout.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      pressTimer = setTimeout(() => { dragging = false; menue(last.x + 16, last.y + 12); }, 500);
    }
  }
  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    if (!dragging) return;
    if (pressTimer) {
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) <= 8) return;
      clearTimeout(pressTimer); pressTimer = undefined;
    }
    moved = true;
    const dx = (e.clientX - last.x) / vp.scale;
    const dy = (e.clientY - last.y) / vp.scale;
    last = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveCutout(s, cutout.id, { x: cutout.position.x + dx, y: cutout.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (moved) void desktop.command('moveCutout', { id: cutout.id, position: { x: cutout.position.x, y: cutout.position.y } });
    activePointer = null;
  }
</script>

<div class="cutout" role="button" tabindex="-1" aria-label="Ausschnitt"
     style:left="{cutout.position.x}px" style:top="{cutout.position.y}px"
     style:z-index={cutout.zIndex} style:transform="rotate({rotationFor(cutout.id)}deg)"
     style:width="{cutout.rect.w}px" style:height="{cutout.rect.h}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); menue(e.clientX, e.clientY); }}>
  {#if desktop.api}
    <PageRenderer api={desktop.api} fileId={cutout.fileId} page={cutout.page}
      targetWidth={Math.round(cutout.rect.w)} sourceRect={cutout.rect} />
  {/if}
</div>

<style>
  /* Ausschnitt wie mit der Schere geschnitten: leicht unregelmäßig gedreht, Papierkante */
  .cutout { position: absolute; cursor: grab; user-select: none; touch-action: none; overflow: hidden;
            background: #fff; box-shadow: 0 5px 14px rgba(0, 0, 0, .35); outline: 1px solid rgba(0, 0, 0, .08); }
  .cutout :global(.page) { pointer-events: none; box-shadow: none; }
</style>
