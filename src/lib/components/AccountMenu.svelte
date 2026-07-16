<script lang="ts">
  import { desktop } from '../store.svelte';
  import { showToast } from '../ui.svelte';
  import UserAdmin from './UserAdmin.svelte';

  let open = $state(false);
  let mode = $state<'menue' | 'passwort'>('menue');
  let adminOffen = $state(false);
  let altesPasswort = $state('');
  let neuesPasswort = $state('');
  let busy = $state(false);

  function toggle() {
    open = !open;
    mode = 'menue';
    altesPasswort = '';
    neuesPasswort = '';
  }

  async function passwortAendern() {
    if (!desktop.api || busy) return;
    if (neuesPasswort.length < 8) {
      showToast('Passwort muss mindestens 8 Zeichen haben');
      return;
    }
    busy = true;
    try {
      await desktop.api.changePassword(altesPasswort, neuesPasswort);
      showToast('Passwort geändert');
      open = false;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ändern fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function abmelden() {
    open = false;
    await desktop.api?.logout().catch(() => {});
    await desktop.stop(); // status 'loggedOut' → +page wechselt zur Login-Maske
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="konto">
  <button class="current" onclick={toggle}>{desktop.me?.username ?? '…'} ▾</button>
  {#if open}
    <div class="backdrop" onpointerdown={(e) => { e.stopPropagation(); open = false; }}></div>
    <div class="menu" onpointerdown={(e) => e.stopPropagation()}>
      {#if mode === 'menue'}
        <button class="item" onclick={() => (mode = 'passwort')}>Passwort ändern…</button>
        {#if desktop.me?.isAdmin}
          <button class="item" onclick={() => { adminOffen = true; open = false; }}>Benutzerverwaltung…</button>
        {/if}
        <button class="item" onclick={() => void abmelden()}>Abmelden</button>
      {:else}
        <input type="password" placeholder="Aktuelles Passwort" bind:value={altesPasswort} autocomplete="current-password" />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="password"
          placeholder="Neues Passwort (min. 8 Zeichen)"
          bind:value={neuesPasswort}
          autocomplete="new-password"
          onkeydown={(e) => {
            if (e.key === 'Enter') void passwortAendern();
            if (e.key === 'Escape') {
              e.stopPropagation();
              mode = 'menue';
            }
          }}
        />
        <div class="row">
          <button class="item" onclick={() => (mode = 'menue')}>Abbrechen</button>
          <button class="item" disabled={busy} onclick={() => void passwortAendern()}>OK</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if adminOffen}
  <UserAdmin onClose={() => (adminOffen = false)} />
{/if}

<style>
  .konto { position: relative; }
  .current { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
             background: rgba(255, 255, 255, .92); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  .menu { position: absolute; top: 36px; right: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; gap: 2px; }
  .item { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
          font-size: 13px; cursor: pointer; }
  .item:hover { background: #e8eefc; }
  .item:disabled { opacity: .5; cursor: default; }
  input { margin: 6px 6px 0; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 4px; padding: 6px; }
</style>
