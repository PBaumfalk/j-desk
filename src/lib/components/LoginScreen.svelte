<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiClient, ApiError } from '../api';
  import { saveSession, type Session } from '../session';

  let { onConnected }: { onConnected: (s: Session) => Promise<void> } = $props();

  let username = $state('');
  let password = $state('');
  let needsSetup = $state<boolean | null>(null);
  let error = $state('');
  let busy = $state(false);

  onMount(() => void checkServer());

  async function checkServer(): Promise<void> {
    error = '';
    try {
      needsSetup = (await new ApiClient().status()).needsSetup;
    } catch {
      error = 'Server nicht erreichbar — später erneut versuchen';
    }
  }

  async function submit(): Promise<void> {
    busy = true;
    error = '';
    try {
      if (needsSetup === null) await checkServer();
      const api = new ApiClient();
      if (needsSetup) await api.setup(username, password);
      else await api.login(username, password);
      const session = { token: api.token! };
      saveSession(session);
      await onConnected(session);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Verbindung fehlgeschlagen';
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap bg-mesh">
  <form class="card glass-elevated" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <img class="logo" src="/j-desk-icon-256.png" alt="" width="72" height="72" />
    <h1>J-Desk</h1>
    {#if needsSetup}<p class="hint">Ersteinrichtung: Lege das erste Konto an (Passwort min. 8 Zeichen).</p>{/if}
    <label>Benutzername <input bind:value={username} autocomplete="username" /></label>
    <label>Passwort <input type="password" bind:value={password} autocomplete="current-password" /></label>
    {#if error}<p class="error">{error}</p>{/if}
    <button disabled={busy || !username || !password}>
      {needsSetup ? 'Konto anlegen' : 'Anmelden'}
    </button>
  </form>
</div>

<style>
  .wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .card { display: flex; flex-direction: column; gap: 12px; width: 320px; padding: 32px 28px;
          border-radius: 18px; }
  .logo { align-self: center; margin-bottom: 2px; }
  h1 { margin: 0 0 4px; font-size: 22px; text-align: center; color: var(--brand-navy);
       letter-spacing: -0.01em; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--glass-text); }
  input { padding: 8px 10px; border: 1px solid var(--glass-separator); border-radius: 8px;
          background: rgba(255, 255, 255, .7); font: inherit; }
  input:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 0; }
  .hint { margin: 0; font-size: 12px; color: var(--brand-blue); }
  .error { margin: 0; font-size: 12px; color: var(--brand-red); }
  button { padding: 9px; border: none; border-radius: 9px; background: var(--brand-navy); color: #fff;
           font-size: 14px; cursor: pointer; }
  button:hover:enabled { background: var(--brand-navy-hover); }
  button:disabled { opacity: .5; cursor: default; }
</style>
