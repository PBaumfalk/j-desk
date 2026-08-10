<script lang="ts">
  import {
    moveZeitleiste, zeitleisteBox, clipOf, findeObjekt, sortierteEintraege, rotationFor, dateDiffDays,
    ZEITLEISTE_W, ZEITLEISTE_H, ZEITLEISTE_MIN_W, ZEITLEISTE_MIN_H,
    type ZeitleisteCard as ZeitleisteKarte, type ZeitleistenEintrag, type Viewport, type DesktopState,
  } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast, pointerUeberKorb } from '../ui.svelte';
  import { kartenBewegungGesperrt } from '../sitzungsmodus';
  import { showZeitleisteMenuAt, showZeitleisteMenu } from '../menus';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import { achsenSpanne, achsenTicks, markerPositionen } from '../zeitleisteAchse';
  import ZeitleisteEintragPopover, { ZEITLEISTE_ART_LABELS, ZEITLEISTE_ART_ICONS } from './ZeitleisteEintragPopover.svelte';

  let { z, vp }: { z: ZeitleisteKarte; vp: Viewport } = $props();

  const box = $derived(zeitleisteBox(z));
  const taped = $derived(z.taped === true);
  // SESS-01: siehe DocCard.svelte — Klebeband und Sitzungssperre teilen sich denselben Zweig.
  const dragGesperrt = $derived(taped || kartenBewegungGesperrt());
  // Hervorhebungs-Markierung (VIEW-01, 11-08): Accent-Ring + 📌-Badge, reiner Client-Zustand.
  const hervorgehoben = $derived(ui.highlightedIds.has(z.id));
  const geklammert = $derived(clipOf(desktop.state, z.id) !== undefined);
  const eintraege = $derived(sortierteEintraege(z));

  /**
   * Markerbeschriftung wird AUSSCHLIESSLICH aus dem projizierten Zustand abgeleitet
   * (findeObjekt) — der Eintrag selbst trägt kein Titel-/Namens-/Textfeld (09-01-PLAN.md,
   * T-09-02). Ein für den Betrachter unauflösbares/gelöschtes Quellobjekt liefert `null` und
   * rendert damit den neutralen Zustand ohne Titel und ohne Inhalt.
   */
  function labelFuer(eintrag: ZeitleistenEintrag): string | null {
    const gefunden = findeObjekt(desktop.state, eintrag.objRef);
    if (!gefunden) return null;
    const o = gefunden.obj as unknown as Record<string, unknown>;
    if (typeof o.name === 'string' && o.name !== '') return o.name;
    if (typeof o.text === 'string' && o.text !== '') return o.text;
    if (typeof o.titel === 'string' && o.titel !== '') return o.titel;
    if (typeof o.textSnapshot === 'string' && o.textSnapshot !== '') return o.textSnapshot;
    return 'Objekt';
  }

  /** Liegt das Quellobjekt eines Eintrags im Papierkorb? (T-09-23) — der Marker bleibt dann
   *  sichtbar und gedimmt statt still zu verschwinden, mit eigenem Tooltip statt dem generischen
   *  „nicht verfügbar" der `labelFuer`-Auflösung (die im Korb absichtlich nichts findet, weil
   *  `findeObjekt` nur den aktiven Zustand durchsucht). Bewusst OHNE den Namen aus dem
   *  Korb-Payload zu zeigen — dieselbe Zurückhaltung wie bei jeder unauflösbaren Referenz (T-09-02). */
  function imPapierkorb(s: DesktopState, objId: string): boolean {
    return (s.trash ?? []).some((t) =>
      t.payload.docs.some((d) => d.id === objId) ||
      t.payload.notes.some((n) => n.id === objId) ||
      t.payload.cutouts.some((c) => c.id === objId) ||
      t.payload.stacks.some((st) => st.id === objId) ||
      t.payload.legalObjects.some((o) => o.id === objId) ||
      t.payload.tables.some((tb) => tb.id === objId) ||
      (t.payload.zeitleisten ?? []).some((zl) => zl.id === objId),
    );
  }

  /** Kalendertag (JJJJ-MM-TT) als de-DE-Datum, UTC-fest (kein Off-by-one durch lokale Zeitzone;
   *  Bestandsmuster `toLocaleDateString('de-DE', { ..., timeZone: 'UTC' })`, s. ZeitleisteCard
   *  Plan 09-01 `monatsTicks`). */
  function formatKalendertag(iso: string): string {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  }

  /** Datumstext je Zeitangabe (09-UI-SPEC.md Zeitangaben-Unsicherheitsgrammatik): Ungefähr erhält
   *  ein vorangestelltes Näherungszeichen, Zeitraum zeigt beide Daten, die übrigen drei Zustände
   *  das reine Kalenderdatum. */
  function datumsText(eintrag: ZeitleistenEintrag): string {
    if (eintrag.zeitangabe === 'ungefaehr') return `~${formatKalendertag(eintrag.datum)}`;
    if (eintrag.zeitangabe === 'zeitraum' && eintrag.datumBis) return `${formatKalendertag(eintrag.datum)}–${formatKalendertag(eintrag.datumBis)}`;
    return formatKalendertag(eintrag.datum);
  }

  const zusammenfassung = $derived(z.eintraege.length === 0 ? 'Keine Einträge' : `${z.eintraege.length} ${z.eintraege.length === 1 ? 'Eintrag' : 'Einträge'}`);

  // ---- Achse (Body, geöffnete Ansicht): horizontal scrollbar, Monats-/Jahres-Tickmarken. ----
  // Die gesamte Rechnung (Spanne, Ticks, Markerpositionen/-reihen) liegt außerhalb der Komponente
  // in zeitleisteAchse.ts (09-05-PLAN.md Task 1) — hier wird nicht mehr gerechnet, nur noch
  // gerendert. Eine Zoomstufe ist dafür nur ein Faktor auf die Achsenbreite.
  const PX_PRO_TAG_BASIS = 6;
  const MARKER_BREITE_PX = 96; // ungefähre Label-Breite — Marker mit überlappenden Labels stapeln sich in Reihen
  const REIHEN_HOEHE_PX = 24;

  let zoom = $state(1);
  function zoomOut(): void { zoom = Math.max(0.25, zoom / 1.5); }
  function zoomIn(): void { zoom = Math.min(8, zoom * 1.5); }

  const spanne = $derived(achsenSpanne(z.eintraege));
  const spannTage = $derived(Math.max(1, dateDiffDays(spanne.von, spanne.bis) ?? 1));
  const achsenBreitePx = $derived(Math.max(box.w, spannTage * PX_PRO_TAG_BASIS * zoom));
  const ticks = $derived(achsenTicks(spanne, achsenBreitePx));
  const positionen = $derived(markerPositionen(z.eintraege, spanne, achsenBreitePx, MARKER_BREITE_PX));
  const positionenNachId = $derived(new Map(positionen.map((p) => [p.eintragId, p])));
  const maxReihe = $derived(positionen.reduce((m, p) => Math.max(m, p.reihe), 0));

  // ---- Body-Rechteck für pointerUeberZeitleiste() (Task 3, Muster ui.trashRect/TrashCan.svelte) ----
  let bodyEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    // Abhängigkeiten: Position/Größe/Öffnen-Zustand der Karte und der Viewport verschieben das
    // Bildschirm-Rechteck des Body — bei jeder Änderung neu messen. `z.zIndex` gehört bewusst
    // dazu (WR-01, 09-REVIEW.md): ein bringToFront() beim Anklicken ändert nur zIndex, nicht
    // Position/Größe — ohne diese Abhängigkeit bliebe der zuvor eingetragene zIndex-Wert stehen
    // und pointerUeberZeitleiste() würde weiterhin die zuerst geöffnete statt die oberste
    // Zeitleiste treffen.
    void box; void vp.x; void vp.y; void vp.scale; void z.open; void z.zIndex;
    if (!bodyEl || !z.open) {
      delete ui.zeitleisteRects[z.id];
      return;
    }
    const r = bodyEl.getBoundingClientRect();
    ui.zeitleisteRects[z.id] = { x: r.left, y: r.top, w: r.width, h: r.height, zIndex: z.zIndex };
    return () => { delete ui.zeitleisteRects[z.id]; };
  });

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (ui.deskPointers > 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== z.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: z.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === z.id) { ui.linkingFromId = null; return; }
    if (ui.clippingFromId && ui.clippingFromId !== z.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: z.id, id: uid() }).catch((err) => showToast(err instanceof Error ? err.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === z.id) { ui.clippingFromId = null; return; }
    if (ui.zeitleisteEintragFuer === z.id) { ui.zeitleisteEintragFuer = null; return; }
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
        pressTimer = setTimeout(() => { showZeitleisteMenuAt(last.x + 16, last.y + 12, z); }, 500);
      }
      return;
    }
    if (activePointer !== null && (e.currentTarget as HTMLElement).hasPointerCapture(activePointer)) return;
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: z.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      pressTimer = setTimeout(() => { dragging = false; showZeitleisteMenuAt(last.x + 16, last.y + 12, z); }, 500);
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
    if (geklammert) moveGroupLocal(groupOf(z.id), dx, dy);
    else desktop.applyLocal((s) => moveZeitleiste(s, z.id, { x: z.position.x + dx, y: z.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (!moved) { activePointer = null; return; }
    if (pointerUeberKorb(e.clientX, e.clientY)) {
      void desktop.command('trashObject', { id: z.id, trashedAt: new Date().toISOString() });
      activePointer = null;
      return;
    }
    if (geklammert) { commitGroupMove(groupOf(z.id)); activePointer = null; return; }
    void desktop.command('moveZeitleiste', { id: z.id, position: { x: z.position.x, y: z.position.y } });
    activePointer = null;
  }

  // ---- Geöffnete Ansicht: Kopfzeile ziehen/Lang-Druck-Menü (Mechanik aus TableCard.svelte) ----
  let headDragging = false;
  let headMoved = false;
  let headLast = { x: 0, y: 0 };
  let headPressTimer: ReturnType<typeof setTimeout> | undefined;
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    if (dragGesperrt) {
      // Festgeklebt oder Sitzungssperre aktiv — die Kopfzeile ist der zweite Zieh-Pfad dieser
      // Kartenart und muss identisch gesperrt werden (11-PATTERNS.md Move-lock enumeration,
      // dieselbe Begründung wie TableCard.svelte).
      clearTimeout(headPressTimer);
      headPressTimer = undefined;
      headLast = { x: e.clientX, y: e.clientY };
      if (e.pointerType !== 'mouse') {
        headPressTimer = setTimeout(() => { showZeitleisteMenuAt(headLast.x + 16, headLast.y + 12, z); }, 500);
      }
      return;
    }
    headDragging = true;
    headMoved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: z.id });
    clearTimeout(headPressTimer);
    headPressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      headPressTimer = setTimeout(() => { headDragging = false; showZeitleisteMenuAt(headLast.x + 16, headLast.y + 12, z); }, 500);
    }
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!headDragging) return;
    if (headPressTimer) {
      if (Math.hypot(e.clientX - headLast.x, e.clientY - headLast.y) <= 8) return;
      clearTimeout(headPressTimer);
      headPressTimer = undefined;
    }
    headMoved = true;
    const dx = (e.clientX - headLast.x) / vp.scale;
    const dy = (e.clientY - headLast.y) / vp.scale;
    headLast = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveZeitleiste(s, z.id, { x: z.position.x + dx, y: z.position.y + dy }));
  }
  function onHeaderPointerUp() {
    clearTimeout(headPressTimer);
    headPressTimer = undefined;
    if (!headDragging) return;
    headDragging = false;
    if (headMoved) void desktop.command('moveZeitleiste', { id: z.id, position: { x: z.position.x, y: z.position.y } });
  }

  // Größe ziehen (Anfasser unten rechts) — Mechanik aus TableCard.svelte onResizeDown/Move/Up.
  // SESS-01, bewusst OHNE dragGesperrt-Guard: Größe ändern ist keine Verschiebung im Sinne des
  // Copywriting Contracts — ein während des Termins versehentlich verkleinertes Fenster ist ein
  // reversibler Darstellungsvorgang ohne Positionsverlust (11-04-PLAN.md Task 3).
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
    const w = Math.max(ZEITLEISTE_MIN_W, box.w + dx);
    const h = Math.max(ZEITLEISTE_MIN_H, box.h + dy);
    desktop.applyLocal((s) => ({ ...s, zeitleisten: (s.zeitleisten ?? []).map((zl) => (zl.id === z.id ? { ...zl, openSize: { w, h } } : zl)) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeZeitleiste', { id: z.id, size: { w: box.w, h: box.h } });
  }

  function markerAnklicken(e: PointerEvent, eintrag: ZeitleistenEintrag): void {
    e.stopPropagation();
    ui.zeitleisteEintragEntwurf = { zeitleisteId: z.id, objRef: eintrag.objRef, eintragId: eintrag.id };
  }

  /** Anker des Eintrags-Popovers: Mitte der geöffneten Karte (Weltkoordinaten) — unabhängig vom
   *  waagerechten Scroll-Zustand der Achse, damit das Formular immer im sichtbaren Kartenbereich
   *  erscheint statt am Rand des scrollbaren Achseninhalts. */
  const popoverAnchor = $derived({ x: z.position.x + box.w / 2, y: z.position.y + box.h / 2 });
</script>

{#if z.open}
  <div class="viewer" role="group" aria-label="Zeitleiste"
       style:left="{z.position.x}px" style:top="{z.position.y}px" style:z-index={z.zIndex}
       style:width="{box.w}px" style:height="{box.h}px">
    <div class="head" role="toolbar" tabindex="-1" aria-label="Zeitleistenleiste"
         onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}
         oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showZeitleisteMenuAt(e.clientX, e.clientY, z); }}>
      <span class="title">Zeitleiste</span>
      <div class="zoom">
        <button onclick={() => zoomOut()} aria-label="Verkleinern" title="Verkleinern">−</button>
        <button onclick={() => zoomIn()} aria-label="Vergrößern" title="Vergrößern">+</button>
      </div>
      <button class="eintrag-knopf" onclick={() => { ui.zeitleisteEintragFuer = z.id; }}>+ Eintrag</button>
      <button class="close" onclick={() => void desktop.command('collapseZeitleiste', { id: z.id })} aria-label="Schließen">✕</button>
    </div>
    <div class="body" bind:this={bodyEl}>
      {#if z.eintraege.length === 0}
        <div class="leer">Objekte per Ziehen oder ＋ Eintrag hier eintragen.</div>
      {:else}
        <div class="achse" style:width="{achsenBreitePx}px" style:min-height="{Math.max(120, 60 + (maxReihe + 1) * REIHEN_HOEHE_PX)}px">
          <div class="achsen-linie" aria-hidden="true"></div>
          {#each ticks as tick (tick.x + tick.label)}
            <div class="tick" style:left="{tick.x}px">
              <span class="tick-strich" aria-hidden="true"></span>
              <span class="tick-label">{tick.label}</span>
            </div>
          {/each}
          {#each eintraege as eintrag (eintrag.id)}
            {@const pos = positionenNachId.get(eintrag.id)}
            {#if pos}
              {@const label = labelFuer(eintrag)}
              {@const inKorb = imPapierkorb(desktop.state, eintrag.objRef)}
              {@const artIcon = ZEITLEISTE_ART_ICONS[eintrag.art]}
              {@const artTitel = ZEITLEISTE_ART_LABELS[eintrag.art]}
              {@const kapselBreite = Math.max(10, (pos.xBis ?? pos.x) - pos.x)}
              <div class="marker" class:neutral={label === null && !inKorb} class:verwaist={inKorb}
                   role="button" tabindex="-1" aria-label="Zeitleisten-Eintrag bearbeiten"
                   style:left="{pos.x}px" style:top="calc(50% + {pos.reihe * REIHEN_HOEHE_PX}px)"
                   title={inKorb ? 'Quellobjekt liegt im Papierkorb' : (label ?? 'Quellobjekt nicht verfügbar')}
                   onpointerdown={(e) => markerAnklicken(e, eintrag)}>
                <span class="strich" class:gestrichelt={eintrag.zeitangabe === 'abgeleitet'} aria-hidden="true"></span>
                {#if eintrag.zeitangabe === 'genau'}
                  <span class="form punkt" aria-hidden="true"></span>
                {:else if eintrag.zeitangabe === 'ungefaehr'}
                  <span class="form ring" aria-hidden="true"></span>
                {:else if eintrag.zeitangabe === 'zeitraum'}
                  <span class="form kapsel" style:width="{kapselBreite}px" aria-hidden="true"></span>
                {:else if eintrag.zeitangabe === 'streitig'}
                  <span class="form punkt streitig-form" aria-hidden="true"></span>
                {:else if eintrag.zeitangabe === 'abgeleitet'}
                  <span class="form punkt abgeleitet-form" aria-hidden="true"></span>
                {/if}
                <div class="marker-label-zeile">
                  {#if artIcon !== ''}
                    <span class="art-icon" aria-hidden="true" title={artTitel}>{artIcon}</span>
                  {/if}
                  {#if eintrag.zeitangabe === 'abgeleitet'}
                    <span class="abgeleitet-icon" aria-hidden="true" title="Automatisch aus Dokument abgeleitet, ungeprüft">📄</span>
                  {/if}
                  <span class="marker-label" class:neutral={label === null}>{label ?? ''}</span>
                  {#if eintrag.zeitangabe === 'streitig'}
                    <span class="streitig-badge">streitig</span>
                  {/if}
                </div>
                <span class="marker-datum">{datumsText(eintrag)}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
    <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
  </div>
  {#if ui.zeitleisteEintragEntwurf?.zeitleisteId === z.id}
    <ZeitleisteEintragPopover anchor={popoverAnchor} />
  {/if}
{:else}
  <div class="card" class:hervorgehoben={hervorgehoben} role="button" tabindex="-1" aria-label="Zeitleiste"
       style:left="{z.position.x}px" style:top="{z.position.y}px"
       style:z-index={z.zIndex} style:transform="rotate({rotationFor(z.id)}deg)"
       style:width="{ZEITLEISTE_W}px" style:height="{ZEITLEISTE_H}px"
       onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
       ondblclick={() => void desktop.command('expandZeitleiste', { id: z.id })}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showZeitleisteMenu(e, z); }}>
    {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
    {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
    {#if hervorgehoben}
      <!-- 📌-Badge (VIEW-01, 11-08): oben links, nach dem Prinzip der Status-Badges. -->
      <div class="pin-badge" title="In Ansicht hervorgehoben">📌</div>
    {/if}
    <div class="icon" aria-hidden="true">🕰</div>
    <div class="titel">Zeitleiste</div>
    <div class="zusammenfassung">{zusammenfassung}</div>
  </div>
{/if}

<style>
  .card { position: absolute; display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 4px; padding: 8px 12px; text-align: center;
          background: var(--glass-card-bg); border: 1px solid var(--glass-border);
          backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
          border-radius: 4px; box-shadow: 0 6px 18px rgba(0, 0, 0, .35); cursor: grab;
          user-select: none; touch-action: none; }
  /* Hervorhebungs-Ring (VIEW-01, 11-08): strukturell dem Bearbeitungs-Ring aus DocCard/NoteCard
     folgend (additiver Zustandsmodifikator), verwendet aber IMMER die Accent-Farbe statt einer
     Präsenzfarbe — die Hervorhebung ist personenunabhängig (UI-SPEC Color e). Als Innenschatten-
     Kontur 2px INNERHALB der Kartenkontur über ::after umgesetzt: verschiebt kein Layout und
     bleibt über undurchsichtigen Kindflächen sichtbar (ein inset-Schatten direkt auf .card läge
     HINTER den Kindelementen). */
  .card.hervorgehoben::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
                               box-shadow: inset 0 0 0 2px var(--brand-blue); pointer-events: none; }
  /* 📌-Badge: oben links AUSSERHALB der Kartenkontur aufgesteckt (Muster .klammer). Bewusst KEIN
     pointer-events: none — der Pflicht-Tooltip braucht den Zeigerkontakt; der Zeigerdruck
     bubbelt zur Karte und startet dort regulär den Drag. */
  .pin-badge { position: absolute; top: -10px; left: -8px; z-index: 6; font-size: 15px;
               filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
  .icon { font-size: 22px; }
  .titel { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
           white-space: nowrap; max-width: 100%; }
  .zusammenfassung { font-size: 12px; color: var(--glass-text-secondary); overflow: hidden;
                      text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }

  .viewer { position: absolute; display: flex; flex-direction: column; background: var(--glass-panel-bg);
            border: 1px solid var(--glass-border); border-radius: 6px;
            backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; touch-action: none; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 16px;
          background: rgba(255, 255, 255, .12); border-bottom: 1px solid var(--glass-border);
          cursor: grab; user-select: none; }
  .title { flex: 1; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .zoom { display: flex; gap: 2px; align-items: center; }
  .zoom button { border: none; background: transparent; color: inherit; border-radius: 6px; cursor: pointer;
                 width: 26px; height: 26px; font-size: 14px; line-height: 1; padding: 0; }
  .zoom button:hover { background: rgba(0, 0, 0, .08); }
  .eintrag-knopf { border: none; background: var(--brand-blue); color: #fff; border-radius: 6px;
                   cursor: pointer; font-size: 12px; font-weight: 600; padding: 6px 10px; white-space: nowrap; }
  .close { border: none; background: rgba(0, 0, 0, .08); border-radius: 5px; cursor: pointer;
           width: 24px; height: 24px; font-size: 15px; line-height: 1; color: inherit; }
  .body { flex: 1; overflow: auto; position: relative; }
  .leer { display: flex; align-items: center; justify-content: center; height: 100%;
          color: var(--glass-text-secondary); font-size: 13px; padding: 0 24px; text-align: center; }
  .achse { position: relative; height: 100%; min-height: 120px; }
  .achsen-linie { position: absolute; left: 0; right: 0; top: 50%; height: 1px;
                  background: var(--glass-border); }
  .tick { position: absolute; top: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; }
  .tick-strich { display: block; width: 1px; height: 12px; background: var(--glass-border); margin-top: 4px; }
  .tick-label { font-size: 12px; color: var(--glass-text-secondary); margin-top: 2px; white-space: nowrap; }

  .marker { position: absolute; transform: translate(-50%, -50%); display: flex;
            flex-direction: column; align-items: center; gap: 2px; cursor: pointer; }
  .marker.verwaist { opacity: .65; }
  .strich { display: block; width: 1px; height: 10px; background: var(--brand-navy, #081F39); }
  .strich.gestrichelt { background: none; border-left: 1px dashed var(--brand-navy, #081F39); width: 0; }
  .form.punkt { display: block; width: 10px; height: 10px; border-radius: 50%; background: var(--brand-navy, #081F39); }
  .marker.neutral .form.punkt { background: var(--glass-text-secondary); opacity: .5; }
  .form.ring { display: block; width: 10px; height: 10px; border-radius: 50%; background: transparent;
               border: 2px solid var(--brand-navy, #081F39); box-sizing: border-box; }
  .form.kapsel { display: block; height: 10px; min-width: 10px; border-radius: 999px;
                 background: var(--glass-card-bg); border: 2px solid var(--brand-navy, #081F39); box-sizing: border-box; }
  .form.punkt.streitig-form { box-shadow: 0 0 0 3px rgba(150, 92, 10, .88); }
  .marker-label-zeile { display: flex; align-items: center; gap: 3px; }
  .art-icon { font-size: 11px; line-height: 1; }
  .abgeleitet-icon { font-size: 10px; line-height: 1; }
  .marker-label { font-size: 12px; max-width: 110px; overflow: hidden; text-overflow: ellipsis;
                   white-space: nowrap; }
  .marker-label.neutral { color: var(--glass-text-secondary); font-style: italic; }
  .streitig-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
                     color: rgba(150, 92, 10, .88); }
  .marker-datum { font-size: 11px; color: var(--glass-text-secondary); white-space: nowrap; }

  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
</style>
