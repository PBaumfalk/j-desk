<script lang="ts">
  import { ui } from '../ui.svelte';
</script>

{#if ui.menu}
  <div class="backdrop" onpointerdown={(e) => { e.stopPropagation(); ui.menu = null; }} oncontextmenu={(e) => { e.preventDefault(); ui.menu = null; }}></div>
  <div class="menu" style:left="{ui.menu.x}px" style:top="{ui.menu.y}px">
    {#each ui.menu.items as item (item.label)}
      <button onpointerdown={(e) => e.stopPropagation()} onclick={() => { item.action(); ui.menu = null; }}>
        {item.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 99998; }
  .menu { position: fixed; z-index: 99999; min-width: 220px; padding: 4px; border-radius: 10px;
          background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; }
  .menu button { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
                 font-size: 13px; cursor: pointer; }
  .menu button:hover { background: #e8eefc; }
</style>
