<script lang="ts">
  /**
   * CommandPalette (UX-04, 13-09): Dialog-Klasse über der DOM-freien Befehls-Registry
   * (palette.ts) — Struktur wortgleich zu VorschlaegeDialog.svelte (.hintergrund/.overlay,
   * role="dialog", Fokusfalle, Escape schließt, warOffen-geschützter Öffnen-Effekt); abweichende
   * Maße (PALETTE_W, Top-Offset 96px, Listen-max-height 52vh — UI-SPEC Spacing Exceptions). Die
   * Eingabe selbst trägt die Heading-Typografie (15px/600) — kein separater Dialog-Titel
   * (UI-SPEC Komponentenkontrakt: „Eingabe oben (Heading 15px, autofokussiert)").
   *
   * Ausführung läuft AUSSCHLIESSLICH über Bestandspfade (kein zweiter Ausführungspfad,
   * must_haves key_links, 13-09-PLAN.md): ui-Schalter direkt, desktop.command()/desktop.jumpTo()
   * für Mutationen/Sprünge, dieselben Bausteine wie ViewSwitcher.svelte::anwenden()
   * (planeAnsichtAnwendung/resetVisibleLayers/toggleLayerVisibility) für Ansicht-Zeilen und
   * dieselbe Zentrier-Formel wie ZonenOverlay.svelte::zentriereAufZone() für Zonen-Zeilen.
   * Fuzzy-Filter und Rollen-/Kontext-Filterung sind reine Funktionen aus palette.ts (Task 1) —
   * synchron aus Client-Zustand, kein Server-Roundtrip beim Öffnen (E7/loading-dismissed).
   */
  import { untrack } from 'svelte';
  import { screenToWorld, type Viewport } from '@j-desk/core';
  import { desktop, resetVisibleLayers } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import {
    baueBefehle, filtereBefehle, sucheBefehle, ABSCHNITT_LABEL,
    type PaletteBefehl, type PaletteAbschnitt,
  } from '../palette';
  import { zurueck, vor, aufzeichnen, labelFuer, type VerlaufEintrag } from '../verlauf';
  import { leseAnsichten, sortiereAnsichten, planeAnsichtAnwendung, ansichtSpeichern, type Ansicht } from '../views';
  import { uid } from '../uid';
  import { exportAktuellenDesk } from '../deskAktionen';

  /** UI-SPEC Spacing Exceptions: breiter als ANSICHTEN_MENU_W, weil Zeilen Shortcut-Hinweise tragen. */
  const PALETTE_W = 'min(560px, 92vw)';
  const PALETTE_TOP = '96px';
  const PALETTE_LISTE_MAX_H = '52vh';
  /** Namensobergrenze für „Ansicht speichern…"/„Zone anlegen…" — deckungsgleich mit
   *  ANSICHT_NAME_MAX (views.ts) und ZONEN_NAME_MAX (packages/core/src/zonen.ts), beide 40. */
  const NAME_MAX = 40;

  let {
    vp = $bindable(),
    suchText = $bindable(),
    sucheOffen = $bindable(),
    viewW,
    viewH,
    onMinimapToggle,
  }: {
    vp: Viewport;
    suchText: string;
    sucheOffen: boolean;
    viewW: number;
    viewH: number;
    onMinimapToggle: () => void;
  } = $props();

  let eingabeEl = $state<HTMLInputElement | null>(null);
  let vorherFokussiert: HTMLElement | null = null;
  let warOffen = false;
  let filterText = $state('');
  let aktiveZeile = $state(0);
  /** Synchron aus localStorage geladen beim Öffnen (E7/loading dismissed, Muster ViewSwitcher). */
  let ansichten = $state<Ansicht[]>([]);

  const IST_MAC = typeof navigator !== 'undefined'
    && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  /** Plattform-Spiegelung (UI-SPEC): die Registry (palette.ts) speichert die kanonische
   *  ⌘-Form — hier wird für Nicht-macOS auf „Strg+" gespiegelt. */
  function anzeigeShortcut(s: string): string {
    return IST_MAC ? s : s.replace('⌘', 'Strg+');
  }

  const kontext = $derived({
    rolle: desktop.currentRolle,
    mode: desktop.mode,
    verlauf: ui.verlauf.eintraege,
    zonen: desktop.state.zones ?? [],
    ansichten,
  });
  const alleBefehle = $derived(baueBefehle(kontext));
  const sichtbareBefehle = $derived(filtereBefehle(alleBefehle, kontext));
  const treffer = $derived(sucheBefehle(sichtbareBefehle, filterText));

  /** Gruppiert die bereits sortierten Treffer für die Abschnitts-Zwischenzeilen im Markup —
   *  reine Anzeige-Umformung, ändert die Sortierung/Filterung nicht. */
  const gruppen = $derived.by(() => {
    const out: { abschnitt: PaletteAbschnitt; zeilen: PaletteBefehl[] }[] = [];
    for (const b of treffer) {
      const letzte = out[out.length - 1];
      if (letzte && letzte.abschnitt === b.abschnitt) letzte.zeilen.push(b);
      else out.push({ abschnitt: b.abschnitt, zeilen: [b] });
    }
    return out;
  });

  function schliessen(): void {
    ui.paletteOffen = false;
    vorherFokussiert?.focus();
  }

  /** Aktuell sichtbarer Weltausschnitt (Umkehrung von screenToWorld über die Bildschirmecken) —
   *  Grundlage für „Zone anlegen…" (erfasst den Ausschnitt bei Anlage, UI-SPEC). */
  function sichtbarerAusschnitt(): { x: number; y: number; w: number; h: number } {
    const oben = screenToWorld(vp, { x: 0, y: 0 });
    const unten = screenToWorld(vp, { x: viewW, y: viewH });
    return { x: oben.x, y: oben.y, w: unten.x - oben.x, h: unten.y - oben.y };
  }

  /** Öffnet ein Inline-Namensfeld über die Bestands-ui.menu-Form (Muster ZonenOverlay.svelte),
   *  zentriert im Bildschirm — die Palette ist bereits geschlossen, es gibt keinen Klickpunkt. */
  function inlineNameEingabe(placeholder: string, onSubmit: (text: string) => void): void {
    const x = Math.round(viewW / 2) - 110;
    const y = Math.round(viewH / 2) - 20;
    ui.menu = { x, y, items: [], input: { placeholder, maxlength: NAME_MAX, onSubmit } };
  }

  /** Wendet eine gespeicherte Ansicht an — wortgleich zu ViewSwitcher.svelte::anwenden()
   *  (dieselben Bausteine, kein zweiter Ausführungspfad). */
  function wendeAnsichtAn(a: Ansicht): void {
    const plan = planeAnsichtAnwendung(desktop.state, a);
    vp = plan.vp;
    resetVisibleLayers();
    const zielEbenen = new Set(plan.visibleLayers);
    for (const id of desktop.visibleLayers) if (!zielEbenen.has(id)) desktop.toggleLayerVisibility(id);
    suchText = plan.suchText;
    sucheOffen = plan.suchText !== '';
    ui.highlightedIds = plan.highlightedIds;
    for (const docId of plan.zuOeffnendeDocIds) void desktop.command('expandDoc', { id: docId });
    if (plan.fehlendeDocs > 0) {
      showToast(`${plan.fehlendeDocs} Dokument(e) aus dieser Ansicht sind nicht mehr vorhanden.`);
    }
    const eintrag: VerlaufEintrag = { vp: plan.vp, ausloeser: 'ansicht', label: labelFuer({ ausloeser: 'ansicht', name: a.name }) };
    ui.verlauf = aufzeichnen(ui.verlauf, eintrag);
  }

  /** Zentriert auf eine Zone — wortgleich zu ZonenOverlay.svelte::zentriereAufZone(). */
  function springeZuZone(zoneId: string): void {
    const zone = (desktop.state.zones ?? []).find((z) => z.id === zoneId);
    if (!zone) return;
    const cx = zone.rect.x + zone.rect.w / 2;
    const cy = zone.rect.y + zone.rect.h / 2;
    vp = { scale: vp.scale, x: viewW / 2 - cx * vp.scale, y: viewH / 2 - cy * vp.scale };
    const eintrag: VerlaufEintrag = { vp, ausloeser: 'zone', label: labelFuer({ ausloeser: 'zone', name: zone.name }) };
    ui.verlauf = aufzeichnen(ui.verlauf, eintrag);
  }

  /** Direkter Sprung zu einem Verlauf-Eintrag (13-05-Verlaufsnavigation) — bewegt NUR den
   *  Zeiger auf den gewählten Index, zeichnet KEINEN neuen Eintrag auf (wie ⌥←/⌥→). */
  function springeZuVerlaufsEintrag(idx: number): void {
    const eintrag = ui.verlauf.eintraege[idx];
    if (!eintrag) return;
    ui.verlauf = { ...ui.verlauf, zeiger: idx };
    vp = eintrag.vp;
  }

  /**
   * Führt einen Befehl aus — die einzige Ausführungsstelle der Palette (E7/error: Fehler folgen
   * dem Bestandsfehlerpfad, die Palette zeigt keinen eigenen Fehlerzustand). Schließt danach
   * IMMER (Komponentenkontrakt: „Schließen: Escape, Backdrop-Klick, nach Ausführung").
   */
  function fuehreAus(b: PaletteBefehl): void {
    const ziel = b.aktion.ziel;
    schliessen();
    if (ziel === 'sucheOffen') { sucheOffen = true; return; }
    if (ziel === 'palette-schliessen' || ziel === 'noop') return;
    if (ziel.startsWith('werkzeug:')) { desktop.wechsleWerkzeug(ziel.slice('werkzeug:'.length)); return; }
    if (ziel === 'ansicht-speichern') {
      inlineNameEingabe('Name der Ansicht', (text) => {
        const deskId = desktop.deskId;
        if (!deskId) return;
        ansichtSpeichern(deskId, text, {
          vp: { x: vp.x, y: vp.y, scale: vp.scale },
          visibleLayers: [...desktop.visibleLayers],
          suchText: sucheOffen ? suchText : '',
          highlightedIds: [...ui.highlightedIds],
          openDocIds: desktop.state.docs.filter((d) => d.open === true).map((d) => d.id),
        }, new Date().toISOString(), uid());
      });
      return;
    }
    if (ziel === 'letzte-fundstelle') {
      if (ui.letzteFundstelle) void desktop.jumpTo(ui.letzteFundstelle);
      else showToast('Keine zuletzt aktive Fundstelle vorhanden.');
      return;
    }
    if (ziel === 'verlauf-zurueck' || ziel === 'verlauf-vor') {
      const naechster = ziel === 'verlauf-zurueck' ? zurueck(ui.verlauf) : vor(ui.verlauf);
      if (naechster.zeiger !== ui.verlauf.zeiger) { ui.verlauf = naechster; vp = naechster.eintraege[naechster.zeiger].vp; }
      return;
    }
    if (ziel === 'auswertungOffen') { ui.auswertungOffen = true; return; }
    if (ziel === 'vorschlaegeOffen') { ui.vorschlaegeOffen = true; return; }
    if (ziel === 'trashOpen') { ui.trashOpen = true; return; }
    if (ziel === 'aufraeumenOffen') { ui.aufraeumenOffen = true; return; }
    if (ziel === 'aufnahmeOffen') { ui.aufnahmeOffen = true; return; }
    if (ziel === 'zone-anlegen') {
      const rect = sichtbarerAusschnitt();
      inlineNameEingabe('Zonenname', (text) => void desktop.command('addZone', { name: text, rect }));
      return;
    }
    if (ziel === 'inboxOffen') { ui.inboxOffen = true; return; }
    if (ziel === 'minimap-toggle') { onMinimapToggle(); return; }
    if (ziel === 'sitzungsmappeOffen') { ui.sitzungsmappeOffen = true; return; }
    if (ziel === 'anlagenpaketOffen') { ui.anlagenpaketOffen = true; return; }
    if (ziel === 'uebergabeOffen') { ui.uebergabeOffen = true; return; }
    if (ziel === 'export') {
      const deskId = desktop.deskId;
      const name = desktop.desks.find((d) => d.id === deskId)?.name ?? 'Schreibtisch';
      if (deskId) void exportAktuellenDesk(deskId, name);
      return;
    }
    if (ziel === 'vorlagenOffen') { ui.vorlagenOffen = true; return; }
    if (ziel.startsWith('zone:')) { springeZuZone(ziel.slice('zone:'.length)); return; }
    if (ziel.startsWith('ansicht:')) {
      const a = ansichten.find((x) => x.id === ziel.slice('ansicht:'.length));
      if (a) wendeAnsichtAn(a);
      return;
    }
    if (ziel.startsWith('verlauf:')) { springeZuVerlaufsEintrag(Number(ziel.slice('verlauf:'.length))); return; }
  }

  /** Ein einzelnes Eingabefeld — die Fokusfalle hält den Fokus schlicht im Feld (kein Tab-Zyklus
   *  über mehrere Elemente nötig, anders als bei mehrteiligen Dialogen). */
  function fokusFalle(ev: KeyboardEvent): void {
    if (ev.key === 'Tab') ev.preventDefault();
  }

  function aufTastaturEingabe(ev: KeyboardEvent): void {
    ev.stopPropagation();
    if (ev.key === 'Escape') { schliessen(); return; }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (treffer.length > 0) aktiveZeile = Math.min(aktiveZeile + 1, treffer.length - 1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (treffer.length > 0) aktiveZeile = Math.max(aktiveZeile - 1, 0);
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const b = treffer[aktiveZeile];
      if (b) fuehreAus(b);
    }
  }

  // E7/zero-one-many: ein Treffer direkt aktiv, viele -> erste Zeile aktiv — die aktive Zeile
  // klemmt bei jeder Änderung der Trefferliste (Tippen) auf den gültigen Bereich zurück.
  $effect(() => {
    void treffer;
    aktiveZeile = 0;
  });

  // Öffnen-Effekt (warOffen-geschützt, Muster VorschlaegeDialog/ActivityOverlay): Fokus merken,
  // Eingabe fokussieren (E7/populated: „Eingabe fokussiert beim Öffnen"), Ansichten synchron aus
  // localStorage laden (E7/loading dismissed — kein eigener Ladepfad, Muster ViewSwitcher).
  $effect(() => {
    if (!ui.paletteOffen) { warOffen = false; return; }
    if (warOffen) return;
    warOffen = true;
    filterText = '';
    aktiveZeile = 0;
    vorherFokussiert = document.activeElement as HTMLElement | null;
    untrack(() => {
      ansichten = sortiereAnsichten(leseAnsichten(desktop.deskId ?? ''));
    });
    queueMicrotask(() => eingabeEl?.focus());
  });
