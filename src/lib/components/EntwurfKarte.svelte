<script lang="ts">
  import { NOTE_W, NOTE_H } from '@j-desk/core';
  import type { VorschlagDto } from '../api';
  import { NOTE_KIND_LABELS } from '../menus';
  import { freigaben } from '../freigaben.svelte';
  import { ui } from '../ui.svelte';

  /**
   * EntwurfKarte (12-07, AI-01): virtuelle Tisch-Vorschau EINES ausstehenden KI-Vorschlags.
   * Entwürfe kommen bewusst aus freigaben.vorschlaege, NICHT aus dem DesktopState
   * (Register-Entscheidung A2) — sie verschwinden mit dem freigaben-Nachladen nach einer
   * Entscheidung von allein. Die Karte ist nur Vorschau; die Prüffläche ist der
   * VorschlaegeDialog (E3/long-text: die Karte kürzt wie der Bestand, der vollständige
   * Inhalt steht immer im Dialog).
   *
   * Kennzeichnung IMMER doppelt kodiert (Verwechslungsverbot, T-12-07-01): gestrichelter
   * ENTWURF_RING 2px innerhalb der Kartenkontur (kein Layout-Shift, keine neue Farbe, keine
   * Deckkraft-Änderung — die gedimmte .65-Deckkraft bleibt dem Papierkorb vorbehalten) PLUS
   * 🤖-Chip oben rechts im Bestands-.chips-Muster. Der Chip steht dort als EINZIGER Chip
   * (Entwürfe sind keine Desk-Objekte und tragen weder 📌 noch 🎙 noch OCR-Badge).
   *
   * Interaktion: Klick öffnet ausschließlich die Prüffläche (Dialog, zur Karte gescrollt/
   * hervorgehoben) — kein Drag, kein Ebenen-Umhängen, kein Kontextmenü, kein Inline-Edit,
   * kein Bearbeitungs-Einstieg irgendeiner Art („nur via Übernahme", Phase-2-Bestand).
   */

  let { vorschlag, position }: { vorschlag: VorschlagDto; position: { x: number; y: number } } = $props();

  /** Knappe Vorschau je art (12-UI-SPEC Entwurfsobjekt-Kontrakt): bei addNote/editNote der
   *  Notiztext wie eine Notiz-Karte, sonst die Zusammenfassung als Kartenzeile. */
  const notizText = $derived.by((): string | null => {
    if (vorschlag.art !== 'addNote' && vorschlag.art !== 'editNote') return null;
    const text = vorschlag.payload.text;
    return typeof text === 'string' ? text : null;
  });

  /** Notiz-Kind für das kleine Kopf-Badge der notizartigen Vorschau (Bestandskonvention
   *  NoteCard.svelte: Badge nur bei kind ≠ 'notiz'). */
  const notizKind = $derived(typeof vorschlag.payload.kind === 'string' ? vorschlag.payload.kind : 'notiz');
  const kindBadge = $derived(
    notizText !== null && notizKind !== 'notiz'
      ? (NOTE_KIND_LABELS[notizKind as keyof typeof NOTE_KIND_LABELS] ?? notizKind)
      : null,
  );

  /** Der einzige Interaktionsweg (Klick): öffnet die Prüffläche und setzt das Scrollziel —
   *  der Dialog scrollt zur Karte und hebt sie hervor (12-07 Task 1). */
  function oeffnePruefflaeche(): void {
    freigaben.fokussierterVorschlagId = vorschlag.id;
    ui.vorschlaegeOffen = true;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -- pointer-only Kartenklick wie
     NoteCard.svelte (tabindex="-1", der Tisch ist eine Zeigerfläche); die Prüfhandlung selbst
     ist im VorschlaegeDialog vollständig tastaturbedienbar (Fokusfalle). -->
<div
  class="entwurf entwurfRing" class:notizartig={notizText !== null}
  role="button" tabindex="-1" aria-label="KI-Vorschlag prüfen"
  style:left="{position.x}px" style:top="{position.y}px"
  style:width="{NOTE_W}px" style:height="{NOTE_H}px"
  onpointerdown={(e) => e.stopPropagation()}
  onclick={oeffnePruefflaeche}
  ondblclick={(e) => e.stopPropagation()}
  oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
>
  <!-- 🤖-Chip im Bestands-.chips-Muster (oben rechts, xs-Gap) — als einziger Chip der Karte.
       Bewusst MIT Zeigerkontakt: der Pflicht-Tooltip (kompakte Kartenecke ohne Begleittext)
       braucht den Hover, Konvention der 📌/🎙-Badges aus Phase 11. -->
  <div class="chips">
    <div class="ki-chip" title="KI-Vorschlag — noch nicht wirksam. Zur Prüfung: 🤖 KI-Freigaben öffnen.">🤖</div>
  </div>
  {#if kindBadge}
    <div class="badge">{kindBadge}</div>
  {/if}
  {#if notizText !== null}
    <div class="text">{notizText}</div>
  {:else}
    <div class="zusammenfassung">{vorschlag.zusammenfassung}</div>
  {/if}
</div>

<style>
  /* Kartenbasis: Maße/Polster/Schatten der Notiz-Karte (NOTE_W×NOTE_H aus @j-desk/core) auf
     Glass-Sekundärfläche; notizartige Vorschau (addNote/editNote) trägt das Notiz-Gelb des
     Bestands, damit die Vorschau wie eine Notiz-Karte liest. */
  .entwurf {
    position: absolute; display: flex; flex-direction: column; padding: 10px 12px;
    background: var(--glass-card-bg); border: 1px solid var(--glass-border); border-radius: 4px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, .3); cursor: pointer; user-select: none; touch-action: none;
    z-index: 1;
  }
  .entwurf.notizartig { background: #fbf0a8; }
  /* ENTWURF_RING (12-UI-SPEC): 2px gestrichelt in var(--glass-border)-Ton, liegt 2px INNERHALB
     der Kartenkontur (negativer outline-offset) — kein Layout-Shift, keine neue Farbe, kein
     Accent-Blau (das ist aktiven Zuständen vorbehalten). „Gestrichelt = noch nicht wirksam"
     ist die einzige neue visuelle Vokabel dieser Phase und steht nie allein (Doppelkodierung
     mit dem 🤖-Chip). */
  .entwurfRing { outline: 2px dashed var(--glass-border); outline-offset: -2px; }
  /* Chips-Container: Werte wortgleich aus DocCard.svelte .chips (oben rechts, xs-Gap 4px). */
  .chips { position: absolute; top: 14px; right: 8px; z-index: 5; display: flex; gap: 4px; }
  /* 🤖-Chip: Bestands-Chip-Optik aus Phase 2 (var(--glass-card-bg), 1px solid
     var(--glass-border)) — gleiche Fläche/Rahmen/Innenabstand wie .ebenen-chip in DocCard. */
  .ki-chip {
    font-size: 10px; color: #333; padding: 2px 6px; border-radius: 4px; width: fit-content;
    background: var(--glass-card-bg); border: 1px solid var(--glass-border);
    box-shadow: 0 1px 3px rgba(0, 0, 0, .2);
  }
  /* Kind-Badge der notizartigen Vorschau: Stil wortgleich aus NoteCard.svelte .badge. */
  .badge { align-self: flex-start; font-size: 10px; font-weight: 700; text-transform: uppercase;
           letter-spacing: .05em; color: rgba(0, 0, 0, .55); margin-bottom: 4px;
           max-width: 100%; overflow: hidden; white-space: nowrap; }
  /* Vorschautext: kürzt wie der Bestand (overflow: hidden, NoteCard .text) — der vollständige
     Inhalt steht immer im Dialog (Karte = Vorschau, Dialog = Prüffläche). */
  .text { flex: 1; font-size: 13px; line-height: 1.35; overflow: hidden; white-space: pre-wrap;
          overflow-wrap: break-word; color: #2a2a20; }
  .zusammenfassung { flex: 1; font-size: 13px; line-height: 1.35; overflow: hidden;
                     overflow-wrap: break-word; }
</style>
