<script lang="ts">
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import { exportiereDiagnosepaket } from '../deskAktionen';
  import { zeitpunktLang } from '../zeitformat';
  import type { DiagnoseBericht, DiagnoseStatus, DiagnoseZeile } from '../api';

  /**
   * Systemdiagnose-Overlay (OPS-02, 14-01/14-06): Eigentümer-only, ohne SQL und ohne
   * Serverzugang lesbar, wie es der Instanz geht. Struktur wortgleich zur großen Dialog-Klasse
   * (HistoryOverlay.svelte: Fokusfalle, Escape, `warOffen`-Öffnen-Effekt). Öffnen/Schließen
   * läuft self-contained über ui.systemdiagnoseOffen (dasselbe Muster wie ui.teilenOffen/
   * ui.historieOffen), NICHT über Props.
   *
   * SYSTEM-/SPEICHER-Zeilen tragen laut UI-SPEC keinen Statuspunkt — reine Fakten, außer bei
   * einer Warnschwelle (SPEICHER „Dateispeicher"). VERBINDUNGEN-/BACKUP-Zeilen sind doppelt
   * kodiert: 8px-Statuspunkt in der Zustandsfarbe PLUS Textlabel, nie Farbe allein
   * (Barrierefreiheits-Kontinuität).
   */

  // Feste Reihenfolge für den Ladezustand (bevor der Bericht da ist) — die Abschnittsstruktur
  // steht bereits, damit die Seite beim Nachladen nicht springt (UI-SPEC E2/loading).
  const SYSTEM_LABELS = ['J-Desk-Version', 'Datenbankschema', 'Node-Laufzeit', 'Betriebsmodus'];
  const VERBINDUNGEN_LABELS = ['Server', 'j-lawyer', 'Euro-Office-Vorschau', 'WebSocket (Live-Sync)'];
  const SPEICHER_LABELS = ['Datenbank', 'Dateispeicher'];
  const BACKUP_LABELS = ['Letzte Sicherung', 'Nächste geplante Sicherung'];

  let bericht = $state<DiagnoseBericht | null>(null);
  let laden = $state(false);
  let fehler = $state<string | null>(null);
  let sichertGerade = $state(false);
  let exportiertGerade = $state(false);

  let vorherFokussiert: HTMLElement | null = null;
  let schliessenKnopf = $state<HTMLButtonElement | null>(null);
  let warOffen = false;

  /**
   * WebSocket (Live-Sync)-Zeile: client-seitig aus dem bestehenden Reconnect-Zustand des Stores
   * abgeleitet (nicht vom Server) — die offene Sitzung ist ihr eigener Beweis, ein
   * Server-Roundtrip könnte den Zustand der FRAGENDEN Verbindung gar nicht beobachten. Reihenfolge
   * laut Copywriting Contract: Server, j-lawyer, Euro-Office-Vorschau, WebSocket (Live-Sync).
   */
  const liveSyncZeile = $derived<DiagnoseZeile>(
    desktop.status === 'online'
      ? { status: 'ok', label: 'WebSocket (Live-Sync)', wert: 'Verbunden' }
      : desktop.status === 'connecting'
        ? { status: 'warnung', label: 'WebSocket (Live-Sync)', ursache: 'Verbindung wird aufgebaut …' }
        : desktop.status === 'offline'
          ? { status: 'fehler', label: 'WebSocket (Live-Sync)', ursache: 'Verbindung getrennt.' }
          : { status: 'nicht-konfiguriert', label: 'WebSocket (Live-Sync)' },
  );
  const verbindungenZeilen = $derived(bericht ? [...bericht.verbindungen, liveSyncZeile] : []);

  /** Statuspunkt-Klasse — dieselben vier `.status-badge`-Farbwerte aus DocCard.svelte
   *  (`.neu`→ok, `.unerreichbar`→warnung, `.gone`→fehler, `.archiviert`→nicht-konfiguriert),
   *  hier direkt über den `DiagnoseStatus`-Wert als Klassenname (kein neuer Farbwert). */
  function punktKlasse(status: DiagnoseStatus): string {
    return status;
  }

  /** Zeilentext nach dem Copywriting Contract — Ursache und Empfehlung stehen getrennt in
   *  DiagnoseZeile, werden hier zu EINEM verständlichen Satz zusammengeführt (nie ein roher
   *  Stacktrace, das übernimmt bereits der Server, hier nur Formatierung). */
  function zeilenText(z: DiagnoseZeile): string {
    if (z.status === 'ok') return z.wert ?? 'Verbunden';
    if (z.status === 'nicht-konfiguriert') return 'Nicht konfiguriert';
    const praefix = z.status === 'warnung' ? 'Warnung' : 'Nicht erreichbar';
    const ursache = z.ursache ?? '';
    const empfehlung = z.empfehlung ? ` ${z.empfehlung}` : '';
    return `${praefix}: ${ursache}${empfehlung}`;
  }

  /** Größen lesbar formatieren (KB/MB/GB je nach Größenordnung, 14-06) — der Server liefert
   *  rohe Byte-Zahlen (`DiagnoseZeile.bytes`), damit die Formatierungslogik nicht doppelt
   *  (Server+Client) gepflegt wird. */
  function formatGroesse(bytes: number): string {
    const einheiten = ['B', 'KB', 'MB', 'GB', 'TB'];
    let wert = bytes;
    let i = 0;
    while (wert >= 1024 && i < einheiten.length - 1) {
      wert /= 1024;
      i += 1;
    }
    return i === 0 ? `${Math.round(wert)} ${einheiten[i]}` : `${wert.toFixed(1).replace('.', ',')} ${einheiten[i]}`;
  }

  /** SPEICHER-Zeilentext: „in Ordnung"-Fall zeigt formatierte Größe (+ Dateianzahl bei
   *  „Dateispeicher"); bei Warnschwelle übernimmt derselbe zeilenText()-Satz wie bei
   *  VERBINDUNGEN („Warnung: Speicher wird knapp — {X} frei") — Server setzt dafür `ursache`
   *  exakt im erwarteten Wortlaut. */
  function speicherZeilenText(z: DiagnoseZeile): string {
    if (z.status !== 'ok') return zeilenText(z);
    const groesse = z.bytes !== undefined ? formatGroesse(z.bytes) : '—';
    if (z.anzahl !== undefined) return `${groesse} (${z.anzahl} ${z.anzahl === 1 ? 'Datei' : 'Dateien'})`;
    return groesse;
  }

  /** BACKUP-Zeilentext: Zeitpunkt im gewohnten deutschen Format (zeitpunktLang, Bestandsmuster
   *  aus zeitformat.ts); die errechnete „Nächste geplante Sicherung" trägt den Hinweis, dass
   *  der Wert errechnet ist (D-C, nicht persistiert). Fehlt die Angabe (keine Sicherung
   *  vorhanden), steht dort eine klare Aussage statt einer Lücke oder eines erfundenen Werts. */
  function backupZeilenText(z: DiagnoseZeile): string {
    if (!z.zeitpunkt) return 'Noch keine Sicherung vorhanden.';
    const text = zeitpunktLang(new Date(z.zeitpunkt).getTime());
    return z.errechnet ? `${text} (errechnet)` : text;
  }

  async function laedt(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) { fehler = 'Nicht verbunden'; return; }
    laden = true;
    fehler = null;
    try {
      bericht = await api.getDiagnose(id);
    } catch (e) {
      fehler = e instanceof Error ? e.message : 'Systemdiagnose konnte nicht geladen werden';
    } finally {
      laden = false;
    }
  }

  /** „Jetzt sichern" (SAFE-03, 14-06): löst die vorhandene Sicherungsroutine aus und lädt
   *  danach den Abschnitt neu (Zeile ist automatisch aktuell — keine zweite Sicherungslogik).
   *  Während des Laufs deaktiviert; Fehler erscheinen als Kurzmeldung, nicht als Seitenfehler
   *  (die Fläche bleibt bedienbar). */
  async function jetztSichern(): Promise<void> {
    const api = desktop.api;
    const id = desktop.deskId;
    if (!api || !id) return;
    sichertGerade = true;
    try {
      await api.sicherJetzt(id);
      await laedt();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Die Sicherung ist fehlgeschlagen.');
    } finally {
      sichertGerade = false;
    }
  }

  /** Diagnosepaket-Export (OPS-02/OPS-05, 14-06): exportiereDiagnosepaket() übernimmt bereits
   *  Erfolgs-/Fehler-Kurzmeldung und 403-Sonderfall (deskAktionen.ts) — hier nur der
   *  Ladezustand für den Fußzeilenknopf. */
  async function exportieren(): Promise<void> {
    const id = desktop.deskId;
    if (!id) return;
    exportiertGerade = true;
    try {
      await exportiereDiagnosepaket(id);
    } finally {
      exportiertGerade = false;
    }
  }

  function schliessen(): void {
    ui.systemdiagnoseOffen = false;
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

  // Reagiert NUR auf den Übergang geschlossen -> offen (Guard via warOffen) — identisches
  // Muster zu ShareDialog.svelte/HistoryOverlay.svelte. Kein Polling: die Seite prüft beim
  // Öffnen einmal (T-14-01-05); „Erneut prüfen" (Kopfzeile) ist die einzige weitere Auslösung —
  // KEIN Auto-Refresh-Intervall, eine reine Diagnoseseite soll keinen Netzwerk-Lärm erzeugen.
  $effect(() => {
    if (!ui.systemdiagnoseOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    queueMicrotask(() => schliessenKnopf?.focus());
    bericht = null;
    fehler = null;
    void laedt();
  });
</script>

{#if ui.systemdiagnoseOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Systemdiagnose" tabindex="-1" onkeydown={fokusFalle}>
    <header>
      <h2>🩺 Systemdiagnose</h2>
      <div class="kopf-aktionen">
        <button class="erneut" onclick={laedt} disabled={laden} title="Erneut prüfen">Erneut prüfen</button>
        <button class="schliessen" bind:this={schliessenKnopf} onclick={schliessen} aria-label="Systemdiagnose schließen">✕</button>
      </div>
    </header>

    <div class="inhalt">
      {#if laden && !bericht}
        <div class="abschnitt">SYSTEM</div>
        {#each SYSTEM_LABELS as label (label)}
          <div class="eintrag">
            <span class="label">{label}</span>
            <span class="wert">Wird geprüft …</span>
          </div>
        {/each}
        <div class="abschnitt">VERBINDUNGEN</div>
        {#each VERBINDUNGEN_LABELS as label (label)}
          <div class="eintrag verbindung">
            <span class="label">{label}</span>
            <span class="wert">Wird geprüft …</span>
          </div>
        {/each}
        <div class="abschnitt">SPEICHER</div>
        {#each SPEICHER_LABELS as label (label)}
          <div class="eintrag">
            <span class="label">{label}</span>
            <span class="wert">Wird geprüft …</span>
          </div>
        {/each}
        <div class="abschnitt">BACKUP</div>
        {#each BACKUP_LABELS as label (label)}
          <div class="eintrag">
            <span class="label">{label}</span>
            <span class="wert">Wird geprüft …</span>
          </div>
        {/each}
      {:else if fehler}
        <div class="fehler">
          <p>{fehler}</p>
          <button onclick={laedt}>Erneut versuchen</button>
        </div>
      {:else if bericht}
        {#if bericht.system.length > 0}
          <div class="abschnitt">SYSTEM</div>
          {#each bericht.system as z (z.label)}
            <div class="eintrag">
              <span class="label">{z.label}</span>
              <span class="wert">{z.wert}</span>
            </div>
          {/each}
        {/if}
        {#if verbindungenZeilen.length > 0}
          <div class="abschnitt">VERBINDUNGEN</div>
          {#each verbindungenZeilen as z (z.label)}
            <div class="eintrag verbindung">
              <span class="punkt {punktKlasse(z.status)}" aria-hidden="true"></span>
              <span class="label">{z.label}</span>
              <span class="wert">{zeilenText(z)}</span>
            </div>
          {/each}
        {/if}
        {#if bericht.speicher.length > 0}
          <div class="abschnitt">SPEICHER</div>
          {#each bericht.speicher as z (z.label)}
            <div class="eintrag {z.status !== 'ok' ? 'verbindung' : ''}">
              {#if z.status !== 'ok'}<span class="punkt {punktKlasse(z.status)}" aria-hidden="true"></span>{/if}
              <span class="label">{z.label}</span>
              <span class="wert">{speicherZeilenText(z)}</span>
            </div>
          {/each}
        {/if}
        {#if bericht.backup.length > 0}
          <div class="abschnitt">BACKUP</div>
          {#each bericht.backup as z (z.label)}
            <div class="eintrag {z.status !== 'ok' ? 'verbindung' : ''}">
              {#if z.status !== 'ok'}<span class="punkt {punktKlasse(z.status)}" aria-hidden="true"></span>{/if}
              <span class="label">{z.label}</span>
              <span class="wert">{backupZeilenText(z)}</span>
            </div>
          {/each}
          <div class="jetzt-sichern-zeile">
            <button
              class="sekundaer-knopf"
              onclick={jetztSichern}
              disabled={sichertGerade}
              title="Löst eine reguläre Sicherung sofort aus"
            >
              {sichertGerade ? 'Sicherung läuft …' : 'Jetzt sichern'}
            </button>
          </div>
        {/if}
      {/if}
    </div>

    <footer>
      <button
        class="sekundaer-knopf paket-export"
        onclick={exportieren}
        disabled={exportiertGerade}
        title="Lädt eine Datei mit technischen Diagnosedaten für den Support herunter. Enthält keine Mandantendaten oder Zugangsdaten."
      >
        {exportiertGerade ? 'Wird erstellt …' : '📦 Diagnosepaket exportieren'}
      </button>
    </footer>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.systemdiagnoseOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(720px, 94vw); max-height: min(80vh, 720px); display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 0 0 16px;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .kopf-aktionen { display: flex; align-items: center; gap: 8px; }
  .erneut { border: 1px solid var(--glass-border); border-radius: 6px; background: transparent;
            color: var(--glass-text); font-size: 12px; cursor: pointer; padding: 4px 10px; }
  .erneut:disabled { opacity: .5; cursor: default; }
  .schliessen { border: 0; background: transparent; font-size: 15px; cursor: pointer; padding: 4px 8px; }
  .inhalt { overflow-y: auto; padding: 0 16px; display: flex; flex-direction: column; gap: 2px; }
  .abschnitt { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
               opacity: .7; margin-top: 24px; }
  .abschnitt:first-child { margin-top: 0; }
  .eintrag {
    display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center;
    padding: 6px 4px; border-radius: 8px;
  }
  .eintrag.verbindung { grid-template-columns: 8px 1fr auto; }
  .eintrag:hover { background: var(--glass-hover); }
  .label { font-size: 13px; }
  .wert { font-size: 12px; opacity: .75; white-space: pre-wrap; }
  .hinweis, .fehler { padding: 18px 4px; font-size: 13px; opacity: .75; }
  .punkt { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  /* Statusfarben — Wiederverwendung der .status-badge-Palette (DocCard.svelte:424-429), kein
     neuer Farbwert: .neu (Grün) = ok, .unerreichbar (Amber) = warnung, .gone (Dunkelrot) =
     fehler, .archiviert (Grau) = nicht-konfiguriert. Doppelkodierung Punkt + Text ist Pflicht
     (Barrierefreiheit) — die Farbe ist nie der alleinige Träger der Information. */
  .punkt.ok { background: rgba(21, 92, 62, .88); }
  .punkt.warnung { background: rgba(150, 92, 10, .88); }
  .punkt.fehler { background: rgba(122, 32, 32, .88); }
  .punkt.nicht-konfiguriert { background: rgba(70, 70, 78, .88); }
  .jetzt-sichern-zeile { display: flex; justify-content: flex-end; padding: 8px 4px 0; }
  /* Sekundär-Button ohne Akzentfarbe (14-06, „Jetzt sichern"/Diagnosepaket-Export) — identischer
     Stil zum bestehenden „Erneut prüfen"-Knopf in der Kopfzeile, kein neuer Button-Fall. */
  .sekundaer-knopf {
    border: 1px solid var(--glass-border); border-radius: 6px; background: transparent;
    color: var(--glass-text); font-size: 12px; cursor: pointer; padding: 4px 10px;
  }
  .sekundaer-knopf:disabled { opacity: .5; cursor: default; }
  footer { padding: 12px 16px 0; border-top: 1px solid var(--glass-border); margin-top: 12px; }
  .paket-export { width: 100%; padding: 8px 10px; font-size: 13px; }
</style>
