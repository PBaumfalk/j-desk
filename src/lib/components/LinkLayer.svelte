<script lang="ts">
  import {
    CARD_W, CARD_H, docBox, findDoc, findNote, findStack, noteBox, stackOf, setLinkNote, type Vec2,
  } from '@digital-desktop/core';
  import { debounce } from '../debounce';
  import { desktop } from '../store.svelte';

  const sendNote = debounce(400, (linkId: string, note: string) => {
    void desktop.command('setLinkNote', { linkId, note });
  });

  let openLinkId = $state<string | null>(null);
  const openLink = $derived(desktop.state.links.find((l) => l.id === openLinkId) ?? null);

  /** Linien-Endpunkt: Kartenmitte (bei aufgeschlagenen Karten die Viewer-Mitte);
      liegt das Dokument in einem Stapel, endet die Linie am Stapel. */
  function endpoint(id: string): Vec2 | null {
    const s = desktop.state;
    const stack = findStack(s, id) ?? stackOf(s, id);
    if (stack) return { x: stack.position.x + (CARD_W + 24) / 2, y: stack.position.y + (CARD_H + 24) / 2 };
    const n = findNote(s, id);
    if (n) {
      const nb = noteBox(n);
      return { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 };
    }
    const d = findDoc(s, id);
    if (!d) return null;
    const b = docBox(d);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function curve(a: Vec2, b: Vec2): string {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return `M ${a.x} ${a.y} Q ${mx - (dy / len) * 40} ${my + (dx / len) * 40} ${b.x} ${b.y}`;
  }
</script>

<svg class="links">
  {#each desktop.state.links as link (link.id)}
    {@const a = endpoint(link.fromId)}
    {@const b = endpoint(link.toId)}
    {#if a && b}
      <path d={curve(a, b)} class="hit" role="button" tabindex="-1" aria-label="Verknüpfung öffnen"
            onpointerdown={(e) => { e.stopPropagation(); openLinkId = link.id; }} />
      <path d={curve(a, b)} class="line" />
      {#if link.note}
        <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 28} text-anchor="middle" class="note">{link.note}</text>
      {/if}
    {/if}
  {/each}
</svg>

{#if openLink}
  {@const a = endpoint(openLink.fromId)}
  {@const b = endpoint(openLink.toId)}
  {#if a && b}
    <div class="popover" role="dialog" tabindex="-1" aria-label="Verknüpfungsnotiz" style:left="{(a.x + b.x) / 2}px" style:top="{(a.y + b.y) / 2}px"
         onpointerdown={(e) => e.stopPropagation()}>
      <textarea placeholder="Notiz zur Verknüpfung…" value={openLink.note}
        oninput={(e) => {
          const note = (e.currentTarget as HTMLTextAreaElement).value;
          desktop.applyLocal((s) => setLinkNote(s, openLink.id, note));
          sendNote(openLink.id, note);
        }}
      ></textarea>
      <div class="row">
        <button onclick={() => { void desktop.command('removeLink', { linkId: openLink.id }); openLinkId = null; }}>Verknüpfung lösen</button>
        <button onclick={() => (openLinkId = null)}>Schließen</button>
      </div>
    </div>
  {/if}
{/if}

<style>
  svg.links { position: absolute; overflow: visible; width: 1px; height: 1px; }
  path.line { fill: none; stroke: #f2e2b8; stroke-width: 2; pointer-events: none; }
  path.hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; }
  text.note { fill: #fdf9ec; font-size: 12px; paint-order: stroke; stroke: rgba(0, 0, 0, .55); stroke-width: 3px; }
  .popover { position: absolute; transform: translate(-50%, 10px); z-index: 100000; width: 230px;
             background: #fff; border-radius: 10px; padding: 10px; box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
             display: flex; flex-direction: column; gap: 8px; }
  textarea { width: 100%; min-height: 60px; font: inherit; font-size: 12px; box-sizing: border-box; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row button { font-size: 12px; cursor: pointer; }
</style>
