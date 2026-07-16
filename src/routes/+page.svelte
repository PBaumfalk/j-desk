<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import Desktop from '../lib/components/Desktop.svelte';
  import { desktop } from '../lib/store.svelte';

  let ready = $state(false);
  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    await desktop.init();
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      event.preventDefault();
      await desktop.saveNow();
      await win.destroy();
    });
    ready = true;
  });
</script>

{#if ready}<Desktop />{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
