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
  <div class="divider" aria-hidden="true"></div>
  <div class="zoom">
    <button onclick={() => onzoom(1 / 1.25)} aria-label="Verkleinern">−</button>
    <button class="fit" onclick={onfit} aria-label="Übersicht">⤢</button>
    <button onclick={() => onzoom(1.25)} aria-label="Vergrößern">＋</button>
  </div>
</div>

<style>
  /* Instrumenten-Panel am Tischrand: dunkles Leder, cremefarbene Symbole wie Schnüre/Beschriftung. */
  .controls { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 9000;
    display: flex; gap: 10px; align-items: center; padding: 8px 12px;
    background: linear-gradient(180deg, rgba(26, 45, 38, .9), rgba(13, 24, 20, .94));
    border: 1px solid rgba(242, 226, 184, .22); border-radius: 16px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255, 255, 255, .09);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .pad { display: grid; grid-template-columns: repeat(3, 38px); grid-template-rows: repeat(2, 32px);
    gap: 2px; }
  .pad .up { grid-column: 2; grid-row: 1; }
  .pad .left { grid-column: 1; grid-row: 2; }
  .pad .down { grid-column: 2; grid-row: 2; }
  .pad .right { grid-column: 3; grid-row: 2; }
  .divider { width: 1px; align-self: stretch; margin: 4px 0;
    background: linear-gradient(180deg, transparent, rgba(242, 226, 184, .28), transparent); }
  .zoom { display: flex; gap: 2px; align-items: center; }
  button { border: none; background: transparent; color: #ead9b0; border-radius: 10px; cursor: pointer;
    width: 38px; height: 32px; font-size: 16px; line-height: 1; padding: 0;
    transition: background .12s ease; }
  .zoom button { height: 38px; }
  .zoom .fit { font-size: 18px; }
  button:hover { background: rgba(242, 226, 184, .14); }
  button:active { background: rgba(242, 226, 184, .22); transform: translateY(1px); }
  button:focus-visible { outline: 2px solid rgba(242, 226, 184, .75); outline-offset: 1px; }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
    button:active { transform: none; }
  }
</style>