</script>

{#if ui.paletteOffen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="hintergrund" onclick={schliessen}></div>
  <div
    class="overlay" role="dialog" aria-modal="true" aria-label="Befehle" tabindex="-1"
    style:width={PALETTE_W} style:top={PALETTE_TOP}
    onkeydown={fokusFalle}
  >
    <input
      bind:this={eingabeEl}
      class="eingabe"
      type="text"
      placeholder="Befehl suchen…"
      bind:value={filterText}
      aria-label="Befehl suchen"
      onkeydown={aufTastaturEingabe}
    />
    <div class="liste" style:max-height={PALETTE_LISTE_MAX_H}>
      {#if treffer.length === 0}
        <p class="keine">Keine Treffer für „{filterText}".</p>
      {:else}
        {#each gruppen as gruppe (gruppe.abschnitt)}
          <div class="abschnitt-label">{ABSCHNITT_LABEL[gruppe.abschnitt]}</div>
          {#each gruppe.zeilen as b (b.id)}
            {@const globalerIndex = treffer.indexOf(b)}
            <!-- svelte-ignore a11y_mouse_events_have_key_events -->
            <button
              class="item" class:aktiv={globalerIndex === aktiveZeile}
              onmouseenter={() => (aktiveZeile = globalerIndex)}
              onclick={() => fuehreAus(b)}
            >
              <span class="label">{b.label}</span>
              {#if b.shortcut}<span class="shortcut">{anzeigeShortcut(b.shortcut)}</span>{/if}
            </button>
          {/each}
        {/each}
      {/if}
    </div>
    <div class="fusszeile">↑↓ wählen · ⏎ ausführen · Esc schließen</div>
  </div>
{/if}

<svelte:window onkeydown={(ev) => { if (ev.key === 'Escape' && ui.paletteOffen) schliessen(); }} />

<style>
  .hintergrund { position: fixed; inset: 0; background: rgba(8, 20, 35, .35); z-index: 9750; }
  .overlay {
    position: fixed; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column;
    z-index: 9760; border-radius: 16px; padding: 8px 0 0;
    background: var(--glass-panel-bg, rgba(255, 255, 255, .82));
    color: var(--glass-text);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  }
  .eingabe {
    margin: 0 16px 8px; padding: 10px 12px; border: 1px solid var(--glass-border); border-radius: 10px;
    background: var(--glass-input-bg); color: var(--glass-text); font: inherit;
    font-size: 15px; font-weight: 600;
  }
  .eingabe:focus { outline: none; border-color: var(--brand-blue); }
  /* Liste scrollt innerhalb PALETTE_LISTE_MAX_H; Eingabe und Fußzeile stehen (E7/overflow). */
  .liste { overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 2px; }
  .abschnitt-label {
    padding: 6px 8px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--glass-text-secondary);
  }
  .item {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%;
    padding: 8px 10px; border-radius: 8px; border: none; background: transparent;
    color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer;
  }
  /* Aktive Zeile: identisches .item.aktiv-Muster wie Ebenen-/Ansichten-Umschalter (13-UI-SPEC Color). */
  .item:hover, .item.aktiv { background: var(--glass-hover); }
  .item.aktiv { box-shadow: inset 0 0 0 2px var(--brand-blue); }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shortcut { flex-shrink: 0; font-size: 12px; color: var(--glass-text-secondary); }
  .keine { margin: 0; padding: 16px; font-size: 13px; opacity: .75; }
  /* Fußzeile liegt AUSSERHALB der scrollenden .liste-Fläche und scrollt nie mit (E7/overflow). */
  .fusszeile {
    flex-shrink: 0; padding: 8px 16px; border-top: 1px solid var(--glass-separator);
    font-size: 12px; color: var(--glass-text-secondary);
  }
</style>
