<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    moveLegalObject, rotationFor, clipOf, deskBackground, legalObjectBox, istUeberfaellig,
    type LegalObject, type Viewport,
  } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { erzeugeDiktatUi } from '../diktatUi.svelte';
  import { kartenBewegungGesperrt } from '../sitzungsmodus';
  import { abwurfZielFuer, starteZeitleisteEintrag } from '../zeitleisteDrop';
  import {
    showLegalObjectMenu, showLegalObjectMenuAt, LEGAL_OBJECT_KIND_LABELS,
    TASK_PRIORITY_LABELS, TASK_STATUS_LABELS,
  } from '../menus';
  import { fundstelleAusTaskDocRef } from '../jump';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import { bearbeitetJetzt, ruhtJetzt, personFuerObjekt } from '../presence.svelte';
  import { identityColor, vorname } from '../identityColor';
  import { isLight } from '../deskThemes';

  let { obj, vp }: { obj: LegalObject; vp: Viewport } = $props();

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;
  let textEl = $state<HTMLTextAreaElement | null>(null);
  /** Soft-Deterrent-Hinweis: bauteil-lokaler Merker, höchstens einmal je Bearbeitungsversuch
   *  (identisches Muster zu NoteCard.svelte), zurückgesetzt in speichern(). */
  let hinweisGezeigt = false;

  // ---- Diktat: Aufnahme mit anschließender Transkription (VOICE-01, 14-09) ----
  // Ersetzt die bisherige Live-Spracherkennung des Browsers vollständig; laufende Diktate enden
  // mit dem Bearbeiten-Modus bzw. dem Komponenten-Lebenszyklus (Verdrahtung inkl. Aufräumen
  // gebündelt in diktatUi.svelte.ts, WR-02: dieselbe Instanziierung wie NoteCard.svelte/
  // SitzungsmodusShell.svelte). Der 🎤-Button hängt am Textfeld der Karte (obj.text — das einzige
  // inline editierbare Textfeld; Titel/Verantwortliche/Fälligkeit werden über das Kontextmenü
  // gepflegt) und fehlt ohne konfigurierte Transkription lautlos (fail-quiet).
  const diktatUi = erzeugeDiktatUi({
    // Hängt den transkribierten Text an den aktuellen Feldinhalt — genau ein trennendes
    // Leerzeichen, wenn der Inhalt nicht auf Whitespace endet (unverändert aus 13-03). Der
    // editLegalObject-Dispatch bleibt der bestehende Blur-/Änderungspfad in speichern() — das
    // Diktat schreibt nur ins Feld.
    anhaengen: (t) => {
      if (!textEl) return;
      const aktuell = textEl.value;
      const trenner = aktuell.length > 0 && !/\s$/.test(aktuell) ? ' ' : '';
      textEl.value = aktuell + trenner + t;
    },
  });

  const bearbeiten = $derived(ui.editingLegalObjectId === obj.id);
  const taped = $derived(obj.taped === true);
  // SESS-01: siehe DocCard.svelte — Klebeband und Sitzungssperre teilen sich denselben Zweig.
  const dragGesperrt = $derived(taped || kartenBewegungGesperrt());
  // Hervorhebungs-Markierung (VIEW-01, 11-08): Accent-Ring + 📌-Badge, reiner Client-Zustand.
  const hervorgehoben = $derived(ui.highlightedIds.has(obj.id));
  const geklammert = $derived(clipOf(desktop.state, obj.id) !== undefined);
  const dunkel = $derived(!isLight(deskBackground(desktop.state).themeId));
  const fremdeBearbeitung = $derived(personFuerObjekt(obj.id, null));
  // TASK-01: Kartengröße kommt aus legalObjectBox() — Aufgaben belegen automatisch die
  // größere Sondergröße (AUFGABE_W/AUFGABE_H), alle übrigen zwölf Typen LEGAL_W/LEGAL_H.
  const box = $derived(legalObjectBox(obj));
  const ueberfaellig = $derived(obj.kind === 'aufgabe' && istUeberfaellig(obj, new Date().toISOString()));

  /** Fälligkeit in deutscher Punktschreibweise (TT.MM.JJJJ) — gleiches toLocaleDateString-Muster
   *  wie tag()/uhrzeit() in zeitformat.ts (dort mit Heute/Gestern-Kurzform, hier bewusst ohne:
   *  eine Fälligkeit soll immer das konkrete Datum zeigen, nie eine relative Kurzform). */
  function formatFaelligkeit(dueDate: string): string {
    return new Date(dueDate).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  $effect(() => {
    if (!bearbeiten) return;
    textEl?.focus();
    if (fremdeBearbeitung && !hinweisGezeigt) {
      hinweisGezeigt = true;
      showToast(`Wird gerade von ${fremdeBearbeitung.name} bearbeitet.`);
    }
    bearbeitetJetzt(obj.id);
  });
  onDestroy(() => {
    if (bearbeiten) ruhtJetzt();
    // Ein laufendes Diktat endet mit dem Komponenten-Lebenszyklus — erzeugeDiktatUi() registriert
    // dafür bereits ein eigenes onDestroy() (WR-02, diktatUi.svelte.ts), kein zweiter Aufruf nötig.
  });

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (ui.deskPointers > 0) return; // Desk pannt bereits — Finger tritt dem Pinch bei
    if (bearbeiten) { e.stopPropagation(); return; } // im Bearbeiten-Modus nicht ziehen
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== obj.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: obj.id, id: uid() });
      return;
    }
    if (ui.linkingFromId === obj.id) { ui.linkingFromId = null; return; }
    if (ui.clippingFromId && ui.clippingFromId !== obj.id) {
      const from = ui.clippingFromId;
      ui.clippingFromId = null;
      desktop.command('addClip', { aId: from, bId: obj.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
      return;
    }
    if (ui.clippingFromId === obj.id) { ui.clippingFromId = null; return; }
    // TASK-01, Task 3: „Bezug zu Dokument…" wartet auf eine Dokument-/Ausschnittkarte als Ziel
    // (DocCard.svelte/CutoutCard.svelte lösen den Modus auf) — ein erneuter Klick auf die
    // Aufgabe selbst bricht die Auswahl ab, gleiches Muster wie linkingFromId/clippingFromId.
    if (ui.taskRefFromId === obj.id) { ui.taskRefFromId = null; return; }
    // CHRONO-01, 09-06 Task 2: „+ Eintrag" wartet auf ein Zielobjekt — gleiche Stelle wie
    // taskRefFromId oben (Klickweg, gleichwertig zum Ziehen unten in onPointerUp).
    if (ui.zeitleisteEintragFuer) {
      starteZeitleisteEintrag(ui.zeitleisteEintragFuer, obj.id);
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
        pressTimer = setTimeout(() => { showLegalObjectMenuAt(last.x + 16, last.y + 12, obj); }, 500);
      }
      return;
    }
    if (activePointer !== null && (e.currentTarget as HTMLElement).hasPointerCapture(activePointer)) return;
    activePointer = e.pointerId;
    dragging = true;
    moved = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: obj.id });
    clearTimeout(pressTimer);
    pressTimer = undefined;
    if (e.pointerType !== 'mouse') {
      pressTimer = setTimeout(() => { dragging = false; showLegalObjectMenuAt(last.x + 16, last.y + 12, obj); }, 500);
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
    if (geklammert) moveGroupLocal(groupOf(obj.id), dx, dy);
    else desktop.applyLocal((s) => moveLegalObject(s, obj.id, { x: obj.position.x + dx, y: obj.position.y + dy }));
  }
  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activePointer) return;
    clearTimeout(pressTimer); pressTimer = undefined;
    if (!dragging) { activePointer = null; return; }
    dragging = false;
    if (moved) {
      const ziel = abwurfZielFuer(e.clientX, e.clientY, obj.id);
      if (ziel.art === 'korb') {
        void desktop.command('trashObject', { id: obj.id, trashedAt: new Date().toISOString() });
        activePointer = null;
        return;
      }
      if (ziel.art === 'zeitleiste') {
        // CHRONO-01: der Eintrag ist eine Referenz, keine Verlagerung — die Position bleibt
        // unangetastet, es wird kein Verschiebe-Command gesendet (T-09-25).
        starteZeitleisteEintrag(ziel.zeitleisteId, obj.id);
        activePointer = null;
        return;
      }
      if (geklammert) commitGroupMove(groupOf(obj.id));
      else void desktop.command('moveLegalObject', { id: obj.id, position: { x: obj.position.x, y: obj.position.y } });
    }
    activePointer = null;
  }

  function speichern() {
    diktatUi.beenden(); // Ende des Bearbeiten-Modus beendet ein laufendes Diktat (kein Waisen-Diktat)
    ruhtJetzt();
    hinweisGezeigt = false;
    ui.editingLegalObjectId = null;
    const text = textEl?.value ?? '';
    if (text !== obj.text) void desktop.command('editLegalObject', { id: obj.id, text });
  }
