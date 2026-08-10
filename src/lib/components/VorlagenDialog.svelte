<script lang="ts">
  import { untrack } from 'svelte';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import type { VorlagenUebersicht } from '../api';

  /**
   * VorlagenDialog (TMPL-01, 13-07) — Dialog-Klasse 1:1 aus VorschlaegeDialog.svelte:
   * .hintergrund/.overlay, role="dialog", Fokusfalle, Escape schließt (eigene svelte:window-
   * Zeile — kein Eintrag im globalen Desktop.svelte-Escape-Handler nötig), warOffen-geschützter
   * Öffnen-Effekt, stehende Fußzeile.
   *
   * Struktur (UI-SPEC Komponentenkontrakt): Kopf → zwei unabhängig scrollende Spalten
   * (Vorlagen-Liste links, konkrete Vorschau rechts) → stehende Fußzeile (Namensfeld + CTA).
   * E11/loading: KEIN Ladepfad — die Liste wird beim Öffnen einmal per GET geholt (api.
   * listVorlagen()) und liegt danach synchron im lokalen $state; die Vorschau liest
   * ausschließlich aus dieser bereits geladenen Liste, nie nachgeladen.
   */

  const VORLAGEN_W = 'min(640px, 92vw)';
  const VORLAGEN_H = 'min(88vh, 760px)';

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  let vorlagen = $state<VorlagenUebersicht[]>([]);
  let ausgewaehlteId = $state<string | null>(null);
  let name = $state('');
  let laedt = $state(false);

  const ausgewaehlteVorlage = $derived(vorlagen.find((v) => v.id === ausgewaehlteId) ?? null);
  /** Deaktivierungsmuster identisch zu „Sitzung starten" (UI-SPEC): erst Vorlage UND Name. */
  const kannAnlegen = $derived(ausgewaehlteId !== null && name.trim() !== '' && !laedt);

  /** Konkrete Inhalts-Aufzählung der Vorschau (Blind-Anlagen-Verbot) — ausschließlich aus den
   *  bereits geladenen Vorlagendaten generiert, nie abstrakt. */
  function vorschauText(v: VorlagenUebersicht): string {
    const objekttypen = [v.zonen.length > 0 ? 'Zonen' : null, v.hinweise.length > 0 ? 'Hinweis-Notizen' : null]
      .filter((t): t is string => t !== null);
    return `Enthält: ${v.zonen.join(', ')} · ${objekttypen.join(', ')} · ${v.hinweise.join('; ')}`;
  }

  function schliessen(): void {
    ui.vorlagenOffen = false;
    ausgewaehlteId = null;
    name = '';
    laedt = false;
    vorherFokussiert?.focus();
  }

  async function anlegen(): Promise<void> {
    if (!kannAnlegen || ausgewaehlteVorlage === null) return;
    laedt = true;
    try {
      const zielName = name.trim();
      const zielVorlage = ausgewaehlteVorlage;
      // desktop.createDesk-Pfad (Store-Muster, store.svelte.ts): legt an, listet neu und
      // wechselt direkt auf den neuen Desk. Bei Misserfolg zeigt der Store bereits die
      // präzise Server-Meldung per Toast — der Dialog bleibt hier bewusst mit Auswahl und
      // Name offen (E11/error), erst bei Erfolg schließt er.
      const ok = await desktop.createDesk(zielName, zielVorlage.id);
      if (ok) {
        showToast(`Schreibtisch „${zielName}" aus Vorlage „${zielVorlage.name}" angelegt.`);
        schliessen();
      }
    } finally {
      laedt = false;
    }
  }

  /** Fokusfalle — wortgleich zu VorschlaegeDialog.svelte. */
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

  // Öffnen-Effekt (warOffen-geschützt, Muster VorschlaegeDialog/AufnahmeDialog): Fokus merken,
  // auf den Schließen-Knopf setzen, Vorlagenliste EINMAL laden (E11/loading: kein weiterer
  // Ladepfad danach).
  $effect(() => {
    if (!ui.vorlagenOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    untrack(() => {
      const api = desktop.api;
      if (!api) return;
      api.listVorlagen()
        .then((v) => { vorlagen = v; })
        .catch((e) => showToast(e instanceof Error ? e.message : 'Vorlagen konnten nicht geladen werden.'));
    });
  });
</script>

{#if ui.vorlagenOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div
    class="overlay" role="dialog" aria-modal="true" aria-label="Neuer Schreibtisch aus Vorlage" tabindex="-1"
    style:width={VORLAGEN_W} style:max-height={VORLAGEN_H}
    onkeydown={fokusFalle}
  >
    <header>
      <div class="titelblock">
        <h2>Neuer Schreibtisch aus Vorlage</h2>
      </div>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Vorlagen-Dialog schließen">✕</button>
    </header>

    {#if vorlagen.length === 0}
      <!-- E11/empty: der Leertext ersetzt die zwei Spalten vollständig; der DeskSwitcher-
           Eintrag bleibt außerhalb dieses Dialogs sichtbar (Entdeckbarkeit). -->
      <div class="inhalt">
        <p class="hinweis">Es sind noch keine Vorlagen hinterlegt.</p>
      </div>
    {:else}
      <div class="spalten">
        <div class="liste-spalte">
          {#each vorlagen as v (v.id)}
            <button
              class="vorlage-zeile" class:aktiv={v.id === ausgewaehlteId}
              onclick={() => (ausgewaehlteId = v.id)}
            >
              <span class="vorlage-name" title={v.name}>{v.name}</span>
              <span class="vorlage-beschreibung">{v.beschreibung}</span>
            </button>
          {/each}
        </div>
        <div class="vorschau-spalte">
          {#if ausgewaehlteVorlage}
            <!-- Vorschau ist schreibgeschützt und bricht vollständig um (Blind-Anlagen-Verbot). -->
            <p class="vorschau-text">{vorschauText(ausgewaehlteVorlage)}</p>
          {:else}
            <p class="hinweis">Wählen Sie links eine Vorlage aus, um die Vorschau zu sehen.</p>
          {/if}
        </div>
      </div>
    {/if}

    <div class="aktionen">
      <input
        class="glass-input namensfeld" type="text" placeholder="Name des neuen Schreibtisches"
        bind:value={name}
        onkeydown={(e) => { if (e.key === 'Enter' && kannAnlegen) void anlegen(); }}
      />
      <div class="aktionen-rechts">
        <button class="sekundaer" onclick={schliessen}>Abbrechen</button>
        <button class="primaer" disabled={!kannAnlegen} onclick={() => void anlegen()}>
          {laedt ? 'Wird angelegt …' : 'Desk anlegen'}
        </button>
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.vorlagenOffen) schliessen(); }} />

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
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; flex-shrink: 0; }

  .inhalt { overflow-y: auto; padding: 8px 16px 0; }
  .hinweis { margin: 0; font-size: 13px; opacity: .75; }

  /* Zwei Spalten, jede scrollt unabhängig innerhalb VORLAGEN_W/H (E11/overflow). */
  .spalten { display: flex; gap: 16px; padding: 8px 16px 0; flex: 1; min-height: 0; }
  .liste-spalte {
    flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
  }
  .vorschau-spalte {
    flex: 1; min-width: 0; overflow-y: auto; padding: 12px; border-radius: 12px;
    background: var(--glass-card-bg); border: 1px solid var(--glass-border);
  }

  .vorlage-zeile {
    display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px;
    border-radius: 8px; border: 1px solid transparent; background: transparent; cursor: pointer;
    color: inherit; font: inherit;
  }
  .vorlage-zeile:hover { background: var(--glass-hover); }
  .vorlage-zeile.aktiv { background: var(--glass-active); border-color: var(--brand-blue); }
  /* Vorlagenname: Body 13px + Ellipsis + title (E11/long-text) — Label, keine Aufzählung. */
  .vorlage-name {
    font-size: 13px; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .vorlage-beschreibung {
    font-size: 12px; line-height: 1.4; color: var(--glass-text-secondary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Vorschau-Aufzählung ist INHALT (Blind-Anlagen-Verbot): bricht vollständig um, nie gekürzt. */
  .vorschau-text { margin: 0; font-size: 13px; font-weight: 400; line-height: 1.5; overflow-wrap: break-word; }

  /* Fußzeile liegt AUSSERHALB der scrollenden Spalten und scrollt nie mit (E11/overflow). */
  .aktionen { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 24px; padding: 0 16px; }
  .namensfeld { flex: 1; min-width: 0; }
  .glass-input { padding: 6px 8px; border-radius: 7px; border: 1px solid var(--glass-separator);
                 background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 13px; }
  .aktionen-rechts { display: flex; gap: 8px; flex-shrink: 0; }
  .aktionen button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; font-size: 13px;
  }
  .aktionen button:hover { background: var(--glass-hover); }
  .aktionen .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .aktionen .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .aktionen .primaer:disabled { opacity: .5; cursor: default; }
</style>
