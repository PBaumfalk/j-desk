<script lang="ts">
  import {
    deskBackground, DEFAULT_BACKGROUND, DESK_MATERIALS, DESK_THEME_IDS,
    type DeskBackground,
  } from '@j-desk/core';
  import { darfAktionClient, desktop } from '../store.svelte';
  import { deskAktionenFuerRolle, exportAktuellenDesk, toast403FallFuerDeskAktion } from '../deskAktionen';
  import { ApiError } from '../api';
  import { MATERIAL_LABELS, THEME_LABELS, themeSwatch } from '../deskThemes';
  import { showToast, toast403, ui } from '../ui.svelte';
  import { profilMenuZeilen } from '../deviceProfile';
  import { geraeteProfil, setzeProfilAuswahl } from '../deviceProfile.svelte';

  let open = $state(false);
  let mode = $state<'liste' | 'neu' | 'umbenennen' | 'gestaltung' | 'profil'>('liste');
  let nameEntwurf = $state('');
  let suche = $state('');

  const aktiv = $derived(desktop.desks.find((d) => d.id === desktop.deskId));
  const hintergrund = $derived(deskBackground(desktop.state));
  /** Wirksames Erscheinungsbild: lokale Regler-Vorschau vor dem gespeicherten Zustand. */
  const wirksam = $derived(ui.backgroundPreview ?? hintergrund);
  const akten = $derived(desktop.mode === 'jlawyer');
  /** PERM-04 (02-10): Rollen-Gating der drei Desk-Aktionen — ausgeblendet, nicht ausgegraut;
   *  reine Komfort-Schicht, die Server-Guards bleiben die Sicherheitsgrenze (T-02-10-01). */
  const aktionen = $derived(deskAktionenFuerRolle(desktop.currentRolle));
  const gefiltert = $derived(
    suche.trim() === ''
      ? desktop.desks
      : desktop.desks.filter((d) => d.name.toLowerCase().includes(suche.trim().toLowerCase())),
  );

  function toggle() {
    open = !open;
    mode = 'liste';
  }

  // Vorschau ist nur während des Ziehens im Gestaltungs-Modus gültig — jeder
  // Kontextwechsel (Menü zu, anderer Modus, Tischwechsel, Unmount) verwirft sie.
  $effect(() => {
    void open; void mode; void desktop.deskId;
    return () => { ui.backgroundPreview = null; };
  });

  function startNeu() {
    mode = 'neu';
    nameEntwurf = '';
  }

  function startUmbenennen() {
    mode = 'umbenennen';
    nameEntwurf = aktiv?.name ?? '';
  }

  async function bestaetigen() {
    const name = nameEntwurf.trim();
    if (!name) return;
    if (mode === 'neu') await desktop.createDesk(name);
    else if (mode === 'umbenennen' && desktop.deskId) await desktop.renameDesk(desktop.deskId, name);
    open = false;
  }

  /** Regler-Vorschau: Tisch folgt sofort, ohne Command (kein Sync-Spam beim Ziehen). */
  function vorschau(teil: Partial<DeskBackground>) {
    ui.backgroundPreview = { ...wirksam, ...teil };
  }

  /** Wert übernehmen: Vorschau beenden und als Command speichern (synct beim Loslassen). */
  async function uebernehmen(teil: Partial<DeskBackground>) {
    const ziel = { ...wirksam, ...teil };
    ui.backgroundPreview = null;
    await desktop.command('setBackground', { background: ziel });
  }

  /** 13-09 (UX-04): Ausführung liegt in deskAktionen.ts (exportAktuellenDesk) — derselbe
   *  Ausführungspfad wie der gleichnamige CommandPalette-Befehl (kein zweiter Wahrheitspfad). */
  async function exportieren(deskId: string, name: string) {
    open = false;
    await exportAktuellenDesk(deskId, name);
  }

  /** DeskSwitcher-Menüeintrag „Befehle…" (UX-04, 13-09): Touch-Paritäts-Einstieg in die Command
   *  Palette (⌘K bleibt der Tastaturweg) — die Palette selbst prüft ihren eigenen Kontext. */
  function befehlePaletteOeffnen() {
    open = false;
    ui.paletteOffen = true;
  }

  /** 03-10 (D-12): öffnet den Übergabe-Dialog (Format-Auswahl, Umfang, Freigabe-Statistik) —
   *  ersetzt den Tracer-Direkt-Download der Aufgabenliste aus 03-01. */
  function uebergabe() {
    open = false;
    ui.uebergabeOffen = true;
  }

  /** KONV-01 (10-01): öffnet den Anlagenpaket-Dialog — analog uebergabe(), kein Zwischendialog. */
  function anlagenpaket() {
    open = false;
    ui.anlagenpaketOffen = true;
  }

  /** Aktivitätsansicht (Phase 4, HIST-01): öffnet das eigenständige Audit-Panel. Gate ausschließlich
   *  auf `aktiv` (ein ausgewählter Schreibtisch), NICHT auf aktionen.export/import — Audit-Einsicht
   *  ist rollenunabhängig sichtbar, keine gefährliche Aktion (04-UI-SPEC.md Komponentenkontrakt). */
  function aktivitaet() {
    open = false;
    ui.aktivitaetOffen = true;
  }

  /**
   * DeskSwitcher-Menüeintrag „🎓 Sitzungsmappe…" (SESS-02, 11-05): öffnet den
   * Vorbereitungsdialog (SitzungsmappeDialog.svelte) — der Dialog ist der einzige Einstieg in
   * die Vorbereitung, und „Sitzung starten" im Dialog ist der einzige Einstieg in den
   * Sitzungsmodus. Muster identisch zu anlagenpaket(): Menü schließen, Overlay-Flag setzen.
   */
  function sitzungsmappeOeffnen() {
    open = false;
    ui.sitzungsmappeOffen = true;
  }

  /**
   * DeskSwitcher-Menüeintrag „📥 Inhalt aufnehmen…" (EXT-01, 13-06): öffnet den
   * AufnahmeDialog — Muster identisch zu anlagenpaket()/sitzungsmappeOeffnen(): Menü
   * schließen, Overlay-Flag setzen. Kein Rollen-Gate über `aktionen` (Aufnahme ist keine der
   * drei rollengebundenen Desk-Aktionen export/import/loeschen) — der Dialog selbst prüft
   * bei der j-lawyer-Ablage-Wahl über die Bestands-Command-/Route-Guards.
   */
  function aufnahmeOeffnen() {
    open = false;
    ui.aufnahmeOffen = true;
  }

  /**
   * DeskSwitcher-Menüeintrag „🤖 KI-Freigaben…" (AI-01, 12-06): der STÄNDIGE Einstieg in den
   * VorschlaegeDialog (Plan 12-07) — immer sichtbar, auch bei 0 wartenden Vorschlägen (der
   * Dialog zeigt dann seinen Leertext); öffnet nur den Dialog, kein Sofort-Effekt, kein
   * Zähler im Menüeintrag. Muster identisch zu anlagenpaket()/sitzungsmappeOeffnen():
   * Menü schließen, Overlay-Flag setzen.
   */
  function kiFreigaben() {
    open = false;
    ui.vorschlaegeOffen = true;
  }

  /**
   * DeskSwitcher-Menüeintrag „Neu aus Vorlage…" (TMPL-01, 13-07): öffnet den VorlagenDialog —
   * Muster identisch zu aufnahmeOeffnen()/kiFreigaben(): Menü schließen, Overlay-Flag setzen.
   */
  function vorlagenOeffnen() {
    open = false;
    ui.vorlagenOffen = true;
  }

  /**
   * DeskSwitcher-Menüeintrag „🧹 Schreibtisch aufräumen…" (UX-02, 13-08): öffnet den
   * AufraeumenDialog — Muster identisch zu aufnahmeOeffnen()/vorlagenOeffnen(): Menü schließen,
   * Overlay-Flag setzen. Rollen-Gate direkt an der Zeile (Bearbeitungsrecht, PERM-04-Matrix
   * 'manage' = Eigentümer+Bearbeiter, dieselbe Gruppe wie deskAktionen.ts import — Aufräumen
   * führt Bestands-Kommandos aus wie jede andere Bearbeitung, kein Sonder-Recht).
   */
  function aufraeumenOeffnen() {
    open = false;
    ui.aufraeumenOffen = true;
  }

  async function importieren(deskId: string) {
    open = false;
    const eingabe = document.createElement('input');
    eingabe.type = 'file';
    eingabe.accept = '.jdesk';
    eingabe.onchange = async () => {
      const datei = eingabe.files?.[0];
      if (!datei) return;
      if (!confirm('Der aktuelle Schreibtisch wird durch den Inhalt des Pakets ersetzt. Fortfahren?')) return;
      try {
        await desktop.api!.importDesk(deskId, datei);
      } catch (e) {
        // 403: siehe exportieren() — präziser Wortlaut statt generischem Guard-Text (02-10).
        if (e instanceof ApiError && e.status === 403) toast403(toast403FallFuerDeskAktion('import'), desktop.currentRolle);
        else showToast(e instanceof Error ? e.message : 'Der Import ist fehlgeschlagen.');
        return;
      }
      try {
        // refresh() wählt intern den richtigen Weg (getCaseDesk im j-lawyer-Modus,
        // getState eigenständig) — siehe store.svelte.ts:170.
        await desktop.refresh();
        showToast('Arbeitsstand importiert.');
      } catch {
        showToast('Arbeitsstand importiert. Die Ansicht konnte nicht aktualisiert werden — bitte neu laden.');
      }
    };
    eingabe.click();
  }

  async function loeschen() {
    if (!desktop.deskId || !aktiv) return;
    const ja = confirm(
      `„${aktiv.name}" löschen? Karten und Verknüpfungen dieses Schreibtischs werden entfernt. Die PDF-Dateien bleiben in der Server-Ablage erhalten.`,
    );
    if (ja) {
      await desktop.deleteDesk(desktop.deskId);
      open = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="switcher">
  <button class="current" onclick={toggle}>{aktiv?.name ?? '…'} ▾</button>
  {#if open}
    <div class="backdrop" role="presentation"
         onpointerdown={(e) => { e.stopPropagation(); open = false; }}></div>
    <div class="menu" role="menu" tabindex="-1" onpointerdown={(e) => e.stopPropagation()}>
      {#if mode === 'liste'}
        {#if akten}
          <input class="suche" placeholder="Akte suchen…" bind:value={suche}
                 onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); suche = ''; } }} />
        {/if}
        <div class="items">
          {#each gefiltert as desk (desk.id)}
            <button class="item" onclick={() => { void desktop.switchDesk(desk.id); open = false; suche = ''; }}>
              {desk.id === desktop.deskId ? '✓ ' : ''}{desk.name}
            </button>
          {/each}
          {#if gefiltert.length === 0}
            <div class="leer">Keine Treffer</div>
          {/if}
        </div>
        <hr />
        <button class="item" onclick={() => (mode = 'gestaltung')}>🎨 Gestaltung…</button>
        {#if aktiv && aktionen.export}
          <button class="item" onclick={() => void exportieren(aktiv.id, aktiv.name)}>📤 Arbeitsstand exportieren…</button>
        {/if}
        {#if aktiv && aktionen.export}
          <button class="item" onclick={uebergabe}>📨 Übergabe…</button>
        {/if}
        {#if aktiv && aktionen.export}
          <button class="item" onclick={anlagenpaket}>📑 Anlagenpaket…</button>
        {/if}
        {#if aktiv}
          <button class="item" onclick={sitzungsmappeOeffnen}>🎓 Sitzungsmappe…</button>
        {/if}
        {#if aktiv}
          <!-- 13-06 (EXT-01): Aktions-Cluster bei 📑 Anlagenpaket…/🎓 Sitzungsmappe…
               (Auslassungspunkte = Dialog, Bestandskonvention). -->
          <button class="item" onclick={aufnahmeOeffnen}>📥 Inhalt aufnehmen…</button>
        {/if}
        {#if aktiv && darfAktionClient(desktop.currentRolle, 'manage')}
          <!-- 13-08 (UX-02): Rollen-Gate über das Bearbeitungsrecht (Ausblendemuster, nicht
               ausgegraut) — der Server bleibt die eigentliche Grenze für jedes einzelne
               Bestands-Kommando, das der Dialog später dispatcht. -->
          <button class="item" onclick={aufraeumenOeffnen}>🧹 Schreibtisch aufräumen…</button>
        {/if}
        {#if aktiv}
          <!-- 12-06 (AI-01): ständiger Einstieg in die KI-Freigaben — IMMER sichtbar (auch bei
               0 wartenden Vorschlägen, der Dialog zeigt dann seinen Leertext), kein Zähler hier,
               kein Sofort-Effekt. Einsicht gilt für alle Desk-Rollen (Vorentscheidung A1) — kein
               Rollen-Gate an dieser Zeile. -->
          <button class="item" onclick={kiFreigaben}>🤖 KI-Freigaben…</button>
        {/if}
        {#if aktiv}
          <!-- 13-09 (UX-04): Touch-Paritäts-Einstieg in die Command Palette — nichts ist
               palette-exklusiv (⌘K bleibt der Tastaturweg, dieser Eintrag der Nicht-Tastatur-Weg). -->
          <button class="item" onclick={befehlePaletteOeffnen}>⌘ Befehle…</button>
        {/if}
        {#if aktiv}
          <!-- MOBILE-01/02 (11-09): Profil-Auswahl als fünfter Modus — dieselben vier Zeilen
               wie die Smartphone-Fußzeile, aktive Zeile trägt ihr „✓ "-Präfix bereits mit. -->
          <button class="item" onclick={() => (mode = 'profil')}>📱 Profil…</button>
        {/if}
        {#if aktiv && aktionen.import}
          <button class="item" onclick={() => void importieren(aktiv.id)}>📩 Arbeitsstand importieren…</button>
        {/if}
        {#if aktiv}
          <button class="item" onclick={aktivitaet}>🕘 Aktivität…</button>
        {/if}
        {#if !akten}
          <button class="item" onclick={startNeu}>🆕 Neuer Schreibtisch…</button>
          <!-- TMPL-01 (13-07, UI-SPEC-fixiert): der Eintrag fehlt im j-lawyer-Aktenmodus
               STRUKTURELL (dieselbe !akten-Bedingung wie „Neuer Schreibtisch…" oben) — dort
               entstehen Desks aus Akten, nicht aus Vorlagen; ausblenden, nicht ausgrauen. -->
          <button class="item" onclick={vorlagenOeffnen}>🗂 Neu aus Vorlage…</button>
          <button class="item" onclick={startUmbenennen}>✏️ Umbenennen…</button>
          {#if aktionen.loeschen}
            <button class="item gefahr" onclick={() => void loeschen()}>🗑 Löschen…</button>
          {/if}
        {/if}
      {:else if mode === 'profil'}
        <!-- E5/overflow: die Zeilen brechen um statt zu kürzen — die Angabe des erkannten
             Profils IST der Informationsgehalt dieser Zeile. -->
        {#each profilMenuZeilen(geraeteProfil.auswahl, geraeteProfil.erkannt) as zeile (zeile.wert)}
          <button class="item profil-zeile" onclick={() => { setzeProfilAuswahl(zeile.wert); mode = 'liste'; }}>
            {zeile.label}
          </button>
        {/each}
        <hr />
        <button class="item" onclick={() => (mode = 'liste')}>Zurück</button>
      {:else if mode === 'gestaltung'}
        <div class="abschnitt">Farbe</div>
        <div class="farben">
          {#each DESK_THEME_IDS as themeId (themeId)}
            <button class="farbe" class:aktiv={themeId === wirksam.themeId}
                    style={`background: ${themeSwatch(themeId)}`}
                    title={THEME_LABELS[themeId]} aria-label={THEME_LABELS[themeId]}
                    aria-pressed={themeId === wirksam.themeId}
                    onclick={() => void uebernehmen({ themeId })}></button>
          {/each}
        </div>
        <div class="abschnitt">Material</div>
        {#each DESK_MATERIALS as material (material)}
          <button class="item" aria-pressed={material === wirksam.material}
                  onclick={() => void uebernehmen({ material })}>
            {material === wirksam.material ? '✓ ' : ''}{MATERIAL_LABELS[material]}
          </button>
        {/each}
        <div class="abschnitt">Helligkeit</div>
        <input class="regler" type="range" min="0.75" max="1.25" step="0.01" aria-label="Helligkeit"
               value={wirksam.brightness}
               oninput={(e) => vorschau({ brightness: Number(e.currentTarget.value) })}
               onchange={(e) => void uebernehmen({ brightness: Number(e.currentTarget.value) })} />
        <div class="abschnitt">Struktur</div>
        <input class="regler" type="range" min="0" max="1" step="0.01" aria-label="Strukturintensität"
               value={wirksam.textureIntensity}
               oninput={(e) => vorschau({ textureIntensity: Number(e.currentTarget.value) })}
               onchange={(e) => void uebernehmen({ textureIntensity: Number(e.currentTarget.value) })} />
        <label class="haken">
          <input type="checkbox" checked={wirksam.vignette}
                 onchange={(e) => void uebernehmen({ vignette: e.currentTarget.checked })} />
          Randabdunklung
        </label>
        <hr />
        <button class="item" onclick={() => void uebernehmen({ ...DEFAULT_BACKGROUND })}>Zurücksetzen</button>
        <div class="row">
          <button class="item" onclick={() => (mode = 'liste')}>Zurück</button>
        </div>
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          placeholder={mode === 'neu' ? 'Name des neuen Schreibtischs' : 'Neuer Name'}
          bind:value={nameEntwurf}
          onkeydown={(e) => {
            if (e.key === 'Enter') void bestaetigen();
            if (e.key === 'Escape') {
              e.stopPropagation();
              mode = 'liste';
            }
          }}
        />
        <div class="row">
          <button class="item" onclick={() => (mode = 'liste')}>Abbrechen</button>
          <button class="item" onclick={() => void bestaetigen()}>OK</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .switcher { position: fixed; top: 12px; left: 12px; z-index: 9000; }
  .current { font-size: 13px; padding: 6px 12px; border-radius: 8px;
             border: 1px solid var(--glass-border);
             background: var(--glass-card-bg); color: var(--glass-text);
             backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
             cursor: pointer; box-shadow: var(--glass-shadow); }
  .current:hover { background: var(--glass-elevated-bg); }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  .suche { margin: 2px; padding: 6px 8px; border: 1px solid var(--glass-separator); border-radius: 7px;
           background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 13px; }
  .items { max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; }
  .leer { padding: 8px 10px; font-size: 12px; color: var(--glass-text-secondary); }
  .menu { position: absolute; top: 36px; left: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: var(--glass-elevated-bg); color: var(--glass-text);
          border: 1px solid var(--glass-border);
          backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
          box-shadow: var(--glass-shadow-lg);
          display: flex; flex-direction: column; gap: 2px;
          max-height: calc(100vh - 56px); overflow-y: auto; }
  /* Regler: volle Menübreite, touch-freundlich; touch-action verhindert Scrollen beim Ziehen. */
  .regler { width: calc(100% - 20px); margin: 2px 10px 8px; accent-color: var(--brand-blue); touch-action: none; }
  .haken { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .item { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
          font-size: 13px; color: inherit; cursor: pointer; }
  .profil-zeile { white-space: normal; overflow-wrap: anywhere; }
  .item:hover { background: var(--glass-hover); }
  .item.gefahr { color: var(--brand-red); }
  hr { border: none; border-top: 1px solid var(--glass-separator); margin: 4px 0; }
  .abschnitt { padding: 6px 10px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
               color: var(--glass-text-secondary); }
  .farben { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 4px 10px 6px; }
  .farbe { width: 34px; height: 34px; border-radius: 50%; border: 2px solid var(--glass-separator);
           cursor: pointer; padding: 0; }
  .farbe:hover { transform: scale(1.08); }
  .farbe.aktiv { border-color: var(--brand-blue); box-shadow: 0 0 0 2px var(--glass-active); }
  input { margin: 6px; padding: 6px 8px; border: 1px solid var(--glass-separator); border-radius: 6px;
          background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 4px; padding: 0 6px 6px; }
</style>
