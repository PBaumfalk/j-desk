<script lang="ts">
  import { untrack } from 'svelte';
  import { legalObjectBox } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import type { LegalQueryKind, LegalQueryTreffer } from '../api';

  // Auswertungs-Panel (LEGAL-03, 08-05): drei kanonische Abfragen über den serverseitig
  // projizierten Zustand (packages/server/src/legalQueries.ts) — Struktur wortgleich aus
  // ActivityOverlay.svelte übernommen (.hintergrund/.overlay, Fokusfalle, Escape, warOffen-Guard).

  /** Kennungen/Labels sind aus dem Copywriting Contract (08-UI-SPEC.md) GESPERRT — Serverspiegel
   *  von LEGAL_QUERIES (packages/server/src/legalQueries.ts, kein Import über den Paketrand
   *  möglich: das Server-Paket zieht better-sqlite3 in den Browser-Build). */
  const ABFRAGEN: { kind: LegalQueryKind; label: string }[] = [
    { kind: 'facts-without-evidence', label: 'Tatsachen ohne Beweismittel' },
    { kind: 'opposing-claims-without-rebuttal', label: 'Behauptungen der Gegenseite ohne Erwiderung' },
    { kind: 'evidence-supporting-multiple-facts', label: 'Beweismittel, die mehrere Tatsachen stützen' },
  ];

  let abfrage = $state<LegalQueryKind | null>(null);
  let treffer = $state<LegalQueryTreffer[]>([]);
  let laeuft = $state(false);
  let fehler = $state(false);
  // Merkt sich die zuletzt GESTARTETE Abfrage (nicht nur die erfolgreiche) — "Erneut versuchen"
  // wiederholt exakt sie, identisches Muster zu ActivityOverlay.svelte letzterModus.
  let letzteAbfrage: LegalQueryKind | null = null;

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  async function starte(kind: LegalQueryKind): Promise<void> {
    const api = desktop.api;
    const deskId = desktop.deskId;
    abfrage = kind;
    letzteAbfrage = kind;
    if (!api || !deskId) { fehler = true; return; }
    laeuft = true;
    fehler = false;
    try {
      const { treffer: server } = await api.legalQuery(deskId, kind);
      treffer = server;
    } catch {
      fehler = true;
    } finally {
      laeuft = false;
    }
  }

  function erneutVersuchen(): void {
    if (letzteAbfrage) void starte(letzteAbfrage);
  }

  function schliessen(): void {
    ui.auswertungOffen = false;
    vorherFokussiert?.focus();
  }

  /** Klick auf eine Ergebniszeile: springt zum betreffenden Objekt auf dem Tisch (Bestands-
   *  Sprungpfad — ui.jumpRequest, dieselbe Leitung wie die Kartensuche/desktop.jumpTo(),
   *  Desktop.svelte $effect(ui.jumpRequest)) und schließt das Panel in JEDEM Fall — auch wenn
   *  das Zielobjekt zwischenzeitlich verschwunden ist (Bestandsverhalten der Suchtreffer-Weiche). */
  function springe(t: LegalQueryTreffer): void {
    const objekt = desktop.state.legalObjects?.find((o) => o.id === t.objektId);
    if (objekt) ui.jumpRequest = { box: legalObjectBox(objekt) };
    schliessen();
  }

  /** Tab-Bewegungen im Panel halten (Fokusfalle) — identisches Muster zu ActivityOverlay.svelte. */
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

  // Beim Öffnen: immer frisch — kein Zwischenspeicher (kein Sprung-Rückkehr-Bedürfnis, analog
  // ActivityOverlay.svelte). Reagiert NUR auf den Übergang geschlossen -> offen (warOffen-Guard).
  $effect(() => {
    if (!ui.auswertungOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    untrack(() => {
      abfrage = null;
      treffer = [];
      laeuft = false;
      fehler = false;
    });
  });
</script>

{#if ui.auswertungOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Auswertungen" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>Auswertungen</h2>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Auswertungen schließen">✕</button>
    </header>

    <div class="abfragen">
      {#each ABFRAGEN as a (a.kind)}
        <button class="abfrage-knopf" class:aktiv={abfrage === a.kind} onclick={() => starte(a.kind)} disabled={laeuft}>
          {a.label}
        </button>
      {/each}
    </div>

    <div class="ergebnisse">
      {#if abfrage === null}
        <p class="hinweis">Abfrage wählen, um auszuwerten.</p>
      {:else if laeuft}
        <p class="hinweis">Wertet aus …</p>
      {:else if fehler}
        <div class="fehler">
          <p>Auswertung fehlgeschlagen.</p>
          <button onclick={erneutVersuchen}>Erneut versuchen</button>
        </div>
      {:else if treffer.length === 0}
        <!-- SEARCH-04/T-08-19: identischer Text für echt leer UND berechtigungsbedingt leer —
             kein zweiter Zweig, keine Zählangabe (der Leerzustand darf nicht verraten, ob
             gefilterte Treffer existierten). -->
        <p class="hinweis">Keine Treffer für diese Abfrage.</p>
      {:else}
        {#each treffer as t (t.objektId)}
          <button class="treffer" onclick={() => springe(t)}>
            <div class="zeile1"><span class="art">{t.art}</span><span class="name">{t.label}</span></div>
            {#if t.ersteller || t.datum}
              <div class="meta">{[t.ersteller, t.datum].filter(Boolean).join(' · ')}</div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.auswertungOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(560px, 92vw); max-height: min(70vh, 640px); display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 8px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  /* Buttonleiste: umbrechend (08-UI-SPEC.md „umbrechende Reihe von drei Knöpfen"). */
  .abfragen { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 8px; }
  .abfrage-knopf { border: 1px solid var(--glass-separator); background: var(--glass-card-bg);
                   color: var(--glass-text); border-radius: 8px; padding: 8px 12px; cursor: pointer;
                   font: inherit; font-size: 13px; }
  .abfrage-knopf:hover { background: var(--glass-hover); }
  .abfrage-knopf:disabled { opacity: .6; cursor: default; }
  .abfrage-knopf.aktiv { background: var(--brand-blue-soft); border-color: var(--brand-blue); }
  /* lg-Gap (24px) zwischen Buttonleiste und Ergebnisliste — 08-UI-SPEC.md Spacing Scale. */
  .ergebnisse { margin-top: 24px; overflow-y: auto; padding: 0 8px; display: flex; flex-direction: column; gap: 2px; }
  .hinweis { padding: 18px 10px; font-size: 13px; opacity: .75; }
  .fehler { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 13px; opacity: .9; }
  .fehler button { border: 1px solid var(--glass-separator); background: transparent; color: var(--glass-text);
                    border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; }
  /* Trefferzeile: wortgleiche Klassen/Stilwerte aus Desktop.svelte .treffer (Suchtreffer-Zeile,
     07-UI-SPEC.md) — dieselbe Zeilenkomponente ist bewusst nicht extrahiert (kein Bestandsmuster
     für geteilte Komponenten in diesem Projekt), aber der Stil bleibt identisch. */
  .treffer { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; border: none;
             background: none; color: var(--glass-text); padding: 7px 8px; border-radius: 8px;
             cursor: pointer; font-size: 13px; }
  .treffer:hover { background: var(--glass-hover); }
  .treffer .zeile1 { display: flex; gap: 8px; align-items: baseline; }
  .treffer .art { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
                  background: var(--brand-blue-soft); border-radius: 5px; padding: 2px 6px; }
  .treffer .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .treffer .meta { font-size: 12px; color: var(--glass-text-secondary);
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
