<script lang="ts">
  let { onzoom, onpan, onfit }: { onzoom: (f: number) => void; onpan: (dx: number, dy: number) => void; onfit: () => void } = $props();
  const STEP = 120;
</script>

<div class="controls">
  <div class="pad">
    <button class="up" onclick={() => onpan(0, STEP)} aria-label="Nach oben">↑</button>
    <button class="left" onclick={() => onpan(STEP, 0)} aria-label="Nach links">←</button>
    <button class="right" onclick={() => onpan(-STEP, 0)} aria-label="Nach rechts">→</button>
    <button class="down" onclick={() => onpan(0, -STEP)} aria-label="Nach unten">↓</button>
  </div>
  <div class="zoom">
    <button onclick={() => onzoom(1 / 1.25)} aria-label="Verkleinern">−</button>
    <button onclick={onfit} aria-label="Übersicht">⤢</button>
    <button onclick={() => onzoom(1.25)} aria-label="Vergrößern">＋</button>
  </div>
</div>

<style>
  .controls { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 9000;
    display: flex; gap: 14px; align-items: center; }
  .pad { display: grid; grid-template-columns: repeat(3, 30px); grid-template-rows: repeat(2, 30px);
    gap: 3px; }
  .pad .up { grid-column: 2; grid-row: 1; }
  .pad .left { grid-column: 1; grid-row: 2; }
  .pad .down { grid-column: 2; grid-row: 2; }
  .pad .right { grid-column: 3; grid-row: 2; }
  .zoom { display: flex; gap: 4px; }
  button { border: none; background: rgba(255, 255, 255, .92); border-radius: 8px; cursor: pointer;
    width: 34px; height: 30px; font-size: 16px; line-height: 1; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  button:hover { background: #fff; }
  button:focus-visible { outline: 2px solid #2c5aa0; outline-offset: 2px; }
</style>
