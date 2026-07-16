<script lang="ts">
  import { ask } from '@tauri-apps/plugin-dialog';
  import { desktop } from '../store.svelte';

  let open = $state(false);
  let mode = $state<'liste' | 'neu' | 'umbenennen'>('liste');
  let nameEntwurf = $state('');

  const aktiv = $derived(desktop.desks.find((d) => d.id === desktop.deskId));

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

  async function loeschen() {
    if (!desktop.deskId || !aktiv) return;
    const ja = await ask(
      `„${aktiv.name}" löschen? Karten und Verknüpfungen dieses Schreibtischs werden entfernt. Die PDF-Dateien bleiben in der Server-Ablage erhalten.`,
      { title: 'Digital Desktop', kind: 'warning' },
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
    <div class="backdrop" onpointerdown={(e) => { e.stopPropagation(); open = false; }}></div>
    <div class="menu" onpointerdown={(e) => e.stopPropagation()}>
      {#if mode === 'liste'}
        {#each desktop.desks as desk (desk.id)}
          <button class="item" onclick={() => { void desktop.switchDesk(desk.id); open = false; }}>
            {desk.id === desktop.deskId ? '✓ ' : ''}{desk.name}
          </button>
        {/each}
        <hr />
        <button class="item" onclick={startNeu}>Neuer Schreibtisch…</button>
        <button class="item" onclick={startUmbenennen}>Umbenennen…</button>
        <button class="item gefahr" onclick={() => void loeschen()}>Löschen…</button>
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
  .menu { position: absolute; top: 36px; left: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; gap: 2px; }
  .item { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
          font-size: 13px; cursor: pointer; }
  .item:hover { background: #e8eefc; }
  .item.gefahr { color: #b02a2a; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 4px 0; }
  input { margin: 6px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 4px; padding: 0 6px 6px; }
</style>
