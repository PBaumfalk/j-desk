<script lang="ts">
  import { moveCutout, rotationFor, clipOf, type Cutout, type Doc, type Viewport } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { fundstelleAusCutout } from '../jump';
  import { ui, showToast } from '../ui.svelte';
  import { kartenBewegungGesperrt } from '../sitzungsmodus';
  import { abwurfZielFuer, starteZeitleisteEintrag } from '../zeitleisteDrop';
  import { showCutoutMenuAt } from '../menus';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import { imageMime } from '../thumbnails';
  import { getFileUrl } from '../fileCache';
  import PageRenderer from './PageRenderer.svelte';

  let { cutout, vp }: { cutout: Cutout; vp: Viewport } = $props();

  const istBild = $derived(cutout.kind === 'image');
  let bildUrl = $state<string | null>(null);
  let bildFehler = $state<string | null>(null);

  $effect(() => {
    cutout.fileId;
    if (!istBild || !desktop.api) return;
    bildUrl = null;
    bildFehler = null;
    void getFileUrl(desktop.api, cutout.fileId, imageMime(cutout.sourceName ?? ''))
      .then((u) => (bildUrl = u))
      .catch((e) => { bildFehler = e instanceof Error ? e.message : 'Laden fehlgeschlagen'; });
  });

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;
  const taped = $derived(cutout.taped === true);
  // SESS-01: siehe DocCard.svelte — Klebeband und Sitzungssperre teilen sich denselben Zweig.
  const dragGesperrt = $derived(taped || kartenBewegungGesperrt());
  const geklammert = $derived(clipOf(desktop.state, cutout.id) !== undefined);

  /**
   * Auflösung der Quellkarte über fileId (ein Ausschnitt trägt selbst keine docId, nur fileId —
   * jump.ts-Kopfkommentar). Gemeinsamer Helfer für taskRefFromId UND tabelleBelegFuer (08-07
   * Task 3): beide Zwei-Klick-Auswahlmodi lösen an genau dieser Stelle dasselbe Ziel auf — ein
   * zweites Mal dieselbe Suche zu schreiben wäre der Punkt, an dem ein drittes Mal vergessen wird.
   */
  function quelleFuerCutout(): Doc | undefined {
    return desktop.state.docs.find((d) => d.fileId === cutout.fileId);
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
    if (ui.clippingFromId && ui.clippingFromId !== cutout.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: cutout.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === cutout.id) { ui.clippingFromId = null; return; }
    // TASK-01, Task 3: „Bezug zu Dokument…" wartet auf eine Dokument-/Ausschnittkarte als Ziel.
    // Ein Cutout trägt selbst keine docId (nur fileId, jump.ts-Kopfkommentar) — TaskDocRef
    // verlangt aber zwingend docId (Task 1). Die auf dem Tisch liegende Quellkarte wird daher
    // über fileId aufgelöst (gleicher Mechanismus wie planeSprung() in jump.ts); liegt sie
    // gerade nicht auf dem Tisch, kann der Bezug hier nicht gesetzt werden.
    if (ui.taskRefFromId) {
      const from = ui.taskRefFromId;
      ui.taskRefFromId = null;
      const quelle = quelleFuerCutout();
      if (!quelle) { showToast('Bezug kann nur gesetzt werden, solange das Quelldokument auf dem Tisch liegt.'); return; }
      void desktop.command('setTaskDocRef', { id: from, docRef: { docId: quelle.id, page: cutout.page, cutoutId: cutout.id } });
      return;
    }
    // CALC-01, 08-07 Task 3: „+ Beleg verknüpfen" wartet auf eine Dokument-/Ausschnittkarte —
    // derselbe fileId->docId-Auflösungsweg wie taskRefFromId oben (quelleFuerCutout()).
    if (ui.tabelleBelegFuer) {
      const { tableId, rowId } = ui.tabelleBelegFuer;
      ui.tabelleBelegFuer = null;
      const quelle = quelleFuerCutout();
      if (!quelle) { showToast('Beleg kann nur gesetzt werden, solange das Quelldokument auf dem Tisch liegt.'); return; }
      void desktop.command('setTableRowBeleg', { tableId, rowId, belegRef: { docId: quelle.id, page: cutout.page, cutoutId: cutout.id } });
      return;
    }
    // CHRONO-01, 09-06 Task 2: „+ Eintrag" wartet auf ein Zielobjekt — gleiche Stelle wie
    // taskRefFromId/tabelleBelegFuer oben (Klickweg, gleichwertig zum Ziehen unten in
    // onPointerUp). Der Ausschnitt referenziert sich hier selbst (eigene id), anders als bei
    // taskRefFromId/tabelleBelegFuer, die auf die zugrundeliegende Dokument-id auflösen müssen.
    if (ui.zeitleisteEintragFuer) {
      starteZeitleisteEintrag(ui.zeitleisteEintragFuer, cutout.id);
      return;
    }
    if (dragGesperrt) {
      // Festgeklebt oder Sitzungssperre aktiv: kein Drag — aber das Lang-Druck-Menü bleibt
      // erreichbar (Band abziehen!)
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
      const ziel = abwurfZielFuer(e.clientX, e.clientY, cutout.id);
      if (ziel.art === 'korb') {
        void desktop.command('trashObject', { id: cutout.id, trashedAt: new Date().toISOString() });
        activePointer = null;
        return;
      }
      if (ziel.art === 'zeitleiste') {
        // CHRONO-01: der Eintrag ist eine Referenz, keine Verlagerung — die Position bleibt
        // unangetastet, es wird kein Verschiebe-Command gesendet (T-09-25).
        starteZeitleisteEintrag(ziel.zeitleisteId, cutout.id);
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
     ondblclick={() => void desktop.jumpTo(fundstelleAusCutout(cutout))}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showCutoutMenuAt(e.clientX, e.clientY, cutout); }}>
  {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
  {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
  <div class="clip">
    {#if istBild}
      {#if bildUrl}
        <img class="bildschnitt" src={bildUrl} alt="" draggable="false"
             style:left="{-cutout.rect.x}px" style:top="{-cutout.rect.y}px" />
      {:else if bildFehler}
        <div class="fallback fehler" title={bildFehler}>⚠️ Seite kann nicht angezeigt werden</div>
      {/if}
    {:else if desktop.api}
      <PageRenderer api={desktop.api} fileId={cutout.fileId} page={cutout.page}
        targetWidth={Math.round(cutout.rect.w)} sourceRect={cutout.rect}
        source={cutout.kind === 'convertible' ? 'preview' : 'original'} />
    {/if}
  </div>
</div>

<style>
  /* Ausschnitt wie mit der Schere geschnitten: leicht unregelmäßig gedreht, Papierkante */
  .cutout { position: absolute; cursor: grab; user-select: none; touch-action: none;
            background: #fff; box-shadow: 0 5px 14px rgba(0, 0, 0, .35); outline: 1px solid rgba(0, 0, 0, .08); }
  .clip { position: absolute; inset: 0; overflow: hidden; }
  .cutout :global(.page) { pointer-events: none; box-shadow: none; }
  .bildschnitt { position: absolute; max-width: none; pointer-events: none; }
  .fallback.fehler { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
                      flex-direction: column; gap: 4px; font-size: 11px; font-weight: 600; color: #b33;
                      text-align: center; padding: 6px; }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
</style>
