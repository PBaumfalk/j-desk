<script lang="ts">
  import {
    deskBackground, DESK_MATERIALS, DESK_THEME_IDS,
    type DeskMaterial, type DeskThemeId,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { MATERIAL_LABELS, THEME_LABELS, themeSwatch } from '../deskThemes';

  let open = $state(false);
  let mode = $state<'liste' | 'neu' | 'umbenennen' | 'gestaltung'>('liste');
  let nameEntwurf = $state('');
  let suche = $state('');

  const aktiv = $derived(desktop.desks.find((d) => d.id === desktop.deskId));
  const hintergrund = $derived(deskBackground(desktop.state));
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

  /** Farbe/Material live umstellen — das Menü bleibt offen, damit man vergleichen kann. */
  async function waehleFarbe(themeId: DeskThemeId) {
    await desktop.command('setBackground', { background: { ...hintergrund, themeId } });
  }

  async function waehleMaterial(material: DeskMaterial) {
    await desktop.command('setBackground', { background: { ...hintergrund, material } });
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
    <div class="backdrop" role="presentation" onpointerdown={(e) => { e.stopPropagation(); open = false; }}></div>
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
            <button class="farbe" class:aktiv={themeId === hintergrund.themeId}
                    style={`background: ${themeSwatch(themeId)}`}
                    title={THEME_LABELS[themeId]} aria-label={THEME_LABELS[themeId]}
                    aria-pressed={themeId === hintergrund.themeId}
                    onclick={() => void waehleFarbe(themeId)}></button>
          {/each}
        </div>
        <div class="abschnitt">Material</div>
        {#each DESK_MATERIALS as material (material)}
          <button class="item" aria-pressed={material === hintergrund.material}
                  onclick={() => void waehleMaterial(material)}>
            {material === hintergrund.material ? '✓ ' : ''}{MATERIAL_LABELS[material]}
          </button>
        {/each}
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
  .current { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
             background: rgba(255, 255, 255, .92); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  .suche { margin: 2px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 7px; font: inherit; font-size: 13px; }
  .items { max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; }
  .leer { padding: 8px 10px; font-size: 12px; color: #888; }
  .menu { position: absolute; top: 36px; left: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; gap: 2px; }
  .item { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
          font-size: 13px; cursor: pointer; }
  .item:hover { background: #e8eefc; }
  .item.gefahr { color: #b02a2a; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 4px 0; }
  .abschnitt { padding: 6px 10px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  .farben { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 4px 10px 6px; }
  .farbe { width: 34px; height: 34px; border-radius: 50%; border: 2px solid rgba(0, 0, 0, .15);
           cursor: pointer; padding: 0; }
  .farbe:hover { transform: scale(1.08); }
  .farbe.aktiv { border-color: #2b5bd7; box-shadow: 0 0 0 2px rgba(43, 91, 215, .35); }
  input { margin: 6px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 4px; padding: 0 6px 6px; }
</style>
