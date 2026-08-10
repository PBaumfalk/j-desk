<script lang="ts">
  import { effektiveFreigabe } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui, showToast, toast403 } from '../ui.svelte';
  import { ApiError } from '../api';
  import { toast403FallFuerDeskAktion } from '../deskAktionen';

  /**
   * Übergabe-Dialog (D-12, 03-10): einziger Einstieg in alle sechs Übergabeformate — Format-
   * Auswahl, Umfang, serverseitige Freigabe-Statistik vor der Erzeugung, Download-Auslösung.
   * Struktur identisch zu ShareDialog.svelte/KonfliktOverlay.svelte (zentriertes .overlay,
   * Header h2 + ✕, Fokusfalle) — Öffnen/Schließen läuft self-contained über ui.uebergabeOffen
   * (dasselbe Muster wie ui.teilenOffen), NICHT über Props. Ersetzt den Tracer-Direkt-Download
   * aus 03-01 im DeskSwitcher-Menü.
   *
   * Feste Abschnittsreihenfolge (UI-SPEC Komponentenkontrakt): FORMAT → UMFANG →
   * FREIGABE-STATISTIK → Buttons. Die Statistik wird beim Öffnen und bei jeder Format-/
   * Scope-Änderung neu vom SERVER geladen (projiziert — der Server zählt, der Client rät
   * nicht, D-08) und erscheint NIEMALS im Artefakt selbst.
   */

  type Format = 'dokument' | 'fundstellen' | 'snapshot' | 'argumentation' | 'beweismittel' | 'aufgaben';

  const FORMATE: { id: Format; titel: string; beschreibung: string }[] = [
    { id: 'dokument', titel: 'Annotierte PDF-Kopie', beschreibung: 'Dokument mit eingebrannten Annotationen als PDF' },
    { id: 'fundstellen', titel: 'Fundstellen-PDF', beschreibung: 'Ausgewählte Fundstellen mit Seitenausschnitt und Herkunftsnachweis' },
    { id: 'snapshot', titel: 'Schreibtisch-Snapshot', beschreibung: 'Visueller Abzug des Schreibtischs mit Objekt-Index' },
    { id: 'argumentation', titel: 'Argumentationsübersicht', beschreibung: 'Behauptungen, Belege und Gegenpositionen als PDF' },
    { id: 'beweismittel', titel: 'Beweismittelübersicht', beschreibung: 'Alle Beweismittel mit Fundstellen als PDF' },
    { id: 'aufgaben', titel: 'Aufgabenliste', beschreibung: 'Offene Zettel und Fähnchen als PDF' },
  ];

  let format = $state<Format>('dokument');
  let docId = $state<string | null>(null);
  let fundstellenAusgewaehlt = $state<Set<string>>(new Set());

  let statistik = $state<{ export: number; mandant: number; intern: number } | null>(null);
  let laden = $state(false);
  let fehler = $state<string | null>(null);
  let erzeugeLaeuft = $state(false);

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  /**
   * Umfang-Auswahl (Planner-Annahme, 03-10-PLAN.md): kompakte Auswahl IM Dialog — bei
   * „Annotierte PDF-Kopie" eine Radio-Liste der Dokumente (genau eines), bei „Fundstellen-PDF"
   * eine Checkbox-Liste (Mehrfachauswahl, alle vorausgewählt); beide nur aus Objekten, deren
   * effektive Freigabe bereits 'export' ist — ein Zielobjekt ohne Export-Freigabe würde vom
   * Server ohnehin abgelehnt (Doc-Gate 422 / leere Fundstellen-Menge 422), die Auswahl zeigt
   * also nur, was tatsächlich exportierbar ist.
   */
  const dokumentOptionen = $derived(
    (desktop.state.docs ?? []).filter((d) => effektiveFreigabe(d, desktop.state.layers) === 'export'),
  );
  const fundstellenOptionen = $derived(
    (desktop.state.cutouts ?? []).filter((c) => effektiveFreigabe(c, desktop.state.layers) === 'export'),
  );

  /** Leerformat (UI-SPEC Copywriting Contract): der Erzeugen-Button entfällt, statt in einen
   *  leeren Export zu führen — statistik.export ist die tatsächliche Kandidatenzahl, die der
   *  Server für DIESES Format ins Artefakt aufnehmen würde (deckungsgleich mit dem Doc-Gate /
   *  keine-fundstellen-Gate der jeweiligen Route). */
  const leer = $derived.by(() => {
    if (statistik === null) return false;
    if (format === 'aufgaben') return statistik.export === 0;
    if (format === 'fundstellen') return statistik.export === 0 || fundstellenAusgewaehlt.size === 0;
    return false;
  });

  const leerText = $derived(
    format === 'aufgaben'
      ? 'Keine offenen Aufgaben auf diesem Schreibtisch — die Übersicht wäre leer.'
      : 'Keine Fundstellen im gewählten Umfang — markieren Sie zuerst Fundstellen auf dem Schreibtisch.',
  );

  async function ladeStatistik(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) { fehler = 'Nicht verbunden'; return; }
    laden = true;
    fehler = null;
    try {
      statistik = await api.exportStatistik(id, format, format === 'dokument' ? (docId ?? undefined) : undefined);
    } catch (e) {
      fehler = e instanceof Error ? e.message : 'Statistik konnte nicht geladen werden';
    } finally {
      laden = false;
    }
  }

  function waehleFormat(neu: Format): void {
    format = neu;
    void ladeStatistik();
  }

  function waehleDokument(neu: string): void {
    docId = neu;
    void ladeStatistik();
  }

  function toggleFundstelle(id: string): void {
    const neu = new Set(fundstellenAusgewaehlt);
    if (neu.has(id)) neu.delete(id); else neu.add(id);
    fundstellenAusgewaehlt = neu;
    void ladeStatistik();
  }

  function schliessen(): void {
    ui.uebergabeOffen = false;
    vorherFokussiert?.focus();
  }

  /** Erzeugen-Klick (D-13): Download-Muster identisch zu DeskSwitcher.svelte exportieren()/
   *  uebergabe() — Blob → objectURL → temporärer a[download] → revoke im finally. Erfolg
   *  schließt den Dialog ohne Erfolgs-Toast (Bestandsmuster); Fehler lässt Format/Scope
   *  erhalten (Dialog bleibt offen) und zeigt die präzise Server-Meldung (WR-05). */
  async function erzeugen(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    const name = desktop.desks.find((d) => d.id === id)?.name ?? 'Schreibtisch';
    if (!api || !id || erzeugeLaeuft) return;
    if (format === 'dokument' && !docId) return;
    erzeugeLaeuft = true;
    let url: string | undefined;
    try {
      const blob = await api.exportPdf(id, format, {
        docId: format === 'dokument' ? (docId ?? undefined) : undefined,
        ids: format === 'fundstellen' ? [...fundstellenAusgewaehlt] : undefined,
      });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/[/\\:*?"<>|]/g, '-')}-${format}.pdf`;
      a.click();
      ui.uebergabeOffen = false;
      vorherFokussiert?.focus();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) toast403(toast403FallFuerDeskAktion('export'), desktop.currentRolle);
      else showToast(`Der Export ist fehlgeschlagen. ${e instanceof Error ? e.message : ''}`.trim());
    } finally {
      erzeugeLaeuft = false;
      if (url) URL.revokeObjectURL(url);
    }
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
    if (!ui.uebergabeOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    format = 'dokument';
    docId = dokumentOptionen[0]?.id ?? null;
    fundstellenAusgewaehlt = new Set(fundstellenOptionen.map((c) => c.id));
    statistik = null;
    fehler = null;
    void ladeStatistik();
  });
