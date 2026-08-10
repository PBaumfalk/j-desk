<script lang="ts">
  import {
    CARD_W, CARD_H, moveDoc, hitTest, stampsFor, flagsFor, clipOf, deskBackground, type Doc, type Viewport,
  } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { kartenBewegungGesperrt } from '../sitzungsmodus';
  import { abwurfZielFuer, starteZeitleisteEintrag } from '../zeitleisteDrop';
  import { chipFuerEbene, chipFuerExtern, chipFuerFreigabe, showDocMenu, showDocMenuAt } from '../menus';
  import { getThumbnail, imageMime } from '../thumbnails';
  import { getFileUrl } from '../fileCache';
  import { PreviewError } from '../previewPoll';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import { referenzstatusVon } from '../referenzstatus';
  import { isLight } from '../deskThemes';
  import { personFuerObjekt } from '../presence.svelte';
  import { identityColor, vorname } from '../identityColor';
  import DocViewer from './DocViewer.svelte';
  import ViewerAbbild from './ViewerAbbild.svelte';

  let { doc, vp, lupe = false }: { doc: Doc; vp: Viewport; lupe?: boolean } = $props();

  // Querformat: liegende Karte (Maße getauscht); Geometrie (docBox) rechnet identisch.
  const kartenW = $derived(doc.landscape ? CARD_H : CARD_W);
  const kartenH = $derived(doc.landscape ? CARD_W : CARD_H);

  /** Erste-Seiten-Format an den Server melden — einmalig; idempotentes Command macht das race-frei. */
  function meldeFormat(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    // Nur das maßgebliche Format melden: bei Einzelseiten-Karten deren fixe Seite,
    // sonst nur Seite 1 — die Miniatur folgt sonst der zuletzt aufgeschlagenen Seite (A2.8).
    const massgeblich = doc.pageOnly !== undefined || (doc.page ?? 1) === 1;
    if (!doc.landscape && massgeblich && img.naturalWidth > img.naturalHeight) {
      void desktop.command('setDocLandscape', { id: doc.id });
    }
  }

  const kind = $derived(doc.kind ?? 'pdf');
  const dateiEndung = $derived(
    doc.name.includes('.') ? (doc.name.split('.').pop() || '?').toUpperCase().slice(0, 5) : '?',
  );

  let thumb = $state<string | null>(null);
  let imgUrl = $state<string | null>(null);
  let bildFehler = $state<string | null>(null);
  let vorschauStatus = $state<'wartet' | 'bereit' | 'fehler'>('wartet');
  let vorschauMeldung = $state<string | null>(null);

  $effect(() => {
    doc.fileId;
    doc.page; // Miniatur folgt der zuletzt aufgeschlagenen Seite (A2.8)
    const k = kind;
    if (!desktop.api) return;
    if (k === 'image') {
      imgUrl = null;
      bildFehler = null;
      void getFileUrl(desktop.api, doc.fileId, imageMime(doc.name))
        .then((u) => (imgUrl = u))
        .catch((e) => { bildFehler = e instanceof Error ? e.message : 'Laden fehlgeschlagen'; });
    } else if (k === 'convertible') {
      vorschauStatus = 'wartet';
      vorschauMeldung = null;
      getThumbnail(desktop.api, doc, 'preview')
        .then((t) => {
          thumb = t;
          vorschauStatus = t ? 'bereit' : 'fehler';
        })
        .catch((e) => {
          vorschauStatus = 'fehler';
          vorschauMeldung = e instanceof PreviewError ? e.message : null;
        });
    } else if (k !== 'other') {
      void getThumbnail(desktop.api, doc).then((t) => (thumb = t));
    }
  });
  const kartenStempel = $derived(stampsFor(desktop.state, doc.id, doc.pageOnly ?? doc.page ?? 1));
  const kartenFahnen = $derived(flagsFor(desktop.state, doc.id));
  const taped = $derived(doc.taped === true);
  // SESS-01: Klebeband und Sitzungssperre führen zum identischen Verhalten — kein Ziehen, aber
  // das Lang-Druck-Kontextmenü, das Öffnen und alle kommandoauslösenden Klicks bleiben
  // erreichbar; deshalb teilen sie sich denselben Zweig statt zweier paralleler Sperrpfade.
  const dragGesperrt = $derived(taped || kartenBewegungGesperrt());
  const geklammert = $derived(clipOf(desktop.state, doc.id) !== undefined);

  // Referenzstatus (j-lawyer-Modus): genau ein Zustand je Karte, feste Priorität
  // gone > entzogen > nicht erreichbar > ersetzt > umbenannt > archiviert (01-06 Plan) —
  // ein verwaistes/entzogenes Dokument ist nicht zugleich „neu gefasst"/„umbenannt". Annotationen
  // bleiben in allen sechs Zuständen unangetastet erhalten. Priorität + Texte kommen aus der
  // gemeinsamen Hilfsfunktion (IN-01) — dieselbe wie in DocViewer.svelte.
  const referenzstatus = $derived(referenzstatusVon(doc));
  const quelleWeg = $derived(referenzstatus?.kind === 'gone');
  const entzogen = $derived(referenzstatus?.kind === 'entzogen');
  const nichtErreichbar = $derived(referenzstatus?.kind === 'nichtErreichbar');
  const neueFassung = $derived(referenzstatus?.kind === 'neueFassung');
  const umbenannt = $derived(referenzstatus?.kind === 'umbenannt');
  const archiviert = $derived(referenzstatus?.kind === 'archiviert');
  // Erklärtext des Badges (Review-Fix): das visuelle Badge ist pointer-events:none + aria-hidden
  // (darf den Drag nicht stören) — Tooltip/Screenreader-Text wandert deshalb auf die Karte selbst
  // (.card trägt schon role="button" + aria-label + empfängt Pointer-Events regulär).
  const statusKurz = $derived(referenzstatus?.kurz ?? null);
  const statusErklaerung = $derived(referenzstatus?.erklaerung ?? null);

  // Ebenen-Chip (Task 3, dezent): kein Chip bei Kanzlei-Standard — genau ein Chip pro Objekt sonst.
  const ebenenChip = $derived(chipFuerEbene(doc.layerId, desktop.state));
  // Freigabe-Chip (03-06, EXP-03): nur bei explizitem Override zum Ebenen-Default — der
  // Normalfall bleibt clean; Volltext via title-Attribut (UI-SPEC).
  const freigabeChip = $derived(chipFuerFreigabe(doc, desktop.state));
  // Externe-Referenz-Chip (13-06, EXT-01): permanent, nicht entfernbar — DOM-Reihenfolge
  // HINTER den Bestands-Chips (13-UI-SPEC Kennzeichnungs-Vertrag).
  const externChip = $derived(chipFuerExtern(doc));

  // Bearbeitungs-/Soft-Lock-Dekoration (06-04, COLLAB-02): NUR DocCard und NoteCard erhalten
  // diese Dekoration — StackCard/CutoutCard bewusst nicht, weil deren übliche Änderungen
  // (Verschieben, Größe, Reihenfolge) bereits über die WIEDERHOLEN-Positions-Allowlist in
  // src/lib/konflikt.ts fail-safe silent-retry-fähig sind; ein Sperrhinweis böte dort keinen
  // Mehrwert, nur zusätzliches visuelles Rauschen (UI-SPEC „Komponentenkontrakt").
  // Dunkles/helles Glas: dieselbe Themenerkennung wie Desktop.svelte — hier negiert, weil
  // identityColor()s zweiter Parameter "dunkel" (dunkles Theme aktiv) erwartet, isLight() aber
  // das Gegenteil liefert.
  const dunkel = $derived(!isLight(deskBackground(desktop.state).themeId));
  // 06-03-SUMMARY: der Server schließt den eigenen Eintrag bereits aus JEDER Präsenzmeldung aus
  // — eine eigene userId ist clientseitig nirgends bekannt und wird durch den serverseitigen
  // Selbst-Ausschluss auch nicht benötigt (identisches Vorgehen wie PresenceRoster.svelte).
  const fremdeBearbeitung = $derived(personFuerObjekt(doc.id, null));

  // OCR-Qualitäts-Chip (SEARCH-03, 07-08): dokumentweite Aggregation kommt bereits fertig
  // aggregiert vom Server (ocrStatusFuerDesk, Minimum über Seiten MIT tatsächlichem OCR-Lauf) —
  // hier nur der Nachschlag über die fileId, kein eigener Aggregationsschritt.
  const ocrUnsicherChip = $derived(desktop.ocrUnsicher(doc.fileId));

  // Hervorhebungs-Markierung (VIEW-01, 11-08): Accent-Ring + 📌-Badge, reiner Client-Zustand.
  const hervorgehoben = $derived(ui.highlightedIds.has(doc.id));

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
    // TASK-01, Task 3: „Bezug zu Dokument…" wartet auf eine Dokument-/Ausschnittkarte als Ziel
    // (LegalObjectCard.svelte setzt ui.taskRefFromId) — ein Klick auf eine Dokumentkarte setzt
    // den Bezug direkt auf docId + aktuelle Seite (kein cutoutId, das ist der Ausschnitt-Pfad).
    if (ui.taskRefFromId) {
      const from = ui.taskRefFromId;
      ui.taskRefFromId = null;
      void desktop.command('setTaskDocRef', { id: from, docRef: { docId: doc.id, page: doc.page ?? 1 } });
      return;
    }
    // CALC-01, 08-07 Task 3: „+ Beleg verknüpfen" wartet auf eine Dokument-/Ausschnittkarte als
    // Ziel (TableCard.svelte setzt ui.tabelleBelegFuer) — an derselben Stelle wie taskRefFromId.
    if (ui.tabelleBelegFuer) {
      const { tableId, rowId } = ui.tabelleBelegFuer;
      ui.tabelleBelegFuer = null;
      void desktop.command('setTableRowBeleg', { tableId, rowId, belegRef: { docId: doc.id, page: doc.page ?? 1 } });
      return;
    }
    // CHRONO-01, 09-06 Task 2: „+ Eintrag" wartet auf ein Zielobjekt — gleiche Stelle wie
    // taskRefFromId/tabelleBelegFuer oben, damit kein Modus einen anderen verdeckt (Klickweg,
    // gleichwertig zum Ziehen unten in onPointerUp).
    if (ui.zeitleisteEintragFuer) {
      starteZeitleisteEintrag(ui.zeitleisteEintragFuer, doc.id);
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
    const ziel = abwurfZielFuer(e.clientX, e.clientY, doc.id);
    if (ziel.art === 'korb') {
      void desktop.command('trashObject', { id: doc.id, trashedAt: new Date().toISOString() });
      activePointer = null;
      return;
    }
    if (ziel.art === 'zeitleiste') {
      // CHRONO-01: der Eintrag ist eine Referenz, keine Verlagerung — die Position bleibt
      // unangetastet, es wird kein Verschiebe-Command gesendet (T-09-25).
      starteZeitleisteEintrag(ziel.zeitleisteId, doc.id);
      activePointer = null;
      return;
    }
    if (geklammert) { commitGroupMove(groupOf(doc.id)); activePointer = null; return; }
    const center = { x: doc.position.x + kartenW / 2, y: doc.position.y + kartenH / 2 };
    const hit = hitTest(desktop.state, center, doc.id);
    if (hit) void desktop.command('stackDocs', { draggedId: doc.id, targetId: hit.id, id: uid() });
    else void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
    activePointer = null;
  }

