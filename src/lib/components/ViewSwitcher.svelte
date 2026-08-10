<script lang="ts">
  /**
   * Ansichten-Umschalter (VIEW-01, 11-08): „aktueller Zustand + Liste + Umschalten" — strukturell
   * 1:1 vom Ebenen-Umschalter in Desktop.svelte übernommen (UI-SPEC Komponentenkontrakt), nur der
   * Inhalt (gespeicherte Ansichten statt Ebenen) ist neu. Die Rechenlogik kommt vollständig aus
   * views.ts (11-02); diese Komponente ist die dünne Bedienschale darüber.
   *
   * vp/suchText/sucheOffen liegen komponentenlokal in Desktop.svelte und sind über den Store NICHT
   * erreichbar (11-RESEARCH.md Pitfall 1) — deshalb bindbare Eigenschaften, kein Store-Zugriff.
   */
  import type { Viewport } from '@j-desk/core';
  import { desktop, resetVisibleLayers } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { uid } from '../uid';
  import {
    leseAnsichten, ansichtSpeichern, ansichtEntfernen, sortiereAnsichten, planeAnsichtAnwendung,
    ANSICHT_NAME_MAX, type Ansicht,
  } from '../views';
  import { aufzeichnen, labelFuer, type VerlaufEintrag } from '../verlauf';

  let {
    vp = $bindable(),
    suchText = $bindable(),
    sucheOffen = $bindable(),
    offen = $bindable(false),
    deskId,
  }: {
    vp: Viewport;
    suchText: string;
    sucheOffen: boolean;
    offen?: boolean;
    deskId: string | null;
  } = $props();

  /** Dropdown-Breite (11-UI-SPEC.md Spacing Exceptions): etwas breiter als das Ebenen-Dropdown
   *  (min-width 220px), weil jede Zeile zusätzlich die 12px-Metazeile „zuletzt aktualisiert …"
   *  trägt. Kein Spacing-Token, sondern eine feste Layoutkonstante wie CARD_W/CARD_H im Bestand. */
  const ANSICHTEN_MENU_W = 260;

  let ansichten = $state<Ansicht[]>([]);
  let eingabeOffen = $state(false);
  let neuerName = $state('');
  let eingabeEl = $state<HTMLInputElement | null>(null);
  /** Zuletzt angewendete Ansicht — trägt die Accent-Markierung (.item.aktiv, Muster Ebenen-Umschalter). */
  let zuletztAngewendetId = $state<string | null>(null);

  /** Öffnen/Schließen. E1/loading: es gibt keinen Ladezustand — die Liste wird beim Öffnen
   *  synchron aus localStorage gelesen, niemals erst beim Aufklappen nachgeladen. */
  function umschalten(): void {
    if (!offen) ansichten = sortiereAnsichten(leseAnsichten(deskId ?? ''));
    offen = !offen;
    if (!offen) zuruecksetzen();
  }

  function zuruecksetzen(): void {
    eingabeOffen = false;
    neuerName = '';
  }

  function schliessen(): void {
    offen = false;
    zuruecksetzen();
  }

  $effect(() => {
    if (eingabeOffen) eingabeEl?.focus();
  });

  function starteEingabe(): void {
    neuerName = '';
    eingabeOffen = true;
  }

  /** Sichert den AKTUELLEN Zustand (Position/Zoom, sichtbare Ebenen, Suchbegriff, Hervorhebungen,
   *  geöffnete Dokumente) unter dem eingegebenen Namen — Read-Modify-Write in views.ts, ein
   *  gleichnamiger Eintrag wird dabei ersetzt statt dupliziert. */
  function speichern(): void {
    if (!deskId) return;
    const name = neuerName.trim();
    zuruecksetzen();
    if (name === '') return; // leerer Name legt keine Ansicht an — still verwerfen
    ansichten = ansichtSpeichern(deskId, name, {
      vp: { x: vp.x, y: vp.y, scale: vp.scale },
      visibleLayers: [...desktop.visibleLayers],
      suchText: sucheOffen ? suchText : '',
      highlightedIds: [...ui.highlightedIds],
      openDocIds: desktop.state.docs.filter((d) => d.open === true).map((d) => d.id),
    }, new Date().toISOString(), uid());
  }

  /** Entfernt eine Ansicht sofort — bewusst OHNE Rückfrage (Copywriting Contract: kein
   *  Bestätigungsdialog, reversibel durch erneutes Speichern). */
  function entfernen(a: Ansicht): void {
    if (!deskId) return;
    ansichten = ansichtEntfernen(deskId, a.id);
    if (zuletztAngewendetId === a.id) zuletztAngewendetId = null;
  }

  /** Wendet eine Ansicht an. Fail-honest (kein Alles-oder-nichts): alle auflösbaren Bestandteile
   *  greifen, fehlende Dokumente werden ausgelassen und per Toast gemeldet. */
  function anwenden(a: Ansicht): void {
    const plan = planeAnsichtAnwendung(desktop.state, a);
    // Weltausschnitt direkt zuweisen — KEIN Animationsübergang, wie jeder bestehende Sprung- und
    // Zentriermechanismus im Bestand (springeZuBox, Pfeilpad).
    vp = plan.vp;
    // Ebenensichtbarkeit wiederherstellen: erst alles sichtbar, dann gezielt ausblenden, was die
    // Ansicht nicht enthält. Reiner clientseitiger Anzeigefilter über bereits serverseitig
    // projizierte Daten — keine Sicherheitsgrenze (T-11-08, filterByVisibleLayers-Kommentar);
    // unbekannte Ebenen-ids hat planeAnsichtAnwendung bereits verworfen.
    resetVisibleLayers();
    const zielEbenen = new Set(plan.visibleLayers);
    for (const id of desktop.visibleLayers) if (!zielEbenen.has(id)) desktop.toggleLayerVisibility(id);
    // Suchbegriff setzen; das Suchpanel öffnet nur bei nicht leerem Begriff (E1, Copywriting).
    suchText = plan.suchText;
    sucheOffen = plan.suchText !== '';
    // Hervorhebungen ersetzen (neue Set-Instanz aus dem Plan — keine Mutation, Reaktivität sicher).
    ui.highlightedIds = plan.highlightedIds;
    // Referenzierte Dokumente über den bestehenden Öffnen-Mechanismus je Karte aufschlagen
    // (bereits geöffnete und nicht mehr vorhandene sind im Plan bereits ausgeschlossen).
    for (const docId of plan.zuOeffnendeDocIds) void desktop.command('expandDoc', { id: docId });
    if (plan.fehlendeDocs > 0) {
      showToast(`${plan.fehlendeDocs} Dokument(e) aus dieser Ansicht sind nicht mehr vorhanden.`);
    }
    // Positions-Verlauf (UX-03, 13-05 Task 1): Ansicht-Anwendung ist einer der vier Auslöser
    // (Muster jump.ts::zeichneFundstelleAuf) — hier statt in Desktop.svelte, weil `vp` genau HIER
    // (nach planeAnsichtAnwendung) gesetzt wird, nicht in Desktop.svelte selbst.
    const eintrag: VerlaufEintrag = { vp: plan.vp, ausloeser: 'ansicht', label: labelFuer({ ausloeser: 'ansicht', name: a.name }) };
    ui.verlauf = aufzeichnen(ui.verlauf, eintrag);
    zuletztAngewendetId = a.id;
    schliessen();
  }

  /** Datum in deutscher Punktschreibweise (TT.MM.JJJJ) — gleiches Muster wie formatDatum() in Desktop.svelte. */
  function formatDatum(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  /** Tasten im Eingabefeld bleiben im Feld (stopPropagation, Muster NoteCard-Textarea): Enter
   *  speichert, Escape schließt nur die Eingabe — das Dropdown bleibt geöffnet und wird über den
   *  globalen Tastatur-Handler in Desktop.svelte geschlossen. */
  function onEingabeKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      speichern();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      zuruecksetzen();
    }
  }
