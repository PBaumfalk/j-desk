<script lang="ts">
  import { stampsFor, type Size } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';

  let { docId, page, base, renderedWidth, active }:
    { docId: string; page: number; base: Size | null; renderedWidth: number; active: boolean } = $props();

  const stamps = $derived(stampsFor(desktop.state, docId, page));
  const f = $derived(base ? renderedWidth / base.w : 1);

  function datum(iso: string): string {
    const [j, m, t] = iso.split('-');
    return `${t}.${m}.${j}`;
  }
</script>

{#if base}
  {#each stamps as st (st.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- Entfernen nur im Werkzeugmodus -->
    <div class="stamp" class:blau={st.color === 'blue'} class:active
         style:left="{st.x * f}px" style:top="{st.y * f}px"
         style:transform="translate(-50%, -50%) rotate({st.angle}deg) scale({f})"
         title={active ? 'Klick entfernt den Stempel' : undefined}
         onclick={(e) => { if (active) { e.stopPropagation(); void desktop.command('removeStamp', { stampId: st.id }); } }}>
      <span class="text">{st.text}</span>
      {#if st.date}<span class="datum">{datum(st.date)}</span>{/if}
    </div>
  {/each}
{/if}

<style>
  /* Stempeloptik: Konturschrift mit Rahmen, halbtransparent wie echte Stempelfarbe. */
  .stamp { position: absolute; pointer-events: none; display: flex; flex-direction: column; align-items: center;
           border: 3px solid #b3261e; color: #b3261e; border-radius: 6px; padding: 2px 10px; opacity: .82;
           font-weight: 800; letter-spacing: .12em; white-space: nowrap; background: rgba(255, 255, 255, .06);
           transform-origin: center; }
  .stamp.blau { border-color: #1d4ed8; color: #1d4ed8; }
  .stamp .text { font-size: 20px; }
  .stamp .datum { font-size: 11px; letter-spacing: .06em; }
  .stamp.active { pointer-events: auto; cursor: pointer; }
</style>
