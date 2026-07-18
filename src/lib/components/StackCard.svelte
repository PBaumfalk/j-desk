<script lang="ts">
  import {
    CARD_W, CARD_H, findDoc, moveStack, clipOf, screenToWorld, type Stack, type Viewport,
  } from '@digital-desktop/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast, pointerUeberKorb } from '../ui.svelte';
  import { showDocMenu, showStackMenu, showStackMenuAt } from '../menus';
  import { getThumbnail } from '../thumbnails';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import KonvolutViewer from './KonvolutViewer.svelte';

  let { stack, vp }: { stack: Stack; vp: Viewport } = $props();
  const fanned = $derived(ui.fannedStackId === stack.id);
  const taped = $derived(stack.taped === true);
  const geklammert = $derived(clipOf(desktop.state, stack.id) !== undefined);

  const topDoc = $derived(findDoc(desktop.state, stack.docIds[stack.docIds.length - 1]));
  let thumb = $state<string | null>(null);
  $effect(() => {
    if (topDoc && desktop.api) void getThumbnail(desktop.api, topDoc).then((t) => (thumb = t));
    else thumb = null;
  });

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (ui.deskPointers > 0) return; // Desk pannt bereits — Finger bubbelt durch und tritt dem Pinch bei
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== stack.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: stack.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === stack.id) { ui.linkingFromId = null; return; }
    if (ui.clippingFromId && ui.clippingFromId !== stack.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: stack.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === stack.id) { ui.clippingFromId = null; return; }
    if (taped) {
      // Festgeklebt: kein Drag — aber das Lang-Druck-Menü bleibt erreichbar (Band abziehen!)
      activePointer = e.pointerId;
      dragging = false;
      last = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      clearTimeout(pressTimer);
      pressTimer = undefined;
      if (e.pointerType !== 'mouse') {
        pressTimer = setTimeout(() => { showStackMenuAt(last.x + 16, last.y + 12, stack); }, 500);
      }
      return;
    }
    // Nur blocken, solange das div den gemerkten Pointer wirklich noch hält (siehe DocCard):
    // ein bei gedrücktem Finger ersetztes div verpasst sein pointerup — Guard wäre sonst permanent.
    if (activePointer !== null && (e.currentTarget as HTMLElement).hasPointerCapture(activePointer)) return;
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: stack.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      // Leicht versetzt öffnen: der synthetische Klick beim Fingerheben landet so auf dem
      // Backdrop (schließt nur per pointerdown) statt auf dem ersten Menüeintrag.
      pressTimer = setTimeout(() => { dragging = false; showStackMenuAt(last.x + 16, last.y + 12, stack); }, 500);
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
    if (geklammert) moveGroupLocal(groupOf(stack.id), dx, dy);
    else desktop.applyLocal((s) => moveStack(s, stack.id, { x: stack.position.x + dx, y: stack.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (moved) {
      if (pointerUeberKorb(e.clientX, e.clientY)) {
        void desktop.command('trashObject', { id: stack.id, trashedAt: new Date().toISOString() });
        activePointer = null;
        return;
      }
      if (geklammert) commitGroupMove(groupOf(stack.id));
      else void desktop.command('moveStack', { stackId: stack.id, position: { x: stack.position.x, y: stack.position.y } });
    } else if (!stack.stapled) {
      // Geheftete Konvolute fächern sich nicht auf — Aufschlagen nur per Doppelklick/Menü.
      ui.fannedStackId = fanned ? null : stack.id;
    }
    activePointer = null;
  }

  /** Gefächerter Eintrag: >30 px ziehen = herausnehmen, sonst Klick = öffnen. */
  function fanPointerDown(e: PointerEvent, docId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Capture ist Komfort (Ziehen über den Rand) — der Klick-Pfad funktioniert auch ohne
    }
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
        // Klick: Papier aus dem Stapel ziehen und direkt aufschlagen (statt neuen Tab öffnen)
        void (async () => {
          await desktop.command('removeFromStack', {
            docId,
            position: { x: stack.position.x + CARD_W + 48, y: stack.position.y },
          });
          await desktop.command('expandDoc', { id: docId });
        })();
      }
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
  }
</script>

{#if stack.open}
  <KonvolutViewer {stack} {vp} />
{:else}
  <div class="stack" role="button" tabindex="-1" aria-label={stack.name || 'Stapel'}
       style:left="{stack.position.x}px" style:top="{stack.position.y}px" style:z-index={stack.zIndex}
       style:width="{CARD_W + 24}px" style:height="{CARD_H + 24}px"
       onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
       ondblclick={() => { if (stack.stapled) void desktop.command('expandStack', { id: stack.id }); }}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showStackMenu(e, stack); }}>
    {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
    {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
    {#if stack.stapled}<div class="heftklammer" aria-hidden="true">📎</div>{/if}
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
            <div class="fan-card" role="button" tabindex="-1" aria-label={d.name}
                 onpointerdown={(e) => fanPointerDown(e, docId)}
                 oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, d); }}>
              {d.name}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .stack { position: absolute; cursor: grab; user-select: none; touch-action: none; }
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
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); z-index: 1; }
  .heftklammer { position: absolute; top: -8px; left: 12px; font-size: 18px; pointer-events: none;
                 filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
  .fan { position: absolute; left: 0; top: 100%; margin-top: 34px; display: flex; flex-direction: column;
         gap: 4px; width: 220px; background: rgba(255, 255, 255, .95); border-radius: 10px; padding: 6px;
         box-shadow: 0 8px 30px rgba(0, 0, 0, .35); }
  .fan-card { padding: 7px 9px; border-radius: 6px; background: #fff; border: 1px solid #e5e5e5;
              font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .fan-card:hover { background: #eef3ff; }
</style>