</script>

<div class="ansichten-wrap">
  <button class="ansichten-current" onclick={umschalten}
          aria-label="Gespeicherte Ansichten" aria-expanded={offen}>📌 Ansichten</button>
  {#if offen}
    <div class="backdrop" role="presentation"
         onpointerdown={(e) => { e.stopPropagation(); schliessen(); }}></div>
    <div class="ansichten-menu" role="menu" tabindex="-1" style:width="{ANSICHTEN_MENU_W}px"
         onpointerdown={(e) => e.stopPropagation()}>
      <div class="abschnitt">Gespeicherte Ansichten</div>
      <!-- E1/overflow: nur die Zeilen scrollen; die Fußzeile liegt AUSSERHALB von .liste und
           bleibt dadurch immer erreichbar. -->
      <div class="liste">
        {#if ansichten.length === 0}
          <!-- E1/empty: Hinweistext (Copywriting Contract), Fußzeile bleibt sichtbar. -->
          <div class="leer">Noch keine Ansicht gespeichert. Position, Zoom, sichtbare Ebenen und geöffnete Dokumente lassen sich hier als Ansicht sichern.</div>
        {/if}
        {#each ansichten as a (a.id)}
          <div class="zeile">
            <button class="item" class:aktiv={a.id === zuletztAngewendetId} onclick={() => anwenden(a)}>
              <!-- E1/long-text: Anzeige kürzt mit Ellipsis, Volltext als Titel-Tooltip. -->
              <span class="name" title={a.name}>{a.name}</span>
              <span class="meta">zuletzt aktualisiert {formatDatum(a.updatedAt)}</span>
            </button>
            <button class="entfernen" title={`Ansicht „${a.name}" entfernen`} aria-label={`Ansicht „${a.name}" entfernen`}
                    onclick={() => entfernen(a)}>✕</button>
          </div>
        {/each}
      </div>
      {#if eingabeOffen}
        <input class="eingabe" bind:this={eingabeEl} bind:value={neuerName}
               maxlength={ANSICHT_NAME_MAX} placeholder="Name der Ansicht"
               onkeydown={onEingabeKeydown} />
      {:else}
        <button class="fusszeile" onclick={starteEingabe}>+ Ansicht speichern…</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ansichten-wrap { position: relative; }
  /* Optik verbatim aus Desktop.svelte `.toolbar button` übernommen — NICHT geerbt.
     Svelte kapselt CSS pro Komponente: die Regel `.toolbar button` in Desktop.svelte greift
     nicht über die Komponentengrenze hinweg auf diesen Knopf. Der frühere Kommentar hier
     behauptete das Gegenteil ("erbt bewusst … kein eigener Stil nötig"), weshalb der Knopf
     auf die Browser-Standardoptik zurückfiel (weiß mit Rand) und sichtbar aus der Leiste
     ausbrach. FreigabenSignal, BenachrichtigungenPanel und PresenceRoster kopieren die
     Regel aus demselben Grund. Änderungen an `.toolbar button` müssen hier mitgezogen werden. */
  .ansichten-current { font-size: 13px; padding: 6px 12px; border-radius: 8px;
                       border: 1px solid var(--glass-border);
                       background: var(--glass-card-bg); color: var(--glass-text);
                       backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
                       cursor: pointer; box-shadow: var(--glass-shadow); }
  .ansichten-current:hover { background: var(--glass-elevated-bg); }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  /* Optik 1:1 aus .ebenen-menu (Desktop.svelte) übernommen; die Breite kommt als Layoutkonstante
     ANSICHTEN_MENU_W aus dem Markup (statt min-width: 220px), das Scrollen übernimmt .liste. */
  .ansichten-menu { position: absolute; top: 40px; right: 0; z-index: 9002; padding: 4px;
                    border-radius: 10px; background: var(--glass-elevated-bg); color: var(--glass-text);
                    border: 1px solid var(--glass-border);
                    backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
                    box-shadow: var(--glass-shadow-lg);
                    display: flex; flex-direction: column; gap: 2px; }
  .ansichten-menu .abschnitt { padding: 4px 10px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
                               color: var(--glass-text-secondary); }
  .liste { display: flex; flex-direction: column; gap: 2px;
           max-height: calc(100vh - 220px); overflow-y: auto; }
  .zeile { display: flex; align-items: stretch; gap: 2px; }
  /* Zeilen-Button: Regeln unter .ansichten-menu gespeichert, damit sie die .toolbar-button-Erbe
     schlagen (gleiche Konvention wie .ebenen-menu .item in Desktop.svelte). */
  .ansichten-menu .item { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
                          text-align: left; padding: 7px 10px; border: 1px solid transparent; background: none;
                          border-radius: 6px; font-size: 13px; color: inherit; cursor: pointer; box-shadow: none; }
  .ansichten-menu .item:hover { background: var(--glass-hover); }
  /* Aktive Zeile: Accent-Markierung wortgleich aus .ebenen-menu .item.aktiv (UI-SPEC Color b). */
  .ansichten-menu .item.aktiv { border-color: var(--brand-blue); box-shadow: 0 0 0 2px var(--glass-active); }
  .ansichten-menu .item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ansichten-menu .item .meta { font-size: 12px; color: var(--glass-text-secondary);
                                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ansichten-menu .entfernen { flex: none; width: 26px; border: none; background: none;
                               color: var(--glass-text-secondary); border-radius: 6px; cursor: pointer;
                               font-size: 12px; box-shadow: none; }
  .ansichten-menu .entfernen:hover { background: var(--glass-hover); color: inherit; }
  .leer { padding: 8px 10px; font-size: 12px; color: var(--glass-text-secondary); line-height: 1.4; }
  .ansichten-menu .fusszeile { text-align: left; padding: 7px 10px; border: 1px solid transparent; background: none;
                               border-radius: 6px; font-size: 13px; color: inherit; cursor: pointer; box-shadow: none; }
  .ansichten-menu .fusszeile:hover { background: var(--glass-hover); }
  /* Inline-Eingabe: Glas-Feld im selben Muster wie .suche-feld (Desktop.svelte). */
  .eingabe { margin: 2px; border: 1px solid var(--glass-separator); border-radius: 8px; padding: 7px 10px;
             background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 13px; }
  .eingabe:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 0; }
</style>
