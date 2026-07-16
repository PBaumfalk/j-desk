<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
  import Desktop from '../lib/components/Desktop.svelte';
  import LoginScreen from '../lib/components/LoginScreen.svelte';
  import { desktop } from '../lib/store.svelte';
  import { ApiClient, ApiError } from '../lib/api';
  import { loadSession, clearSession, type Session } from '../lib/session';
  import { maybeOfferV1Import } from '../lib/importV1';

  let phase = $state<'loading' | 'login' | 'desk'>('loading');
  let lastServerUrl = $state('http://localhost:4810');

  async function connect(session: Session): Promise<void> {
    const api = new ApiClient(session.serverUrl, session.token);
    await desktop.start(api);
    phase = 'desk';
    void maybeOfferV1Import(api);
  }

  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    const win = getCurrentWindow();
    try {
      const quitItem = await MenuItem.new({
        text: 'Digital Desktop beenden',
        accelerator: 'CmdOrCtrl+Q',
        action: async () => {
          await win.destroy();
        },
      });
      const appSubmenu = await Submenu.new({ text: 'Digital Desktop', items: [quitItem] });
      const editSubmenu = await Submenu.new({
        text: 'Bearbeiten',
        items: [
          await PredefinedMenuItem.new({ item: 'Undo' }),
          await PredefinedMenuItem.new({ item: 'Redo' }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await PredefinedMenuItem.new({ item: 'Cut' }),
          await PredefinedMenuItem.new({ item: 'Copy' }),
          await PredefinedMenuItem.new({ item: 'Paste' }),
          await PredefinedMenuItem.new({ item: 'SelectAll' }),
        ],
      });
      await (await Menu.new({ items: [appSubmenu, editSubmenu] })).setAsAppMenu();
    } catch {
      // Menü ist Komfort — Start nicht blockieren
    }

    const session = await loadSession();
    if (!session) {
      phase = 'login';
      return;
    }
    lastServerUrl = session.serverUrl;
    try {
      await connect(session);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await clearSession();
      phase = 'login';
    }
  });
</script>

{#if phase === 'login'}
  <LoginScreen onConnected={connect} initialServerUrl={lastServerUrl} />
{:else if phase === 'desk'}
  <Desktop />
{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
