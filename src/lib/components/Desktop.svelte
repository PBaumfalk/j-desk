<script lang="ts">
  import { onMount } from 'svelte';
  import {
    freeDocs, screenToWorld, zoomAt, zoomToFit, allBoxes, panBy, docBox, stackBox, noteBox, cutoutBox, CARD_W,
    NOTE_KINDS, NOTE_W, NOTE_H, deskBackground, type Box, type NoteKind, type Vec2, type Viewport,
  } from '@digital-desktop/core';
  import { deskCss, isLight } from '../deskThemes';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { NOTE_KIND_LABELS } from '../menus';
  import { clearSession } from '../session';
  import { revokeFileUrls } from '../fileCache';
  import { ui, showToast } from '../ui.svelte';
  import DocCard from './DocCard.svelte';
  import StackCard from './StackCard.svelte';
  import NoteCard from './NoteCard.svelte';
  import CutoutCard from './CutoutCard.svelte';
  import LinkLayer from './LinkLayer.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import DeskSwitcher from './DeskSwitcher.svelte';
  import DeskControls from './DeskControls.svelte';
  import TrashCan from './TrashCan.svelte';

  let { onlogout }: { onlogout: () => void } = $props();

  let vp = $state<Viewport>({ x: 0, y: 0, scale: 1 });
  let el: HTMLDivElement;
  let panning = $state(false);
  let spaceDown = $state(false);
  let fileInput: HTMLInputElement;
  let viewW = $state(0);
  let viewH = $state(0);

  // Erscheinungsbild des Schreibtischs (Farbe/Material/Regler) — Regler-Vorschau vor gespeichertem Zustand.
  const hintergrund = $derived(ui.backgroundPreview ?? deskBackground(desktop.state));
  const hintergrundStil = $derived(deskCss(hintergrund));

  // Sichtbarkeits-Culling: Karten weit außerhalb des Fensters verlassen das DOM.
  // Der Puffer sorgt dafür, dass beim Schwenken nichts sichtbar „aufpoppt".
  const CULL_MARGIN = 300;
  const sichtfenster = $derived.by(() => ({
    x0: -vp.x / vp.scale - CULL_MARGIN,
    y0: -vp.y / vp.scale - CULL_MARGIN,
    x1: (viewW - vp.x) / vp.scale + CULL_MARGIN,
    y1: (viewH - vp.y) / vp.scale + CULL_MARGIN,
  }));
  function imSichtfenster(b: Box): boolean {
    if (viewW === 0) return true; // vor der ersten Messung nichts verstecken
    return b.x + b.w >= sichtfenster.x0 && b.x <= sichtfenster.x1
      && b.y + b.h >= sichtfenster.y0 && b.y <= sichtfenster.y1;
  }

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
  // Lupe folgt dem Zeiger (auch ohne gedrückte Taste)
  const LUPE = 260;
  let lupePos = $state<{ x: number; y: number } | null>(null);
  const lupenVp = $derived.by(() => {
    if (!lupePos) return null;
    const z = vp.scale * 2.5;
    const w = screenToWorld(vp, lupePos);
    return { x: LUPE / 2 - w.x * z, y: LUPE / 2 - w.y * z, scale: z };
  });

  function onPointerMove(e: PointerEvent) {
    if (ui.lupe) lupePos = { x: e.clientX, y: e.clientY };
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

  async function addFile(file: File, position: Vec2): Promise<void> {
    if (!desktop.api || !desktop.deskId) return;
    try {
      if (desktop.mode === 'jlawyer') {
        // Upload in die Akte; die Karte legt der Server erst nach j-lawyer-Bestätigung an.
        const result = await desktop.api.uploadToCase(desktop.deskId, new Uint8Array(await file.arrayBuffer()), file.name);
        desktop.acceptServerState(result);
        return;
      }
      const r = await desktop.api.uploadFile(new Uint8Array(await file.arrayBuffer()), file.name, file.type || undefined);
      await desktop.command('addDoc', { fileId: r.fileId, name: file.name, position, id: uid(), kind: r.kind });
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Upload fehlgeschlagen: ${file.name}`);
    }
  }

  function onFilesPicked(): void {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    // Nebeneinander statt fast deckungsgleich — mehrere Uploads sollen sofort unterscheidbar sein (UAT A1.2).
    files.forEach((f, i) => void addFile(f, { x: center.x + i * (CARD_W + 24), y: center.y + i * 8 }));
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
  }

  /** Zettel anlegen (am Weltpunkt, sonst Bildschirmmitte) und sofort in den Bearbeiten-Modus gehen. */
  function zettelAnlegen(kind: NoteKind, customLabel?: string, weltPunkt?: Vec2): void {
    const mitte = weltPunkt ?? screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    const id = uid();
    void desktop
      .command('addNote', {
        kind, text: '', position: { x: mitte.x - NOTE_W / 2, y: mitte.y - NOTE_H / 2 }, id,
        ...(customLabel !== undefined ? { customLabel } : {}),
      })
      .then(() => (ui.editingNoteId = id));
  }

  /** Doppelklick/Doppeltipp auf freie Tischfläche → Notizzettel an Ort und Stelle (Quickwin F4). */
  function onDeskDblClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('.card, .viewer, .note, .stack, .cutout, .abbild, button, input, textarea, .menu, .panel')) return;
    zettelAnlegen('notiz', undefined, screenToWorld(vp, { x: e.clientX, y: e.clientY }));
  }

  // Karten-Suche (Quickwin F5): Suchfeld oben mittig, springt zum Treffer und pulst kurz.
  let sucheOffen = $state(false);
  let suchText = $state('');
  let pulsBox = $state<Box | null>(null);
  let pulsTimer: ReturnType<typeof setTimeout> | undefined;

  type Treffer = { id: string; art: string; label: string; box: Box };
  const treffer = $derived.by((): Treffer[] => {
    const q = suchText.trim().toLowerCase();
    if (q === '') return [];
    const s = desktop.state;
    const alle: Treffer[] = [
      ...s.docs.map((d) => ({ id: d.id, art: 'Karte', label: d.name, box: docBox(d) })),
      ...s.stacks.map((st) => ({ id: st.id, art: 'Stapel', label: st.name || `Stapel (${st.docIds.length})`, box: stackBox(st) })),
      ...(s.notes ?? []).map((n) => ({
        id: n.id, art: 'Zettel',
        label: `${n.customLabel ? `[${n.customLabel}] ` : ''}${n.text.trim() || NOTE_KIND_LABELS[n.kind]}`.slice(0, 60),
        box: noteBox(n),
      })),
    ];
    return alle.filter((t) => t.label.toLowerCase().includes(q)).slice(0, 8);
  });

  function springe(t: Treffer): void {
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    const s = vp.scale < 0.5 ? 0.8 : vp.scale;
    vp = { scale: s, x: viewW / 2 - cx * s, y: viewH / 2 - cy * s };
    pulsBox = t.box;
    clearTimeout(pulsTimer);
    pulsTimer = setTimeout(() => (pulsBox = null), 2000);
    schliesseSuche();
  }

  function schliesseSuche(): void {
    sucheOffen = false;
    suchText = '';
  }

  /** Zettel-Typ wählen (zweispaltig); „Eigener…" fragt das Badge im Menü ab. */
  function zettelTypAuswahl(x: number, y: number): void {
    ui.menu = {
      x, y, columns: 2,
      items: NOTE_KINDS.map((kind: NoteKind) => ({
        label: kind === 'eigen' ? 'Eigener…' : NOTE_KIND_LABELS[kind],
        action: kind === 'eigen'
          ? () => queueMicrotask(() => {
              ui.menu = { x, y, items: [], input: { placeholder: 'Bezeichnung (z. B. Zeugenfrage)', onSubmit: (t) => zettelAnlegen('eigen', t), onEscape: () => zettelTypAuswahl(x, y) } };
            })
          : () => zettelAnlegen(kind),
      })),
    };
  }

  /** „＋"-Menü: Datei-Upload oder Zettel anlegen. Das Zettel-Untermenü ersetzt den Menüinhalt
   *  erst, nachdem ContextMenu.svelte den Klick verarbeitet (und ui.menu synchron auf null setzt) —
   *  daher die Verzögerung auf den nächsten Tick statt einer echten Verschachtelung. */
  function plusMenu(e: MouseEvent): void {
    const x = e.clientX;
    const y = e.clientY;
    ui.menu = {
      x, y,
      items: [
        { label: 'Datei…', action: () => fileInput.click() },
        { label: 'Zettel…', action: () => queueMicrotask(() => zettelTypAuswahl(x, y)) },
      ],
    };
  }

  async function abmelden(): Promise<void> {
    if (!confirm('Wirklich abmelden?')) return; // Nutzerentscheidung UAT A1.9
    // Server-Invalidierung ist Best-Effort — lokal wird die Sitzung in jedem Fall beendet.
    await desktop.api?.logout().catch(() => {});
    clearSession();
    revokeFileUrls();
    await desktop.stop();
    onlogout();
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    const world = screenToWorld(vp, { x: e.clientX, y: e.clientY });
    files.forEach((f, i) => void addFile(f, { x: world.x + i * (CARD_W + 24), y: world.y + i * 8 }));
  }

  onMount(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault(); // Desk-Suche statt Browser-Suche
        sucheOffen = true;
        return;
      }
      if (e.code === 'Space') spaceDown = true;
      if (e.code === 'Escape') {
        ui.linkingFromId = null;
        ui.clippingFromId = null;
        ui.menu = null;
        ui.lupe = false; // Lupe auch per Escape ausschalten (Nutzerwunsch)
        schliesseSuche();
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

<div class="desk" role="application" aria-label="Schreibtisch" bind:this={el} style={hintergrundStil}
     bind:clientWidth={viewW} bind:clientHeight={viewH} class:grabbing={spaceDown || panning}
     class:hell={isLight(hintergrund.themeId)}
     onwheel={onWheel} onpointerdown={onPointerDown} onpointermove={onPointerMove}
     onpointerup={endPointer} onpointercancel={endPointer} ondblclick={onDeskDblClick}
     ondragover={onDragOver} ondrop={onDrop}>
  {#snippet weltInhalt(v: Viewport, inLupe: boolean)}
    <LinkLayer />
    {#each freeDocs(desktop.state).filter((d) => imSichtfenster(docBox(d))) as doc (doc.id)}
      <DocCard {doc} vp={v} lupe={inLupe} />
    {/each}
    {#each desktop.state.stacks.filter((st) => imSichtfenster(stackBox(st))) as stack (stack.id)}
      <StackCard {stack} vp={v} />
    {/each}
    {#each (desktop.state.notes ?? []).filter((n) => imSichtfenster(noteBox(n))) as note (note.id)}
      <NoteCard {note} vp={v} />
    {/each}
    {#each (desktop.state.cutouts ?? []).filter((c) => imSichtfenster(cutoutBox(c))) as cutout (cutout.id)}
      <CutoutCard {cutout} vp={v} />
    {/each}
  {/snippet}

  <div class="world" style:transform="translate({vp.x}px, {vp.y}px) scale({vp.scale})">
    {@render weltInhalt(vp, false)}
    {#if pulsBox}
      <div class="puls" style:left="{pulsBox.x - 8}px" style:top="{pulsBox.y - 8}px"
           style:width="{pulsBox.w + 16}px" style:height="{pulsBox.h + 16}px" aria-hidden="true"></div>
    {/if}
  </div>
  {#if ui.lupe && lupePos && lupenVp}
    <div class="lupe" style={hintergrundStil}
         style:left="{lupePos.x - LUPE / 2}px" style:top="{lupePos.y - LUPE / 2}px"
         style:width="{LUPE}px" style:height="{LUPE}px" aria-hidden="true">
      <div class="lupenwelt" style:transform="translate({lupenVp.x}px, {lupenVp.y}px) scale({lupenVp.scale})">
        {@render weltInhalt(lupenVp, true)}
      </div>
    </div>
  {/if}
  <DeskSwitcher />
  <DeskControls
    onzoom={(f) => (vp = zoomAt(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 }, f))}
    onpan={(dx, dy) => (vp = panBy(vp, dx, dy))}
    onfit={fitAll}
    onsuche={() => (sucheOffen = true)}
  />
  {#if sucheOffen}
    <div class="suche-panel" role="search">
      <!-- svelte-ignore a11y_autofocus -- das Suchfeld ist der einzige Zweck des Panels -->
      <input autofocus class="suche-feld" placeholder="Karte, Stapel oder Zettel suchen…"
             bind:value={suchText} aria-label="Auf dem Schreibtisch suchen"
             onkeydown={(e) => {
               e.stopPropagation();
               if (e.key === 'Escape') schliesseSuche();
               if (e.key === 'Enter' && treffer.length > 0) springe(treffer[0]);
             }} />
      {#if suchText.trim() !== ''}
        <div class="suche-liste">
          {#each treffer as t (t.id)}
            <button class="treffer" onclick={() => springe(t)}>
              <span class="art">{t.art}</span><span class="name">{t.label}</span>
            </button>
          {:else}
            <div class="keine">Keine Treffer</div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <TrashCan />
  <div class="toolbar">
    <input
      bind:this={fileInput}
      type="file"
      multiple
      hidden
      onchange={onFilesPicked}
    />
    <button onclick={plusMenu} title="Hinzufügen">＋</button>
    <button onclick={() => void abmelden()} title="Abmelden">Abmelden</button>
  </div>
  {#if ui.linkingFromId}
    <div class="hint">Verknüpfen: Ziel anklicken (Esc bricht ab)</div>
  {/if}
  {#if ui.clippingFromId}
    <div class="hint">Anklammern: Ziel anklicken (Esc bricht ab)</div>
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
  /* Helle Tischflächen: Papier setzt sich per Kontur + kräftigerem Schlagschatten ab (Vision). */
  .desk.hell :global(:is(.card, .stack, .cutout)) {
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .22), 0 8px 22px rgba(0, 0, 0, .4);
  }
  /* Tafel-Text: auf hellen Tischflächen schwarze statt weißer Filzstift-Tinte (Nutzerwunsch). */
  .desk.hell :global(.note.kind-tafel .text),
  .desk.hell :global(.note.kind-tafel textarea) {
    color: #26241d;
    text-shadow: 0 1px 2px rgba(255, 255, 255, .45);
  }
  .desk.hell :global(.note.kind-tafel textarea) { outline-color: rgba(38, 36, 29, .45); }
  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  /* Such-Treffer: pulsierender Umriss in Weltkoordinaten (keine Änderungen an den Karten nötig). */
  .puls { position: absolute; border: 3px solid rgba(242, 226, 184, .95); border-radius: 12px;
          pointer-events: none; z-index: 99997; animation: pulsieren 1s ease-in-out infinite;
          box-shadow: 0 0 24px rgba(242, 226, 184, .55); }
  @keyframes pulsieren { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .puls { animation: none; } }
  .suche-panel { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 9600;
                 width: min(420px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 6px;
                 background: var(--glass-panel-bg); border: 1px solid var(--glass-border);
                 backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
                 border-radius: 12px; padding: 10px; box-shadow: var(--glass-shadow-lg); }
  .suche-feld { border: 1px solid var(--glass-separator); border-radius: 8px; padding: 8px 10px;
                background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 14px; }
  .suche-feld::placeholder { color: var(--glass-text-secondary); }
  .suche-feld:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 0; }
  .suche-liste { display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto; }
  .treffer { display: flex; gap: 8px; align-items: baseline; text-align: left; border: none;
             background: none; color: var(--glass-text); padding: 7px 8px; border-radius: 8px;
             cursor: pointer; font-size: 13px; }
  .treffer:hover { background: var(--glass-hover); }
  .treffer .art { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
                  background: var(--brand-blue-soft); border-radius: 5px; padding: 2px 6px; }
  .treffer .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .keine { padding: 8px; font-size: 12px; color: var(--glass-text-secondary); }
  .lupe { position: fixed; z-index: 9500; border-radius: 50%; overflow: hidden; pointer-events: none;
          border: 3px solid rgba(242, 226, 184, .85); box-shadow: 0 10px 34px rgba(0, 0, 0, .5), inset 0 0 20px rgba(0, 0, 0, .15);
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .lupenwelt { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; z-index: 9000; }
  .toolbar button { font-size: 13px; padding: 6px 12px; border-radius: 8px;
                    border: 1px solid var(--glass-border);
                    background: var(--glass-card-bg); color: var(--glass-text);
                    backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
                    cursor: pointer; box-shadow: var(--glass-shadow); }
  .toolbar button:hover { background: var(--glass-elevated-bg); }
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
          border-radius: 999px; background: rgba(8, 31, 57, .88); color: #fff; font-size: 13px; z-index: 9999; }
  .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
            border-radius: 999px; background: rgba(140, 60, 20, .9); color: #fff; font-size: 13px; z-index: 99000; }
  .blocker { position: fixed; inset: 0; z-index: 98000; cursor: wait; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
           border-radius: 10px; background: rgba(20, 20, 20, .88); color: #fff; font-size: 13px; z-index: 99500; }
</style>
