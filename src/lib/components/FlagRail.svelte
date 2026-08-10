<script lang="ts">
  import { flagsFor, type Doc } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { showFlagMenu } from '../menus';

  let { doc, height, active, onjump }:
    { doc: Doc; height: number; active: boolean; onjump: (page: number) => void } = $props();

  const flags = $derived(flagsFor(desktop.state, doc.id));
</script>

{#each flags as fl (fl.id)}
  <button class="fahne" class:active style:top="{fl.offset * height}px" style:background={fl.color}
          title={active ? 'Klick entfernt die Fahne' : `Zu Seite ${fl.page}`}
          aria-label={active ? 'Fahne entfernen' : `Zu Seite ${fl.page} springen`}
          onclick={(e) => {
            e.stopPropagation();
            if (active) void desktop.command('removeFlag', { flagId: fl.id });
            else onjump(fl.page);
          }}
          oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showFlagMenu(e, fl); }}>{fl.page}</button>
{/each}

<style>
  /* Laschen hängen an der rechten Viewer-Kante nach innen (der Viewer clippt mit overflow: hidden —
     nach außen ragende Laschen gibt es nur an der Miniatur-Karte). */
  .fahne { position: absolute; right: 0; width: 26px; height: 18px; border: none; border-radius: 4px 0 0 4px;
           font-size: 10px; font-weight: 700; color: rgba(0, 0, 0, .65); text-align: left; padding: 0 0 0 4px;
           cursor: pointer; box-shadow: -1px 1px 3px rgba(0, 0, 0, .3); z-index: 5; }
  .fahne.active { outline: 1px dashed rgba(44, 90, 160, .8); }
</style>
