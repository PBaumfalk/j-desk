<script lang="ts">
  import { findSitzungsmappe, sprungmarkenFuerSitzungsmappe, naechsteKaskadenPosition, type Flag } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { erzeugeDiktatUi } from '../diktatUi.svelte';
  import { uid } from '../uid';
  import { fundstelleAusFlag } from '../jump';
  import { beendeSitzungsmodus, sitzungBeendenBeiVollbildwechsel, schalteVerschiebeSperre } from '../sitzungsmodus';
  import { bannerText, bannerSichtbar } from '../banner';

  // SESS-01 (11-UI-SPEC.md Spacing Exceptions): Mindestbreite/-höhe jedes interaktiven Elements
  // innerhalb dieser Vollbild-Chrome — deutlich über dem WCAG-Mindestmaß (44px). In den
  // Stilregeln unten über die CSS-Variable --session-touch-min verwendet (Svelte-Stilblöcke
  // können Skriptkonstanten nicht direkt referenzieren).
  const SESSION_TOUCH_MIN = 48;

  let el = $state<HTMLDivElement | null>(null);
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let notizText = $state('');
  let warOffen = false;

  /** SESS-03/empty: leeres oder nur aus Leerzeichen bestehendes Feld lässt sich nicht
   *  speichern — die Leerprüfung trimmt, der gespeicherte Text selbst bleibt unverändert. */
  const notizSpeicherbar = $derived(notizText.trim().length > 0);

  // ---- Diktat: Aufnahme mit anschließender Transkription (VOICE-01, 14-09) ----
  // Ersetzt die bisherige Live-Spracherkennung des Browsers vollständig; laufende Diktate enden
  // mit dem Panel bzw. der Sitzung (Verdrahtung inkl. Aufräumen gebündelt in diktatUi.svelte.ts,
  // WR-02: dieselbe Instanziierung wie NoteCard.svelte/LegalObjectCard.svelte — vorher rief NUR
  // diese Komponente `diktat.stop()` nicht in `onDestroy`, jetzt übernimmt das der gemeinsame
  // Composable automatisch für alle drei). Das Diktat schreibt NUR in dasselbe notizText-Feld —
  // der Bestandsweg der Sitzungsnotiz (temporär/offline-gepuffert über desktop.command/addNote)
  // bleibt unverändert. Der 🎤-Button fehlt ohne konfigurierte Transkription lautlos (fail-quiet).
  const diktatUi = erzeugeDiktatUi({
    // Hängt den transkribierten Text an notizText an — genau ein trennendes Leerzeichen, wenn
    // der Inhalt nicht auf Whitespace endet (unverändert aus 13-03).
    anhaengen: (t) => {
      const trenner = notizText.length > 0 && !/\s$/.test(notizText) ? ' ' : '';
      notizText = notizText + trenner + t;
    },
  });

  /** Diktat-Lebenszyklus an den des Editors gekoppelt: schließt das Notiz-Panel oder endet
   *  die Sitzung, endet auch ein laufendes Diktat (kein Waisen-Diktat, komponentenlokal). */
  $effect(() => {
    if (!ui.sitzungsmodusAktiv || !ui.sitzungsnotizOffen) diktatUi.beenden();
  });

  const mappe = $derived(
    ui.aktiveSitzungsmappeId ? findSitzungsmappe(desktop.state, ui.aktiveSitzungsmappeId) : undefined,
  );
  const sprungmarken = $derived<Flag[]>(mappe ? sprungmarkenFuerSitzungsmappe(desktop.state, mappe) : []);

  function dokumentname(docId: string): string {
    return desktop.state.docs.find((d) => d.id === docId)?.name ?? 'Unbekanntes Dokument';
  }

  /** SESS-03: eine gewöhnliche Notiz mit Kennzeichen über den Bestandspfad anlegen.
   *  desktop.command() reiht bei fehlender Verbindung selbst in die bestehende
   *  IndexedDB-Warteschlange ein — es gibt hier bewusst KEINEN zweiten Puffer und keinen
   *  eigenen Wiederholungspfad. Die clientseitig erzeugte id ist die Voraussetzung dafür,
   *  dass die bestehende Dubletten-Erkennung ein bereits angewendetes Erzeugungs-Kommando
   *  beim erneuten Abarbeiten der Warteschlange erkennt (belegt in offlineQueue.test.ts).
   *  WR-01: naechsteKaskadenPosition berücksichtigt auch Docs auf Kaskaden-Slots (Telefon-
   *  Foto-Uploads), damit eine Sitzungsnotiz nie deckungsgleich auf einem Foto landet. */
  function sitzungsnotizSpeichern(): void {
    const text = notizText; // unverändert übernommen — ohne Kürzung, ohne Normalisierung
    notizText = '';
    ui.sitzungsnotizOffen = false;
    void desktop.command('addNote', {
      kind: 'notiz',
      text,
      position: naechsteKaskadenPosition(desktop.state),
      id: uid(),
      sitzungsnotiz: true,
    });
  }

  /** Tab-Bewegungen in der Chrome halten (Fokusfalle) — wortgleiches Muster zu
   *  ActivityOverlay.svelte/AnlagenpaketDialog.svelte. */
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

  /** SESS-01/E3-error, SESS-01/concurrency (11-UI-SPEC.md): synchronisiert ui.sitzungsmodusAktiv
   *  mit dem tatsächlichen Fullscreen-Zustand — verlässt der Nutzer das Vollbild über Escape/
   *  OS-Geste statt über den „✕ Sitzung beenden"-Button, schließt sich die Chrome ebenso
   *  zuverlässig. Der Listener wird in der Aufräumfunktion wieder entfernt. */
  $effect(() => {
    if (!ui.sitzungsmodusAktiv) return;
    let warImVollbild = typeof document !== 'undefined' && !!document.fullscreenElement;
    const onFullscreenChange = () => {
      const imVollbild = !!document.fullscreenElement;
      if (sitzungBeendenBeiVollbildwechsel(warImVollbild, imVollbild)) beendeSitzungsmodus();
      warImVollbild = imVollbild;
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  });

  /** Öffnen-Effekt (Muster AnlagenpaketDialog.svelte/ActivityOverlay.svelte): fokussiert den
   *  Schließen-Knopf einmalig beim Übergang geschlossen -> offen (warOffen-Guard verhindert
   *  erneutes Fokussieren bei jedem Rerender, z. B. beim Öffnen/Schließen des Sprungmarken-Panels). */
  $effect(() => {
    if (!(ui.sitzungsmodusAktiv && mappe)) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    queueMicrotask(() => schliessenKnopf?.focus());
  });
</script>

{#if ui.sitzungsmodusAktiv && mappe}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="shell" bind:this={el} style:--session-touch-min={`${SESSION_TOUCH_MIN}px`}
       role="region" aria-label="Sitzungsmodus" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <div class="titel" title={mappe.titel}>{mappe.titel}</div>
      <div class="werkzeuge">
        <button class="sperre-knopf" class:aktiv={ui.verschiebeSperreAktiv}
                aria-pressed={ui.verschiebeSperreAktiv}
                title={ui.verschiebeSperreAktiv
                  ? 'Karten und Tisch sind gegen versehentliches Verschieben gesperrt — erneut tippen zum Aufheben'
                  : 'Karten und Tisch verschieben sperren'}
                onclick={schalteVerschiebeSperre}>
          {ui.verschiebeSperreAktiv ? '🔒 Verschiebe-Sperre aktiv' : '🔓 Verschiebe-Sperre'}
        </button>
        <button class="sprungmarken-knopf" onclick={() => (ui.sprungmarkenOffen = !ui.sprungmarkenOffen)}
                aria-expanded={ui.sprungmarkenOffen}>🎯 Sprungmarken</button>
        <button class="notiz-knopf" onclick={() => (ui.sitzungsnotizOffen = !ui.sitzungsnotizOffen)}
                aria-expanded={ui.sitzungsnotizOffen}>🎙 + Sitzungsnotiz</button>
      </div>
      <button class="beenden" bind:this={schliessenKnopf} onclick={beendeSitzungsmodus}>✕ Sitzung beenden</button>
    </header>
    {#if ui.sprungmarkenOffen}
      <div class="panel">
        {#if sprungmarken.length === 0}
          <p class="leer">Diese Sitzungsmappe enthält noch keine Sprungmarken.</p>
        {:else}
          {#each sprungmarken as flag (flag.id)}
            <button class="zeile" onclick={() => void desktop.jumpTo(fundstelleAusFlag(flag))}>
              <span class="swatch" style:background={flag.color}></span>
              <span class="name">{dokumentname(flag.docId)}</span>
              <span class="seite">Seite {flag.page}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
    {#if ui.sitzungsnotizOffen}
      <!-- SESS-03: großes Textfeld in Display-Typografie (18px/600/1.3) mit 48px-Speichern-Knopf;
           gespeichert wird eine gewöhnliche Notiz mit dem Kennzeichen sitzungsnotiz. -->
      <div class="panel notiz-panel">
        <textarea class="notiz-feld" bind:value={notizText} rows="5"
                  placeholder="Sitzungsnotiz…" aria-label="Sitzungsnotiz"></textarea>
        <div class="notiz-aktionen">
          {#if diktatUi.verfuegbar}
            <!-- 🎤 Diktieren (VOICE-01, 14-09): fail-quiet gerendert; 48px-Mindestziel und
                 Display-Typografie der Phase-11-Oberfläche (SESSION_TOUCH_MIN, kein neuer Wert).
                 Aktiver Zustand: Text + Accent-Stil (Doppelkodierung, 🔒-Sperre-Muster). -->
            <button type="button" class="diktat-knopf" class:laeuft={diktatUi.zustand === 'aufnahme'}
                    aria-pressed={diktatUi.zustand === 'aufnahme'}
                    aria-busy={diktatUi.zustand === 'transkription'}
                    disabled={diktatUi.zustand === 'transkription'}
                    onclick={diktatUi.startenStoppen}>
              {diktatUi.zustand === 'aufnahme'
                ? `■ Aufnahme läuft · ${diktatUi.laufzeit()} — Tippen zum Beenden`
                : diktatUi.zustand === 'transkription' ? 'Wird transkribiert …' : '🎤 Diktieren'}
            </button>
          {/if}
          <button class="speichern-knopf" disabled={!notizSpeicherbar} onclick={sitzungsnotizSpeichern}>Speichern</button>
        </div>
      </div>
    {/if}
    {#if bannerSichtbar(desktop.status, desktop.pendingCount)}
      <!-- SESS-03 (11-UI-SPEC „Wartestand-Banner im Sitzungsmodus-Chrome"): dasselbe Bannerelement
           und derselbe Wortlaut wie am normalen Tisch (Modul ../banner), an fester Position
           innerhalb der eigenen Chrome. Bewusste Abweichung vom Tischverhalten: KEIN modaler
           Blocker — die Sitzung darf durch eine Verbindungsstörung nicht unbedienbar werden,
           während die Erfassung (z. B. Sitzungsnotiz) weiterläuft. Es gibt keinen zweiten,
           feineren Indikator pro Notiz — nur diesen aggregierten Wartestand. -->
      <div class="banner" role="status" aria-live="polite">{bannerText(desktop.status, desktop.pendingCount)}</div>
    {/if}
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.sitzungsmodusAktiv) beendeSitzungsmodus(); }} />

<style>
  .shell { position: fixed; inset: 0; z-index: 9800; display: flex; flex-direction: column; pointer-events: none; }
  header { pointer-events: auto; display: flex; align-items: center; gap: 12px; padding: 8px 16px;
           background: var(--glass-panel-bg); border-bottom: 1px solid var(--glass-border);
           backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel); }
  /* Titel links, Werkzeuge mittig, Schließen rechts (Bestandsreihenfolge-Konvention, wie DocViewer.svelte). */
  .titel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
           font-size: 18px; font-weight: 600; line-height: 1.3; color: var(--glass-text); }
  .werkzeuge { display: flex; align-items: center; gap: 8px; flex: none; }
  button { font: inherit; cursor: pointer; }
  .sperre-knopf, .sprungmarken-knopf, .notiz-knopf, .beenden {
    min-width: var(--session-touch-min); min-height: var(--session-touch-min); padding: 0 16px;
    border-radius: 10px; border: 1px solid var(--glass-border); background: var(--glass-card-bg);
    color: var(--glass-text); font-size: 18px; font-weight: 600;
  }
  .sperre-knopf:hover, .sprungmarken-knopf:hover, .notiz-knopf:hover, .beenden:hover { background: var(--glass-elevated-bg); }
  /* Aktiver Zustand: Toggle-Optik wortgleich aus AuswertungsPanel.svelte .abfrage-knopf.aktiv. */
  .sperre-knopf.aktiv { background: var(--brand-blue-soft); border-color: var(--brand-blue); }
  .sperre-knopf.aktiv:hover { background: var(--brand-blue-soft); }
  .beenden { flex: none; }
  .panel { pointer-events: auto; max-width: min(420px, 92vw); margin: 8px 16px 0 auto;
           max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
           padding: 8px; border-radius: 12px; background: var(--glass-panel-bg);
           border: 1px solid var(--glass-border);
           backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel); }
  .zeile { display: flex; align-items: center; gap: 10px; min-height: var(--session-touch-min);
           padding: 0 10px; border-radius: 8px; border: none; background: none; color: var(--glass-text);
           text-align: left; width: 100%; }
  .zeile:hover { background: var(--glass-hover); }
  .swatch { width: 14px; height: 14px; border-radius: 50%; flex: none; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; }
  .seite { flex: none; font-size: 12px; color: var(--glass-text-secondary); }
  .leer { padding: 12px; font-size: 13px; color: var(--glass-text-secondary); }
  /* SESS-03: Erfassungsfläche — Display-Typografie (18px/600/1.3), Speichern-Knopf in 48px. */
  .notiz-panel { max-width: min(560px, 92vw); margin: 8px 16px 0 auto; gap: 8px; }
  .notiz-feld { width: 100%; box-sizing: border-box; resize: vertical; min-height: 120px;
                padding: 10px 12px; border-radius: 8px; border: 1px solid var(--glass-border);
                background: var(--glass-card-bg); color: var(--glass-text);
                font-size: 18px; font-weight: 600; line-height: 1.3; font-family: inherit; }
  .notiz-feld:focus { outline: 2px solid var(--brand-blue); outline-offset: -1px; }
  .speichern-knopf { align-self: flex-end; min-width: var(--session-touch-min); min-height: var(--session-touch-min);
                     padding: 0 20px; border-radius: 10px; border: 1px solid var(--brand-blue);
                     background: var(--brand-blue-soft); color: var(--glass-text);
                     font-size: 18px; font-weight: 600; }
  .speichern-knopf:hover:not(:disabled) { background: var(--glass-elevated-bg); }
  .speichern-knopf:disabled { opacity: 0.5; cursor: default; }
  /* Aktionszeile des Notiz-Panels (13-03): 🎤 links, Speichern rechts (margin-left:auto). */
  .notiz-aktionen { display: flex; align-items: center; gap: 8px; }
  .notiz-aktionen .speichern-knopf { margin-left: auto; }
  /* 🎤-Diktat-Knopf (VOICE-01, 14-09): erbt die Phase-11-Oberflächen-Konvention — 48px-
     Mindestziel (var(--session-touch-min)) und Display-Typografie 18px/600 ohne neuen Wert
     (UI-SPEC Typography); aktiver Zustand wortgleich zum .sperre-knopf.aktiv-Muster. */
  .diktat-knopf { min-width: var(--session-touch-min); min-height: var(--session-touch-min);
                  padding: 0 16px; border-radius: 10px; border: 1px solid var(--glass-border);
                  background: var(--glass-card-bg); color: var(--glass-text);
                  font-size: 18px; font-weight: 600; }
  .diktat-knopf:hover { background: var(--glass-elevated-bg); }
  .diktat-knopf.laeuft { background: var(--brand-blue-soft); border-color: var(--brand-blue); }
  .diktat-knopf.laeuft:hover { background: var(--brand-blue-soft); }
  /* Transkriptions-Zustand (14-09): gedämpft, nicht klickbar — kein neues Zeichen. */
  .diktat-knopf:disabled { opacity: .55; cursor: default; }
  /* Wortgleiche Stilregel wie .banner in Desktop.svelte — dasselbe Element, dieselbe Optik,
     feste Position innerhalb der Chrome (kein Blocker, siehe Kommentar im Markup). */
  .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
            border-radius: 999px; background: rgba(140, 60, 20, .9); color: #fff; font-size: 13px; z-index: 99000; }
</style>
