<script lang="ts">
  import type { Size } from '@j-desk/core';
  import { markierungenAus } from '../vergleichSeite';
  import type { Rect } from '../pdfText';

  // Markierungsebene für Textunterschiede (COMP-02, Plan 09-09) — strukturell identisch zu
  // SourceHighlight.svelte/MarkLayer.svelte: Basiskoordinaten -> Overlay-Pixel über
  // markierungenAus() (derselbe Breitenfaktor, kein zweiter Rechenweg neben dem aus
  // vergleichSeite.ts). Rein darstellend: keine Zeigerereignisse, damit Blättern/Auswählen
  // darunter unangetastet bleibt.
  let { rects, art, base, renderedWidth }:
    { rects: Rect[]; art: 'entfernt' | 'hinzugefuegt'; base: Size | null; renderedWidth: number } = $props();

  // Fehlt die Basisgröße (die Seite ist noch nicht gerendert), zeichnet die Ebene nichts, statt
  // mit einem Ersatzfaktor an die falsche Stelle zu zeichnen.
  const skaliert = $derived(base ? markierungenAus(rects, base.w, renderedWidth) : []);
</script>

{#each skaliert as r, i (i)}
  <div class="diff" class:entfernt={art === 'entfernt'} class:hinzugefuegt={art === 'hinzugefuegt'} aria-hidden="true"
       style:left="{r.x}px" style:top="{r.y}px" style:width="{r.w}px" style:height="{r.h}px"></div>
{/each}

<style>
  /* Rein darstellend — keine Zeigerereignisse, das Blättern/Auswählen darunter bleibt unangetastet. */
  .diff { position: absolute; pointer-events: none; border-radius: 2px; }
  /* Rot-Ton wiederverwendet aus der --brand-red-soft-/.schnittrahmen.redact-Familie
     (09-UI-SPEC.md „Diff-Hervorhebung"). Die goldene Sprung-Hervorhebung
     (SourceHighlight.svelte, #f2c94c) wird bewusst NICHT wiederverwendet — Sprungziel und
     Textänderung sind verschiedene Aussagen und dürfen nicht gleich aussehen. */
  .diff.entfernt { background: rgba(238, 24, 30, .18); border: 1px solid var(--brand-red); }
  /* Grün-Ton wiederverwendet aus LinkLayer.svelte Familie „bestätigend" (Phase 8). */
  .diff.hinzugefuegt { background: rgba(95, 168, 122, .22); border: 1px solid #5fa87a; }
</style>
