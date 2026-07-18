<script lang="ts">
  import { onMount } from 'svelte';
  import {
    freeDocs, screenToWorld, zoomAt, zoomToFit, allBoxes, panBy,
    type Vec2, type Viewport,
  } from '@digital-desktop/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { clearSession } from '../session';
  import { revokeFileUrls } from '../fileCache';
  import { ui, showToast } from '../ui.svelte';
  import DocCard from './DocCard.svelte';
  import StackCard from './StackCard.svelte';
  import LinkLayer from './LinkLayer.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import DeskSwitcher from './DeskSwitcher.svelte';
  import DeskControls from './DeskControls.svelte';

  let { onlogout }: { onlogout: () => void } = $props();

  let vp = $state<Viewport>({ x: 0, y: 0, scale: 1 });
  let el: HTMLDivElement;
  let panning = $state(false);
  let spaceDown = $state(false);
  let fileInput: HTMLInputElement;

  // Mausrad zoomt zum Cursor (statt zu schwenken).
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    vp = zoomAt(vp, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.0015));
  }

  // Pointer-Verfolgung: Ein Finger/Maus schwenkt, zwei Finger pinchen+schwenken.
  const pointers = new Map<number, { x: number; y: number }>();
  let panLast: { x: number; y: number } | null = null;
  let pinchLast = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    // Erster Finger nur auf freier Fläche; weitere Finger dürfen von Karten kommen
    // (die Karte reicht sie durch, solange der Desk schon pannt — Pinch-Beitritt).
    if (e.target !== el && pointers.size === 0) return;
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    ui.deskPointers = pointers.size;
    if (pointers.size === 1) { panning = true; panLast = { x: e.clientX, y: e.clientY }; }
  }
  function onPointerMove(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && panLast) {
      vp = panBy(vp, e.clientX - panLast.x, e.clientY - panLast.y);
      panLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
      if (pinchLast) vp = zoomAt(vp, mid, dist / pinchLast);
      pinchLast = dist;
      panLast = null;
    }
  }
  function endPointer(e: PointerEvent) {
    pointers.delete(e.pointerId);
    ui.deskPointers = pointers.size;
    if (pointers.size < 2) pinchLast = 0;
    if (pointers.size === 0) { panning = false; panLast = null; }
    else if (pointers.size === 1) { const p = Array.from(pointers.values())[0]; panLast = { x: p.x, y: p.y }; }
  }

  function fitAll() {
    vp = zoomToFit(allBoxes(desktop.state), { w: el.clientWidth, h: el.clientHeight });
  }

  async function addPdfFile(file: File, position: Vec2): Promise<void> {
    if (!desktop.api) return;
    try {
      const fileId = await desktop.api.uploadFile(new Uint8Array(await file.arrayBuffer()), file.name);
      await desktop.command('addDoc', { fileId, name: file.name, position, id: uid() });
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Upload fehlgeschlagen: ${file.name}`);
    }
  }

  function onFilesPicked(): void {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    files.forEach((f, i) => void addPdfFile(f, { x: center.x + i * 28, y: center.y + i * 20 }));
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
  }

  async function abmelden(): Promise<void> {
    // Server-Invalidierung ist Best-Effort — lokal wird die Sitzung in jedem Fall beendet.
    await desktop.api?.logout().catch(() => {});
    clearSession();
    revokeFileUrls();
    await desktop.stop();
    onlogout();
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []).filter(
      (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
    );
    const world = screenToWorld(vp, { x: e.clientX, y: e.clientY });
    files.forEach((f, i) => void addPdfFile(f, { x: world.x + i * 28, y: world.y + i * 20 }));
  }

  onMount(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = true;
      if (e.code === 'Escape') {
        ui.linkingFromId = null;
        ui.menu = null;
      }
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        // Ein fokussierter Viewer blättert mit den Pfeilen selbst; Eingabefelder behalten ihre Cursor-Tasten.
        const a = document.activeElement;
        if (a instanceof HTMLElement && (a.closest('.viewer') || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        const step = 120; // wie das Pfeilpad im Bedienfeld
        if (e.code === 'ArrowUp') vp = panBy(vp, 0, step);
        if (e.code === 'ArrowDown') vp = panBy(vp, 0, -step);
        if (e.code === 'ArrowLeft') vp = panBy(vp, step, 0);
        if (e.code === 'ArrowRight') vp = panBy(vp, -step, 0);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

</script>

<div class="desk" bind:this={el} class:grabbing={spaceDown || panning}
     onwheel={onWheel} onpointerdown={onPointerDown} onpointermove={onPointerMove}
     onpointerup={endPointer} onpointercancel={endPointer}
     ondragover={onDragOver} ondrop={onDrop}>
  <div class="world" style:transform="translate({vp.x}px, {vp.y}px) scale({vp.scale})">
    <LinkLayer />
    {#each freeDocs(desktop.state) as doc (doc.id)}
      <DocCard {doc} {vp} />
    {/each}
    {#each desktop.state.stacks as stack (stack.id)}
      <StackCard {stack} {vp} />
    {/each}
  </div>
  <DeskSwitcher />
  <DeskControls
    onzoom={(f) => (vp = zoomAt(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, f))}
    onpan={(dx, dy) => (vp = panBy(vp, dx, dy))}
    onfit={fitAll}
  />
  <div class="toolbar">
    <input
      bind:this={fileInput}
      type="file"
      accept="application/pdf,.pdf"
      multiple
      hidden
      onchange={onFilesPicked}
    />
    <button onclick={() => fileInput.click()} title="PDF hinzufügen">＋ PDF</button>
    <button onclick={() => void abmelden()} title="Abmelden">Abmelden</button>
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
  .desk { position: fixed; inset: 0; overflow: hidden; touch-action: none;
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
