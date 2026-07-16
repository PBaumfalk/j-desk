<script lang="ts">
  import { onMount } from 'svelte';
  import Desktop from '../lib/components/Desktop.svelte';
  import { desktop } from '../lib/store.svelte';

  let ready = $state(false);
  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    await desktop.init();
    ready = true;
  });
</script>

{#if ready}<Desktop />{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
