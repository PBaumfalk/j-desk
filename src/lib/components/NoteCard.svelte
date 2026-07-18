<script lang="ts">
  import {
    NOTE_W, NOTE_H, moveNote, rotationFor, clipOf, type Note, type Viewport,
  } from '@digital-desktop/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { showNoteMenu, showNoteMenuAt, NOTE_KIND_LABELS } from '../menus';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';

  let { note, vp }: { note: Note; vp: Viewport } = $props();

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;
  let textEl = $state<HTMLTextAreaElement | null>(null);

  const bearbeiten = $derived(ui.editingNoteId === note.id);
  const taped = $derived(note.taped === true);
  const geklammert = $derived(clipOf(desktop.state, note.id) !== undefined);
  $effect(() => {
    if (bearbeiten) textEl?.focus();
  });

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (ui.deskPointers > 0) return; // Desk pannt bereits — Finger tritt dem Pinch bei
    if (bearbeiten) { e.stopPropagation(); return; } // im Bearbeiten-Modus nicht ziehen
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== note.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: note.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === note.id) { ui.linkingFromId = null; return; }
    if (ui.clippingFromId && ui.clippingFromId !== note.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: note.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === note.id) { ui.clippingFromId = null; return; }
    if (taped) {
      // Festgeklebt: kein Drag — aber das Lang-Druck-Menü bleibt erreichbar (Band abziehen!)
      activePointer = e.pointerId;
      dragging = false;
      last = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      clearTimeout(pressTimer);
      pressTimer = undefined;
      if (e.pointerType !== 'mouse') {
        pressTimer = setTimeout(() => { showNoteMenuAt(last.x + 16, last.y + 12, note); }, 500);
      }
      return;
    }
    if (activePointer !== null && (e.currentTarget as HTMLElement).hasPointerCapture(activePointer)) return;
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: note.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      pressTimer = setTimeout(() => { dragging = false; showNoteMenuAt(last.x + 16, last.y + 12, note); }, 500);
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
    if (geklammert) moveGroupLocal(groupOf(note.id), dx, dy);
    else desktop.applyLocal((s) => moveNote(s, note.id, { x: note.position.x + dx, y: note.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (moved) {
      if (geklammert) commitGroupMove(groupOf(note.id));
      else void desktop.command('moveNote', { id: note.id, position: { x: note.position.x, y: note.position.y } });
    }
    activePointer = null;
  }

  function speichern() {
    ui.editingNoteId = null;
    const text = textEl?.value ?? '';
    if (text !== note.text) void desktop.command('editNote', { id: note.id, text });
  }
</script>

<div class="note kind-{note.kind}" role="button" tabindex="-1" aria-label={NOTE_KIND_LABELS[note.kind]}
     style:left="{note.position.x}px" style:top="{note.position.y}px"
     style:z-index={note.zIndex} style:transform="rotate({rotationFor(note.id)}deg)"
     style:width="{NOTE_W}px" style:height="{NOTE_H}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
     ondblclick={() => (ui.editingNoteId = note.id)}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showNoteMenu(e, note); }}>
  {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
  {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
  {#if note.kind !== 'notiz'}
    <div class="badge">{NOTE_KIND_LABELS[note.kind]}</div>
  {/if}
  {#if bearbeiten}
    <textarea bind:this={textEl} value={note.text} placeholder="Gedanken notieren…"
              onblur={speichern}
              onkeydown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); speichern(); } e.stopPropagation(); }}
              onpointerdown={(e) => e.stopPropagation()}></textarea>
  {:else}
    <div class="text">{note.text}</div>
  {/if}
</div>

<style>
  .note { position: absolute; display: flex; flex-direction: column; padding: 10px 12px;
          background: #fbf0a8; border-radius: 2px; cursor: grab; user-select: none; touch-action: none;
          box-shadow: 0 6px 16px rgba(0, 0, 0, .3); }
  .note.kind-frage { background: #cfe3ff; }
  .note.kind-these { background: #d3efc9; }
  .note.kind-angriffspunkt { background: #ffd9b0; }
  .note.kind-risiko { background: #ffc4c4; }
  .badge { align-self: flex-start; font-size: 10px; font-weight: 700; text-transform: uppercase;
           letter-spacing: .05em; color: rgba(0, 0, 0, .55); margin-bottom: 4px; }
  .text { flex: 1; font-size: 13px; line-height: 1.35; overflow: hidden; white-space: pre-wrap;
          overflow-wrap: break-word; color: #2a2a20; }
  textarea { flex: 1; border: none; background: transparent; resize: none; font: inherit;
             font-size: 13px; line-height: 1.35; color: #2a2a20; outline: 2px solid rgba(44, 90, 160, .5); }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
</style>
