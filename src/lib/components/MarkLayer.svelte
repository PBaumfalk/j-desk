<script lang="ts">
  import { marksFor, type MarkKind, type Size } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import { showMarkMenu } from '../menus';

  let { docId, page, base, renderedWidth, active }:
    { docId: string; page: number; base: Size | null; renderedWidth: number; active: MarkKind | null } = $props();

  const marks = $derived(marksFor(desktop.state, docId, page));
  const f = $derived(base ? renderedWidth / base.w : 1); // Basiskoordinaten -> Overlay-Pixel
</script>

{#if base}
  {#each marks as m (m.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- Ablösen nur im Werkzeugmodus, per Zeiger;
         Rechtsklick (Kontextmenü) ist unabhängig vom Werkzeugmodus immer erreichbar. -->
    <div class="mark" class:redact={m.kind === 'redact'} class:tippex={m.kind === 'tippex'} class:active={active === m.kind}
         style:left="{m.rect.x * f}px" style:top="{m.rect.y * f}px"
         style:width="{m.rect.w * f}px" style:height="{m.rect.h * f}px"
         title={active === m.kind ? 'Klick löst die Fläche ab' : undefined}
         onclick={() => { if (active === m.kind) void desktop.command('removeMark', { markId: m.id }); }}
         oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showMarkMenu(e, m); }}></div>
  {/each}
{/if}

<style>
  /* Abdeckungen liegen ÜBER den Strichen (Tipp-Ex deckt auch Tinte) — DOM-Reihenfolge nach InkOverlay.
     pointer-events: auto (statt vormals nur im Werkzeugmodus) — sonst wäre die Fläche per Rechtsklick
     unerreichbar. Linksklick bleibt außerhalb des Werkzeugmodus wirkungslos (onclick prüft weiter
     `active === m.kind`), Zeiger-Ereignisse ohne stopPropagation bubbeln normal zu .body/.head hoch,
     Ziehen/Blättern bleibt also unangetastet (siehe SUMMARY, T-0102-01). */
  .mark { position: absolute; pointer-events: auto; }
  .mark.redact { background: #111; }
  .mark.tippex { background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .06) inset; }
  .mark.active { cursor: pointer; outline: 1px dashed rgba(44, 90, 160, .6); }
</style>
