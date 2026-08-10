<script lang="ts">
  import { ui } from '../ui.svelte';

  let { onzoom, onpan, onfit, onsuche, onauswertung }: { onzoom: (f: number) => void; onpan: (dx: number, dy: number) => void; onfit: () => void; onsuche: () => void; onauswertung: () => void } = $props();
  const STEP = 120;
</script>

<div class="controls">
  <div class="pad">
    <button class="up" onclick={() => onpan(0, STEP)} aria-label="Nach oben">↑</button>
    <button class="left" onclick={() => onpan(STEP, 0)} aria-label="Nach links">←</button>
    <button class="right" onclick={() => onpan(-STEP, 0)} aria-label="Nach rechts">→</button>
    <button class="down" onclick={() => onpan(0, -STEP)} aria-label="Nach unten">↓</button>
  </div>
  <div class="divider" aria-hidden="true"></div>
  <div class="zoom">
    <button onclick={() => onzoom(1 / 1.25)} aria-label="Verkleinern">−</button>
    <button class="fit" onclick={onfit} aria-label="Übersicht">⤢</button>
    <button onclick={() => onzoom(1.25)} aria-label="Vergrößern">＋</button>
    <button class:on={ui.lupe} onclick={() => (ui.lupe = !ui.lupe)} aria-pressed={ui.lupe} aria-label="Lupe" title="Lupe">🔍</button>
    <button onclick={onsuche} aria-label="Suchen" title="Suchen (⌘F)">📇</button>
    <button onclick={onauswertung} aria-label="Auswertungen" title="Auswertungen (⌥⇧A)">⚖</button>
  </div>
</div>

<style>
  /* Instrumenten-Panel am Tischrand: Glass-Panel mit Navy-Symbolen (J-Desk Glass-Design). */
  .controls { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 9000;
    display: flex; gap: 10px; align-items: center; padding: 8px 12px;
    background: var(--glass-panel-bg);
    border: 1px solid var(--glass-border); border-radius: 16px;
    box-shadow: var(--glass-shadow-lg);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel); }
  .pad { display: grid; grid-template-columns: repeat(3, 38px); grid-template-rows: repeat(2, 32px);
    gap: 2px; }
  .pad .up { grid-column: 2; grid-row: 1; }
  .pad .left { grid-column: 1; grid-row: 2; }
  .pad .down { grid-column: 2; grid-row: 2; }
  .pad .right { grid-column: 3; grid-row: 2; }
  .divider { width: 1px; align-self: stretch; margin: 4px 0;
    background: linear-gradient(180deg, transparent, var(--glass-separator), transparent); }
  .zoom { display: flex; gap: 2px; align-items: center; }
  button { border: none; background: transparent; color: var(--glass-text); border-radius: 10px; cursor: pointer;
    width: 38px; height: 32px; font-size: 16px; line-height: 1; padding: 0;
    transition: background .12s ease; }
  .zoom button { height: 38px; }
  .zoom .fit { font-size: 18px; }
  button:hover { background: var(--glass-hover); }
  button:active { background: var(--glass-active); transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 1px; }
  button.on { background: var(--glass-active); }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
    button:active { transform: none; }
  }
</style>
