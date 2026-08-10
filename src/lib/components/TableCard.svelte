<script lang="ts">
  import {
    CARD_W, CARD_H, moveTable, tableBox, clipOf, berechneFormelSpalte, formatCentsDe, rotationFor, setTableCell,
    type TableCard as TabelleKarte, type TableColumn, type TableRow, type Viewport,
  } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast, pointerUeberKorb } from '../ui.svelte';
  import { kartenBewegungGesperrt } from '../sitzungsmodus';
  import { showTableMenu, showTableMenuAt, formelMenuOeffnen, FORMEL_ART_LABELS } from '../menus';
  import { fundstelleAusBelegRef } from '../jump';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';

  let { t, vp }: { t: TabelleKarte; vp: Viewport } = $props();

  const box = $derived(tableBox(t));
  const taped = $derived(t.taped === true);
  // SESS-01: siehe DocCard.svelte — Klebeband und Sitzungssperre teilen sich denselben Zweig.
  const dragGesperrt = $derived(taped || kartenBewegungGesperrt());
  // Hervorhebungs-Markierung (VIEW-01, 11-08): Accent-Ring + 📌-Badge, reiner Client-Zustand.
  const hervorgehoben = $derived(ui.highlightedIds.has(t.id));
  const geklammert = $derived(clipOf(desktop.state, t.id) !== undefined);

  /**
   * Formel-Zusammenfassungszeile der geschlossenen Miniatur (08-UI-SPEC.md Copywriting Contract):
   * ausschließlich die ZUERST definierte Formelspalte, nie eine Aufzählung mehrerer Formeln — die
   * Anzeigeform ("Strich" statt Zahl bei unberechenbarem Ergebnis) folgt derselben Regel wie die
   * Fußzeile der geöffneten Karte. berechneFormelSpalte() ist die einzige Rechenquelle; hier
   * passiert ausschließlich Formatierung, keine eigene Berechnung.
   */
  const ersteFormelSpalte = $derived(t.spalten.find((sp) => sp.art === 'formel'));
  const zusammenfassung = $derived.by(() => {
    const sp = ersteFormelSpalte;
    if (!sp) return null;
    return `${sp.titel}: ${formelErgebnisText(sp)}`;
  });

  /** Formatiert das Ergebnis einer Formelspalte für die Anzeige — Geldergebnisse über
   *  formatCentsDe mit angehängtem Euro-Zeichen, Tagesdifferenzen als ganze Zahl. Ein
   *  unberechenbares Ergebnis (undefined) zeigt einen Strich statt einer Null (T-08-33): eine
   *  nicht interpretierbare Zelle darf nicht wie ein Ergebnis von null aussehen. Reine
   *  Formatierung — die Berechnung selbst kommt ausschließlich aus berechneFormelSpalte(). */
  function formelErgebnisText(sp: TableColumn): string {
    const ergebnis = berechneFormelSpalte(t, sp);
    if (ergebnis === undefined) return '—';
    return sp.formel === 'datumsdifferenz' ? `${ergebnis} Tage` : `${formatCentsDe(ergebnis)} €`;
  }

  const gridTemplate = $derived(`repeat(${Math.max(t.spalten.length, 1)}, minmax(90px, 1fr)) 130px`);

  /** Zellwert beim Verlassen des Feldes übernehmen — nur bei tatsächlicher Änderung (Sparsamkeits-
   *  muster wie beim Zettel-Text, NoteCard.svelte speichern()). desktop.applyLocal() sorgt für die
   *  sofortige Neuberechnung der Ergebniszelle, bevor die Server-Antwort da ist. */
  function zelleAendern(rowId: string, spaltenId: string, wert: string): void {
    const row = t.rows.find((r) => r.id === rowId);
    if (!row) return;
    if ((row.zellen[spaltenId] ?? '') === wert) return;
    desktop.applyLocal((s) => setTableCell(s, t.id, rowId, spaltenId, wert));
    void desktop.command('setTableCell', { tableId: t.id, rowId, spaltenId, wert });
  }

  /** Dokumentname für den title des Beleg-Chips (08-UI-SPEC.md Copywriting Contract) — fällt auf
   *  die docId zurück, falls das Dokument gerade nicht auf dem Tisch liegt (z. B. Papierkorb). */
  function belegTitel(docId: string): string {
    return desktop.state.docs.find((d) => d.id === docId)?.name ?? docId;
  }

  /** Zeilen-Kontextmenü (Task 3): bislang einziger Eintrag ist „Beleg entfernen" — ohne
   *  gesetzten Beleg gibt es nichts zu entfernen, dann bleibt das native Kontextmenü unangetastet
   *  statt eines leeren eigenen Menüs. */
  function zeilenKontextmenu(e: MouseEvent, row: TableRow): void {
    if (!row.belegRef) return;
    e.preventDefault();
    e.stopPropagation();
    ui.menu = {
      x: e.clientX, y: e.clientY,
      items: [{ label: 'Beleg entfernen', action: () => void desktop.command('setTableRowBeleg', { tableId: t.id, rowId: row.id, belegRef: undefined }) }],
    };
  }

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (ui.deskPointers > 0) return; // Desk pannt bereits — Finger tritt dem Pinch bei
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== t.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: t.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === t.id) { ui.linkingFromId = null; return; }
    if (ui.clippingFromId && ui.clippingFromId !== t.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: t.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === t.id) { ui.clippingFromId = null; return; }
    // CALC-01, 08-07 Task 3: ein Klick auf die Tabellenkarte selbst bricht den laufenden
    // Beleg-Auswahlmodus ab (Muster ui.taskRefFromId in LegalObjectCard.svelte).
    if (ui.tabelleBelegFuer && ui.tabelleBelegFuer.tableId === t.id) { ui.tabelleBelegFuer = null; return; }
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
        pressTimer = setTimeout(() => { showTableMenuAt(last.x + 16, last.y + 12, t); }, 500);
      }
      return;
    }
    if (activePointer !== null && (e.currentTarget as HTMLElement).hasPointerCapture(activePointer)) return;
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: t.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      pressTimer = setTimeout(() => { dragging = false; showTableMenuAt(last.x + 16, last.y + 12, t); }, 500);
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
    if (geklammert) moveGroupLocal(groupOf(t.id), dx, dy);
    else desktop.applyLocal((s) => moveTable(s, t.id, { x: t.position.x + dx, y: t.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (!moved) { activePointer = null; return; }
    if (pointerUeberKorb(e.clientX, e.clientY)) {
      void desktop.command('trashObject', { id: t.id, trashedAt: new Date().toISOString() });
      activePointer = null;
      return;
    }
    if (geklammert) { commitGroupMove(groupOf(t.id)); activePointer = null; return; }
    void desktop.command('moveTable', { id: t.id, position: { x: t.position.x, y: t.position.y } });
    activePointer = null;
  }

  // ---- Geöffnete Ansicht: Kopfzeile ziehen/Lang-Druck-Menü (Mechanik aus DocViewer.svelte) ----
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
      // Kartenart und muss identisch gesperrt werden (11-PATTERNS.md Move-lock enumeration).
      clearTimeout(headPressTimer);
      headPressTimer = undefined;
      headLast = { x: e.clientX, y: e.clientY };
      if (e.pointerType !== 'mouse') {
        headPressTimer = setTimeout(() => { showTableMenuAt(headLast.x + 16, headLast.y + 12, t); }, 500);
      }
      return;
    }
    headDragging = true;
    headMoved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: t.id });
    clearTimeout(headPressTimer);
    headPressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      headPressTimer = setTimeout(() => { headDragging = false; showTableMenuAt(headLast.x + 16, headLast.y + 12, t); }, 500);
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
    desktop.applyLocal((s) => moveTable(s, t.id, { x: t.position.x + dx, y: t.position.y + dy }));
  }
  function onHeaderPointerUp() {
    clearTimeout(headPressTimer);
    headPressTimer = undefined;
    if (!headDragging) return;
    headDragging = false;
    if (headMoved) void desktop.command('moveTable', { id: t.id, position: { x: t.position.x, y: t.position.y } });
  }

  // Größe ziehen (Anfasser unten rechts) — Mechanik aus DocViewer.svelte onResizeDown/Move/Up.
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
    const w = Math.max(320, box.w + dx);
    const h = Math.max(200, box.h + dy);
    desktop.applyLocal((s) => ({ ...s, tables: (s.tables ?? []).map((tb) => (tb.id === t.id ? { ...tb, openSize: { w, h } } : tb)) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeTable', { id: t.id, size: { w: box.w, h: box.h } });
  }
</script>

{#if t.open}
  <div class="viewer" role="group" aria-label={t.titel || 'Tabelle'}
       style:left="{t.position.x}px" style:top="{t.position.y}px" style:z-index={t.zIndex}
       style:width="{box.w}px" style:height="{box.h}px">
    <div class="head" role="toolbar" tabindex="-1" aria-label="Tabellenleiste"
         onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}
         oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showTableMenuAt(e.clientX, e.clientY, t); }}>
      <span class="title">{t.titel || 'Tabelle'}</span>
      <button class="formel-knopf" onclick={(e) => formelMenuOeffnen(e.clientX, e.clientY, t)}>+ Formel</button>
      <button class="close" onclick={() => void desktop.command('collapseTable', { id: t.id })} aria-label="Schließen">✕</button>
    </div>
    <div class="body">
      <div class="tabelle" role="table">
        <div class="kopfzeile" role="row" style:grid-template-columns={gridTemplate}>
          {#each t.spalten as sp (sp.id)}
            <div class="zelle kopf" class:rechts={sp.art !== 'text'}>
              {#if sp.art === 'formel'}
                <span class="formel-badge" title="Formel: {FORMEL_ART_LABELS[sp.formel!]}">ƒ</span>
              {/if}
              {sp.titel}
            </div>
          {/each}
          <div class="zelle kopf beleg-kopf" aria-hidden="true"></div>
        </div>
        <div class="zeilen">
          {#each t.rows as row (row.id)}
            <div class="zeile" role="row" tabindex="-1" style:grid-template-columns={gridTemplate}
                 oncontextmenu={(e) => zeilenKontextmenu(e, row)}>
              {#each t.spalten as sp (sp.id)}
                {#if sp.art === 'formel'}
                  <!-- Formelspalten sind Spalten-AGGREGATE (Ergebnis nur in der Fußzeile) — keine
                       eigenen Zeilenwerte, deshalb hier eine leere Platzhalterzelle für die
                       Spaltenausrichtung. -->
                  <div class="zelle" aria-hidden="true"></div>
                {:else}
                  <div class="zelle" class:rechts={sp.art === 'zahl' || sp.art === 'datum'}>
                    <input value={row.zellen[sp.id] ?? ''} placeholder="…"
                           onblur={(e) => zelleAendern(row.id, sp.id, e.currentTarget.value)}
                           onpointerdown={(e) => e.stopPropagation()} />
                  </div>
                {/if}
              {/each}
              <div class="zelle beleg">
                {#if row.belegRef}
                  <button type="button" class="beleg-chip" title={belegTitel(row.belegRef.docId)}
                          onpointerdown={(e) => e.stopPropagation()}
                          onclick={() => void desktop.jumpTo(fundstelleAusBelegRef(desktop.state, row.belegRef!))}>📎 Beleg</button>
                {:else}
                  <button type="button" class="ghost-chip"
                          onpointerdown={(e) => e.stopPropagation()}
                          onclick={() => { ui.tabelleBelegFuer = { tableId: t.id, rowId: row.id }; }}>+ Beleg verknüpfen</button>
                {/if}
              </div>
            </div>
          {/each}
          <button class="zeile-hinzufuegen" onclick={() => void desktop.command('addTableRow', { tableId: t.id, id: uid() })}>+ Zeile</button>
        </div>
        <div class="fusszeile" role="row" style:grid-template-columns={gridTemplate}>
          {#each t.spalten as sp (sp.id)}
            <div class="zelle ergebnis" class:rechts={sp.art === 'formel'}>
              {#if sp.art === 'formel'}{formelErgebnisText(sp)}{/if}
            </div>
          {/each}
          <div class="zelle" aria-hidden="true"></div>
        </div>
      </div>
    </div>
    <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
  </div>
{:else}
  <div class="card" class:hervorgehoben={hervorgehoben} role="button" tabindex="-1" aria-label={t.titel ? `Tabelle: ${t.titel}` : 'Tabelle'}
       style:left="{t.position.x}px" style:top="{t.position.y}px"
       style:z-index={t.zIndex} style:transform="rotate({rotationFor(t.id)}deg)"
       style:width="{CARD_W}px" style:height="{CARD_H}px"
       onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
       ondblclick={() => void desktop.command('expandTable', { id: t.id })}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showTableMenu(e, t); }}>
    {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
    {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
    {#if hervorgehoben}
      <!-- 📌-Badge (VIEW-01, 11-08): oben links, nach dem Prinzip der Status-Badges. -->
      <div class="pin-badge" title="In Ansicht hervorgehoben">📌</div>
    {/if}
    <div class="icon" aria-hidden="true">🧮</div>
    <div class="titel">{t.titel || 'Tabelle'}</div>
    {#if zusammenfassung}<div class="zusammenfassung">{zusammenfassung}</div>{/if}
  </div>
{/if}

<style>
  .card { position: absolute; display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 6px; padding: 10px 12px; text-align: center;
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
  .icon { font-size: 28px; }
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
  .formel-knopf { border: none; background: var(--brand-blue); color: #fff; border-radius: 6px;
                  cursor: pointer; padding: 6px 12px; font-size: 12px; font-weight: 600; }
  .close { border: none; background: rgba(0, 0, 0, .08); border-radius: 5px; cursor: pointer;
           width: 24px; height: 24px; font-size: 15px; line-height: 1; color: inherit; }
  .body { flex: 1; overflow: auto; }
  .tabelle { display: flex; flex-direction: column; font-size: 13px; }
  .kopfzeile, .zeile, .fusszeile { display: grid; align-items: center; }
  .kopfzeile { position: sticky; top: 0; z-index: 2; background: inherit; }
  .fusszeile { position: sticky; bottom: 0; z-index: 2; background: inherit; }
  .zelle { padding: 6px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .zelle.rechts { text-align: right; }
  .zelle.kopf { font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--glass-border); }
  .formel-badge { display: inline-block; margin-right: 4px; font-size: 10px; font-weight: 700;
                   text-transform: uppercase; letter-spacing: .05em; color: var(--brand-blue); }
  .zeile:hover { background: var(--glass-hover); }
  .zeile input { width: 100%; border: none; background: transparent; font: inherit; color: inherit;
                 text-align: inherit; padding: 0; outline: 2px solid transparent; border-radius: 3px; }
  .zeile input:focus { outline-color: var(--brand-blue); }
  .zelle.rechts input { text-align: right; }
  .zeile-hinzufuegen { display: block; width: 100%; text-align: left; padding: 8px 10px;
                        border: none; background: transparent; cursor: pointer; color: var(--brand-blue);
                        font: inherit; font-size: 13px; }
  .zeile-hinzufuegen:hover { background: var(--glass-hover); }
  .fusszeile .zelle.ergebnis { font-weight: 600; }
  /* Beleg-Chip (Task 3, 08-UI-SPEC.md Color): Ghost-Chip in Akzent-Textfarbe ohne Beleg,
     gefüllter Zustand mit Klammer-Symbol sobald verknüpft — beide als <button>, damit ein Klick
     springt bzw. den Auswahlmodus startet. */
  .beleg-chip, .ghost-chip { border: none; background: transparent; cursor: pointer; font: inherit;
                              font-size: 12px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
  .ghost-chip { color: var(--brand-blue); }
  .beleg-chip { color: var(--glass-text-secondary); }
  .beleg-chip:hover, .ghost-chip:hover { background: var(--glass-hover); }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
</style>
