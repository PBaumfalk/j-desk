<script lang="ts">
  import {
    aktuelleSitzungsmappe, agendaZeilen, findSitzungsmappe, sprungmarkenFuerSitzungsmappe,
    type Flag,
  } from '@j-desk/core';
  import { desktop, darfAktionClient } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { uid } from '../uid';
  import { starteSitzungsmodus } from '../sitzungsmodus';

  /**
   * Sitzungsmappe-Vorbereitungsdialog (SESS-02, 11-05): strukturell wortgleich zu
   * AnlagenpaketDialog.svelte (Overlay-Chrome, Fokusfalle, Escape schließt, warOffen-geschützter
   * Öffnen-Effekt, Glas-Panel, 16px Eckenradius), aber ohne Server-Prüfpfad — alle drei Abschnitte
   * lesen ausschließlich aus `desktop.state` (T-11-01: nur projizierte, bereits berechtigte Daten).
   *
   * Feste Abschnittsreihenfolge (11-UI-SPEC.md Komponentenkontrakt): Dokumente → Sprungmarken →
   * Offene Fragen → Aktionen. Die Aktions-Fußzeile liegt AUSSERHALB der scrollenden Fläche
   * (E2/overflow), jeder der drei Abschnitte scrollt in sich.
   *
   * Doppelweg der Dokumentauswahl: das Anklicken in der Verfügbar-Liste hier UND der
   * Kontextmenü-Eintrag am Tisch (menus.ts sitzungsmappeDocEintrag) senden dasselbe
   * addSitzungsmappeDoc-/removeSitzungsmappeDoc-Kommando in dieselbe Agenda — es gibt keinen
   * zweiten Schreibweg neben dem Kommandopfad.
   *
   * „Später fortsetzen" verwirft nichts: die Sitzungsmappe bleibt als versioniertes Objekt im
   * DesktopState gespeichert und der Dialog lässt sich über denselben DeskSwitcher-Eintrag
   * wieder öffnen — deshalb heißt der Sekundär-Button nicht „Abbrechen" (Copywriting Contract).
   */

  /** Dialogmaße (11-UI-SPEC.md Spacing Exceptions): identisch zu ANLAGENPAKET_W/H. */
  const SITZUNGSMAPPE_W = 'min(640px, 92vw)';
  const SITZUNGSMAPPE_H = 'min(88vh, 760px)';

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  /**
   * Auflösung der bearbeiteten Sitzungsmappe: primär über `ui.aktiveSitzungsmappeId`, mit
   * Rückfall auf die zuletzt angelegte Mappe (`aktuelleSitzungsmappe`) — sonst würde der Dialog
   * eine zweite Mappe anlegen, obwohl das Kontextmenü am Tisch längst eine befüllt hat (es gibt
   * in dieser Ausbaustufe genau eine aktive Sitzungsmappe je Desk, keine Auswahlliste).
   */
  const mappe = $derived.by(() => {
    const perId = ui.aktiveSitzungsmappeId ? findSitzungsmappe(desktop.state, ui.aktiveSitzungsmappeId) : undefined;
    return perId ?? aktuelleSitzungsmappe(desktop.state);
  });

  const zeilen = $derived(mappe ? agendaZeilen(desktop.state, mappe) : []);
  /** Sprungmarken (Abschnitt 2): reine $derived-Ableitung — bewusste Abweichung von der
   *  UI-SPEC, die hier ein debouncetes Nachladen samt Lade- und Fehlerzustand vorsah. Die
   *  Fahnen liegen im Client bereits vollständig im `DesktopState` vor (`flagsFor`), die
   *  Ableitung ist damit synchron und kann strukturell weder laden noch fehlschlagen; es gibt
   *  deshalb keinen Fehlerzustand und keine Wiederholen-Möglichkeit in diesem Abschnitt
   *  (E2/error entfällt fachlich, E2/loading bleibt visueller Backstop: kein Zwischenzustand,
   *  der als „keine Fahnen" gelesen werden könnte). Das sichtbare Ergebnis ist identisch. */
  const sprungmarken = $derived<Flag[]>(mappe ? sprungmarkenFuerSitzungsmappe(desktop.state, mappe) : []);

  function schliessen(): void {
    ui.sitzungsmappeOffen = false;
    vorherFokussiert?.focus();
  }

  /** Doppelweg Schreibseite Dialog: Klick auf eine Verfügbar-Zeile schaltet die Agenda-
   *  Mitgliedschaft um — dasselbe Kommandopaar wie der Kontextmenü-Eintrag am Tisch. */
  function toggleDoc(docId: string): void {
    if (!mappe) return;
    if (mappe.docIds.includes(docId)) {
      void desktop.command('removeSitzungsmappeDoc', { id: mappe.id, docId });
    } else {
      void desktop.command('addSitzungsmappeDoc', { id: mappe.id, docId });
    }
  }

  function verschieben(docId: string, richtung: -1 | 1): void {
    if (!mappe) return;
    void desktop.command('verschiebeSitzungsmappeDoc', { id: mappe.id, docId, richtung });
  }

  function entfernen(docId: string): void {
    if (!mappe) return;
    void desktop.command('removeSitzungsmappeDoc', { id: mappe.id, docId });
  }

  function frageHinzufuegen(): void {
    if (!mappe) return;
    void desktop.command('addOffeneFrage', { id: mappe.id, text: '' });
  }

  /** Sichert den Freitext beim Verlassen des Felds — nur bei tatsächlicher Änderung, damit
   *  ein bloßes Durchtabben keinen Kommando-Eintrag im Journal erzeugt. Der Text wird
   *  unverändert und ohne Kürzung übernommen (Inhalt, kein Etikett). */
  function frageTextSichern(frageId: string, bisher: string, neu: string): void {
    if (!mappe || neu === bisher) return;
    void desktop.command('setOffeneFrageText', { id: mappe.id, frageId, text: neu });
  }

  function frageBeantwortet(frageId: string, beantwortet: boolean): void {
    if (!mappe) return;
    void desktop.command('setOffeneFrageBeantwortet', { id: mappe.id, frageId, beantwortet });
  }

  function frageEntfernen(frageId: string): void {
    if (!mappe) return;
    void desktop.command('removeOffeneFrage', { id: mappe.id, frageId });
  }

  /** Anzeigename eines Sprungmarken-Dokuments aus dem Client-Zustand (nie nachgeladen). */
  function dokumentname(docId: string): string {
    return desktop.state.docs.find((d) => d.id === docId)?.name ?? 'Entferntes Dokument';
  }

  /** „Sitzung starten": schließt den Dialog und aktiviert sofort den Sitzungsmodus mit dieser
   *  Sitzungsmappe — der einzige Einstieg in den Sitzungsmodus (11-05 Task 3). */
  function sitzungStarten(): void {
    if (!mappe || mappe.docIds.length === 0) return;
    ui.sitzungsmappeOffen = false;
    void starteSitzungsmodus(mappe.id);
    vorherFokussiert?.focus();
  }

  /** WR-05 (11-REVIEW): einziger Löschweg für eine Sitzungsmappe. Der Papierkorb kann die Art
   *  noch nicht aufnehmen (trashObject kennt sitzungsmappen nicht), die Löschung über
   *  removeSitzungsmappe ist deshalb endgültig — daher derselbe Bestätigungsdialog wie beim
   *  endgültigen Schreddern im Papierkorb (TrashCan.svelte). Gerade weil eine Mappe vertrauliche
   *  Vorbereitungsnotizen (offene Fragen) enthält, darf sie nicht unlöschbar im Desk-State, im
   *  Journal und in jedem .jdesk-Export akkumulieren. */
  function mappeLoeschen(): void {
    if (!mappe) return;
    if (!confirm(`Sitzungsmappe „${mappe.titel}" endgültig löschen? Agenda und offene Fragen gehen dabei unwiderruflich verloren.`)) return;
    const id = mappe.id;
    if (ui.aktiveSitzungsmappeId === id) ui.aktiveSitzungsmappeId = null;
    void desktop.command('removeSitzungsmappe', { id });
    schliessen();
  }

  /** Tab-Bewegungen im Overlay halten (Fokusfalle) — wortgleich zu AnlagenpaketDialog.svelte. */
  function fokusFalle(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab') return;
    const ziele = (ev.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (ziele.length === 0) return;
    const erste = ziele[0];
    const letzte = ziele[ziele.length - 1];
    if (!ev.shiftKey && document.activeElement === letzte) { ev.preventDefault(); erste.focus(); }
    else if (ev.shiftKey && document.activeElement === erste) { ev.preventDefault(); letzte.focus(); }
  }

  /**
   * Öffnen-Effekt (warOffen-geschützt, Muster AnlagenpaketDialog): Fokus merken und auf den
   * Schließen-Knopf setzen. Ist weder `ui.aktiveSitzungsmappeId` gesetzt noch eine Mappe
   * vorhanden, wird genau einmal eine angelegt und ihre id gemerkt — nicht bei jedem Rerender.
   * Eine vorhandene, noch nicht als aktiv gemerkte Mappe wird als aktiv gemerkt, damit Dialog
   * und Kontextmenü in dieselbe Agenda schreiben.
   */
  $effect(() => {
    if (!ui.sitzungsmappeOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    if (ui.aktiveSitzungsmappeId && findSitzungsmappe(desktop.state, ui.aktiveSitzungsmappeId)) return;
    const bestehende = aktuelleSitzungsmappe(desktop.state);
    if (bestehende) {
      ui.aktiveSitzungsmappeId = bestehende.id;
      return;
    }
    const id = uid();
    void desktop.command('addSitzungsmappe', { titel: 'Termin', id });
    ui.aktiveSitzungsmappeId = id;
  });
</script>

{#if ui.sitzungsmappeOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div
    class="overlay" role="dialog" aria-modal="true" aria-label="Sitzungsmappe" tabindex="-1"
    style:width={SITZUNGSMAPPE_W} style:max-height={SITZUNGSMAPPE_H}
    onkeydown={fokusFalle}
  >
    <header>
      <div class="titelblock">
        <h2>🎓 Sitzungsmappe</h2>
        <p class="unterzeile">Bereiten Sie Dokumente, Sprungmarken und offene Fragen für den Termin vor. Im Sitzungsmodus stehen sie mit großen Zielen und ohne Verschiebe-Risiko bereit.</p>
      </div>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Sitzungsmappe-Dialog schließen">✕</button>
    </header>

    <div class="inhalt">
      <div class="abschnitt">Dokumente</div>
      {#if desktop.state.docs.length === 0}
        <p class="hinweis">Keine Dokumente auf diesem Schreibtisch.</p>
      {:else}
        <div class="umfang-liste">
          {#each desktop.state.docs as d (d.id)}
            <label class="umfang-option" title={d.name}>
              <input
                type="checkbox"
                checked={mappe?.docIds.includes(d.id) ?? false}
                onchange={() => toggleDoc(d.id)}
              />
              <span class="umfang-name">{d.name}</span>
            </label>
          {/each}
        </div>
      {/if}

      <div class="unterabschnitt">Agenda (Reihenfolge im Termin)</div>
      {#if zeilen.length === 0}
        <p class="hinweis">Noch keine Dokumente in der Agenda. Über das Kontextmenü am Tisch oder die Liste oben hinzufügen.</p>
      {:else}
        <div class="agenda-liste">
          {#each zeilen as zeile, index (zeile.docId)}
            <div class="agenda-zeile" class:gedaempft={!zeile.verfuegbar}>
              <span class="agenda-name" title={zeile.name}>
                {zeile.name}{#if zeile.imPapierkorb}<span class="papierkorb-zusatz"> (im Papierkorb)</span>{/if}
              </span>
              <div class="schaltflaechen">
                <button
                  class="pager-btn" disabled={index === 0}
                  onclick={() => verschieben(zeile.docId, -1)} aria-label="Nach oben verschieben"
                >↑</button>
                <button
                  class="pager-btn" disabled={index === zeilen.length - 1}
                  onclick={() => verschieben(zeile.docId, 1)} aria-label="Nach unten verschieben"
                >↓</button>
                <button class="entfernen" onclick={() => entfernen(zeile.docId)} aria-label={`${zeile.name} entfernen`}>✕ Entfernen</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <div class="abschnitt abschnitt-lg">Sprungmarken</div>
      {#if sprungmarken.length === 0}
        <p class="hinweis">Die ausgewählten Dokumente tragen noch keine Fahnen. Am Tisch per Rechtsklick auf eine Seite setzen.</p>
      {:else}
        <div class="sprungmarken-liste">
          {#each sprungmarken as flag (flag.id)}
            <div class="sprungmarke-zeile">
              <span class="swatch" style:background={flag.color}></span>
              <span class="sprungmarke-name" title={dokumentname(flag.docId)}>{dokumentname(flag.docId)}</span>
              <span class="sprungmarke-seite">Seite {flag.page}</span>
            </div>
          {/each}
        </div>
      {/if}

      <div class="abschnitt abschnitt-lg">Offene Fragen</div>
      {#if !mappe || mappe.offeneFragen.length === 0}
        <p class="hinweis">Noch keine offenen Fragen notiert.</p>
      {:else}
        <div class="fragen-liste">
          {#each mappe.offeneFragen as f (f.id)}
            <div class="frage-zeile">
              <input
                type="checkbox"
                checked={f.beantwortet}
                onchange={(e) => frageBeantwortet(f.id, (e.currentTarget as HTMLInputElement).checked)}
                aria-label="beantwortet"
              />
              <input
                class="glass-input frage-feld"
                type="text"
                value={f.text}
                onchange={(e) => frageTextSichern(f.id, f.text, (e.currentTarget as HTMLInputElement).value)}
              />
              <button class="entfernen" onclick={() => frageEntfernen(f.id)} aria-label="Frage entfernen">✕</button>
            </div>
          {/each}
        </div>
      {/if}
      {#if mappe}
        <button class="frage-add" onclick={frageHinzufuegen}>+ Frage hinzufügen</button>
      {/if}
    </div>

    <div class="aktionen">
      {#if mappe && darfAktionClient(desktop.currentRolle, 'delete')}
        <!-- 11-REVIEW CR-01: dasselbe PERM-04-Gate wie Foto-Kachel/TrashCan (WR-04) —
             removeSitzungsmappe ist serverseitig Eigentümer-only (LOESCH_COMMANDS). -->
        <button class="sekundaer gefahr" onclick={mappeLoeschen}>Mappe löschen…</button>
      {:else}
        <span></span>
      {/if}
      <div class="aktionen-rechts">
        <button class="sekundaer" onclick={schliessen}>Später fortsetzen</button>
        <button
          class="primaer"
          disabled={zeilen.length === 0}
          onclick={sitzungStarten}
        >
          Sitzung starten
        </button>
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.sitzungsmappeOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 16px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 16px 8px; gap: 8px; }
  .titelblock { display: flex; flex-direction: column; gap: 2px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .unterzeile { margin: 0; font-size: 12px; line-height: 1.4; opacity: .7; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; flex-shrink: 0; }
  .inhalt { overflow-y: auto; padding: 0 16px; display: flex; flex-direction: column; gap: 2px; }
  .abschnitt {
    padding: 4px 0 2px; margin-top: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .04em; opacity: .7;
  }
  .abschnitt:first-child { margin-top: 0; }
  /* lg-Abstand (24px) zwischen den Abschnitten (11-UI-SPEC.md Spacing Scale). */
  .abschnitt-lg { margin-top: 24px; }
  .unterabschnitt { padding: 4px 0 2px; margin-top: 8px; font-size: 12px; font-weight: 600; opacity: .75; }

  .umfang-liste { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .umfang-option {
    display: flex; align-items: center; gap: 8px; padding: 4px; border-radius: 6px; cursor: pointer;
    text-align: left; font-size: 13px; width: 100%;
  }
  .umfang-option:hover { background: var(--glass-hover); }
  .umfang-option input { accent-color: var(--brand-blue); flex-shrink: 0; }
  .umfang-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Agenda-Liste: scrollt in sich (E2/overflow); Zeilenstruktur wie AnlagenpaketDialog, aber
     ohne Nummernpräfix — die Reihenfolge ist Terminagenda, kein Nummerierungsartefakt. */
  .agenda-liste { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
  .agenda-zeile { display: flex; align-items: center; gap: 8px; }
  /* Agenda-Dokument im Papierkorb/verschwunden: gedimmt, identisches Muster zu
     DocCard.svelte .card.verwaist — die Zeile bleibt sichtbar und bedienbar (E2/partial). */
  .agenda-zeile.gedaempft { opacity: .65; }
  .agenda-name {
    flex: 1; min-width: 0; font-size: 13px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .papierkorb-zusatz { opacity: .75; }
  .schaltflaechen { flex-shrink: 0; display: flex; align-items: center; gap: 4px; }
  /* ↑/↓-Reorder-Buttons: Bestandsstil .pager button (DocViewer.svelte/KonvolutViewer.svelte). */
  .pager-btn {
    flex-shrink: 0; border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
    width: 24px; height: 24px; font-size: 13px; line-height: 1;
  }
  .pager-btn:disabled { opacity: .4; cursor: default; }
  .entfernen {
    flex-shrink: 0; border: none; background: transparent; color: inherit; cursor: pointer;
    font-size: 12px; padding: 4px 6px; opacity: .75;
  }
  .entfernen:hover { opacity: 1; }

  /* Sprungmarken: schreibgeschützte Ableitung (Fahnen werden am Tisch verwaltet, nicht hier) —
     Zeilenstruktur wie das 🎯-Panel der SitzungsmodusShell, ohne Klick-Aktion. */
  .sprungmarken-liste { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
  .sprungmarke-zeile { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .swatch { flex-shrink: 0; width: 12px; height: 12px; border-radius: 3px; }
  .sprungmarke-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sprungmarke-seite { flex-shrink: 0; font-size: 12px; opacity: .75; }

  .fragen-liste { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
  .frage-zeile { display: flex; align-items: center; gap: 8px; }
  .frage-zeile input[type="checkbox"] { accent-color: var(--brand-blue); flex-shrink: 0; }
  /* Freitext ohne Kürzung (Inhalt, kein Etikett) — Feld wächst mit dem Dialog, Ellipsis nur
     als Overflow-Schutz der Zeile, der gesicherte Wert bleibt vollständig. */
  .frage-feld { flex: 1; min-width: 0; }
  .frage-add {
    align-self: flex-start; border: none; background: transparent; color: inherit; cursor: pointer;
    font-size: 12px; padding: 4px 6px; opacity: .75;
  }
  .frage-add:hover { opacity: 1; }

  .hinweis { margin: 0; font-size: 13px; opacity: .75; }

  /* Fußzeile liegt AUSSERHALB der scrollenden .inhalt-Fläche und scrollt nie mit (E2/overflow). */
  .aktionen { display: flex; justify-content: space-between; gap: 8px; margin-top: 24px; padding: 0 16px; }
  .aktionen-rechts { display: flex; gap: 8px; }
  .aktionen button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; font-size: 13px;
  }
  .aktionen button:hover { background: var(--glass-hover); }
  /* Lösch-Affordanz (WR-05): dezente Warnfärbung, Muster .entfernen oben — kein Rot-Block,
     die endgültige Absicherung trägt der Bestätigungsdialog. */
  .aktionen .gefahr { color: #a33; }
  .aktionen .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .aktionen .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .aktionen .primaer:disabled { opacity: .5; cursor: default; }
</style>
