<script lang="ts">
  import {
    deskBackground, DEFAULT_BACKGROUND, DESK_MATERIALS, DESK_THEME_IDS,
    type DeskBackground,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { MATERIAL_LABELS, THEME_LABELS, themeSwatch } from '../deskThemes';
  import { ui } from '../ui.svelte';

  let open = $state(false);
  let mode = $state<'liste' | 'neu' | 'umbenennen' | 'gestaltung'>('liste');
  let nameEntwurf = $state('');
  let suche = $state('');

  const aktiv = $derived(desktop.desks.find((d) => d.id === desktop.deskId));
  const hintergrund = $derived(deskBackground(desktop.state));
  /** Wirksames Erscheinungsbild: lokale Regler-Vorschau vor dem gespeicherten Zustand. */
  const wirksam = $derived(ui.backgroundPreview ?? hintergrund);
  const akten = $derived(desktop.mode === 'jlawyer');
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
        <button class="item" onclick={() => (mode = 'gestaltung')}>Gestaltung…</button>
        {#if !akten}
          <button class="item" onclick={startNeu}>Neuer Schreibtisch…</button>
          <button class="item" onclick={startUmbenennen}>Umbenennen…</button>
          <button class="item gefahr" onclick={() => void loeschen()}>Löschen…</button>
        {/if}
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
