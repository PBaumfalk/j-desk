<script lang="ts">
  import {
    CARD_W, CARD_H, moveDoc, hitTest, stampsFor, flagsFor, clipOf, type Doc, type Viewport,
  } from '@digital-desktop/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { showDocMenu, showDocMenuAt } from '../menus';
  import { getThumbnail } from '../thumbnails';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import DocViewer from './DocViewer.svelte';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let thumb = $state<string | null>(null);
  $effect(() => {
    doc.fileId;
    if (desktop.api) void getThumbnail(desktop.api, doc).then((t) => (thumb = t));
  });
  const kartenStempel = $derived(stampsFor(desktop.state, doc.id, doc.pageOnly ?? 1));
  const kartenFahnen = $derived(flagsFor(desktop.state, doc.id));
  const taped = $derived(doc.taped === true);
  const geklammert = $derived(clipOf(desktop.state, doc.id) !== undefined);

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (ui.deskPointers > 0) return; // Desk pannt bereits — Finger bubbelt durch und tritt dem Pinch bei
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== doc.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: doc.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === doc.id) { ui.linkingFromId = null; return; }
    if (ui.clippingFromId && ui.clippingFromId !== doc.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: doc.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === doc.id) { ui.clippingFromId = null; return; }
    if (taped) {
      // Festgeklebt: kein Drag — aber das Lang-Druck-Menü bleibt erreichbar (Band abziehen!)
      activePointer = e.pointerId;
      dragging = false;
      last = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      clearTimeout(pressTimer);
      pressTimer = undefined;
      if (e.pointerType !== 'mouse') {
        pressTimer = setTimeout(() => { showDocMenuAt(last.x + 16, last.y + 12, doc); }, 500);
      }
      return;
    }
    // Nur blocken, solange das div den gemerkten Pointer wirklich noch hält — wird die Karte
    // bei gedrücktem Finger durch den Viewer ersetzt ({#if doc.open}), erreicht das pointerup
    // das alte div nie; ohne diese Prüfung bliebe die Karte dauerhaft unverschiebbar.
    if (activePointer !== null && (e.currentTarget as HTMLElement).hasPointerCapture(activePointer)) return;
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      // Leicht versetzt öffnen: der synthetische Klick beim Fingerheben landet so auf dem
      // Backdrop (schließt nur per pointerdown) statt auf dem ersten Menüeintrag.
      pressTimer = setTimeout(() => { dragging = false; showDocMenuAt(last.x + 16, last.y + 12, doc); }, 500);
    }
  }
  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    if (!dragging) return;
    if (pressTimer) {
      // Lang-Druck abwarten: unterhalb der 8-px-Schwelle bewegt sich die Karte nicht (kein Mikro-Drift).
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) <= 8) return;
      clearTimeout(pressTimer); pressTimer = undefined;
    }
    moved = true;
    const dx = (e.clientX - last.x) / vp.scale;
    const dy = (e.clientY - last.y) / vp.scale;
    last = { x: e.clientX, y: e.clientY };
    if (geklammert) moveGroupLocal(groupOf(doc.id), dx, dy);
    else desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + dx, y: doc.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (!moved) { activePointer = null; return; }
    if (geklammert) { commitGroupMove(groupOf(doc.id)); activePointer = null; return; }
    const center = { x: doc.position.x + CARD_W / 2, y: doc.position.y + CARD_H / 2 };
    const hit = hitTest(desktop.state, center, doc.id);
    if (hit) void desktop.command('stackDocs', { draggedId: doc.id, targetId: hit.id, id: uid() });
    else void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
    activePointer = null;
  }

</script>

{#if doc.open}
  <DocViewer {doc} {vp} />
{:else}
  <div class="card" role="button" tabindex="-1" aria-label={doc.name}
       style:left="{doc.position.x}px" style:top="{doc.position.y}px"
       style:z-index={doc.zIndex} style:transform="rotate({doc.rotation}deg)"
       style:width="{CARD_W}px" style:height="{CARD_H}px"
       onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
       ondblclick={() => void desktop.command('expandDoc', { id: doc.id })}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, doc); }}>
    {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
    {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
    <div class="body">
      {#if thumb}
        <img src={thumb} alt="" draggable="false" />
      {:else}
        <div class="fallback">PDF</div>
      {/if}
      {#each kartenStempel as st (st.id)}
        <div class="mini-stamp" class:blau={st.color === 'blue'}
             style:left="{(st.x / st.baseW) * 100}%" style:top="{(st.y / st.baseH) * 100}%"
             style:transform="translate(-50%, -50%) rotate({st.angle}deg) scale({CARD_W / st.baseW})">
          {st.text}
        </div>
      {/each}
    </div>
    <div class="name">{doc.name}</div>
    {#each kartenFahnen as fl (fl.id)}
      <div class="mini-fahne" style:top="{fl.offset * CARD_H}px" style:background={fl.color}></div>
    {/each}
  </div>
{/if}

<style>
  .card { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 4px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, .35); cursor: grab; user-select: none; touch-action: none; }
  .body { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden;
          border-radius: 4px 4px 0 0; }
  img { width: 100%; height: 100%; object-fit: cover; object-position: top; pointer-events: none; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  .mini-stamp { position: absolute; pointer-events: none; border: 3px solid #b3261e; color: #b3261e;
                border-radius: 6px; padding: 2px 10px; opacity: .82; font-weight: 800; letter-spacing: .12em;
                font-size: 20px; white-space: nowrap; transform-origin: center; }
  .mini-stamp.blau { border-color: #1d4ed8; color: #1d4ed8; }
  .name { padding: 4px 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          background: rgba(255, 255, 255, .9); border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
  .mini-fahne { position: absolute; right: -8px; width: 16px; height: 10px; border-radius: 0 3px 3px 0;
                box-shadow: 1px 1px 2px rgba(0, 0, 0, .3); pointer-events: none; }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
</style>
