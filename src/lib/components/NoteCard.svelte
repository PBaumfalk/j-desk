<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    NOTE_W, NOTE_H, TAFEL_W, TAFEL_H, moveNote, rotationFor, clipOf, deskBackground, type Note, type Viewport,
  } from '@j-desk/core';
  import { uid } from '../uid';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { erzeugeDiktatUi } from '../diktatUi.svelte';
  import { kartenBewegungGesperrt } from '../sitzungsmodus';
  import { abwurfZielFuer, starteZeitleisteEintrag } from '../zeitleisteDrop';
  import { chipFuerExtern, showNoteMenu, showNoteMenuAt, NOTE_KIND_LABELS } from '../menus';
  import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';
  import { isLight } from '../deskThemes';
  import { bearbeitetJetzt, ruhtJetzt, personFuerObjekt } from '../presence.svelte';
  import { identityColor, vorname } from '../identityColor';

  let { note, vp }: { note: Note; vp: Viewport } = $props();

  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let activePointer: number | null = null;
  let textEl = $state<HTMLTextAreaElement | null>(null);
  /** Soft-Deterrent-Hinweis (Task 3): bauteil-lokaler Merker, damit der Toast höchstens einmal
   *  je Bearbeitungsversuch erscheint — zurückgesetzt in speichern() (Verlassen des Feldes). */
  let hinweisGezeigt = false;

  // ---- Diktat: Aufnahme mit anschließender Transkription (VOICE-01, 14-09) ----
  // Ersetzt die bisherige Live-Spracherkennung des Browsers vollständig — Aufnahme geht an die
  // eigene, authentifizierte Server-Route, niemals direkt an eine fremde Adresse. Verfügbarkeit
  // und Diktat-Zustand sind komponentenlokal (Zustand der zurückgegebenen DiktatUi-Instanz) —
  // nichts davon überlebt einen Desk-Wechsel als Fremdzustand; laufende Diktate enden mit dem
  // Bearbeiten-Modus bzw. dem Komponenten-Lebenszyklus (Verdrahtung inkl. Aufräumen gebündelt in
  // diktatUi.svelte.ts, WR-02: die drei Aufrufer NoteCard/LegalObjectCard/SitzungsmodusShell
  // teilen sich jetzt dieselbe Instanziierung statt sie wortgleich zu kopieren). Der 🎤-Button
  // fehlt ohne konfigurierte Transkription lautlos (fail-quiet, wie zuvor bei fehlender
  // Browser-Spracherkennung).
  const diktatUi = erzeugeDiktatUi({
    // Hängt den transkribierten Text an den aktuellen Feldinhalt — genau ein trennendes
    // Leerzeichen, wenn der Inhalt nicht auf Whitespace endet (unverändert aus 13-03). Der
    // editNote-Dispatch bleibt der bestehende Blur-/Änderungspfad in speichern() — das Diktat
    // schreibt nur ins Feld.
    anhaengen: (t) => {
      if (!textEl) return;
      const aktuell = textEl.value;
      const trenner = aktuell.length > 0 && !/\s$/.test(aktuell) ? ' ' : '';
      textEl.value = aktuell + trenner + t;
    },
  });

  const bearbeiten = $derived(ui.editingNoteId === note.id);
  const taped = $derived(note.taped === true);
  // SESS-01: siehe DocCard.svelte — Klebeband und Sitzungssperre teilen sich denselben Zweig.
  const dragGesperrt = $derived(taped || kartenBewegungGesperrt());
  // Hervorhebungs-Markierung (VIEW-01, 11-08): Accent-Ring + 📌-Badge, reiner Client-Zustand.
  const hervorgehoben = $derived(ui.highlightedIds.has(note.id));
  // Sitzungsnotiz-Badge (SESS-03, 11-08): aus dem persistierten Notizfeld abgeleitet.
  const istSitzungsnotiz = $derived(note.sitzungsnotiz === true);
  const geklammert = $derived(clipOf(desktop.state, note.id) !== undefined);
  // Dunkles/helles Glas: dieselbe Themenerkennung wie Desktop.svelte (class:hell auf .desk über
  // isLight(hintergrund.themeId)) — hier negiert, weil identityColor()s zweiter Parameter
  // "dunkel" (dunkles Theme aktiv) erwartet, isLight() aber das Gegenteil liefert.
  const dunkel = $derived(!isLight(deskBackground(desktop.state).themeId));
  /** 06-03-SUMMARY: der Server schließt den eigenen Eintrag bereits aus JEDER ausgelieferten
   *  Präsenzmeldung aus — eine eigene userId ist clientseitig nirgends bekannt und wird durch
   *  den serverseitigen Selbst-Ausschluss auch nicht benötigt (identisches Vorgehen wie
   *  PresenceRoster.svelte, das ebenfalls `null` übergibt). */
  const fremdeBearbeitung = $derived(personFuerObjekt(note.id, null));
  // Externe-Referenz-Chip (13-06, EXT-01): permanent, nicht entfernbar. Note besitzt keinen
  // Bestands-.chips-Container wie DocCard — Platzierung UNTEN RECHTS statt oben rechts
  // (Abweichung von der 13-UI-SPEC-Standardecke, dokumentiert im 13-06-SUMMARY): oben links
  // trägt bereits 📌/🎙 (Kollisionsregel schiebt 🎙 bei gleichzeitigem 📌 nach oben RECHTS,
  // UI-SPEC E6), unten links die Bearbeitungs-Pille — unten rechts ist die einzige Ecke ohne
  // bestehende oder kollidierende Belegung.
  const externChip = $derived(chipFuerExtern(note));
  $effect(() => {
    if (!bearbeiten) return;
    textEl?.focus();
    // Soft-Deterrent-Toast (Task 3, UI-SPEC „Soft-Deterrent-Toast"): einmalig je
    // Bearbeitungsversuch, kein Blocker — das Textfeld erhält den Fokus regulär weiter.
    if (fremdeBearbeitung && !hinweisGezeigt) {
      hinweisGezeigt = true;
      showToast(`Wird gerade von ${fremdeBearbeitung.name} bearbeitet.`);
    }
    bearbeitetJetzt(note.id);
  });
  onDestroy(() => {
    // Bauteil wird zerstört, während der Fokus noch im Textfeld liegt (z. B. Zettel gelöscht) —
    // ohne diesen Aufräumpfad bliebe das Bearbeitungssignal bis zum serverseitigen TTL-Ablauf
    // stehen, obwohl niemand mehr am Feld sitzt.
    if (bearbeiten) ruhtJetzt();
    // Ein laufendes Diktat endet mit dem Komponenten-Lebenszyklus — erzeugeDiktatUi() registriert
    // dafür bereits ein eigenes onDestroy() (WR-02, diktatUi.svelte.ts), kein zweiter Aufruf nötig.
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
    // CHRONO-01, 09-06 Task 2: „+ Eintrag" wartet auf ein Zielobjekt — gleiche Stelle wie
    // linkingFromId/clippingFromId oben (Klickweg, gleichwertig zum Ziehen unten in onPointerUp).
    if (ui.zeitleisteEintragFuer) {
      starteZeitleisteEintrag(ui.zeitleisteEintragFuer, note.id);
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
      const ziel = abwurfZielFuer(e.clientX, e.clientY, note.id);
      if (ziel.art === 'korb') {
        void desktop.command('trashObject', { id: note.id, trashedAt: new Date().toISOString() });
        activePointer = null;
        return;
      }
      if (ziel.art === 'zeitleiste') {
        // CHRONO-01: der Eintrag ist eine Referenz, keine Verlagerung — die Position bleibt
        // unangetastet, es wird kein Verschiebe-Command gesendet (T-09-25).
        starteZeitleisteEintrag(ziel.zeitleisteId, note.id);
        activePointer = null;
        return;
      }
      if (geklammert) commitGroupMove(groupOf(note.id));
      else void desktop.command('moveNote', { id: note.id, position: { x: note.position.x, y: note.position.y } });
    }
    activePointer = null;
  }

  function speichern() {
    diktatUi.beenden(); // Ende des Bearbeiten-Modus beendet ein laufendes Diktat (kein Waisen-Diktat)
    ruhtJetzt();
    hinweisGezeigt = false;
    ui.editingNoteId = null;
    const text = textEl?.value ?? '';
    if (text !== note.text) void desktop.command('editNote', { id: note.id, text });
  }
</script>

<div class="note kind-{note.kind}" class:erledigt={note.done === true} class:wird-bearbeitet={fremdeBearbeitung !== undefined}
     class:hervorgehoben={hervorgehoben}
     role="button" tabindex="-1" aria-label={note.kind === 'eigen' ? (note.customLabel ?? 'Eigener') : NOTE_KIND_LABELS[note.kind]}
     style:left="{note.position.x}px" style:top="{note.position.y}px"
     style:z-index={note.zIndex} style:transform="rotate({rotationFor(note.id)}deg)"
     style:width="{note.kind === 'tafel' ? TAFEL_W : NOTE_W}px" style:height="{note.kind === 'tafel' ? TAFEL_H : NOTE_H}px"
     style:--wird-bearbeitet-farbe={fremdeBearbeitung ? identityColor(fremdeBearbeitung.userId, dunkel) : undefined}
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
     ondblclick={() => (ui.editingNoteId = note.id)}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showNoteMenu(e, note); }}>
  {#if taped}<div class="tape" aria-hidden="true"></div>{/if}
  {#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
  {#if hervorgehoben}
    <!-- 📌-Badge (VIEW-01, 11-08): oben links, nach dem Prinzip der Status-Badges. -->
    <div class="pin-badge" title="In Ansicht hervorgehoben">📌</div>
  {/if}
  {#if istSitzungsnotiz}
    <!-- 🎙-Badge (SESS-03, 11-08): einzige Ausnahme von der Icon-plus-Text-Pflicht dieser Phase —
         die Kartenecke hat keinen Platz für Begleittext, deshalb ist der Titel-Tooltip zwingend.
         Kollisionsregel (verbindlich, UI-SPEC E6/overflow): trägt dieselbe Karte beide Badges,
         bleibt 📌 oben links und 🎙 rückt nach oben rechts — nie überlappend, nie eines
         unterdrückt. Umgesetzt über zwei getrennte Positionierungsklassen, deren Zuordnung
         allein davon abhängt, ob die Karte hervorgehoben ist. -->
    <div class="mic-badge" class:oben-rechts={hervorgehoben} title="Sitzungsnotiz">🎙</div>
  {/if}
  {#if fremdeBearbeitung}
    <!-- Bearbeitungs-Pille (Soft-Lock-Dekoration, UI-SPEC „Komponentenkontrakt"): zeigt nur die
         zuletzt aktive fremde Person (personFuerObjekt liefert genau einen Eintrag, nie mehrere
         gestapelt) — erscheint NIE für die eigene Bearbeitung. -->
    <div class="bearbeitungs-pille" aria-hidden="true" title={`Wird gerade bearbeitet von ${fremdeBearbeitung.name}`}>● {vorname(fremdeBearbeitung.name)}</div>
  {/if}
  {#if externChip}
    <!-- 🌐-Chip (13-06, EXT-01): permanent, nicht entfernbar — unten rechts (s. Kommentar an
         externChip oben), fixierter title-Wortlaut aus dem Copywriting Contract. -->
    <div class="extern-chip" aria-hidden="true" title="Externe Referenz — nicht in j-lawyer abgelegt. Die Quelle liegt außerhalb der Akte.">{externChip.icon}</div>
  {/if}
  {#if note.kind !== 'notiz' && note.kind !== 'tafel'}
    <div class="kopf">
      {#if note.kind === 'todo'}
        <button class="haken" aria-pressed={note.done === true}
                aria-label={note.done ? 'Abhaken aufheben' : 'Als erledigt abhaken'}
                onpointerdown={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
                onclick={() => void desktop.command('setNoteDone', { id: note.id, done: !(note.done === true) })}>
          {note.done ? '✓' : ''}
        </button>
      {/if}
      <div class="badge">{note.kind === 'eigen' ? (note.customLabel ?? 'Eigener') : NOTE_KIND_LABELS[note.kind]}</div>
    </div>
  {/if}
  {#if bearbeiten}
    <textarea bind:this={textEl} value={note.text} placeholder="Gedanken notieren…"
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
  .note.kind-behauptung { background: #e8d5b5; }
  .note.kind-beweisziel { background: #b8ded6; }
  .note.kind-idee { background: #f8cfe0; }
  .note.kind-todo { background: #e8e8e4; }
  .note.kind-argument { background: #c5ebe6; }
  .note.kind-rechtsfrage { background: #ddd0f0; }
  .note.kind-eigen { background: #f3ecd8; }
  /* Tafel-Text: weißer Filzstift direkt auf dem Filz — kein Papier, kein Schatten. */
  .note.kind-tafel { background: transparent; box-shadow: none; border-radius: 0; }
  .note.kind-tafel .text, .note.kind-tafel textarea {
    font-family: 'Marker Felt', 'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive;
    font-size: 26px; line-height: 1.25; color: #f8f6ef;
    text-shadow: 0 1px 3px rgba(0, 0, 0, .55), 0 0 12px rgba(0, 0, 0, .25);
  }
  .note.kind-tafel textarea { outline: 2px dashed rgba(248, 246, 239, .5); }
  .note.erledigt { opacity: .65; }
  .note.erledigt .text { text-decoration: line-through; }
  /* Bearbeitungs-/Soft-Lock-Ring (06-04, COLLAB-02): additiver zweiter Schattenwert in der
     Identitätsfarbe der fremden Person — ersetzt den bestehenden Schlagschatten der .note-Regel
     oben NICHT, ergänzt ihn nur (additiver Zustandsmodifikator, gleiche Konvention wie
     .note.erledigt). Erscheint nie für die eigene Bearbeitung (personFuerObjekt() liefert dafür
     strukturell undefined, siehe 06-03-SUMMARY.md). */
  .note.wird-bearbeitet { box-shadow: 0 6px 16px rgba(0, 0, 0, .3), 0 0 0 2px var(--wird-bearbeitet-farbe); }
  /* Hervorhebungs-Ring (VIEW-01, 11-08): strukturell dem Bearbeitungs-Ring folgend (additiver
     Zustandsmodifikator), verwendet aber IMMER die Accent-Farbe statt einer Präsenzfarbe — die
     Hervorhebung ist personenunabhängig (UI-SPEC Color e). Als Innenschatten-Kontur 2px INNERHALB
     der Kartenkontur über ::after umgesetzt: verschiebt kein Layout und bleibt über
     undurchsichtigen Kindflächen sichtbar (ein inset-Schatten direkt auf .note läge HINTER den
     Kindelementen). */
  .note.hervorgehoben::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
                               box-shadow: inset 0 0 0 2px var(--brand-blue); pointer-events: none; }
  /* 📌-/🎙-Badges: oben an den Kartenecken AUSSERHALB der Kontur aufgesteckt (Muster .klammer),
     so kollidieren sie nie mit Innen-Elementen (.kopf/.badge, .bearbeitungs-pille). Bewusst KEIN
     pointer-events: none — die Pflicht-Tooltips (kompakte Kartenecken ohne Begleittext) brauchen
     den Zeigerkontakt; der Zeigerdruck bubbelt zur Karte und startet dort regulär den Drag. */
  .pin-badge { position: absolute; top: -10px; left: -8px; z-index: 6; font-size: 15px;
               filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
  .mic-badge { position: absolute; top: -10px; left: -8px; z-index: 6; font-size: 15px;
               filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
  /* Kollisionsregel: bei gleichzeitigem 📌 rückt 🎙 nach oben rechts (siehe Markup-Kommentar). */
  .mic-badge.oben-rechts { left: auto; right: -8px; }
  /* Bearbeitungs-Pille: neue, bislang unbelegte untere linke Ecke — Fläche/Rahmen/
     Abschneideverhalten wortgleich aus DocCard.svelte .ebenen-chip übernommen (die Ecke ist die
     einzige Abweichung), Textgröße 12px nach UI-SPEC-Typografie („Label"), nicht die 10px der
     Chips. */
  .bearbeitungs-pille { position: absolute; bottom: 8px; left: 8px; z-index: 5; pointer-events: none;
                         font-size: 12px; color: #333; padding: 2px 6px; border-radius: 4px; width: fit-content;
                         max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                         background: var(--glass-card-bg); border: 1px solid var(--glass-border);
                         box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
  /* Externe-Referenz-Chip (13-06, EXT-01): unten rechts — die einzige unbelegte Ecke dieser
     Karte (oben links: 📌/🎙, oben rechts bei Kollision: 🎙, unten links: Bearbeitungs-Pille).
     Fläche/Rahmen wortgleich zur Bearbeitungs-Pille übernommen. */
  .extern-chip { position: absolute; bottom: 8px; right: 8px; z-index: 5; pointer-events: none;
                 font-size: 10px; color: #333; padding: 2px 6px; border-radius: 4px; width: fit-content;
                 background: var(--glass-card-bg); border: 1px solid var(--glass-border);
                 box-shadow: 0 1px 3px rgba(0, 0, 0, .2); }
  .kopf { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .kopf .badge { margin-bottom: 0; }
  .haken { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid rgba(0, 0, 0, .45);
           background: rgba(255, 255, 255, .5); cursor: pointer; padding: 0; font-size: 12px;
           line-height: 1; color: #1d3557; flex: none; }
  .badge { align-self: flex-start; font-size: 10px; font-weight: 700; text-transform: uppercase;
           letter-spacing: .05em; color: rgba(0, 0, 0, .55); margin-bottom: 4px;
           max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .text { flex: 1; font-size: 13px; line-height: 1.35; overflow: hidden; white-space: pre-wrap;
          overflow-wrap: break-word; color: #2a2a20; }
  textarea { flex: 1; border: none; background: transparent; resize: none; font: inherit;
             font-size: 13px; line-height: 1.35; color: #2a2a20; outline: 2px solid rgba(44, 90, 160, .5); }
  /* 🎤-Diktat-Knopf (VOICE-01, 13-03): kompakter Editor-Fuß; der aktive Zustand trägt Text
     plus Accent-Stil (Doppelkodierung, bewusst kein Rot — Rot bleibt destruktiven Aktionen
     vorbehalten) nach dem 🔒-Verschiebe-Sperre-Muster aus Phase 11 (UI-SPEC Color e). */
  .diktat-knopf { flex: none; align-self: flex-start; margin-top: 4px; padding: 2px 8px;
                  border-radius: 4px; border: 1px solid rgba(0, 0, 0, .3);
                  background: rgba(255, 255, 255, .5); font: inherit; font-size: 12px;
                  line-height: 1.35; color: #2a2a20; cursor: pointer; }
  .diktat-knopf.laeuft { background: var(--brand-blue-soft); border-color: var(--brand-blue); }
  /* Transkriptions-Zustand (14-09): gedämpft, nicht klickbar — kein neues Zeichen, Textlabel
     „Wird transkribiert …" trägt den Zustand allein (siehe Markup). */
  .diktat-knopf:disabled { opacity: .55; cursor: default; }
  .tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
          background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
  .klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
             filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
</style>
