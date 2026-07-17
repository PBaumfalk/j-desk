<script lang="ts">
  import { onMount } from 'svelte';
  import Desktop from '../lib/components/Desktop.svelte';
  import LoginScreen from '../lib/components/LoginScreen.svelte';
  import { desktop } from '../lib/store.svelte';
  import { ApiClient, ApiError } from '../lib/api';
  import { loadSession, clearSession, type Session } from '../lib/session';

  let phase = $state<'loading' | 'login' | 'desk'>('loading');

  async function connect(session: Session): Promise<void> {
    const api = new ApiClient('', session.token);
    await desktop.start(api, session.lastDeskId);
    phase = 'desk';
  }

  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    const session = loadSession();
    if (!session) {
      phase = 'login';
      return;
    }
    try {
      await connect(session);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) clearSession();
      phase = 'login';
    }
  });
</script>

{#if phase === 'login'}
  <LoginScreen onConnected={connect} />
{:else if phase === 'desk'}
  <Desktop />
{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
