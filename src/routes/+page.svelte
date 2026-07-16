<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
  import Desktop from '../lib/components/Desktop.svelte';
  import { desktop } from '../lib/store.svelte';

  let ready = $state(false);
  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    await desktop.init();
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        await desktop.saveNow();
      } finally {
        await win.destroy();
      }
    });

    const quitItem = await MenuItem.new({
      text: 'Digital Desktop beenden',
      accelerator: 'CmdOrCtrl+Q',
      action: async () => {
        try {
          await desktop.saveNow();
        } finally {
          await win.destroy();
        }
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
    const appMenu = await Menu.new({ items: [appSubmenu, editSubmenu] });
    await appMenu.setAsAppMenu();

    ready = true;
  });
</script>

{#if ready}<Desktop />{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
