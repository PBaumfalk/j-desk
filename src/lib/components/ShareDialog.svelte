<script lang="ts">
  import { ALLE_ROLLEN, type Rolle } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui, showToast, toast403 } from '../ui.svelte';
  import { ApiError, type Mitglied } from '../api';

  /**
   * Teilen-Dialog (02-08, PERM-03/PERM-04): Rollenvergabe für die 5 Rollen, sofort wirksam
   * (kein Speichern-Button). Struktur identisch zu KonfliktOverlay.svelte/HistoryOverlay.svelte
   * (zentriertes .overlay, Header h2 + ✕, Fokusfalle) — Öffnen/Schließen läuft self-contained
   * über ui.teilenOffen (dasselbe Muster wie ui.historieOffen), NICHT über Props.
   *
   * Nur der Eigentümer öffnet diesen Dialog (Desktop.svelte gated den Auslöser-Button); der
   * Server validiert jede Mitgliederroute ohnehin erneut (requireDeskRolle(['Eigentümer']), 02-04)
   * — ein 403 hier wäre eine Race Condition (z. B. eigene Rolle wurde inzwischen geändert).
   *
   * „Hinzufügen"-Zeile (Rule 2 — Missing Critical): die 02-UI-SPEC beschreibt nur Mitgliederliste/
   * Rollen-Select/Entfernen, aber ohne JEDE Möglichkeit, überhaupt ein erstes Mitglied zu benennen,
   * wäre PERM-03 („weist bekannten Nutzern eine Rolle zu") gar nicht bedienbar — kein Einladungs-
   * code, keine Konto-Erstellung, nur POST /members mit einem bereits existierenden Nutzernamen
   * (404 bei Unbekanntem, 400 bei unbekannter Rolle, s. 02-04).
   */

  const WAEHLBARE_ROLLEN: Rolle[] = ALLE_ROLLEN.filter((r) => r !== 'Eigentümer');

  let mitglieder = $state<Mitglied[]>([]);
  let laden = $state(false);
  let fehler = $state<string | null>(null);

  let neuerName = $state('');
  let neueRolle = $state<Rolle>('Bearbeiter');
  let hinzufuegenFehler = $state<string | null>(null);
  let hinzufuegenLaeuft = $state(false);

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  const uebrigeMitglieder = $derived(mitglieder.filter((m) => m.rolle !== 'Eigentümer'));

  async function laedt(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) { fehler = 'Nicht verbunden'; return; }
    laden = true;
    fehler = null;
    try {
      mitglieder = await api.listMembers(id);
    } catch (e) {
      fehler = e instanceof Error ? e.message : 'Mitgliederliste konnte nicht geladen werden';
    } finally {
      laden = false;
    }
  }

  function schliessen(): void {
    ui.teilenOffen = false;
    vorherFokussiert?.focus();
  }

  /** onchange am Rollen-Select wirkt sofort (kein Speichern-Button) — bei Fehlschlag springt
   *  der Select optimistisch auf den zuletzt bestätigten Wert zurück (Copywriting Contract). */
  async function rolleAendern(m: Mitglied, neu: string, select: HTMLSelectElement): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) return;
    const vorherigeRolle = m.rolle;
    m.rolle = neu as Rolle; // optimistisch
    try {
      await api.setMemberRolle(id, m.userId, neu as Rolle);
    } catch (e) {
      m.rolle = vorherigeRolle;
      select.value = vorherigeRolle;
      if (e instanceof ApiError && e.status === 403) {
        toast403('verwaltung');
      } else {
        showToast('Rolle konnte nicht geändert werden. Versuchen Sie es erneut.');
      }
    }
  }

  async function entfernen(m: Mitglied): Promise<void> {
    if (!confirm(`„${m.username}" aus diesem Schreibtisch entfernen? Die Person verliert sofort den Zugriff.`)) return;
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) return;
    try {
      await api.removeMember(id, m.userId);
      mitglieder = mitglieder.filter((x) => x.userId !== m.userId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) toast403('verwaltung');
      else showToast(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen');
    }
  }

  async function hinzufuegen(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    const name = neuerName.trim();
    if (!api || !id || name === '') return;
    hinzufuegenFehler = null;
    hinzufuegenLaeuft = true;
    try {
      await api.addMember(id, name, neueRolle);
      neuerName = '';
      await laedt();
    } catch (e) {
      hinzufuegenFehler = e instanceof Error ? e.message : 'Hinzufügen fehlgeschlagen';
    } finally {
      hinzufuegenLaeuft = false;
    }
  }

  /** Tab-Bewegungen im Overlay halten (Fokusfalle) — identisches Muster zu HistoryOverlay.svelte. */
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

  $effect(() => {
    if (!ui.teilenOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    mitglieder = [];
    fehler = null;
    neuerName = '';
    hinzufuegenFehler = null;
    void laedt();
  });
</script>

{#if ui.teilenOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Teilen" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>Teilen</h2>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Teilen-Dialog schließen">✕</button>
    </header>

    <div class="inhalt">
      {#if laden}
        <p class="hinweis">Lädt…</p>
      {:else if fehler}
        <div class="fehler">
          <p>{fehler}</p>
          <button onclick={laedt}>Erneut versuchen</button>
        </div>
      {:else}
        <div class="kopfzeile eintrag" aria-hidden="true">
          <span></span>
          <span class="abschnitt">Rolle</span>
          <span></span>
        </div>
        {#each mitglieder as m (m.userId)}
          <div class="eintrag">
            <span class="name" title={m.username}>{m.username}</span>
            {#if m.rolle === 'Eigentümer'}
              <span class="rolle-fest">Eigentümer</span>
              <span></span>
            {:else}
              <select
                value={m.rolle}
                onchange={(e) => rolleAendern(m, e.currentTarget.value, e.currentTarget)}
                aria-label={`Rolle von ${m.username}`}
              >
                {#each WAEHLBARE_ROLLEN as r (r)}<option value={r}>{r}</option>{/each}
              </select>
              <button class="entfernen" onclick={() => entfernen(m)}>Entfernen</button>
            {/if}
          </div>
        {/each}
        {#if uebrigeMitglieder.length === 0}
          <p class="leer">Noch niemand eingeladen — nur Sie haben Zugriff auf diesen Schreibtisch.</p>
        {/if}

        <div class="hinzufuegen">
          <input
            type="text"
            placeholder="Nutzername"
            bind:value={neuerName}
            aria-label="Nutzername für neues Mitglied"
            onkeydown={(e) => { if (e.key === 'Enter') void hinzufuegen(); }}
          />
          <select bind:value={neueRolle} aria-label="Rolle für neues Mitglied">
            {#each WAEHLBARE_ROLLEN as r (r)}<option value={r}>{r}</option>{/each}
          </select>
          <button onclick={hinzufuegen} disabled={hinzufuegenLaeuft || neuerName.trim() === ''}>Hinzufügen</button>
        </div>
        {#if hinzufuegenFehler}
          <p class="hinzufuegen-fehler">{hinzufuegenFehler}</p>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.teilenOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(520px, 92vw); max-height: min(70vh, 620px); display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 16px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  .inhalt { overflow-y: auto; padding: 0 16px 0; display: flex; flex-direction: column; gap: 2px; }
  .kopfzeile { opacity: .7; }
  .abschnitt { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .eintrag {
    display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center;
    padding: 6px 4px; border-radius: 8px;
  }
  .eintrag:not(.kopfzeile):hover { background: var(--glass-hover); }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; max-width: 220px; }
  .rolle-fest { font-size: 12px; opacity: .7; padding: 4px 8px; }
  select { font: inherit; font-size: 12px; border-radius: 6px; border: 1px solid var(--glass-border); background: var(--glass-card-bg); color: var(--glass-text); padding: 4px 6px; }
  .entfernen { border: none; border-radius: 6px; background: var(--brand-red-soft); color: var(--brand-red); cursor: pointer; font-size: 11px; padding: 4px 8px; }
  .entfernen:hover { background: rgba(238, 24, 30, .28); }
  .leer { padding: 12px 4px; font-size: 13px; opacity: .75; }
  .hinweis, .fehler { padding: 18px 4px; font-size: 13px; opacity: .75; }
  .hinzufuegen { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--glass-border); }
  .hinzufuegen input { font: inherit; font-size: 13px; border-radius: 6px; border: 1px solid var(--glass-border); background: var(--glass-card-bg); color: var(--glass-text); padding: 6px 8px; min-width: 0; }
  .hinzufuegen button { border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text); cursor: pointer; font-size: 12px; padding: 6px 10px; }
  .hinzufuegen button:disabled { opacity: .5; cursor: default; }
  .hinzufuegen-fehler { margin: 6px 4px 0; font-size: 12px; color: var(--brand-red); }
</style>
