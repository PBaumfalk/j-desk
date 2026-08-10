<script lang="ts">
  import type { DesktopState } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { ApiError, type BerechtigungsBefund, type Mitglied } from '../api';

  /**
   * Admin-Berechtigungsdiagnose (OPS-03, 14-05): beantwortet „Warum sieht Nutzer X Dokument Y
   * nicht?" ohne SQL, mit einer konkreten, mehrpunktigen Begründung im PERM-Vokabular. Struktur
   * wortgleich zur mittelgroßen Dialog-Klasse (Vorbild ShareDialog.svelte): `.hintergrund`/
   * `.overlay`, `role="dialog"`, `aria-modal="true"`, Fokusfalle, Escape schließt, Header mit
   * Titel + ✕, Glas-Fläche. Öffnen/Schließen läuft self-contained über ui.berechtigungDialog
   * (dasselbe Muster wie ui.teilenOffen), NICHT über Props.
   *
   * Kein Fußzeilen-„Prüfen"-Knopf: die Auswahl selbst löst die Prüfung aus (14-UI-SPEC.md
   * Copywriting Contract „keine Auswahl").
   *
   * Nur der Eigentümer öffnet diesen Dialog (Desktop.svelte/menus.ts gaten die Auslöser); der
   * Server validiert jede Anfrage ohnehin erneut (requireDeskRolle(['Eigentümer']), 14-05) —
   * ein 403/404 hier wäre eine Race Condition (z. B. eigene Rolle wurde inzwischen geändert).
   */

  let mitglieder = $state<Mitglied[]>([]);
  let mitgliederLaden = $state(false);
  let mitgliederFehler = $state<string | null>(null);

  let ausgewaehlterUserId = $state('');
  let ausgewaehlteObjektId = $state('');

  let befund = $state<BerechtigungsBefund | null>(null);
  let pruefungLaeuft = $state(false);
  let pruefungFehler = $state<string | null>(null);

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  const uebrigeMitglieder = $derived(mitglieder.filter((m) => m.rolle !== 'Eigentümer'));

  /**
   * Objekt-Auswahl aus dem EIGENEN, bereits projizierten Zustand des Clients (14-UI-SPEC.md
   * Komponentenkontrakt) — Name und Art je Objekt. Planner-Entscheidung (14-05-PLAN.md,
   * Ermessen): auf die drei am Tisch am häufigsten fachlich geprüften Kartenarten beschränkt
   * (Karten, Stapel, Zettel) statt aller 14 versionierten Arten — die Konsequenz ist bewusst:
   * der Eigentümer kann nur Objekte prüfen, die er selbst sieht, der Server lehnt jede fremde
   * Objektkennung ohnehin ab (Informationssparsamkeit aus berechtigung.ts).
   */
  function objekteAusState(state: DesktopState): { id: string; name: string; art: string }[] {
    const docs = (state.docs ?? []).map((d) => ({ id: d.id, name: d.name, art: 'Karte' }));
    const stacks = (state.stacks ?? []).map((s) => ({
      id: s.id,
      name: s.name && s.name.trim() !== '' ? s.name : `Stapel (${s.docIds?.length ?? 0})`,
      art: 'Stapel',
    }));
    const notes = (state.notes ?? []).map((n) => ({
      id: n.id,
      name: (n.text ?? '').trim().slice(0, 60) || 'Zettel',
      art: 'Zettel',
    }));
    return [...docs, ...stacks, ...notes];
  }

  const objekte = $derived(objekteAusState(desktop.state));

  async function ladeMitglieder(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) { mitgliederFehler = 'Nicht verbunden'; return; }
    mitgliederLaden = true;
    mitgliederFehler = null;
    try {
      mitglieder = await api.listMembers(id);
    } catch (e) {
      mitgliederFehler = e instanceof Error ? e.message : 'Mitgliederliste konnte nicht geladen werden';
    } finally {
      mitgliederLaden = false;
    }
  }

  async function pruefe(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id || ausgewaehlterUserId === '' || ausgewaehlteObjektId === '') { befund = null; return; }
    pruefungLaeuft = true;
    pruefungFehler = null;
    befund = null;
    try {
      befund = await api.getBerechtigung(id, ausgewaehlterUserId, ausgewaehlteObjektId);
    } catch (e) {
      pruefungFehler = e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Sichtbarkeit konnte nicht ermittelt werden.';
    } finally {
      pruefungLaeuft = false;
    }
  }

  // Die Auswahl selbst löst die Prüfung aus — kein „Prüfen"-Knopf (14-UI-SPEC.md).
  $effect(() => {
    void ausgewaehlterUserId;
    void ausgewaehlteObjektId;
    void pruefe();
  });

  function schliessen(): void {
    ui.berechtigungDialog = false;
    vorherFokussiert?.focus();
  }

  /** Tab-Bewegungen im Overlay halten (Fokusfalle) — identisches Muster zu ShareDialog.svelte. */
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
    if (ui.berechtigungDialog === false) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    mitglieder = [];
    mitgliederFehler = null;
    ausgewaehlterUserId = '';
    // Kontextmenü-Einstieg (menus.ts „Sichtbarkeit prüfen…") liefert eine vorbefüllte
    // Objektkennung mit; der Werkzeugleisten-Knopf öffnet leer (ein Feld, zwei Einstiege).
    ausgewaehlteObjektId = ui.berechtigungDialog.objektId ?? '';
    befund = null;
    pruefungFehler = null;
    void ladeMitglieder();
  });