</script>

{#if ui.uebergabeOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Übergabe" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>Übergabe</h2>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Übergabe-Dialog schließen">✕</button>
    </header>

    <div class="inhalt">
      <div class="abschnitt">Format</div>
      <div class="formate">
        {#each FORMATE as f (f.id)}
          <label class="format-option">
            <input type="radio" name="uebergabe-format" checked={format === f.id} onchange={() => waehleFormat(f.id)} />
            <span class="format-text">
              <span class="format-titel">{f.titel}</span>
              <span class="format-beschreibung">{f.beschreibung}</span>
            </span>
          </label>
        {/each}
      </div>

      <div class="abschnitt">Umfang</div>
      {#if format === 'dokument'}
        {#if dokumentOptionen.length === 0}
          <p class="hinweis">Keine für den Export freigegebenen Dokumente auf diesem Schreibtisch.</p>
        {:else}
          <div class="umfang-liste">
            {#each dokumentOptionen as d (d.id)}
              <label class="umfang-option" title={d.name}>
                <input type="radio" name="uebergabe-dokument" checked={docId === d.id} onchange={() => waehleDokument(d.id)} />
                <span class="umfang-name">{d.name}</span>
              </label>
            {/each}
          </div>
        {/if}
      {:else if format === 'fundstellen'}
        {#if fundstellenOptionen.length === 0}
          <p class="hinweis">Keine für den Export freigegebenen Fundstellen auf diesem Schreibtisch.</p>
        {:else}
          <div class="umfang-liste">
            {#each fundstellenOptionen as c (c.id)}
              <label class="umfang-option" title={c.textSnapshot ?? c.sourceName ?? 'Ausschnitt'}>
                <input
                  type="checkbox"
                  checked={fundstellenAusgewaehlt.has(c.id)}
                  onchange={() => toggleFundstelle(c.id)}
                />
                <span class="umfang-name">{c.textSnapshot ?? c.sourceName ?? 'Ausschnitt'}</span>
              </label>
            {/each}
          </div>
        {/if}
      {:else}
        <p class="umfang-fest">Gesamter Schreibtisch</p>
      {/if}

      <div class="abschnitt">Freigabe-Statistik</div>
      <div class="statistik">
        {#if laden}
          <p class="hinweis">Lädt…</p>
        {:else if fehler}
          <div class="fehler">
            <p>{fehler}</p>
            <button onclick={ladeStatistik}>Erneut versuchen</button>
          </div>
        {:else if statistik}
          <p class="statistik-zeile statistik-gesamt">Im Export enthalten: {statistik.export} Objekte</p>
          <p class="statistik-zeile">Nicht enthalten: {statistik.intern} intern · {statistik.mandant} mandantensichtbar</p>
        {/if}
      </div>

      {#if leer}
        <p class="leerformat">{leerText}</p>
      {/if}

      <div class="aktionen">
        <button class="abbrechen" onclick={schliessen}>Abbrechen</button>
        {#if !leer}
          <button
            class="primaer"
            disabled={erzeugeLaeuft || (format === 'dokument' && !docId)}
            onclick={erzeugen}
          >
            {erzeugeLaeuft ? 'Erzeuge Übergabe…' : 'Übergabe erzeugen'}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.uebergabeOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(480px, 92vw); max-height: min(80vh, 640px); display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 16px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  .inhalt { overflow-y: auto; padding: 0 16px; display: flex; flex-direction: column; gap: 2px; }
  .abschnitt {
    padding: 4px 0 2px; margin-top: 12px; font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .04em; opacity: .7;
  }
  .abschnitt:first-child { margin-top: 0; }

  .formate { display: flex; flex-direction: column; gap: 2px; }
  .format-option { display: flex; align-items: flex-start; gap: 8px; padding: 6px 4px; border-radius: 8px; cursor: pointer; }
  .format-option:hover { background: var(--glass-hover); }
  .format-option input[type='radio'] { margin-top: 2px; accent-color: var(--brand-blue); }
  .format-text { display: flex; flex-direction: column; }
  .format-titel { font-size: 13px; }
  .format-beschreibung { font-size: 12px; opacity: .7; line-height: 1.4; }

  .umfang-fest { margin: 4px 0; font-size: 13px; opacity: .8; }
  .umfang-liste { max-height: 140px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .umfang-option { display: flex; align-items: center; gap: 8px; padding: 4px; border-radius: 6px; cursor: pointer; }
  .umfang-option:hover { background: var(--glass-hover); }
  .umfang-option input { accent-color: var(--brand-blue); flex-shrink: 0; }
  .umfang-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .statistik {
    background: var(--glass-card-bg); border: 1px solid var(--glass-border); border-radius: 8px;
    padding: 8px 10px; margin: 4px 0;
  }
  .statistik-zeile { margin: 0; font-size: 12px; line-height: 1.4; }
  .statistik-gesamt { font-size: 15px; font-weight: 600; margin-bottom: 2px; }

  .hinweis, .fehler p { margin: 0; font-size: 13px; opacity: .75; }
  .fehler { display: flex; flex-direction: column; gap: 6px; }
  .fehler button { align-self: flex-start; border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text); cursor: pointer; font-size: 12px; padding: 4px 8px; }

  .leerformat { margin: 8px 0 0; font-size: 13px; opacity: .8; }

  .aktionen { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
  .aktionen button {
    padding: 9px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
    background: transparent; color: var(--glass-text); cursor: pointer; font: inherit; font-size: 13px;
  }
  .aktionen button:hover { background: var(--glass-hover); }
  .aktionen .primaer { background: var(--brand-blue); color: #fff; border-color: transparent; }
  .aktionen .primaer:hover { background: var(--brand-blue); opacity: .9; }
  .aktionen .primaer:disabled { opacity: .5; cursor: default; }
</style>
