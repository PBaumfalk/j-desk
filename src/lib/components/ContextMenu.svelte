<script lang="ts">
  import { ui } from '../ui.svelte';

  // Verhindert, dass ein synthetischer Klick (z. B. von Safari beim Abheben nach Lang-Druck)
  // sofort den unter dem Finger liegenden Menüeintrag auslöst.
  let openedAt = 0;
  $effect(() => {
    if (ui.menu) openedAt = Date.now();
  });
</script>

{#if ui.menu}
  <div class="backdrop" role="presentation" onpointerdown={(e) => { e.stopPropagation(); ui.menu = null; }} oncontextmenu={(e) => { e.preventDefault(); ui.menu = null; }}></div>
  <div class="menu" class:zweispaltig={ui.menu.columns === 2} role="menu" style:left="{ui.menu.x}px" style:top="{ui.menu.y}px">
    {#if ui.menu.input}
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus maxlength="24" placeholder={ui.menu.input.placeholder} aria-label={ui.menu.input.placeholder}
             onpointerdown={(e) => e.stopPropagation()}
             onkeydown={(e) => {
               e.stopPropagation();
               if (e.key === 'Enter') {
                 const wert = e.currentTarget.value.trim();
                 if (wert && ui.menu?.input) { ui.menu.input.onSubmit(wert); ui.menu = null; }
               }
               if (e.key === 'Escape') {
                 const esc = ui.menu?.input?.onEscape;
                 ui.menu = null;
                 esc?.();
               }
             }} />
    {/if}
    {#each ui.menu.items as item (item.label)}
      <button onpointerdown={(e) => e.stopPropagation()} onclick={() => { if (Date.now() - openedAt < 300) return; item.action(); ui.menu = null; }}>
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
  .menu.zweispaltig { display: grid; grid-template-columns: 1fr 1fr; }
  .menu input { margin: 4px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; grid-column: 1 / -1; }
  .menu button { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
                 font-size: 13px; cursor: pointer; }
  .menu button:hover { background: #e8eefc; }
</style>
