<script lang="ts">
  import type { Box, Size } from '@j-desk/core';
  import { ui } from '../ui.svelte';

  // Sprung zur Quelle: pulsiert kurz über der Originalstelle, sobald der Rücksprung hier gelandet ist.
  // Muster MarkLayer: Basiskoordinaten -> Overlay-Pixel per f = renderedWidth/base.w.
  let { docId, page, base, renderedWidth }: { docId: string; page: number; base: Size | null; renderedWidth: number } = $props();

  const treffer = $derived.by(() => {
    const h = ui.sourceHighlight;
    if (!h || h.docId !== docId || h.page !== page) return null; // Seitenwechsel blendet sofort aus
    return Date.now() < h.until ? h : null;
  });
  const f = $derived(base ? renderedWidth / base.w : 1);
  // Fundstellen ohne Wortkoordinaten (PDF-Text-/OCR-Treffer, 07-03: kein `rect`, nur `ganzeSeite`)
  // pulsen die ganze sichtbare Seite — das Rechteck wird HIER gebildet, weil nur diese Ebene
  // (der Store kennt nur Karten-Weltkoordinaten) die Basis-Seitengröße (`base`) kennt.
  const rect = $derived.by((): Box | null => {
    if (!treffer) return null;
    if (treffer.ganzeSeite) return base ? { x: 0, y: 0, w: base.w, h: base.h } : null;
    return treffer.rect ?? null;
  });
</script>

{#if rect}
  <div class="highlight" aria-hidden="true"
       style:left="{rect.x * f}px" style:top="{rect.y * f}px"
       style:width="{rect.w * f}px" style:height="{rect.h * f}px"></div>
{/if}

<style>
  /* Ganz ans Ende des Layer-Stapels (Lehre aus der Werkzeugkasten-Runde): eigene Sichtbarkeit,
     sonst überdecken MarkLayer/StampLayer/Setzflächen das Highlight. */
  .highlight { position: absolute; pointer-events: none; border: 3px solid #f2c94c; border-radius: 4px;
               box-shadow: 0 0 18px rgba(242, 201, 76, .7); animation: sprung-puls 1s ease-in-out infinite; }
  /* Die Sichtdauer (bis "until") regelt der Store — hier nur das Pulsieren selbst. */
  @keyframes sprung-puls { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) {
    .highlight { animation: none; }
  }
</style>
