<script lang="ts">
  import { STAMP_PRESETS, STAMP_TEXT_MAX } from '@digital-desktop/core';

  let { onpick, onclose }:
    { onpick: (wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) => void; onclose: () => void } = $props();

  let freitext = $state('');
  function frei() {
    const text = freitext.trim();
    if (!text) return;
    onpick({ text: text.toUpperCase().slice(0, STAMP_TEXT_MAX), color: 'red' });
    freitext = '';
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -- Backdrop schließt nur -->
<div class="backdrop" onpointerdown={onclose}></div>
<div class="pop" role="menu" aria-label="Stempel wählen">
  {#each STAMP_PRESETS as p (p.text)}
    <button class:blau={p.color === 'blue'} onclick={() => onpick(p)} role="menuitem">
      {p.text}{#if p.withDate}&nbsp;<small>+ Datum</small>{/if}
    </button>
  {/each}
  <div class="frei">
    <input placeholder="Freitext…" maxlength={STAMP_TEXT_MAX} bind:value={freitext}
           onkeydown={(e) => { if (e.key === 'Enter') frei(); }} />
    <button onclick={frei} disabled={!freitext.trim()}>Stempeln</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 9600; }
  .pop { position: absolute; top: 34px; right: 8px; z-index: 9700; display: flex; flex-direction: column; gap: 4px;
         background: #fff; border-radius: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, .35); padding: 8px; min-width: 170px; }
  .pop > button { border: 2px solid #b3261e; color: #b3261e; background: #fff; border-radius: 4px;
                  font-weight: 700; letter-spacing: .08em; font-size: 12px; padding: 4px 8px; cursor: pointer; }
  .pop > button.blau { border-color: #1d4ed8; color: #1d4ed8; }
  .pop > button:hover { background: #f6f7fa; }
  .frei { display: flex; gap: 4px; margin-top: 4px; }
  .frei input { flex: 1; min-width: 0; font-size: 12px; padding: 4px 6px; border: 1px solid #cdd4df; border-radius: 4px; }
  .frei button { font-size: 12px; border: none; background: #e7ebf2; border-radius: 4px; cursor: pointer; padding: 4px 8px; }
  .frei button:disabled { opacity: .4; cursor: default; }
</style>
