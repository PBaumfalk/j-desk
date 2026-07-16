<script lang="ts">
  import { ApiClient, ApiError } from '../api';
  import { saveSession, type Session } from '../session';

  let { onConnected, initialServerUrl = 'http://localhost:4810' }: { onConnected: (s: Session) => Promise<void>; initialServerUrl?: string } = $props();

  let serverUrl = $state(initialServerUrl);
  let username = $state('');
  let password = $state('');
  let needsSetup = $state<boolean | null>(null);
  let error = $state('');
  let busy = $state(false);
  let modus = $state<'anmelden' | 'einladung'>('anmelden');
  let code = $state('');
  let deskName = $state<string | null>(null);
  let codeGeprueft = $state(false);

  async function checkServer(): Promise<void> {
    error = '';
    needsSetup = null;
    try {
      needsSetup = (await new ApiClient(serverUrl).status()).needsSetup;
    } catch {
      error = 'Server nicht erreichbar — URL prüfen';
    }
  }

  async function submit(): Promise<void> {
    busy = true;
    error = '';
    try {
      if (needsSetup === null) await checkServer();
      const api = new ApiClient(serverUrl);
      if (needsSetup) await api.setup(username, password);
      else await api.login(username, password);
      const session = { serverUrl, token: api.token! };
      await saveSession(session);
      await onConnected(session);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Verbindung fehlgeschlagen';
    } finally {
      busy = false;
    }
  }

  async function codePruefen(): Promise<void> {
    error = '';
    codeGeprueft = false;
    deskName = null;
    if (!code.trim()) return;
    try {
      deskName = (await new ApiClient(serverUrl).inviteInfo(code.trim())).deskName;
      codeGeprueft = true;
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Server nicht erreichbar — URL prüfen';
    }
  }

  async function einloesen(): Promise<void> {
    busy = true;
    error = '';
    try {
      const api = new ApiClient(serverUrl);
      await api.redeem(code.trim(), username, password);
      const session = { serverUrl, token: api.token! };
      await saveSession(session);
      await onConnected(session);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Verbindung fehlgeschlagen';
    } finally {
      busy = false;
    }
  }

  function modusWechseln(neu: 'anmelden' | 'einladung'): void {
    modus = neu;
    error = '';
    codeGeprueft = false;
    deskName = null;
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={(e) => { e.preventDefault(); void (modus === 'anmelden' ? submit() : einloesen()); }}>
    <h1>Digital Desktop</h1>
    <label>Server-URL
      <input bind:value={serverUrl} onblur={() => void (modus === 'anmelden' ? checkServer() : codePruefen())} placeholder="http://192.168.1.10:4810" />
    </label>
    {#if modus === 'anmelden'}
      {#if needsSetup}<p class="hint">Ersteinrichtung: Lege das erste Konto an (Passwort min. 8 Zeichen).</p>{/if}
      <label>Benutzername <input bind:value={username} autocomplete="username" /></label>
      <label>Passwort <input type="password" bind:value={password} autocomplete="current-password" /></label>
      {#if error}<p class="error">{error}</p>{/if}
      <button disabled={busy || !serverUrl || !username || !password}>
        {needsSetup ? 'Konto anlegen' : 'Anmelden'}
      </button>
      <button type="button" class="link" onclick={() => modusWechseln('einladung')}>Ich habe einen Einladungscode</button>
    {:else}
      <label>Einladungscode
        <input bind:value={code} onblur={() => void codePruefen()} placeholder="Code aus der Einladung" />
      </label>
      {#if codeGeprueft}
        <p class="hint">{deskName ? `Du wirst zu Schreibtisch „${deskName}" eingeladen.` : 'Einladung gültig — wähle Benutzername und Passwort.'}</p>
      {/if}
      <label>Wunsch-Benutzername <input bind:value={username} autocomplete="username" /></label>
      <label>Passwort (min. 8 Zeichen) <input type="password" bind:value={password} autocomplete="new-password" /></label>
      {#if error}<p class="error">{error}</p>{/if}
      <button disabled={busy || !serverUrl || !code.trim() || !username || !password}>Einladung einlösen</button>
      <button type="button" class="link" onclick={() => modusWechseln('anmelden')}>Zurück zur Anmeldung</button>
    {/if}
  </form>
</div>

<style>
  .wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .card { display: flex; flex-direction: column; gap: 12px; width: 320px; padding: 28px;
          border-radius: 14px; background: rgba(255, 255, 255, .96); box-shadow: 0 12px 40px rgba(0, 0, 0, .4); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  input { padding: 7px 9px; border: 1px solid #ccc; border-radius: 7px; font: inherit; }
  .hint { margin: 0; font-size: 12px; color: #2c5aa0; }
  .error { margin: 0; font-size: 12px; color: #b02a2a; }
  button { padding: 8px; border: none; border-radius: 8px; background: #2c5aa0; color: #fff;
           font-size: 14px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .link { background: none; color: #2c5aa0; font-size: 12px; padding: 2px; cursor: pointer; border: none; }
</style>
