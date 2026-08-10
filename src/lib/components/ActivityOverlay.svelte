<script lang="ts">
  import { untrack } from 'svelte';
  import type { JournalEintragDto } from '@j-desk/core';
  import { desktop, darfAktionClient } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { ApiError } from '../api';
  import { beschreibe } from '../history';
  import { tag, uhrzeit, zeitpunktLang } from '../zeitformat';

  // Aktivitätsansicht (Phase 4, HIST-01): eigenständiges zweites Audit-Panel neben
  // HistoryOverlay.svelte (D-01, P-11 — dieses bleibt unangetastet, siehe ui.aktivitaetOffen).
  // Komponentenlokaler $state statt ui.historieEintraege-Muster: keine Sprung-Rückkehr hier,
  // daher lädt jedes Öffnen frisch (A-16).
  let eintraege = $state<JournalEintragDto[]>([]);
  let liste = $state<HTMLDivElement | null>(null);
  let laden = $state(false);
  let fehler = $state<string | null>(null);

  // Merkt sich den Modus des zuletzt GESTARTETEN Ladeversuchs (nicht nur des erfolgreichen),
  // damit "Erneut versuchen" genau den fehlgeschlagenen Schritt wiederholt — identisches Muster
  // zu HistoryOverlay.svelte laedt(). Ohne dieses Gedächtnis würde ein fehlgeschlagenes
  // "Mehr laden" beim Retry auf weiter=false zurückfallen und die bereits nachgeladenen Seiten
  // stillschweigend durch die erste Seite ersetzen.
  let letzterModus = false;

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  // Anzeige je Zeile über beschreibe(e, desktop.state); gerendert werden ausschließlich Akteur,
  // Zeit, Klartext und Badge des Übersetzungsergebnisses. Das Zitat-Feld und das Sprungziel-Feld
  // des Ergebnisses werden bewusst NICHT gelesen (P-10, D-02) — die Aktivitätsansicht kennt kein
  // Sprungziel und zeigt keinen Quelltext aus Dokumenten.
  const zeilen = $derived(eintraege.map((e) => beschreibe(e, desktop.state)));

  // HIST-02 (D-05): dasselbe Recht, das die Server-Route requireDeskAktion(db, 'manage')
  // erzwingt (Plan 04-01) — das Label ist Komfort, keine Sicherheitsgrenze (P-14).
  const darfWiederherstellen = $derived(darfAktionClient(desktop.currentRolle, 'manage'));

  // AI-02 (Plan 12-08): „Zurücknehmen" trägt dieselbe Rolle-gated Tragweite wie
  // „Wiederherstellen" — der Server (Route aus Plan 12-04) bleibt mit 'manage'-Guard und
  // 409-terminal die Grenze, das Label ist Komfort.
  const darfZuruecknehmen = $derived(darfAktionClient(desktop.currentRolle, 'manage'));

  /** String-Feld aus einem Journal-Payload (Fremdstruktur, deshalb defensiv wie in history.ts). */
  function payloadText(eintrag: JournalEintragDto, feld: string): string | undefined {
    const p = eintrag.payload && typeof eintrag.payload === 'object' ? (eintrag.payload as Record<string, unknown>) : {};
    const v = p[feld];
    return typeof v === 'string' && v !== '' ? v : undefined;
  }

  /** Boolean-Feld aus einem Journal-Payload (defensiv wie payloadText). */
  function payloadFlag(eintrag: JournalEintragDto, feld: string): boolean | undefined {
    const p = eintrag.payload && typeof eintrag.payload === 'object' ? (eintrag.payload as Record<string, unknown>) : {};
    const v = p[feld];
    return typeof v === 'boolean' ? v : undefined;
  }

  /** Terminal-Probe (AI-02/edge): zur vorschlagGenehmigt-Zeile existiert bereits eine spätere
   *  vorschlagZurueckgenommen-Zeile mit derselben vorschlagId — dann wird „Zurücknehmen" nicht
   *  erneut angeboten. Listenbasierte Ableitung (Komfort): jenseits der geladenen Seiten kann
   *  eine bereits zurückgenommene Zeile kurz als offen erscheinen; der Server-409-terminal
   *  bleibt die Wahrheit und wird ehrlich per Toast gemeldet (Planner-Annahme, 12-08-PLAN). */
  function istZurueckgenommen(eintraege: JournalEintragDto[], eintrag: JournalEintragDto): boolean {
    const vorschlagId = payloadText(eintrag, 'vorschlagId');
    if (vorschlagId === undefined) return false;
    return eintraege.some(
      (e) => e.type === 'vorschlagZurueckgenommen' && e.id > eintrag.id && payloadText(e, 'vorschlagId') === vorschlagId,
    );
  }

  /** id der Zeile mit laufendem Wiederherstellungs-Versuch, sonst null — sperrt parallele
   *  Läufe (T-04-24) und steuert den inerten Ladezustand der betroffenen Zeile. */
  let laeuftFuer = $state<number | null>(null);

  /** Zweistufige Bestätigung (D-06, P-13) vor jedem destruktiven Zustandsersatz. Bei Erfolg
   *  schließt das Panel — der neue Stand kommt ohnehin per WebSocket-Broadcast bei allen
   *  Clients an, inklusive diesem (D-08, siehe store.svelte.ts socket.onmessage). Bei Fehler
   *  bleibt das Panel offen und die geladene Liste erhalten (WR-05: präzise Server-Meldung
   *  hat Vorrang vor jedem Client-Wortlaut). */
  async function wiederherstellen(eintragId: number, zeitpunkt: number): Promise<void> {
    if (laeuftFuer !== null) return;
    const ja = confirm(
      `Schreibtisch auf den Stand vom ${zeitpunktLang(zeitpunkt)} zurücksetzen? Der aktuelle Stand wird automatisch gesichert und bleibt wiederherstellbar. Alle verbundenen Nutzer sehen die Änderung sofort.`,
    );
    if (!ja) return;
    laeuftFuer = eintragId;
    try {
      await desktop.api!.restoreDesk(desktop.deskId!, eintragId);
      schliessen();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) showToast(e.message);
      else showToast(`Der Stand konnte nicht wiederhergestellt werden. ${e instanceof Error ? e.message : ''}`.trim());
    } finally {
      laeuftFuer = null;
    }
  }

  /** Rücknahme einer KI-Übernahme (AI-02, Plan 12-08) — 1:1-Muster von wiederherstellen():
   *  zweistufiges confirm() mit dem Wortlaut aus dem 12-UI-SPEC Copywriting Contract,
   *  laeuftFuer-Sperre gegen Parallel-Läufe, ehrliche Fehler per Toast (WR-05: die präzise
   *  Server-Meldung — z.B. 409 „Objekt seit Übernahme verändert" oder Status-terminal —
   *  geht unverändert durch). Anders als die Wiederherstellung schließt Erfolg das Panel
   *  NICHT: die neue vorschlagZurueckgenommen-Zeile kommt per Broadcast, die Ansicht lädt
   *  danach wie üblich neu (Terminal-Probe aktualisiert sich mit der frischen Liste). */
  async function zuruecknehmen(eintragId: number, vorschlagId: string, zusammenfassung: string): Promise<void> {
    if (laeuftFuer !== null) return;
    const ja = confirm(
      `KI-Übernahme „${zusammenfassung}" zurücknehmen? Alle dabei entstandenen Objekte und Verknüpfungen werden entfernt bzw. zurückgesetzt. Die Rücknahme wird in der Historie festgehalten.`,
    );
    if (!ja) return;
    laeuftFuer = eintragId;
    try {
      await desktop.api!.nimmVorschlagZurueck(desktop.deskId!, vorschlagId);
      await laedt();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) showToast(e.message);
      else showToast(`Die KI-Übernahme konnte nicht zurückgenommen werden. ${e instanceof Error ? e.message : ''}`.trim());
    } finally {
      laeuftFuer = null;
    }
  }

  async function laedt(weiter = false): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    letzterModus = weiter;
    if (!api || !id) { fehler = 'Nicht verbunden'; return; }
    laden = true;
    fehler = null;
    try {
      const vorher = weiter ? eintraege.at(-1)?.id : undefined;
      const { entries } = await api.listJournal(id, { limit: 50, ...(vorher !== undefined ? { before: vorher } : {}) });
      eintraege = weiter ? [...eintraege, ...entries] : entries;
    } catch (e) {
      fehler = e instanceof Error ? e.message : 'Aktivität konnte nicht geladen werden';
    } finally {
      laden = false;
    }
  }

  function schliessen(): void {
    ui.aktivitaetOffen = false;
    vorherFokussiert?.focus();
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

  // Beim Öffnen: immer frisch laden (Seite 1) — anders als HistoryOverlay.svelte gibt es hier
  // keine Sprung-Rückkehr, die einen Zwischenspeicher rechtfertigen würde (A-16). Reagiert NUR auf
  // den Übergang geschlossen -> offen (Guard via warOffen); alle übrigen Reads bleiben deshalb in
  // untrack() gekapselt, damit ein "Mehr laden"/Retry (laedt() schreibt eintraege/laden/fehler)
  // diesen Effekt nicht erneut auslöst.
  $effect(() => {
    if (!ui.aktivitaetOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    untrack(() => {
      eintraege = [];
      void laedt();
    });
  });
</script>

{#if ui.aktivitaetOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Aktivität" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>Aktivität</h2>
      <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Aktivität schließen">✕</button>
    </header>

    <div class="liste" bind:this={liste}>
      {#each zeilen as e, i (e.id)}
        {#if i === 0 || tag(zeilen[i - 1].zeit) !== tag(e.zeit)}
          <div class="tagUeberschrift">{tag(e.zeit)}</div>
        {/if}
        {#if darfWiederherstellen}
          {@const roh = eintraege[i]}
          {@const vorschlagId = roh ? payloadText(roh, 'vorschlagId') : undefined}
          <!-- AI-02: offene KI-Genehmigungs-Zeilen (kein späterer Rücknahme-Eintrag zur selben
               vorschlagId in der geladenen Liste) bekommen statt „Wiederherstellen" die
               Zeilenaktion „Zurücknehmen" — gleiches Recht, gleiche Sperrlogik. WR-01 (It. 2):
               das serverseitig pro Empfänger berechnete Flag zuruecknehmenErlaubt hängt die
               Aktion an dieselbe Rechtepositions-Regel wie die Route (PERM-04-Ausblendemuster —
               Komfort, keine Sicherheitsgrenze; der generische 403 bleibt die Wahrheit). Fehlt
               das Flag (Alt-Stand), bleibt das bisherige Verhalten (`!== false`). -->
          {#if darfZuruecknehmen && roh?.type === 'vorschlagGenehmigt' && vorschlagId !== undefined && !istZurueckgenommen(eintraege, roh) && payloadFlag(roh, 'zuruecknehmenErlaubt') !== false}
            <button
              class="eintrag klickbar"
              class:laeuft={laeuftFuer === e.id}
              onclick={() => zuruecknehmen(e.id, vorschlagId, payloadText(roh, 'zusammenfassung') ?? 'Änderung')}
            >
              <span class="zeit">{uhrzeit(e.zeit)}</span>
              <span class="wer" title={e.akteur}>{e.akteur}</span>
              <span class="was">
                {#if e.badge}<span class="badge" title={e.badge.titel}>{e.badge.icon}</span>{/if}
                {e.text}
              </span>
              <span class="zuruecknehmen">{laeuftFuer === e.id ? 'Wird zurückgenommen…' : 'Zurücknehmen'}</span>
            </button>
          {:else}
            <button class="eintrag klickbar" class:laeuft={laeuftFuer === e.id} onclick={() => wiederherstellen(e.id, e.zeit)}>
              <span class="zeit">{uhrzeit(e.zeit)}</span>
              <span class="wer" title={e.akteur}>{e.akteur}</span>
              <!-- Klartext bleibt fest kurz (zeitformat.ts formatiert Heute/Gestern/TT.MM.JJJJ, HH:MM) —
                   kein variabler Umbruch, auch bei fernem Ziel-Datum einer Wiederherstellungs-Zeile. -->
              <span class="was">
                {#if e.badge}<span class="badge" title={e.badge.titel}>{e.badge.icon}</span>{/if}
                {e.text}
              </span>
              <span class="wiederherstellen">{laeuftFuer === e.id ? 'Wird wiederhergestellt…' : '↺ Wiederherstellen'}</span>
            </button>
          {/if}
        {:else}
          <div class="eintrag">
            <span class="zeit">{uhrzeit(e.zeit)}</span>
            <span class="wer" title={e.akteur}>{e.akteur}</span>
            <span class="was">
              {#if e.badge}<span class="badge" title={e.badge.titel}>{e.badge.icon}</span>{/if}
              {e.text}
            </span>
          </div>
        {/if}
      {:else}
        {#if !laden && !fehler}
          <p class="leer">Auf diesem Schreibtisch wurde noch nichts festgehalten.</p>
        {/if}
      {/each}

      {#if fehler}
        <div class="fehler">
          <p>{fehler}</p>
          <button onclick={() => laedt(letzterModus)}>Erneut versuchen</button>
        </div>
      {/if}

      {#if zeilen.length > 0 && !fehler}
        <button class="mehr" onclick={() => laedt(true)} disabled={laden || desktop.status !== 'online'}>
          {laden ? 'Lädt …' : 'Mehr laden'}
        </button>
      {/if}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.aktivitaetOffen) schliessen(); }} />

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
  .liste { overflow-y: auto; padding: 0 8px; }
  .tagUeberschrift { position: sticky; top: 0; padding: 6px 8px; font-size: 11px; text-transform: uppercase;
                      letter-spacing: .04em; opacity: .6; background: inherit; }
  /* Zeilenraster wie HistoryOverlay.svelte .eintrag: vier Spalten — die vierte nimmt seit Plan
     04-06 das Wiederherstellen-Label auf (nur mit manage-Recht, sonst bleibt sie leer). Button-
     Reset (border/background/font) gilt auch für die reine <div>-Fassung (Plan 04-05) — harmlos,
     macht aber beide Fassungen visuell ununterscheidbar, wie im Bestandsoverlay HistoryOverlay.svelte. */
  .eintrag { display: grid; grid-template-columns: auto auto 1fr auto; gap: 8px; align-items: baseline;
             width: 100%; text-align: left; padding: 7px 8px; border: 0; background: transparent;
             border-radius: 8px; font: inherit; color: inherit; }
  .klickbar { cursor: pointer; }
  .klickbar:hover, .klickbar:focus-visible { background: var(--glass-hover); }
  /* Ladezustand der laufenden Zeile (analog UebergabeDialog.svelte, hier auf Zeilenebene statt
     Button) — inert gegen Doppelklicks, alle übrigen Zeilen bleiben bedienbar. */
  .laeuft { pointer-events: none; opacity: .6; }
  /* Bewusste 600-Ausnahme auf Label-Größe (04-UI-SPEC.md Typography) — markiert die destruktive
     Aktion, analog DeskSwitcher.svelte .item.gefahr (Gewicht/Farbe statt Größe zur Abgrenzung). */
  .wiederherstellen { font-size: 12px; font-weight: 600; color: var(--brand-red); white-space: nowrap; }
  /* „Zurücknehmen" (AI-02) ist der vorgesehene, selbst journalierte Umkehrpfad — laut
     12-UI-SPEC nicht destruktiv im Rot-Sinn, daher neutraler Ton ohne brand-red; die
     Tragweite trägt das zweistufige confirm(), nicht die Farbe. */
  .zuruecknehmen { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .zeit { font-variant-numeric: tabular-nums; opacity: .6; font-size: 12px; font-weight: 400; }
  /* Überlauf (Verbesserung ggü. HistoryOverlay.svelte, das hier noch keine Ellipsis hat):
     Muster aus ShareDialog.svelte .name — title-Attribut trägt den Volltext. */
  .wer { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden;
         text-overflow: ellipsis; max-width: 160px; }
  .was { font-size: 13px; font-weight: 400; display: flex; align-items: center; gap: 4px; }
  /* Badge-Innenpolster verbatim aus DocCard.svelte .status-badge (2px 6px). */
  .badge { display: inline-flex; align-items: center; font-size: 12px; padding: 2px 6px; border-radius: 4px;
           background: var(--glass-card-bg); border: 1px solid var(--glass-border); }
  .leer, .fehler { padding: 18px 10px; font-size: 13px; opacity: .75; }
  .mehr { display: block; width: calc(100% - 16px); margin: 8px; padding: 8px; border-radius: 8px;
          border: 1px solid rgba(0, 0, 0, .12); background: transparent; cursor: pointer; font: inherit; }
  .mehr:disabled { opacity: .5; cursor: default; }
</style>
