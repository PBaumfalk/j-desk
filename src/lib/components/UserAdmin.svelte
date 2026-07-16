<script lang="ts">
  import { ask } from '@tauri-apps/plugin-dialog';
  import { desktop } from '../store.svelte';
  import { showToast } from '../ui.svelte';
  import type { InviteInfo, UserInfo } from '../api';

  let { onClose }: { onClose: () => void } = $props();

  let users = $state<UserInfo[]>([]);
  let invites = $state<InviteInfo[]>([]);
  let neuName = $state('');
  let neuPasswort = $state('');
  let aktion = $state<{ userId: string; art: 'umbenennen' | 'passwort' } | null>(null);
  let aktionWert = $state('');
  let neuerCode = $state<string | null>(null);
  let busy = $state(false);

  async function laden() {
    if (!desktop.api) return;
    try {
      users = await desktop.api.listUsers();
      invites = (await desktop.api.listInvites()).filter((i) => i.deskId === null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Laden fehlgeschlagen');
    }
  }
  void laden();

  async function kontoAnlegen() {
    if (!desktop.api || busy || !neuName.trim() || !neuPasswort) return;
    busy = true;
    try {
      await desktop.api.createUser(neuName.trim(), neuPasswort);
      neuName = '';
      neuPasswort = '';
      showToast('Konto angelegt');
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Anlegen fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function aktionAusfuehren() {
    if (!desktop.api || !aktion || busy || !aktionWert) return;
    busy = true;
    try {
      if (aktion.art === 'umbenennen') await desktop.api.renameUser(aktion.userId, aktionWert.trim());
      else await desktop.api.resetUserPassword(aktion.userId, aktionWert);
      showToast(aktion.art === 'umbenennen' ? 'Umbenannt' : 'Passwort zurückgesetzt');
      aktion = null;
      aktionWert = '';
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function loeschen(user: UserInfo) {
    if (!desktop.api || busy) return;
    busy = true;
    try {
      const desks = await desktop.api.getUserDesks(user.id);
      const zusatz = desks.length
        ? `Folgende Schreibtische werden mitgelöscht: ${desks.map((d) => `„${d.name}"`).join(', ')}.`
        : 'Der Benutzer besitzt keine Schreibtische.';
      const ja = await ask(`Konto „${user.username}" löschen? ${zusatz}`, { title: 'Digital Desktop', kind: 'warning' });
      if (!ja) return;
      await desktop.api.deleteUser(user.id);
      showToast('Konto gelöscht');
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function einladungErstellen() {
    if (!desktop.api || busy) return;
    busy = true;
    try {
      neuerCode = (await desktop.api.createInvite()).token;
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Einladung fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function widerrufen(token: string) {
    if (!desktop.api || busy) return;
    busy = true;
    try {
      await desktop.api.revokeInvite(token);
      if (neuerCode === token) neuerCode = null;
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Widerruf fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function kopieren(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Code kopiert');
    } catch {
      showToast('Kopieren fehlgeschlagen — Code bitte markieren und kopieren');
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop" onpointerdown={onClose}></div>
<div class="dialog" onpointerdown={(e) => e.stopPropagation()}>
  <h2>Benutzerverwaltung</h2>

  <section>
    <h3>Konten</h3>
    {#each users as user (user.id)}
      <div class="zeile">
        <span class="name">{user.username}{user.isAdmin ? ' (Admin)' : ''}</span>
        {#if aktion?.userId === user.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            type={aktion.art === 'passwort' ? 'password' : 'text'}
            placeholder={aktion.art === 'umbenennen' ? 'Neuer Name' : 'Neues Passwort (min. 8 Zeichen)'}
            bind:value={aktionWert}
            onkeydown={(e) => {
              if (e.key === 'Enter') void aktionAusfuehren();
              if (e.key === 'Escape') {
                e.stopPropagation();
                aktion = null;
              }
            }}
          />
          <button onclick={() => void aktionAusfuehren()}>OK</button>
          <button onclick={() => (aktion = null)}>✕</button>
        {:else}
          <button onclick={() => { aktion = { userId: user.id, art: 'umbenennen' }; aktionWert = user.username; }}>Umbenennen</button>
          <button onclick={() => { aktion = { userId: user.id, art: 'passwort' }; aktionWert = ''; }}>Passwort</button>
          {#if user.id !== desktop.me?.id}
            <button class="gefahr" onclick={() => void loeschen(user)}>Löschen</button>
          {/if}
        {/if}
      </div>
    {/each}
    <div class="zeile neu">
      <input placeholder="Benutzername" bind:value={neuName} />
      <input type="password" placeholder="Anfangspasswort" bind:value={neuPasswort} />
      <button disabled={busy || !neuName.trim() || !neuPasswort} onclick={() => void kontoAnlegen()}>Neues Konto</button>
    </div>
  </section>

  <section>
    <h3>Konto-Einladungen</h3>
    {#if neuerCode}
      <div class="zeile code">
        <input readonly value={neuerCode} onfocus={(e) => (e.target as HTMLInputElement).select()} />
        <button onclick={() => void kopieren(neuerCode!)}>Kopieren</button>
      </div>
    {/if}
    {#each invites as invite (invite.token)}
      <div class="zeile">
        <span class="name mono">{invite.token.slice(0, 12)}… (gültig bis {new Date(invite.expiresAt).toLocaleDateString('de-DE')})</span>
        <button onclick={() => void widerrufen(invite.token)}>Widerrufen</button>
      </div>
    {/each}
    <div class="zeile neu">
      <button disabled={busy} onclick={() => void einladungErstellen()}>Einladung erstellen</button>
    </div>
  </section>

  <div class="fuss">
    <button onclick={onClose}>Schließen</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 9100; background: rgba(0, 0, 0, .35); }
  .dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 9101;
            width: 460px; max-height: 80vh; overflow: auto; padding: 20px; border-radius: 12px;
            background: rgba(255, 255, 255, .98); box-shadow: 0 16px 50px rgba(0, 0, 0, .45);
            display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 17px; }
  h3 { margin: 0 0 6px; font-size: 13px; color: #555; }
  section { display: flex; flex-direction: column; gap: 4px; }
  .zeile { display: flex; align-items: center; gap: 6px; }
  .zeile.neu { margin-top: 6px; }
  .name { flex: 1; font-size: 13px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  input { flex: 1; padding: 5px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; min-width: 0; }
  button { font-size: 12px; padding: 5px 9px; border-radius: 6px; border: none; background: #eef1f6; cursor: pointer; }
  button:hover { background: #e8eefc; }
  button:disabled { opacity: .5; cursor: default; }
  .gefahr { color: #b02a2a; }
  .code input { background: #f6f8e8; }
  .fuss { display: flex; justify-content: flex-end; }
</style>