</script>

{#if ui.berechtigungDialog !== false}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Sichtbarkeit prüfen" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>🛡 Sichtbarkeit prüfen</h2>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Sichtbarkeitsprüfung schließen">✕</button>
    </header>
    <p class="unterzeile">Wählen Sie einen Nutzer und ein Objekt — Sie erhalten die konkrete Begründung, nicht nur ja/nein.</p>

    <div class="inhalt">
      {#if mitgliederLaden}
        <p class="hinweis">Lädt…</p>
      {:else if mitgliederFehler}
        <div class="fehler">
          <p>{mitgliederFehler}</p>
          <button onclick={ladeMitglieder}>Erneut versuchen</button>
        </div>
      {:else if uebrigeMitglieder.length === 0}
        <p class="leer">Dieser Schreibtisch hat noch keine weiteren Mitglieder — laden Sie über „Teilen" jemanden ein, um die Sichtbarkeit zu prüfen.</p>
      {:else}
        <div class="feld">
          <label for="berechtigung-nutzer">Nutzer</label>
          <select id="berechtigung-nutzer" bind:value={ausgewaehlterUserId}>
            <option value="">— wählen —</option>
            {#each uebrigeMitglieder as m (m.userId)}
              <option value={m.userId} title={m.username}>{m.username}</option>
            {/each}
          </select>
        </div>
        <div class="feld">
          <label for="berechtigung-objekt">Objekt</label>
          <select id="berechtigung-objekt" bind:value={ausgewaehlteObjektId}>
            <option value="">— wählen —</option>
            {#each objekte as o (o.id)}
              <option value={o.id} title={o.name}>{o.name} ({o.art})</option>
            {/each}
          </select>
        </div>

        <div class="ergebnis">
          {#if ausgewaehlterUserId === '' || ausgewaehlteObjektId === ''}
            <p class="hinweis">Wählen Sie oben Nutzer und Objekt.</p>
          {:else if pruefungLaeuft}
            <p class="hinweis">Wird geprüft …</p>
          {:else if pruefungFehler}
            <div class="fehler">
              <p>Sichtbarkeit konnte nicht ermittelt werden. {pruefungFehler}</p>
              <button onclick={pruefe}>Erneut versuchen</button>
            </div>
          {:else if befund}
            {@const gewaehlterNutzer = mitglieder.find((m) => m.userId === ausgewaehlterUserId)}
            {@const gewaehltesObjekt = objekte.find((o) => o.id === ausgewaehlteObjektId)}
            <p class="befund-kopf">
              „{gewaehlterNutzer?.username ?? befund.nutzerName}" sieht „{gewaehltesObjekt?.name ?? befund.objektName}"
              {befund.sichtbar ? '' : 'NICHT '}weil:
            </p>
            <ul class="gruende">
              {#each befund.gruende as g, i (i)}
                <li>{g.text}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.berechtigungDialog !== false) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(560px, 92vw); max-height: min(70vh, 620px); display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 16px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  .unterzeile { margin: 0; padding: 0 16px 12px; font-size: 12px; opacity: .75; }
  .inhalt { overflow-y: auto; padding: 0 16px 0; display: flex; flex-direction: column; gap: 12px; }
  .feld { display: flex; flex-direction: column; gap: 4px; }
  .feld label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  select { font: inherit; font-size: 13px; border-radius: 6px; border: 1px solid var(--glass-border); background: var(--glass-card-bg); color: var(--glass-text); padding: 6px 8px; }
  .ergebnis { margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--glass-border); }
  .befund-kopf { margin: 0 0 8px; font-size: 13px; line-height: 1.5; }
  .gruende { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.5; display: flex; flex-direction: column; gap: 4px; }
  .leer { padding: 12px 4px; font-size: 13px; opacity: .75; }
  .hinweis, .fehler { padding: 8px 4px; font-size: 13px; opacity: .75; }
  .fehler button { margin-top: 6px; border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text); cursor: pointer; font-size: 12px; padding: 6px 10px; }
</style>
