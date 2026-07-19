<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { moveDoc, setDocPage, uid, DEFAULT_OPEN_SIZE, FLAG_COLORS, type Doc, type Size, type Viewport } from '@digital-desktop/core';
  import { debounce } from '../debounce';
  import { clientToBase } from '../inkMath';
  import { desktop } from '../store.svelte';
  import { showToast } from '../ui.svelte';
  import PageRenderer from './PageRenderer.svelte';
  import ImagePage from './ImagePage.svelte';
  import InkOverlay, { type InkTool } from './InkOverlay.svelte';
  import MarkLayer from './MarkLayer.svelte';
  import StampPopover from './StampPopover.svelte';
  import StampLayer from './StampLayer.svelte';
  import FlagRail from './FlagRail.svelte';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let pageCount = $state<number | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  let bodyH = $state(0);
  const kind = $derived(doc.kind ?? 'pdf');
  // Bild-Dokument: eine "Seite" (die Bildpixel selbst) — kein Blättern, kein Herauslösen.
  const bildmodus = $derived(kind === 'image');
  const seitenQuelle = $derived(kind === 'convertible' ? 'preview' : 'original');
  const seitenfix = $derived(doc.pageOnly !== undefined || bildmodus); // kein Blättern
  const page = $derived(bildmodus ? 1 : (doc.pageOnly ?? doc.page ?? 1));
  const size = $derived(doc.openSize ?? DEFAULT_OPEN_SIZE);
  const pageWidth = $derived(Math.round(size.w - 20));

  // Lichttisch: Viewer wird durchscheinend — Seiten lassen sich zum Vergleich übereinanderlegen
  let lichttisch = $state(false);

  // Zeichen-/Schneidwerkzeuge: aktives Werkzeug gilt pro Viewer
  let inkTool = $state<InkTool | 'scissors' | 'tippex' | 'redact' | null>(null);
  let baseSize = $state<Size | null>(null);
  const rectTool = $derived(inkTool === 'scissors' || inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null);
  function toggleTool(t: InkTool | 'scissors' | 'tippex' | 'redact') {
    inkTool = inkTool === t ? null : t;
    // Zeichnen/Schneiden/Abdecken beendet Stempel- und Fahnenmodus — sonst fängt deren
    // ganzseitige Setzfläche die Klicks ab und das gewählte Werkzeug wirkt "kaputt".
    stampChoice = null;
    flagColor = null;
    if (inkTool === 'redact' && !localStorage.getItem('dd-redact-hinweis')) {
      localStorage.setItem('dd-redact-hinweis', '1');
      showToast('Hinweis: Die Schwärzung deckt nur sichtbar ab — der Text bleibt im PDF erhalten.');
    }
  }

  // Stempel: Auswahl "klebt" am Werkzeug — jeder Seitenklick setzt einen Abdruck
  let stampMenu = $state(false);
  let stampChoice = $state<{ text: string; color: 'red' | 'blue'; withDate?: boolean } | null>(null);

  function pickStamp(wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) {
    stampMenu = false;
    stampChoice = wahl;
    inkTool = null; // Stempeln ist ein eigener Modus, Zeichnen aus
    flagColor = null; // Fahnen-Werkzeug schließt sich mit Stempeln gegenseitig aus
  }

  // Notizfahnen: Farbwahl "klebt" bis zum nächsten Seitenklick — danach ist das Werkzeug wieder aus.
  let flagMenu = $state(false);
  let flagColor = $state<string | null>(null); // gewählte Farbe = Werkzeug aktiv

  function setFlagAt(e: PointerEvent) {
    if (!flagColor || !baseSize) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    const offset = Math.min(1, Math.max(0, p.y / baseSize.h));
    void desktop.command('addFlag', { flag: { id: uid(), docId: doc.id, page, offset, color: flagColor } });
    flagColor = null; // eine Fahne pro Aktivierung — bewusst, kein Dauer-Modus
  }

  function stampAt(e: PointerEvent) {
    if (!stampChoice) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p || !baseSize) return;
    const heute = new Date().toISOString().slice(0, 10);
    void desktop.command('addStamp', {
      stamp: {
        id: uid(), docId: doc.id, page, x: p.x, y: p.y,
        angle: Math.random() * 12 - 6,
        text: stampChoice.text, color: stampChoice.color,
        ...(stampChoice.withDate ? { date: heute } : {}),
        baseW: baseSize.w, baseH: baseSize.h,
      },
    });
  }

  // Schere: Rechteck auf der Seite aufziehen -> Ausschnitt als eigenes Objekt daneben
  let schnitt = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  let schnittPointer: number | null = null;
  function pagePoint(e: PointerEvent): { x: number; y: number } | null {
    const wrap = (e.currentTarget as HTMLElement).closest('.pagewrap');
    if (!wrap || !baseSize) return null;
    // Echte Bildschirmbreite statt nomineller pageWidth — der Viewer liegt in der
    // gezoomten Welt-Ebene (UAT-Befund: Schnitt/Stempel neben dem Cursor).
    const r = wrap.getBoundingClientRect();
    if (r.width === 0) return null;
    return clientToBase({ x: e.clientX, y: e.clientY }, r, baseSize);
  }
  function schnittDown(e: PointerEvent) {
    if (e.button !== 0 || schnittPointer !== null) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    schnittPointer = e.pointerId;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* Komfort */ }
    schnitt = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
  function schnittMove(e: PointerEvent) {
    if (e.pointerId !== schnittPointer || !schnitt) return;
    const p = pagePoint(e);
    if (p) schnitt = { ...schnitt, x1: p.x, y1: p.y };
  }
  function schnittUp(e: PointerEvent) {
    if (e.pointerId !== schnittPointer) return;
    schnittPointer = null;
    const sn = schnitt;
    schnitt = null;
    if (!sn) return;
    const rect = {
      x: Math.min(sn.x0, sn.x1), y: Math.min(sn.y0, sn.y1),
      w: Math.abs(sn.x1 - sn.x0), h: Math.abs(sn.y1 - sn.y0),
    };
    if (rect.w < 12 || rect.h < 12) return; // Mini-Wischer verwerfen
    if (rectTool === 'scissors') {
      inkTool = null;
      void desktop.command('addCutout', {
        docId: doc.id, page, rect,
        position: { x: doc.position.x + size.w + 24, y: doc.position.y + 40 },
      });
    } else if (rectTool) {
      // Tipp-Ex/Schwärzung: Werkzeug bleibt aktiv (mehrere Flächen nacheinander)
      void desktop.command('addMark', { mark: { id: uid(), docId: doc.id, page, rect, kind: rectTool } });
    }
  }
  const schnittCss = $derived.by(() => {
    if (!schnitt || !baseSize) return null;
    const f = pageWidth / baseSize.w; // Basiskoordinaten -> Overlay-Pixel
    return {
      left: Math.min(schnitt.x0, schnitt.x1) * f,
      top: Math.min(schnitt.y0, schnitt.y1) * f,
      w: Math.abs(schnitt.x1 - schnitt.x0) * f,
      h: Math.abs(schnitt.y1 - schnitt.y0) * f,
    };
  });

  // Aufgeschlagene Karte direkt fokussieren, damit die Pfeiltasten sofort blättern.
  onMount(() => wrapEl?.focus({ preventScroll: true }));

  let dragging = false, moved = false;
  let headLast = { x: 0, y: 0 };
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return; // Klicks auf ‹ › ✕ nicht als Drag verschlucken
    if (doc.taped) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true; moved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    const dx = (e.clientX - headLast.x) / vp.scale;
    const dy = (e.clientY - headLast.y) / vp.scale;
    headLast = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + dx, y: doc.position.y + dy }));
  }
  function onHeaderPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }

  // Blättern wirkt sofort lokal; der Server bekommt gebündelt nur die letzte Seite.
  let pendingPage: number | null = null;
  const sendPage = debounce(350, (p: number) => {
    pendingPage = null;
    void desktop.command('setDocPage', { id: doc.id, page: p });
  });
  onDestroy(() => {
    sendPage.cancel();
    if (pendingPage !== null && desktop.status === 'online') {
      void desktop.command('setDocPage', { id: doc.id, page: pendingPage });
    }
  });

  function turn(delta: number) {
    if (seitenfix) return;
    const next = page + delta;
    if (next < 1 || (pageCount !== null && next > pageCount)) return;
    desktop.applyLocal((s) => setDocPage(s, doc.id, next));
    pendingPage = next;
    sendPage(next);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Wischen zum Blättern (horizontal) — bei aktivem Zeichenwerkzeug deaktiviert
  let swipeX = 0, swiping = false;
  function onBodyPointerDown(e: PointerEvent) { if (inkTool) return; if (e.pointerType === 'touch') { swiping = true; swipeX = e.clientX; } }
  function onBodyPointerUp(e: PointerEvent) {
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }

  // Größe ziehen (Anfasser unten rechts)
  let resizing = false;
  let gripLast = { x: 0, y: 0 };
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true;
    gripLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const dx = (e.clientX - gripLast.x) / vp.scale;
    const dy = (e.clientY - gripLast.y) / vp.scale;
    gripLast = { x: e.clientX, y: e.clientY };
    const w = Math.max(220, size.w + dx);
    const h = Math.max(280, size.h + dy);
    desktop.applyLocal((s) => ({ ...s, docs: s.docs.map((d) => d.id === doc.id ? { ...d, openSize: { w, h } } : d) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeDoc', { id: doc.id, size: { w: size.w, h: size.h } });
  }
</script>

<svelte:window onkeydown={(e) => { if (document.activeElement === wrapEl) onKey(e); }} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- der Viewer ist bewusst fokussierbar: Pfeiltasten blättern -->
<div class="viewer" class:licht={lichttisch} role="group" aria-label={doc.name} bind:this={wrapEl} tabindex="0"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px" style:z-index={doc.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" role="toolbar" tabindex="-1" aria-label="Dokumentleiste" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}>
    <span class="title">{doc.name}</span>
    <span class="tools">
      <button class:on={inkTool === 'pencil'} onclick={() => toggleTool('pencil')} aria-pressed={inkTool === 'pencil'} aria-label="Bleistift" title="Bleistift">✏</button>
      <button class:on={inkTool === 'pen'} onclick={() => toggleTool('pen')} aria-pressed={inkTool === 'pen'} aria-label="Kugelschreiber" title="Kugelschreiber">✎</button>
      <button class:on={inkTool === 'marker'} onclick={() => toggleTool('marker')} aria-pressed={inkTool === 'marker'} aria-label="Textmarker" title="Textmarker"><span class="marker-chip"></span></button>
      <button class:on={inkTool === 'line'} onclick={() => toggleTool('line')} aria-pressed={inkTool === 'line'} aria-label="Lineal" title="Lineal: gerade Linie ziehen">⟍</button>
      <button class:on={inkTool === 'eraser'} onclick={() => toggleTool('eraser')} aria-pressed={inkTool === 'eraser'} aria-label="Radierer" title="Radierer (nur Striche)">⌫</button>
      <span class="sep"></span>
      <button class:on={inkTool === 'tippex'} onclick={() => toggleTool('tippex')} aria-pressed={inkTool === 'tippex'} aria-label="Tipp-Ex" title="Tipp-Ex: weiß abdecken"><span class="tippex-chip"></span></button>
      <button class:on={inkTool === 'redact'} onclick={() => toggleTool('redact')} aria-pressed={inkTool === 'redact'} aria-label="Schwärzung" title="Schwärzung: schwarz abdecken (rein visuell)">■</button>
      <span class="sep"></span>
      <button class:on={stampChoice !== null || stampMenu} onclick={() => { if (stampChoice) { stampChoice = null; } else { stampMenu = !stampMenu; if (stampMenu) flagMenu = false; } }}
              aria-label="Stempel" title={stampChoice ? `Stempel „${stampChoice.text}" abschalten` : 'Stempel wählen'}>✪</button>
      <span class="sep"></span>
      <button class:on={flagColor !== null || flagMenu} onclick={() => { if (flagColor) { flagColor = null; } else { flagMenu = !flagMenu; if (flagMenu) stampMenu = false; } }}
              aria-label="Notizfahne" title="Notizfahne setzen">⚑</button>
      <span class="sep"></span>
      {#if !seitenfix}
        <button onclick={() => void desktop.command('extractPage', { docId: doc.id, page, position: { x: doc.position.x + size.w + 24, y: doc.position.y } })}
                aria-label="Seite herauslösen" title="Seite herauslösen (Enthefterzange)">⧉</button>
      {/if}
      <button class:on={inkTool === 'scissors'} onclick={() => toggleTool('scissors')} aria-pressed={inkTool === 'scissors'} aria-label="Schere" title="Schere: Ausschnitt aufziehen">✄</button>
      <button class:on={lichttisch} onclick={() => (lichttisch = !lichttisch)} aria-pressed={lichttisch} aria-label="Lichttisch" title="Lichttisch: durchscheinend übereinanderlegen">◐</button>
    </span>
    {#if bildmodus}
      <span class="pos">Bild</span>
    {:else if seitenfix}
      <span class="pos">S. {page}</span>
    {:else}
      <span class="pager">
        <button onclick={() => turn(-1)} disabled={page <= 1} aria-label="Zurück">‹</button>
        <span class="pos">{page}{#if pageCount} / {pageCount}{/if}</span>
        <button onclick={() => turn(1)} disabled={pageCount !== null && page >= pageCount} aria-label="Weiter">›</button>
      </span>
    {/if}
    <button class="close" onclick={() => void desktop.command('collapseDoc', { id: doc.id })} aria-label="Schließen">✕</button>
  </div>
  {#if stampMenu}<StampPopover onpick={pickStamp} onclose={() => (stampMenu = false)} />{/if}
  {#if flagMenu}
    <!-- svelte-ignore a11y_no_static_element_interactions -- Backdrop schließt nur -->
    <div class="flag-backdrop" onpointerdown={() => (flagMenu = false)}></div>
    <div class="flag-pop" role="menu" aria-label="Fahnenfarbe">
      {#each FLAG_COLORS as farbe (farbe)}
        <button style:background={farbe} aria-label="Farbe wählen"
                onclick={() => { flagColor = farbe; flagMenu = false; stampChoice = null; inkTool = null; }}></button>
      {/each}
    </div>
  {/if}
  <div class="body" role="presentation" onwheel={(e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }} onpointerdown={onBodyPointerDown} onpointerup={onBodyPointerUp}>
    {#if desktop.api}
      <div class="pagewrap">
        {#if bildmodus}
          <ImagePage api={desktop.api} fileId={doc.fileId} name={doc.name} targetWidth={pageWidth}
            onbasesize={(s) => (baseSize = s)} />
        {:else}
          <PageRenderer api={desktop.api} fileId={doc.fileId} {page} targetWidth={pageWidth} source={seitenQuelle}
            onpagecount={(n) => (pageCount = n)} onbasesize={(s) => (baseSize = s)} />
        {/if}
        <InkOverlay docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth}
          tool={inkTool === 'scissors' || inkTool === 'tippex' || inkTool === 'redact' ? null : inkTool} />
        {#if rectTool && baseSize}
          <div class="schnittflaeche" role="presentation"
               onpointerdown={schnittDown} onpointermove={schnittMove} onpointerup={schnittUp}
               onpointercancel={() => { schnittPointer = null; schnitt = null; }}>
            {#if schnittCss}
              <div class="schnittrahmen" class:tippex={rectTool === 'tippex'} class:redact={rectTool === 'redact'}
                   style:left="{schnittCss.left}px" style:top="{schnittCss.top}px"
                   style:width="{schnittCss.w}px" style:height="{schnittCss.h}px"></div>
            {/if}
          </div>
        {/if}
        <MarkLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth}
                   active={inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null} />
        {#if stampChoice && baseSize}
          <div class="stempelflaeche" role="presentation" onpointerdown={stampAt}></div>
        {/if}
        {#if flagColor && baseSize}
          <div class="stempelflaeche" role="presentation" onpointerdown={setFlagAt}></div>
        {/if}
        <StampLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} active={stampChoice !== null} />
      </div>
    {/if}
  </div>
  <div class="rail" bind:clientHeight={bodyH} aria-hidden={false}>
    <FlagRail {doc} height={bodyH} active={flagColor !== null}
              onjump={(p) => { if (!seitenfix) { desktop.applyLocal((s) => setDocPage(s, doc.id, p)); pendingPage = p; sendPage(p); } }} />
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
</div>

<style>
  .viewer { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 6px;
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; touch-action: none; }
  .viewer:focus { outline: 2px solid #2c5aa0; }
  /* Lichttisch: Papier wird durchscheinend, darunterliegende Seiten schimmern durch */
  .viewer.licht { opacity: .58; }
  .viewer.licht .body { background: transparent; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #f2f4f8;
          border-bottom: 1px solid #e4e8ef; cursor: grab; user-select: none; }
  .title { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pager { display: flex; align-items: center; gap: 6px; }
  .tools { display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .tools button { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 13px; line-height: 1;
          display: inline-flex; align-items: center; justify-content: center; }
  .tools button.on { background: #2c5aa0; color: #fff; }
  .sep { width: 1px; height: 16px; background: #d3d9e3; margin: 0 2px; flex: none; }
  .marker-chip { width: 12px; height: 12px; border-radius: 3px; background: #ffd166; display: inline-block; }
  .tools button.on .marker-chip { outline: 2px solid #fff; }
  .tippex-chip { width: 12px; height: 12px; border-radius: 3px; background: #fff; border: 1px solid #b8c0cc; display: inline-block; }
  .pagewrap { position: relative; width: fit-content; }
  .pager button, .close { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 15px; line-height: 1; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pos { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .body { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start;
          background: #52616b; padding: 10px; }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
  .schnittflaeche { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
  .stempelflaeche { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
  .schnittrahmen { position: absolute; border: 2px dashed #c0392b; background: rgba(192, 57, 43, .08);
                   pointer-events: none; }
  .schnittrahmen.tippex { border-color: #8a94a3; background: rgba(255, 255, 255, .35); }
  .schnittrahmen.redact { border-color: #111; background: rgba(0, 0, 0, .18); }
  /* Notizfahnen-Rail: Geschwister nach .body, damit die Laschen an der Viewer-Kante stehenbleiben,
     auch wenn der Seiteninhalt im .body scrollt. 36px ≈ Kopfzeilenhöhe; width: 0 hält die Rail aus
     dem Layoutfluss, die Laschen positionieren sich innerhalb absolut. */
  .rail { position: absolute; top: 36px; right: 0; bottom: 0; width: 0; overflow: visible; }
  .flag-backdrop { position: fixed; inset: 0; z-index: 9600; }
  .flag-pop { position: absolute; top: 34px; right: 8px; z-index: 9700; display: flex; gap: 6px;
              background: #fff; border-radius: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, .35); padding: 8px; }
  .flag-pop button { width: 22px; height: 22px; border: none; border-radius: 4px; cursor: pointer; }
</style>
