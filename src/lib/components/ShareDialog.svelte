<script lang="ts">
  import { desktop } from '../store.svelte';
  import { showToast } from '../ui.svelte';
  import type { DeskInfo, InviteInfo, MemberInfo, UserInfo } from '../api';

  let { desk, onClose }: { desk: DeskInfo; onClose: () => void } = $props();

  let members = $state<MemberInfo[]>([]);
  let users = $state<UserInfo[]>([]);
  let invites = $state<InviteInfo[]>([]);
  let auswahl = $state('');
  let neuerCode = $state<string | null>(null);
  let busy = $state(false);

  const kandidaten = $derived(
    users.filter((u) => u.id !== desk.ownerId && !members.some((m) => m.id === u.id)),
  );

  async function laden() {
    if (!desktop.api) return;
    try {
      members = await desktop.api.listMembers(desk.id);
      users = await desktop.api.listUsers();
      invites = (await desktop.api.listInvites()).filter((i) => i.deskId === desk.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Laden fehlgeschlagen');
    }
  }
  void laden();

  async function hinzufuegen() {
    if (!desktop.api || busy || !auswahl) return;
    busy = true;
    try {
      await desktop.api.addMember(desk.id, auswahl);
      auswahl = '';
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Hinzufügen fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function entfernen(member: MemberInfo) {
    if (!desktop.api || busy) return;
    busy = true;
    try {
      await desktop.api.removeMember(desk.id, member.id);
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function einladungErstellen() {
    if (!desktop.api || busy) return;
    busy = true;
    try {
      neuerCode = (await desktop.api.createInvite(desk.id)).token;
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
  <h2>„{desk.name}" teilen</h2>

  <section>
    <h3>Mitglieder</h3>
    {#if members.length === 0}
      <p class="leer">Noch keine Mitglieder.</p>
    {/if}
    {#each members as member (member.id)}
      <div class="zeile">
        <span class="name">{member.username}</span>
        <button onclick={() => void entfernen(member)}>✕</button>
      </div>
    {/each}
    <div class="zeile neu">
      <select bind:value={auswahl}>
        <option value="" disabled>Benutzer wählen…</option>
        {#each kandidaten as user (user.id)}
          <option value={user.username}>{user.username}</option>
        {/each}
      </select>
      <button disabled={busy || !auswahl} onclick={() => void hinzufuegen()}>Hinzufügen</button>
    </div>
  </section>

  <section>
    <h3>Einladungen für diesen Schreibtisch</h3>
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
            width: 420px; max-height: 80vh; overflow: auto; padding: 20px; border-radius: 12px;
            background: rgba(255, 255, 255, .98); box-shadow: 0 16px 50px rgba(0, 0, 0, .45);
            display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 17px; }
  h3 { margin: 0 0 6px; font-size: 13px; color: #555; }
  section { display: flex; flex-direction: column; gap: 4px; }
  .zeile { display: flex; align-items: center; gap: 6px; }
  .zeile.neu { margin-top: 6px; }
  .name { flex: 1; font-size: 13px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .leer { margin: 0; font-size: 12px; color: #888; }
  input, select { flex: 1; padding: 5px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; min-width: 0; }
  button { font-size: 12px; padding: 5px 9px; border-radius: 6px; border: none; background: #eef1f6; cursor: pointer; }
  button:hover { background: #e8eefc; }
  button:disabled { opacity: .5; cursor: default; }
  .code input { background: #f6f8e8; }
  .fuss { display: flex; justify-content: flex-end; }
</style>
