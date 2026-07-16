<script lang="ts">
  import { onMount } from 'svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { desktop } from '../store.svelte';
  import {
    freeDocs, addDoc, screenToWorld, zoomAt, zoomToFit, type Viewport, allBoxes,
  } from '@digital-desktop/core';
  import DocCard from './DocCard.svelte';
  import StackCard from './StackCard.svelte';
  import LinkLayer from './LinkLayer.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import { ui } from '../ui.svelte';

  let vp = $state<Viewport>({ x: 0, y: 0, scale: 1 });
  let el: HTMLDivElement;
  let panning = $state(false);
  let spaceDown = $state(false);

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad-Pinch kommt in der Webview als wheel-Event mit ctrlKey an
      vp = zoomAt(vp, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.01));
    } else {
      vp = { ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY };
    }
  }
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || e.target !== el) return;
    panning = true;
    el.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (panning) vp = { ...vp, x: vp.x + e.movementX, y: vp.y + e.movementY };
  }
  function onPointerUp() {
    panning = false;
  }

  function fitAll() {
    vp = zoomToFit(allBoxes(desktop.state), { w: el.clientWidth, h: el.clientHeight });
  }

  async function addViaDialog() {
    const picked = await openDialog({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!picked) return;
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    (Array.isArray(picked) ? picked : [picked]).forEach((p, i) => {
      desktop.apply((s) => addDoc(s, p, { x: center.x + i * 28, y: center.y + i * 20 }));
    });
  }

  onMount(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = true;
      if (e.code === 'Escape') { ui.linkingFromId = null; ui.menu = null; }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== 'drop') return;
      const dpr = window.devicePixelRatio;
      const world = screenToWorld(vp, { x: e.payload.position.x / dpr, y: e.payload.position.y / dpr });
      e.payload.paths
        .filter((p) => p.toLowerCase().endsWith('.pdf'))
        .forEach((p, i) => desktop.apply((s) => addDoc(s, p, { x: world.x + i * 28, y: world.y + i * 20 })));
    }).then((u) => { unlisten = u; });
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      unlisten?.();
    };
  });
</script>

<div class="desk" bind:this={el} class:grabbing={spaceDown || panning}
     onwheel={onWheel} onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}>
  <div class="world" style:transform="translate({vp.x}px, {vp.y}px) scale({vp.scale})">
    <LinkLayer />
    {#each freeDocs(desktop.state) as doc (doc.id)}
      <DocCard {doc} {vp} />
    {/each}
    {#each desktop.state.stacks as stack (stack.id)}
      <StackCard {stack} {vp} />
    {/each}
  </div>
  <div class="toolbar">
    <button onclick={addViaDialog} title="PDF hinzufügen">＋ PDF</button>
    <button onclick={fitAll}>Übersicht</button>
  </div>
  {#if ui.linkingFromId}
    <div class="hint">Verknüpfen: Ziel anklicken (Esc bricht ab)</div>
  {/if}
  <ContextMenu />
</div>

<style>
  .desk { position: fixed; inset: 0; overflow: hidden;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .desk.grabbing { cursor: grabbing; }
  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; }
  .toolbar button { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
                    background: rgba(255,255,255,.92); cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
          border-radius: 999px; background: rgba(20, 40, 90, .85); color: #fff; font-size: 13px; z-index: 9999; }
</style>
