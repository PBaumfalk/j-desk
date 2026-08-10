<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    konvolutPages, moveStack, setStackPage, uid, DEFAULT_OPEN_SIZE,
    type FileKind, type KonvolutPage, type Size, type Stack, type Viewport,
  } from '@j-desk/core';
  import { debounce } from '../debounce';
  import { pagePointIn } from '../inkMath';
  import { desktop } from '../store.svelte';
  import { bytesFor, getPageCount } from '../pageCounts';
  import { textInRect } from '../pdfText';
  import { ui, showToast } from '../ui.svelte';
  import PageRenderer from './PageRenderer.svelte';
  import ImagePage from './ImagePage.svelte';
  import InkOverlay, { type InkTool } from './InkOverlay.svelte';
  import MarkLayer from './MarkLayer.svelte';
  import StampLayer from './StampLayer.svelte';
  import StampPopover from './StampPopover.svelte';
  import SourceHighlight from './SourceHighlight.svelte';
  import RadialMenu, { type RadialGroup } from './RadialMenu.svelte';
  import { STABILO_COLORS, PEN_COLORS, loadInkColor, saveInkColor } from '../inkColors';

  let { stack, vp }: { stack: Stack; vp: Viewport } = $props();

  // Seitenzahlen aller Mitglieder laden -> pages ist null, bis alles bekannt ist
  let pageCounts = $state<Record<string, number>>({});
  let pageCountFehlerGemeldet = false;
  $effect(() => {
    const api = desktop.api;
    if (!api) return;
    for (const docId of stack.docIds) {
      const d = desktop.state.docs.find((x) => x.id === docId);
      if (!d || d.pageOnly !== undefined || pageCounts[d.fileId] !== undefined) continue;
      const kind = d.kind ?? 'pdf';
      if (kind === 'image') {
        // Bild-Mitglied: eine "Seite" (die Bildpixel selbst) — kein pdfjs nötig.
        pageCounts = { ...pageCounts, [d.fileId]: 1 };
        continue;
      }
      const quelle = kind === 'convertible' ? 'preview' : 'original';
      getPageCount(api, d.fileId, quelle)
        .then((n) => { pageCounts = { ...pageCounts, [d.fileId]: n }; })
        .catch((e) => {
          // Fehler darf das Konvolut nicht dauerhaft blockieren — Lade-Hinweis bleibt stehen,
          // aber einmalig melden statt endlos leise zu scheitern.
          console.error('Seitenzahl konnte nicht ermittelt werden', d.fileId, e);
          if (!pageCountFehlerGemeldet) {
            pageCountFehlerGemeldet = true;
            showToast('Eine Seitenzahl konnte nicht ermittelt werden.');
          }
        });
    }
  });
  const pages = $derived(konvolutPages(desktop.state, stack, pageCounts));
  const globalPage = $derived(Math.min(stack.page ?? 1, pages?.length ?? 1));
  const aktuelle = $derived<KonvolutPage | null>(pages?.[globalPage - 1] ?? null);
  const aktuelleDoc = $derived(aktuelle ? desktop.state.docs.find((d) => d.id === aktuelle.docId) : undefined);
  const aktuelleKind = $derived(aktuelleDoc?.kind ?? 'pdf');
  const size = $derived(stack.openSize ?? DEFAULT_OPEN_SIZE);
  const pageWidth = $derived(Math.round(size.w - 20));
  let baseSize = $state<Size | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  let lichttisch = $state(false);
  let inkTool = $state<InkTool | 'tippex' | 'redact' | null>(null);
  const rectTool = $derived(inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null);
  // Zeichnen/Abdecken beendet den Stempelmodus — sonst fängt die ganzseitige Setzfläche
  // die Klicks ab und das gewählte Werkzeug wirkt "kaputt".
  function toggleTool(t: InkTool | 'tippex' | 'redact') { inkTool = inkTool === t ? null : t; stampChoice = null; }

  onMount(() => wrapEl?.focus({ preventScroll: true }));

  // Blättern: sofort lokal, debounced zum Server (Muster DocViewer)
  let pendingPage: number | null = null;
  const sendPage = debounce(350, (p: number) => { pendingPage = null; void desktop.command('setStackPage', { id: stack.id, page: p }); });
  onDestroy(() => {
    sendPage.cancel();
    clearTimeout(bodyPress);
    if (pendingPage !== null && desktop.status === 'online') void desktop.command('setStackPage', { id: stack.id, page: pendingPage });
  });
  function turn(delta: number) {
    if (!pages) return;
    const next = globalPage + delta;
    if (next < 1 || next > pages.length) return;
    desktop.applyLocal((s) => setStackPage(s, stack.id, next));
    pendingPage = next;
    sendPage(next);
  }

  /** Breadcrumb (UX-03, 13-05 Task 3): Sprung auf eine ABSOLUTE Seite — dieselbe Bestands-
   *  Paginierung wie turn() (lokal sofort + debounced zum Server), aber mit Zielseite statt
   *  Delta. Kein neuer Sprungweg (13-RESEARCH.md-Vorgabe). No-Op, wenn die Zielseite bereits
   *  aktiv ist oder pages noch nicht bekannt sind. */
  function springeZuSeite(ziel: number | null): void {
    if (ziel === null || !pages) return;
    const geklemmt = Math.max(1, Math.min(ziel, pages.length));
    if (geklemmt === globalPage) return;
    desktop.applyLocal((s) => setStackPage(s, stack.id, geklemmt));
    pendingPage = geklemmt;
    sendPage(geklemmt);
  }

  /** Erste Seite eines Mitglieds-Dokuments innerhalb der verketteten Konvolut-Paginierung —
   *  `null`, wenn das Dokument (noch) nicht in `pages` auftaucht. */
  function ersteSeiteDesDokuments(docId: string): number | null {
    if (!pages) return null;
    const idx = pages.findIndex((p) => p.docId === docId);
    return idx === -1 ? null : idx + 1;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Kopf-Drag (Muster DocViewer, aber moveStack + taped-Guard)
  let dragging = false, moved = false, headLast = { x: 0, y: 0 };
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0 || stack.taped) return;
    e.stopPropagation();
    dragging = true; moved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: stack.id });
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    const dx = (e.clientX - headLast.x) / vp.scale;
    const dy = (e.clientY - headLast.y) / vp.scale;
    headLast = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveStack(s, stack.id, { x: stack.position.x + dx, y: stack.position.y + dy }));
  }
  function onHeaderPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveStack', { stackId: stack.id, position: { ...stack.position } });
  }

  // Wischen zum Blättern; Lang-Druck (Touch, 500 ms, <8 px Bewegung) öffnet das Radial-Menü.
  let swipeX = 0, swiping = false;
  let bodyPress: ReturnType<typeof setTimeout> | undefined;
  let bodyPressStart = { x: 0, y: 0 };
  function onBodyPointerDown(e: PointerEvent) {
    if (inkTool) return;
    if (e.pointerType === 'touch') {
      swiping = true; swipeX = e.clientX;
      if (!stampChoice) {
        bodyPressStart = { x: e.clientX, y: e.clientY };
        clearTimeout(bodyPress);
        bodyPress = setTimeout(() => { swiping = false; radial = { x: bodyPressStart.x, y: bodyPressStart.y }; }, 500);
      }
    }
  }
  function onBodyPointerMove(e: PointerEvent) {
    if (bodyPress && Math.hypot(e.clientX - bodyPressStart.x, e.clientY - bodyPressStart.y) > 8) {
      clearTimeout(bodyPress); bodyPress = undefined;
    }
  }
  function onBodyPointerUp(e: PointerEvent) {
    clearTimeout(bodyPress); bodyPress = undefined;
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }
  let resizing = false, gripLast = { x: 0, y: 0 };
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true; gripLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const dx = (e.clientX - gripLast.x) / vp.scale;
    const dy = (e.clientY - gripLast.y) / vp.scale;
    gripLast = { x: e.clientX, y: e.clientY };
    const w = Math.max(220, size.w + dx);
    const h = Math.max(280, size.h + dy);
    desktop.applyLocal((s) => ({ ...s, stacks: s.stacks.map((x) => x.id === stack.id ? { ...x, openSize: { w, h } } : x) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeStack', { id: stack.id, size: { w: size.w, h: size.h } });
  }

  // Stempel (Muster DocViewer, wirkt auf das Mitglieds-Dokument der aktuellen Seite)
  let stampMenu = $state(false);
  let stampChoice = $state<{ text: string; color: 'red' | 'blue'; withDate?: boolean } | null>(null);
  function pickStamp(wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) {
    stampMenu = false; stampChoice = wahl; inkTool = null;
  }

  // Radial-Werkzeugmenü (ersetzt die Werkzeugleiste; Spec 2026-07-19) — reduzierter
  // Werkzeugsatz: kein Fahne/Schere/Seite-lösen/Kopie im Konvolut.
  let radial = $state<{ x: number; y: number } | null>(null);
  let penColor = $state(loadInkColor('pen'));
  let markerColor = $state(loadInkColor('marker'));
  function openRadialCentered() {
    const r = wrapEl?.getBoundingClientRect();
    radial = r
      ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 280) }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  const radialGroups = $derived.by((): RadialGroup[] => [
    {
      id: 'zeichnen', icon: '✏', label: 'Zeichnen',
      items: [
        { id: 'pencil', icon: '✏', label: 'Bleistift', active: inkTool === 'pencil' },
        { id: 'pen', icon: '✎', label: 'Kuli', active: inkTool === 'pen' },
        { id: 'marker', icon: '', chip: markerColor, label: 'Marker', active: inkTool === 'marker' },
        { id: 'line', icon: '⟍', label: 'Lineal', active: inkTool === 'line' },
        { id: 'eraser', icon: '⌫', label: 'Radierer', active: inkTool === 'eraser' },
      ],
      colors: inkTool === 'marker' ? { list: STABILO_COLORS, active: markerColor }
        : inkTool === 'pen' || inkTool === 'line' ? { list: PEN_COLORS, active: penColor }
        : null,
    },
    {
      id: 'abdecken', icon: '◻', label: 'Abdecken',
      items: [
        { id: 'tippex', icon: '', chip: '#ffffff', label: 'Tipp-Ex', active: inkTool === 'tippex' },
        { id: 'redact', icon: '■', label: 'Schwärzen', active: inkTool === 'redact' },
      ],
    },
    {
      id: 'anbringen', icon: '✪', label: 'Anbringen',
      items: [{ id: 'stempel', icon: '✪', label: 'Stempel', active: stampChoice !== null }],
    },
    {
      id: 'seite', icon: '◐', label: 'Seite',
      items: [{ id: 'licht', icon: '◐', label: 'Lichttisch', active: lichttisch }],
    },
  ]);

  function radialPick(id: string) {
    if (id === 'pen' || id === 'marker' || id === 'line') {
      const warAktiv = inkTool === id;
      toggleTool(id);
      if (warAktiv) radial = null;
      return;
    }
    if (id === 'pencil' || id === 'eraser' || id === 'tippex' || id === 'redact') {
      toggleTool(id);
    } else if (id === 'stempel') {
      if (stampChoice) stampChoice = null;
      else { stampMenu = true; inkTool = null; }
    } else if (id === 'licht') {
      lichttisch = !lichttisch;
    }
    radial = null;
  }

  function radialColor(_groupId: string, farbe: string) {
    if (inkTool === 'marker') { markerColor = farbe; saveInkColor('marker', farbe); }
    else { penColor = farbe; saveInkColor('pen', farbe); }
    radial = null;
  }

  function pagePoint(e: PointerEvent): { x: number; y: number } | null {
    const wrap = (e.currentTarget as HTMLElement).closest('.pagewrap');
    if (!wrap) return null;
    // Echte Bildschirmbreite statt nomineller pageWidth — der Viewer liegt in der
    // gezoomten Welt-Ebene (UAT-Befund: Stempel/Abdecken neben dem Cursor).
    return pagePointIn({ x: e.clientX, y: e.clientY }, wrap.getBoundingClientRect(), baseSize);
  }
  function stampAt(e: PointerEvent) {
    if (!stampChoice || !aktuelle || !baseSize) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    const heute = new Date().toISOString().slice(0, 10);
    void desktop.command('addStamp', {
      stamp: {
        id: uid(), docId: aktuelle.docId, page: aktuelle.page, x: p.x, y: p.y,
        angle: Math.random() * 12 - 6, text: stampChoice.text, color: stampChoice.color,
        ...(stampChoice.withDate ? { date: heute } : {}),
        baseW: baseSize.w, baseH: baseSize.h,
      },
    });
  }

  // Tipp-Ex/Schwärzung: Rechteck auf der Seite aufziehen (kein Schere-Werkzeug im Konvolut)
  let schnitt = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  let schnittPointer: number | null = null;
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
  function wartezeit(ms: number): Promise<''> {
    return new Promise((resolve) => setTimeout(() => resolve(''), ms));
  }
  /**
   * Fundstellen-Provenienz: Text im Rect des Mitglieds holen (Muster DocViewer, dieselben
   * Bytes/Cache wie PageRenderer). image/other sind kein PDF -> gar nicht erst versuchen.
   * Die GESAMTE Arbeit (Bytes-Beschaffung UND Textsuche) läuft im Timeout-Race: bytesFor kann
   * im Vorschau-Pfad (Konverter-Polling) selbst bis zu 90 s dauern — allein textInRect zu
   * befristen reichte nicht, Abdecken durfte NIE auf einen hakenden Snapshot warten.
   */
  async function holeTextSnapshot(
    mitglied: KonvolutPage, kindMitglied: FileKind, rect: { x: number; y: number; w: number; h: number },
  ): Promise<string> {
    if (kindMitglied === 'image' || kindMitglied === 'other' || !desktop.api) return '';
    const api = desktop.api;
    const quelle = kindMitglied === 'convertible' ? 'preview' : 'original';
    try {
      return await Promise.race([
        (async () => textInRect(await bytesFor(api, mitglied.fileId, quelle), mitglied.page, rect))(),
        wartezeit(1500),
      ]);
    } catch {
      return '';
    }
  }
  async function schnittUp(e: PointerEvent) {
    if (e.pointerId !== schnittPointer) return;
    schnittPointer = null;
    const sn = schnitt;
    // Schnittrahmen sofort ausblenden (einfachere Variante) — das Command folgt bis zu 1,5 s
    // später, sobald der Text-Snapshot da ist oder der Timeout greift.
    schnitt = null;
    if (!sn || !aktuelle) return;
    const rect = {
      x: Math.min(sn.x0, sn.x1), y: Math.min(sn.y0, sn.y1),
      w: Math.abs(sn.x1 - sn.x0), h: Math.abs(sn.y1 - sn.y0),
    };
    if (rect.w < 12 || rect.h < 12) return; // Mini-Wischer verwerfen
    if (rectTool) {
      // Vor dem await einfrieren: Mitglied/Kind der Seite sowie das Werkzeug (Tipp-Ex/Schwärzung) —
      // der Nutzer könnte während der Extraktion (bis 1,5 s) bereits weiterblättern oder das
      // Werkzeug wechseln; beides darf das bereits gezogene Rechteck nicht rückwirkend ändern.
      const mitglied = aktuelle;
      const kindMitglied = aktuelleKind;
      const werkzeug = rectTool;
      // Ebenso den Schreibtisch einfrieren: ein Desk-Wechsel während der Extraktion darf das
      // Command nicht am inzwischen falschen Schreibtisch abliefern (400, Schnitt verloren) —
      // desktop.command() liest die deskId erst beim Senden, nicht beim Aufruf hier.
      const deskBeimSchnitt = desktop.deskId;
      // Tipp-Ex/Schwärzung: Werkzeug bleibt aktiv (mehrere Flächen nacheinander)
      const textSnapshot = await holeTextSnapshot(mitglied, kindMitglied, rect);
      if (desktop.deskId !== deskBeimSchnitt) return; // Nutzer ist inzwischen woanders — still verwerfen
      void desktop.command('addMark', {
        mark: { id: uid(), docId: mitglied.docId, page: mitglied.page, rect, kind: werkzeug, ...(textSnapshot ? { textSnapshot } : {}) },
      });
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
</script>

<svelte:window onkeydown={(e) => { if (document.activeElement === wrapEl) onKey(e); }} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- bewusst fokussierbar: Pfeiltasten blättern -->
<div class="viewer" class:licht={lichttisch} role="group" aria-label={stack.name || 'Konvolut'} bind:this={wrapEl} tabindex="0"
     style:left="{stack.position.x}px" style:top="{stack.position.y}px" style:z-index={stack.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" role="toolbar" tabindex="-1" aria-label="Konvolutleiste" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}>
    <!-- Konvolut-Breadcrumb (UX-03, 13-05 Task 3): ersetzt die bisherige reine Titel-Anzeige.
         Konvolut-Segment -> Seite 1, Dokument-Segment -> erste Seite dieses Dokuments im
         Konvolut (Bestands-Paginierung, kein neuer Sprungweg). E6-Verdrängungsverbot: die
         Kette (.breadcrumb) schrumpft VOR den Bedienelementen rechts (Werkzeuge/Herkunft/
         Pager/Schließen bleiben flex:none); der Seitenteil kürzt NIE (eigenes flex:none,
         kein Ellipsis). -->
    <div class="breadcrumb">
      <button class="crumb" onclick={() => springeZuSeite(1)} title={stack.name || 'Konvolut'}>📎 {stack.name || 'Konvolut'}</button>
      {#if aktuelleDoc}
        <span class="trenner" aria-hidden="true">›</span>
        <button class="crumb" onclick={() => springeZuSeite(ersteSeiteDesDokuments(aktuelleDoc.id))} title={aktuelleDoc.name}>{aktuelleDoc.name}</button>
        <span class="seitenteil">· Seite {globalPage} von {pages?.length ?? globalPage}</span>
      {/if}
    </div>
    <button class="werkzeuge" onclick={openRadialCentered} aria-label="Werkzeuge" title="Werkzeuge">🧰</button>
    <button class="info" onclick={(e) => { ui.provenancePopover = { id: stack.id, anchor: { x: e.clientX, y: e.clientY } }; }}
            aria-label="Herkunft anzeigen" title="Herkunft anzeigen">ⓘ</button>
    <span class="pager">
      <button onclick={() => turn(-1)} disabled={!pages || globalPage <= 1} aria-label="Zurück">‹</button>
      <span class="pos">{globalPage}{#if pages} / {pages.length}{/if}</span>
      <button onclick={() => turn(1)} disabled={!pages || globalPage >= pages.length} aria-label="Weiter">›</button>
    </span>
    <button class="close" onclick={() => void desktop.command('collapseStack', { id: stack.id })} aria-label="Schließen">✕</button>
  </div>
  {#if stampMenu}<StampPopover onpick={pickStamp} onclose={() => (stampMenu = false)} />{/if}
  <div class="body" role="presentation" onwheel={(e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }} onpointerdown={onBodyPointerDown} onpointermove={onBodyPointerMove} onpointerup={onBodyPointerUp}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); radial = { x: e.clientX, y: e.clientY }; }}>
    {#if desktop.api && aktuelle}
      <div class="pagewrap">
        {#if aktuelleKind === 'image'}
          <ImagePage api={desktop.api} fileId={aktuelle.fileId} name={aktuelleDoc?.name ?? ''} targetWidth={pageWidth}
            onbasesize={(s) => (baseSize = s)} />
        {:else if aktuelleKind === 'convertible'}
          <PageRenderer api={desktop.api} fileId={aktuelle.fileId} page={aktuelle.page} targetWidth={pageWidth}
            source="preview" onbasesize={(s) => (baseSize = s)} />
        {:else}
          <PageRenderer api={desktop.api} fileId={aktuelle.fileId} page={aktuelle.page} targetWidth={pageWidth} onbasesize={(s) => (baseSize = s)} />
        {/if}
        <InkOverlay docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth}
                    colors={{ pen: penColor, marker: markerColor }}
                    tool={inkTool === 'tippex' || inkTool === 'redact' ? null : inkTool} />
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
        <MarkLayer docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth}
                   active={inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null} />
        {#if stampChoice && baseSize}
          <div class="stempelflaeche" role="presentation" onpointerdown={stampAt}></div>
        {/if}
        <StampLayer docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth} active={stampChoice !== null} />
        <!-- Sprung zur Quelle: Mitglieds-docId+Seite passen hier direkt (ohne Verrenkung) -> mit einbauen. -->
        <SourceHighlight docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth} />
      </div>
    {:else}
      <div class="laden">Seiten werden gezählt…</div>
    {/if}
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
  {#if radial}
    <RadialMenu x={radial.x} y={radial.y} groups={radialGroups}
                onpick={radialPick} oncolor={radialColor} onclose={() => (radial = null)} />
  {/if}
</div>

<style>
  /* CSS 1:1 vom DocViewer übernommen (bewusste Duplikation, Bestandsmuster) — plus .laden für den Ladezustand. */
  .viewer { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 6px;
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; touch-action: none; }
  .viewer:focus { outline: 2px solid var(--brand-blue); }
  /* Lichttisch: Papier wird durchscheinend, darunterliegende Seiten schimmern durch */
  .viewer.licht { opacity: .58; }
  .viewer.licht .body { background: transparent; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
          background: rgba(255, 255, 255, .78);
          backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
          border-bottom: 1px solid rgba(8, 31, 57, .10); cursor: grab; user-select: none; }
  /* Breadcrumb (13-05 Task 3): ersetzt .title. Der ganze Container schrumpft (flex:1, min-width:0)
     VOR den Bedienelementen rechts (die bleiben flex:none — E6-Verdrängungsverbot). Bricht nie in
     eine zweite Zeile (white-space: nowrap auf dem Container). */
  .breadcrumb { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px;
                white-space: nowrap; overflow: hidden; font-size: 12px; font-weight: 600; }
  /* Jedes Segment kürzt EINZELN mit Ellipsis (+ title trägt den Volltext) — nicht die ganze Kette
     auf einmal abgeschnitten. flex-shrink erlaubt beiden Crumbs, sich proportional zurückzuziehen. */
  .crumb { flex: 0 1 auto; min-width: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
           border: none; background: none; padding: 0; font: inherit; font-weight: inherit; color: inherit;
           cursor: pointer; text-align: left; }
  .crumb:hover { text-decoration: underline; }
  .trenner { flex: none; opacity: .6; }
  /* Seitenteil kürzt NIE (E6-Backstop) — eigenes flex:none, kein Ellipsis, immer voll lesbar. */
  .seitenteil { flex: none; font-weight: 400; opacity: .85; }
  .pager { display: flex; align-items: center; gap: 6px; }
  .werkzeuge, .info { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
               width: 24px; height: 24px; font-size: 13px; line-height: 1; }
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
  .schnittrahmen { position: absolute; border: 2px dashed var(--brand-red); background: var(--brand-red-soft);
                   pointer-events: none; }
  .schnittrahmen.tippex { border-color: #8a94a3; background: rgba(255, 255, 255, .35); }
  .schnittrahmen.redact { border-color: #111; background: rgba(0, 0, 0, .18); }
  .laden { color: #dfe5ee; font-size: 13px; padding: 40px; }
</style>