</script>

{#if doc.open}
  {#if lupe}
    <!-- In der Lupe: statisches Abbild statt des interaktiven Viewers (keine doppelten Effekte) -->
    <ViewerAbbild {doc} />
  {:else}
    <DocViewer {doc} {vp} />
  {/if}
{:else}
  <div class="card" class:verwaist={quelleWeg} class:wird-bearbeitet={fremdeBearbeitung !== undefined} class:hervorgehoben={hervorgehoben} role="button" tabindex="-1"
       aria-label={statusKurz ? `${doc.name} — ${statusKurz}, ${statusErklaerung}` : doc.name}
       title={statusKurz ? `${statusKurz} — ${statusErklaerung}` : undefined}
       style:left="{doc.position.x}px" style:top="{doc.position.y}px"
       style:z-index={doc.zIndex} style:transform="rotate({doc.rotation}deg)"
       style:width="{kartenW}px" style:height="{kartenH}px"
       style:--wird-bearbeitet-farbe={fremdeBearbeitung ? identityColor(fremdeBearbeitung.userId, dunkel) : undefined}
       onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
       ondblclick={() => { if (kind !== 'other') void desktop.command('expandDoc', { id: doc.id }); }}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, doc); }}>
    {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
    {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
    {#if hervorgehoben}
      <!-- 📌-Badge (VIEW-01, 11-08): oben links, nach dem Prinzip der Status-Badges — außerhalb
           der Kontur aufgesteckt, damit es nie mit dem Referenzstatus-Badge kollidiert. -->
      <div class="pin-badge" title="In Ansicht hervorgehoben">📌</div>
    {/if}
    <div class="body" class:polaroid={kind === 'image'} class:other={kind === 'other'}>
      {#if kind === 'image'}
        {#if imgUrl}
          <img class="photo" src={imgUrl} alt="" draggable="false" onload={meldeFormat} />
        {:else if bildFehler}
          <div class="fallback fehler" title={bildFehler}>⚠️</div>
        {:else}
          <div class="fallback wartend">⏳</div>
        {/if}
      {:else if kind === 'other'}
        <div class="other-icon" aria-hidden="true">📄</div>
        <div class="other-ext">{dateiEndung}</div>
      {:else if kind === 'convertible'}
        {#if vorschauStatus === 'bereit' && thumb}
          <img src={thumb} alt="" draggable="false" onload={meldeFormat} />
        {:else if vorschauStatus === 'fehler'}
          <div class="fallback fehler" title={vorschauMeldung ?? undefined}>
            ⚠️
            {#if vorschauMeldung}<span class="fehlertext">{vorschauMeldung}</span>{/if}
          </div>
        {:else}
          <div class="fallback wartend">⏳ Vorschau wird erstellt…</div>
        {/if}
      {:else if thumb}
        <img src={thumb} alt="" draggable="false" onload={meldeFormat} />
      {:else}
        <div class="fallback">PDF</div>
      {/if}
      {#each kartenStempel as st (st.id)}
        <div class="mini-stamp" class:blau={st.color === 'blue'}
             style:left="{(st.x / st.baseW) * 100}%" style:top="{(st.y / st.baseH) * 100}%"
             style:transform="translate(-50%, -50%) rotate({st.angle}deg) scale({kartenW / st.baseW})">
          {st.text}
        </div>
      {/each}
      {#if fremdeBearbeitung}
        <!-- Bearbeitungs-Pille: innerhalb von .body (nicht .card) verankert, damit die untere
             linke Ecke der Vorschaufläche belegt wird, nicht die .name-Leiste darunter, die sonst
             kollidieren würde (.body ist bereits position:relative). Zeigt nur die zuletzt aktive
             fremde Person — nie mehrere gestapelt (personFuerObjekt liefert genau einen Eintrag). -->
        <div class="bearbeitungs-pille" aria-hidden="true" title={`Wird gerade bearbeitet von ${fremdeBearbeitung.name}`}>● {vorname(fremdeBearbeitung.name)}</div>
      {/if}
      {#if ocrUnsicherChip}
        <!-- OCR-Qualitäts-Chip: vierte, bislang unbelegte Ecke von .body (unten rechts) — die
             anderen drei sind bereits vergeben: oben-links .status-badge, oben-rechts .chips,
             unten-links .bearbeitungs-pille (06-04). Rein informativ (aria-hidden,
             pointer-events:none, kein Klickverhalten), identisch zur bestehenden
             Chip-Konvention. Der title-Wortlaut benennt ausdrücklich die Folge für die Suche,
             nicht die Verlässlichkeit des Dokuments selbst (T-07-40). -->
        <div class="ocr-chip" aria-hidden="true" title="Die Texterkennung dieses Dokuments ist unsicher — Volltextsuche kann Treffer auf gescannten Seiten verpassen oder falsch zuordnen.">OCR unsicher</div>
      {/if}
    </div>
    {#if quelleWeg}
      <div class="status-badge gone" aria-hidden="true">In j-lawyer gelöscht</div>
    {:else if entzogen}
      <div class="status-badge entzogen" aria-hidden="true">Zugriff entzogen</div>
    {:else if nichtErreichbar}
      <div class="status-badge unerreichbar" aria-hidden="true">Nicht erreichbar</div>
    {:else if neueFassung}
      <div class="status-badge neu" aria-hidden="true">Neue Fassung</div>
    {:else if umbenannt}
      <div class="status-badge umbenannt" aria-hidden="true">Umbenannt</div>
    {:else if archiviert}
      <div class="status-badge archiviert" aria-hidden="true">Archiviert</div>
    {/if}
    {#if ebenenChip || freigabeChip || externChip}
      <div class="chips">
        {#if ebenenChip}
          <div class="ebenen-chip" aria-hidden="true" title={ebenenChip.label}>{ebenenChip.icon} {ebenenChip.label}</div>
        {/if}
        {#if freigabeChip}
          <div class="freigabe-chip" aria-hidden="true" title="Freigabe: {freigabeChip.label} (abweichend vom Ebenen-Standard)">{freigabeChip.icon}</div>
        {/if}
        {#if externChip}
          <!-- 13-06 (EXT-01): permanent, nicht entfernbar — kein onclick/Entfernen-Affordanz,
               fixierter title-Wortlaut aus dem Copywriting Contract. -->
          <div class="extern-chip" aria-hidden="true" title="Externe Referenz — nicht in j-lawyer abgelegt. Die Quelle liegt außerhalb der Akte.">{externChip.icon}</div>
        {/if}
      </div>
    {/if}
    <div class="name">{doc.name}</div>
    {#each kartenFahnen as fl (fl.id)}
      <div class="mini-fahne" style:top="{fl.offset * kartenH}px" style:background={fl.color}></div>
    {/each}
  </div>
{/if}

<style>
  .card { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 4px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, .35); cursor: grab; user-select: none; touch-action: none; }
  /* Quelldokument in j-lawyer nicht mehr vorhanden — Karte verwaist, bleibt aber erhalten (Muster NoteCard .erledigt). */
  .card.verwaist { opacity: .65; }
  /* Bearbeitungs-/Soft-Lock-Ring (06-04, COLLAB-02): additiver zweiter Schattenwert in der
     Identitätsfarbe der fremden Person — ersetzt den bestehenden Schlagschatten der .card-Regel
     oben NICHT, ergänzt ihn nur (additiver Zustandsmodifikator, gleiche Konvention wie
     .card.verwaist). Erscheint nie für die eigene Bearbeitung (personFuerObjekt() liefert dafür
     strukturell undefined, siehe 06-03-SUMMARY.md). */
  .card.wird-bearbeitet { box-shadow: 0 6px 18px rgba(0, 0, 0, .35), 0 0 0 2px var(--wird-bearbeitet-farbe); }
  /* Hervorhebungs-Ring (VIEW-01, 11-08): strukturell dem Bearbeitungs-Ring folgend (additiver
     Zustandsmodifikator), verwendet aber IMMER die Accent-Farbe statt einer Präsenzfarbe — die
     Hervorhebung ist personenunabhängig (UI-SPEC Color e). Als Innenschatten-Kontur 2px INNERHALB
     der Kartenkontur über ::after umgesetzt: verschiebt kein Layout und bleibt über dem
     undurchsichtigen Vorschaubild sichtbar (ein inset-Schatten direkt auf .card läge HINTER
     .body/img). */
  .card.hervorgehoben::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
                               box-shadow: inset 0 0 0 2px var(--brand-blue); pointer-events: none; }
  /* 📌-Badge: oben links AUSSERHALB der Kartenkontur aufgesteckt (Muster .klammer) — die vier
     Innen-Ecken sind belegt (status-badge, chips, bearbeitungs-pille, ocr-chip). Bewusst KEIN
     pointer-events: none — der Pflicht-Tooltip braucht den Zeigerkontakt; der Zeigerdruck
     bubbelt zur Karte und startet dort regulär den Drag. */
  .pin-badge { position: absolute; top: -10px; left: -8px; z-index: 6; font-size: 15px;
               filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
  .body { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden;
          border-radius: 4px 4px 0 0; }
  /* contain statt cover: Querformat-Seiten werden vollständig (unbeschnitten) gezeigt (UAT A1.2). */
  img { width: 100%; height: 100%; object-fit: contain; object-position: center top; background: #fff; pointer-events: none; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  .fallback.wartend { font-size: 12px; font-weight: 600; color: #666; text-align: center; padding: 0 10px; }
  .fallback.fehler { flex-direction: column; align-items: center; gap: 4px; font-size: 20px; color: #b33; }
  .fehlertext { font-size: 10px; font-weight: 500; color: #944; max-width: 92%; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
  .body.polaroid { background: #fff; box-sizing: border-box; padding: 10px 10px 22px; }
  .photo { width: 100%; height: 100%; object-fit: contain; object-position: center; pointer-events: none; }
  .body.other { background: #d9d0bb; flex-direction: column; gap: 4px; }
  .other-icon { font-size: 32px; }
  .other-ext { font-weight: 800; font-size: 15px; letter-spacing: .05em; color: #5b5540; }
  .mini-stamp { position: absolute; pointer-events: none; border: 3px solid #b3261e; color: #b3261e;
                border-radius: 6px; padding: 2px 10px; opacity: .82; font-weight: 800; letter-spacing: .12em;
                font-size: 20px; white-space: nowrap; transform-origin: center; }
  .mini-stamp.blau { border-color: #1d4ed8; color: #1d4ed8; }
  .name { padding: 4px 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          background: rgba(255, 255, 255, .9); border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
  /* Referenzstatus-Badge: unterhalb von .tape (endet bei y=12) und .klammer (endet bei y≈8),
     rechts Abstand zur Fahnenlasche (die außerhalb der Karte hängt) — pointer-events: none,
     damit sie das Drag/Lang-Druck der Karte nicht stört (Wunsch Task 4). */
  .status-badge { position: absolute; top: 14px; left: 8px; right: 26px; z-index: 5; pointer-events: none;
                   font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
                   color: #fff; padding: 2px 6px; border-radius: 4px; width: fit-content; max-width: 100%;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                   box-shadow: 0 1px 4px rgba(0, 0, 0, .35); }
  .status-badge.gone { background: rgba(122, 32, 32, .88); }
  .status-badge.neu { background: rgba(21, 92, 62, .88); }
  .status-badge.umbenannt { background: rgba(13, 74, 130, .88); }
  .status-badge.unerreichbar { background: rgba(150, 92, 10, .88); }
  .status-badge.entzogen { background: rgba(107, 30, 84, .88); }
  .status-badge.archiviert { background: rgba(70, 70, 78, .88); }
  /* Ebenen-/Freigabe-Chips (02-07/03-06, dezent — kein Accent, nur bei Abweichung vom
     Normalfall sichtbar): Gegenecke zum Referenzstatus-Badge (das links sitzt), gemeinsamer
     Flex-Container mit xs-Gap (4px), gleiches padding/pointer-events-Muster. */
  .chips { position: absolute; top: 14px; right: 8px; z-index: 5; display: flex; gap: 4px; }
  .ebenen-chip, .freigabe-chip, .extern-chip { pointer-events: none;
                 font-size: 10px; color: #333; padding: 2px 6px; border-radius: 4px; width: fit-content;
                 max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                 background: var(--glass-card-bg); border: 1px solid var(--glass-border);
                 box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
  /* Bearbeitungs-Pille: neue, bislang unbelegte untere linke Ecke von .body — Fläche/Rahmen/
     Abschneideverhalten wortgleich aus .ebenen-chip übernommen (die Ecke ist die einzige
     Abweichung), Textgröße 12px nach UI-SPEC-Typografie („Label"), nicht die 10px der Chips. */
  .bearbeitungs-pille { position: absolute; bottom: 8px; left: 8px; z-index: 5; pointer-events: none;
                         font-size: 12px; color: #333; padding: 2px 6px; border-radius: 4px; width: fit-content;
                         max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                         background: var(--glass-card-bg); border: 1px solid var(--glass-border);
                         box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
  /* OCR-Qualitäts-Chip (07-08, SEARCH-03): Fläche/Rahmen/Innenabstand/Schriftgröße/
     Abschneideverhalten wortgleich aus .ebenen-chip übernommen, nur neue Ecke (unten rechts von
     .body) und der bereits etablierte Warnton aus .status-badge.unerreichbar als Hintergrund
     (keine neue Farbe) mit weißem statt dunklem Text — dieselbe Bedeutungskategorie „technisch
     funktionsfähig, aber eingeschränkt verlässlich" wie der Referenzstatus „Nicht erreichbar". */
  .ocr-chip { position: absolute; bottom: 8px; right: 8px; z-index: 5; pointer-events: none;
              font-size: 10px; color: #fff; padding: 2px 6px; border-radius: 4px; width: fit-content;
              max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
              background: rgba(150, 92, 10, .88); border: 1px solid var(--glass-border);
              box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
  .mini-fahne { position: absolute; right: -8px; width: 16px; height: 10px; border-radius: 0 3px 3px 0;
                box-shadow: 1px 1px 2px rgba(0, 0, 0, .3); pointer-events: none; }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
</style>
