<script lang="ts">
  import { onMount } from 'svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { readFile } from '@tauri-apps/plugin-fs';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import {
    freeDocs, screenToWorld, zoomAt, zoomToFit, allBoxes,
    type Vec2, type Viewport,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import DocCard from './DocCard.svelte';
  import StackCard from './StackCard.svelte';
  import LinkLayer from './LinkLayer.svelte';
  import ContextMenu from './ContextMenu.svelte';

  let vp = $state<Viewport>({ x: 0, y: 0, scale: 1 });
  let el: HTMLDivElement;
  let panning = $state(false);
  let spaceDown = $state(false);

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
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

  async function addPdfFromPath(path: string, position: Vec2): Promise<void> {
    if (!desktop.api) return;
    const name = path.split('/').pop() ?? 'Dokument.pdf';
    try {
      const fileId = await desktop.api.uploadFile(await readFile(path), name);
      await desktop.command('addDoc', { fileId, name, position, id: crypto.randomUUID() });
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Upload fehlgeschlagen: ${name}`);
    }
  }

  async function addViaDialog(): Promise<void> {
    const picked = await openDialog({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!picked) return;
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    const paths = Array.isArray(picked) ? picked : [picked];
    for (const [i, p] of paths.entries()) {
      await addPdfFromPath(p, { x: center.x + i * 28, y: center.y + i * 20 });
    }
  }

  onMount(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = true;
      if (e.code === 'Escape') {
        ui.linkingFromId = null;
        ui.menu = null;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type !== 'drop') return;
        const dpr = window.devicePixelRatio;
        const world = screenToWorld(vp, { x: e.payload.position.x / dpr, y: e.payload.position.y / dpr });
        e.payload.paths
          .filter((p) => p.toLowerCase().endsWith('.pdf'))
          .forEach((p, i) => void addPdfFromPath(p, { x: world.x + i * 28, y: world.y + i * 20 }));
      })
      .then((u) => {
        unlisten = u;
      });
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
    <button onclick={() => void addViaDialog()} title="PDF hinzufügen">＋ PDF</button>
    <button onclick={fitAll}>Übersicht</button>
  </div>
  {#if ui.linkingFromId}
    <div class="hint">Verknüpfen: Ziel anklicken (Esc bricht ab)</div>
  {/if}
  {#if desktop.status === 'offline' || desktop.status === 'connecting'}
    <div class="banner">
      {desktop.status === 'offline' ? 'Verbindung getrennt — verbinde neu…' : 'Verbinde…'}
    </div>
    <div class="blocker"></div>
  {/if}
  {#if ui.toast}
    <div class="toast">{ui.toast}</div>
  {/if}
  <ContextMenu />
</div>

<style>
  .desk { position: fixed; inset: 0; overflow: hidden;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .desk.grabbing { cursor: grabbing; }
  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; z-index: 9000; }
  .toolbar button { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
                    background: rgba(255, 255, 255, .92); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
          border-radius: 999px; background: rgba(20, 40, 90, .85); color: #fff; font-size: 13px; z-index: 9999; }
  .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
            border-radius: 999px; background: rgba(140, 60, 20, .9); color: #fff; font-size: 13px; z-index: 99000; }
  .blocker { position: fixed; inset: 0; z-index: 98000; cursor: wait; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
           border-radius: 10px; background: rgba(20, 20, 20, .88); color: #fff; font-size: 13px; z-index: 99500; }
</style>
