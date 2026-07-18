<script lang="ts">
  import { moveCutout, rotationFor, clipOf, type Cutout, type Viewport } from '@digital-desktop/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast, pointerUeberKorb } from '../ui.svelte';
  import { showCutoutMenuAt } from '../menus';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import PageRenderer from './PageRenderer.svelte';

  let { cutout, vp }: { cutout: Cutout; vp: Viewport } = $props();

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;
  const taped = $derived(cutout.taped === true);
  const geklammert = $derived(clipOf(desktop.state, cutout.id) !== undefined);

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
    if (ui.clippingFromId && ui.clippingFromId !== cutout.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: cutout.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === cutout.id) { ui.clippingFromId = null; return; }
    if (taped) {
      // Festgeklebt: kein Drag — aber das Lang-Druck-Menü bleibt erreichbar (Band abziehen!)
      activePointer = e.pointerId;
      dragging = false;
      last = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      clearTimeout(pressTimer);
      pressTimer = undefined;
      if (e.pointerType !== 'mouse') {
        pressTimer = setTimeout(() => { showCutoutMenuAt(last.x + 16, last.y + 12, cutout); }, 500);
      }
      return;
    }
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
      pressTimer = setTimeout(() => { dragging = false; showCutoutMenuAt(last.x + 16, last.y + 12, cutout); }, 500);
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
    if (geklammert) moveGroupLocal(groupOf(cutout.id), dx, dy);
    else desktop.applyLocal((s) => moveCutout(s, cutout.id, { x: cutout.position.x + dx, y: cutout.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (moved) {
      if (pointerUeberKorb(e.clientX, e.clientY)) {
        void desktop.command('trashObject', { id: cutout.id, trashedAt: new Date().toISOString() });
        activePointer = null;
        return;
      }
      if (geklammert) commitGroupMove(groupOf(cutout.id));
      else void desktop.command('moveCutout', { id: cutout.id, position: { x: cutout.position.x, y: cutout.position.y } });
    }
    activePointer = null;
  }
</script>

<div class="cutout" role="button" tabindex="-1" aria-label="Ausschnitt"
     style:left="{cutout.position.x}px" style:top="{cutout.position.y}px"
     style:z-index={cutout.zIndex} style:transform="rotate({rotationFor(cutout.id)}deg)"
     style:width="{cutout.rect.w}px" style:height="{cutout.rect.h}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showCutoutMenuAt(e.clientX, e.clientY, cutout); }}>
  {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
  {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
  <div class="clip">
    {#if desktop.api}
      <PageRenderer api={desktop.api} fileId={cutout.fileId} page={cutout.page}
        targetWidth={Math.round(cutout.rect.w)} sourceRect={cutout.rect} />
    {/if}
  </div>
</div>

<style>
  /* Ausschnitt wie mit der Schere geschnitten: leicht unregelmäßig gedreht, Papierkante */
  .cutout { position: absolute; cursor: grab; user-select: none; touch-action: none;
            background: #fff; box-shadow: 0 5px 14px rgba(0, 0, 0, .35); outline: 1px solid rgba(0, 0, 0, .08); }
  .clip { position: absolute; inset: 0; overflow: hidden; }
  .cutout :global(.page) { pointer-events: none; box-shadow: none; }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
</style>