</script>

<div class="legal kind-{obj.kind}" class:wird-bearbeitet={fremdeBearbeitung !== undefined}
     class:hervorgehoben={hervorgehoben}
     role="button" tabindex="-1" aria-label={LEGAL_OBJECT_KIND_LABELS[obj.kind]}
     style:left="{obj.position.x}px" style:top="{obj.position.y}px"
     style:z-index={obj.zIndex} style:transform="rotate({rotationFor(obj.id)}deg)"
     style:width="{box.w}px" style:height="{box.h}px"
     style:--wird-bearbeitet-farbe={fremdeBearbeitung ? identityColor(fremdeBearbeitung.userId, dunkel) : undefined}
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
     ondblclick={() => (ui.editingLegalObjectId = obj.id)}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showLegalObjectMenu(e, obj); }}>
  {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
  {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
  {#if hervorgehoben}
    <!-- 📌-Badge (VIEW-01, 11-08): oben links, nach dem Prinzip der Status-Badges. -->
    <div class="pin-badge" title="In Ansicht hervorgehoben">📌</div>
  {/if}
  {#if fremdeBearbeitung}
    <div class="bearbeitungs-pille" aria-hidden="true" title={`Wird gerade bearbeitet von ${fremdeBearbeitung.name}`}>● {vorname(fremdeBearbeitung.name)}</div>
  {/if}
  <div class="kopf">
    {#if obj.kind === 'aufgabe' && obj.priority}
      <div class="prioritaet-punkt prioritaet-{obj.priority}" aria-hidden="true"
           title="Priorität: {TASK_PRIORITY_LABELS[obj.priority]}"></div>
    {/if}
    <div class="badge">{LEGAL_OBJECT_KIND_LABELS[obj.kind]}</div>
    {#if obj.kind === 'aufgabe' && obj.status && obj.status !== 'offen'}
      <div class="status-badge status-{obj.status}" aria-hidden="true">{TASK_STATUS_LABELS[obj.status]}</div>
    {/if}
  </div>
  {#if bearbeiten}
    <textarea bind:this={textEl} value={obj.text} placeholder="Text…"
              onblur={speichern}
              onkeydown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); speichern(); } e.stopPropagation(); }}
              onpointerdown={(e) => e.stopPropagation()}></textarea>
    {#if diktatUi.verfuegbar}
      <!-- 🎤 Diktieren (VOICE-01, 14-09): fail-quiet gerendert — ohne konfigurierte
           Transkription fehlt der Button lautlos (kein Hinweis im Negativfall, Lärm-Regel).
           pointerdown/mousedown-Default wird unterdrückt, damit der Klick NICHT den Fokus aus
           der textarea nimmt (sonst würde onblur → speichern den Bearbeiten-Modus beenden). -->
      <button type="button" class="diktat-knopf" class:laeuft={diktatUi.zustand === 'aufnahme'}
              aria-pressed={diktatUi.zustand === 'aufnahme'}
              aria-busy={diktatUi.zustand === 'transkription'}
              disabled={diktatUi.zustand === 'transkription'}
              onpointerdown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onmousedown={(e) => e.preventDefault()}
              onclick={(e) => { e.stopPropagation(); diktatUi.startenStoppen(); }}>
        {diktatUi.zustand === 'aufnahme'
          ? `■ Aufnahme läuft · ${diktatUi.laufzeit()} — Tippen zum Beenden`
          : diktatUi.zustand === 'transkription' ? 'Wird transkribiert …' : '🎤 Diktieren'}
      </button>
    {/if}
  {:else}
    <div class="text">{obj.text}</div>
  {/if}
  {#if obj.kind === 'aufgabe' && (obj.assignee || obj.dueDate || obj.docRef)}
    <!-- Aufgaben-Metazeile (08-UI-SPEC.md Copywriting Contract): jedes Segment nur, wenn
         sein Feld gesetzt ist — fehlt der Verantwortliche, entfällt der „→ {Name}"-Teil
         restlos statt eines Platzhalters (Fail-honest-Prinzip). Der Bezugs-Chip (Task 3) ist
         eine dritte, unabhängige Ergänzung — derselbe Sprungpfad wie „Zum Bezug springen" im
         Kontextmenü (jump.ts fundstelleAusTaskDocRef, kein zweiter Mechanismus). -->
    <div class="meta-zeile">
      {#if obj.assignee}
        <span class="zugewiesen" title={obj.assignee}>→ {obj.assignee}</span>
      {/if}
      {#if obj.assignee && (obj.dueDate || obj.docRef)}<span class="trenner"> · </span>{/if}
      {#if obj.dueDate}
        <span class="faellig-pille" class:ueberfaellig={ueberfaellig}>Fällig {formatFaelligkeit(obj.dueDate)}</span>
      {/if}
      {#if obj.dueDate && obj.docRef}<span class="trenner"> · </span>{/if}
      {#if obj.docRef}
        <button type="button" class="bezug-chip" title="Zum Bezug springen"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => void desktop.jumpTo(fundstelleAusTaskDocRef(desktop.state, obj.docRef!))}>Bezug</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .legal { position: absolute; display: flex; flex-direction: column; padding: 10px 12px;
           background: #e8e8e4; border-radius: 2px; cursor: grab; user-select: none; touch-action: none;
           box-shadow: 0 6px 16px rgba(0, 0, 0, .3); }
  /* Juristische Objekttyp-Palette (LEGAL-01, 08-UI-SPEC.md): 13 Pastellfarben, eine je Typ.
     Die .badge-Zeile bleibt für ALLE 13 Typen sichtbar (kein Ausblendzweig wie bei
     notiz/tafel in NoteCard.svelte) — bei einem strukturierten juristischen Objekt ist der
     Typname nie optional, damit Farbfehlsichtigkeit die Bedeutung nicht verliert. */
  .legal.kind-tatsache { background: #dbe6f0; }
  .legal.kind-eigene-behauptung { background: #e8d5b5; }
  .legal.kind-behauptung-gegenseite { background: #e0c9d6; }
  .legal.kind-beweismittel { background: #b8ded6; }
  .legal.kind-gegenbeweis { background: #f0b8a8; }
  .legal.kind-rechtsfrage { background: #ddd0f0; }
  .legal.kind-tatbestandsmerkmal { background: #c9d4f0; }
  .legal.kind-einwendung { background: #f0dca0; }
  .legal.kind-risiko { background: #ffc4c4; }
  .legal.kind-frist { background: #ffcf8f; }
  .legal.kind-aufgabe { background: #d7e0ea; }
  .legal.kind-fundstelle-zitierfaehig { background: #efe6c9; }
  .legal.kind-ergebnis { background: #c6e6b8; }
  /* Bearbeitungs-/Soft-Lock-Ring (Phase 6, COLLAB-02) — wortgleich aus NoteCard.svelte
     übernommen: additiver zweiter Schattenwert in der Identitätsfarbe der fremden Person. */
  .legal.wird-bearbeitet { box-shadow: 0 6px 16px rgba(0, 0, 0, .3), 0 0 0 2px var(--wird-bearbeitet-farbe); }
  /* Hervorhebungs-Ring (VIEW-01, 11-08): strukturell dem Bearbeitungs-Ring folgend (additiver
     Zustandsmodifikator), verwendet aber IMMER die Accent-Farbe statt einer Präsenzfarbe — die
     Hervorhebung ist personenunabhängig (UI-SPEC Color e). Als Innenschatten-Kontur 2px INNERHALB
     der Kartenkontur über ::after umgesetzt: verschiebt kein Layout und bleibt über
     undurchsichtigen Kindflächen sichtbar (ein inset-Schatten direkt auf .legal läge HINTER den
     Kindelementen). */
  .legal.hervorgehoben::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
                                box-shadow: inset 0 0 0 2px var(--brand-blue); pointer-events: none; }
  /* 📌-Badge: oben links AUSSERHALB der Kartenkontur aufgesteckt (Muster .klammer), so kollidiert
     es nie mit Kopfzeile oder Bearbeitungs-Pille. Bewusst KEIN pointer-events: none — der
     Pflicht-Tooltip braucht den Zeigerkontakt; der Zeigerdruck bubbelt zur Karte und startet
     dort regulär den Drag. */
  .pin-badge { position: absolute; top: -10px; left: -8px; z-index: 6; font-size: 15px;
               filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
  .bearbeitungs-pille { position: absolute; bottom: 8px; left: 8px; z-index: 5; pointer-events: none;
                         font-size: 12px; color: #333; padding: 2px 6px; border-radius: 4px; width: fit-content;
                         max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                         background: var(--glass-card-bg); border: 1px solid var(--glass-border);
                         box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
  .kopf { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .kopf .badge { margin-bottom: 0; }
  .badge { align-self: flex-start; font-size: 10px; font-weight: 700; text-transform: uppercase;
           letter-spacing: .05em; color: rgba(0, 0, 0, .55); margin-bottom: 4px;
           max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Aufgaben-Kopfzeile (TASK-01, 08-UI-SPEC.md): Prioritäts-Punkt links vor dem Typ-Badge
     (xs-Abstand 4px, reiner Farbpunkt ohne Text — die Bedeutung steht ausschließlich im
     title-Attribut, damit Farbe nie die alleinige Kodierung ist), Status-Badge rechtsbündig
     in derselben Zeile (Offen zeigt kein Badge — kein-Badge-im-Normalfall-Muster). */
  .prioritaet-punkt { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-right: 4px; }
  .prioritaet-punkt.prioritaet-hoch { background: #d9484f; }
  .prioritaet-punkt.prioritaet-mittel { background: #e8a33d; }
  .prioritaet-punkt.prioritaet-niedrig { background: #8fa8bd; }
  .status-badge { margin-left: auto; font-size: 10px; font-weight: 700; text-transform: uppercase;
                   letter-spacing: .05em; color: #fff; padding: 2px 8px; border-radius: 4px;
                   white-space: nowrap; flex-shrink: 0; }
  .status-badge.status-in-arbeit { background: rgba(13, 74, 130, .88); }
  .status-badge.status-erledigt { background: rgba(21, 92, 62, .88); }
  .status-badge.status-uebergeben { background: rgba(70, 70, 78, .88); }
  .text { flex: 1; font-size: 13px; line-height: 1.35; overflow: hidden; white-space: pre-wrap;
          overflow-wrap: break-word; color: #2a2a20; }
  /* Aufgaben-Metazeile (Fußzeile, TASK-01): 12px, Bestandsstil identisch zur Suchtreffer-
     Metazeile aus Phase 7 (07-UI-SPEC.md). Das Assignee-Segment kürzt lange Namen mit
     Ellipsis + title (Muster ShareDialog.svelte .name). Die Fälligkeits-Pille trägt die
     neutrale Chip-Optik von .ebenen-chip und wechselt nur bei istUeberfaellig()===true auf
     den Warnton — dieselbe Farbe wie DocCard.svelte .status-badge.unerreichbar. */
  .meta-zeile { display: flex; align-items: center; min-width: 0; margin-top: 4px;
                font-size: 12px; color: var(--glass-text-secondary); }
  .zugewiesen { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .trenner { flex-shrink: 0; white-space: pre; }
  .faellig-pille { flex-shrink: 0; padding: 2px 8px; border-radius: 4px;
                    background: var(--glass-card-bg); border: 1px solid var(--glass-border); }
  .faellig-pille.ueberfaellig { background: rgba(150, 92, 10, .88); border-color: transparent; color: #fff; }
  /* Bezugs-Chip (Task 3): klickbar, springt zur Fundstelle (derselbe Pfad wie „Zum Bezug
     springen" im Kontextmenü) — optisch wie .faellig-pille, aber als <button> mit Cursor. */
  .bezug-chip { flex-shrink: 0; padding: 2px 8px; border-radius: 4px; font: inherit; font-size: 12px;
                color: var(--glass-text-secondary); cursor: pointer;
                background: var(--glass-card-bg); border: 1px solid var(--glass-border); }
  .bezug-chip:hover { background: var(--glass-hover); }
  textarea { flex: 1; border: none; background: transparent; resize: none; font: inherit;
             font-size: 13px; line-height: 1.35; color: #2a2a20; outline: 2px solid rgba(44, 90, 160, .5); }
  /* 🎤-Diktat-Knopf (VOICE-01, 14-09): wortgleich zu NoteCard.svelte — kompakter Editor-Fuß,
     aktiver Zustand mit Text plus Accent-Stil (Doppelkodierung, bewusst kein Rot). */
  .diktat-knopf { flex: none; align-self: flex-start; margin-top: 4px; padding: 2px 8px;
                  border-radius: 4px; border: 1px solid rgba(0, 0, 0, .3);
                  background: rgba(255, 255, 255, .5); font: inherit; font-size: 12px;
                  line-height: 1.35; color: #2a2a20; cursor: pointer; }
  .diktat-knopf.laeuft { background: var(--brand-blue-soft); border-color: var(--brand-blue); }
  /* Transkriptions-Zustand (14-09): gedämpft, nicht klickbar — kein neues Zeichen. */
  .diktat-knopf:disabled { opacity: .55; cursor: default; }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
</style>
