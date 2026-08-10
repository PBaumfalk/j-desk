<script lang="ts" module>
  export type RadialItem = { id: string; icon: string; label: string; active?: boolean; chip?: string };
  export type RadialGroup = {
    id: string; icon: string; label: string; items: RadialItem[];
    /** Farbbogen der offenen Gruppe (z.B. Stabilo-Palette bei aktivem Marker, Fahnenfarben). */
    colors?: { list: readonly string[]; active: string | null } | null;
  };
</script>

<script lang="ts">
  import { untrack } from 'svelte';

  let { x, y, groups, onpick, oncolor, onclose }: {
    x: number; y: number;
    groups: RadialGroup[];
    onpick: (itemId: string) => void;
    oncolor?: (groupId: string, color: string) => void;
    onclose: () => void;
  } = $props();

  /* Die Viewer liegen in der skalierten .world-Ebene — dort wäre position:fixed verzerrt.
     Deshalb wandert das Menü per Portal an document.body (Viewport-Koordinaten). */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  // Gruppe mit aktivem Werkzeug ist beim Öffnen direkt aufgefächert (bewusst NUR initial —
  // ein $effect würde die manuelle Gruppenwahl bei jeder groups-Neuberechnung überschreiben).
  let offen = $state<string | null>(
    untrack(() => groups.find((g) => g.items.some((i) => i.active))?.id ?? null),
  );

  const R_GRUPPE = 70, R_FARBE = 105, R_WERKZEUG = 150, RAND = 175;
  // Menümitte in den sichtbaren Bereich schieben (Öffnungspunkt kann am Rand liegen).
  const cx = $derived(Math.min(Math.max(x, RAND), window.innerWidth - RAND));
  const cy = $derived(Math.min(Math.max(y, RAND), window.innerHeight - RAND));

  const GRUPPEN_WINKEL = [-90, 0, 90, 180]; // oben, rechts, unten, links
  function polar(deg: number, r: number): { x: number; y: number } {
    const rad = (deg * Math.PI) / 180;
    return { x: Math.cos(rad) * r, y: Math.sin(rad) * r };
  }
  const offeneGruppe = $derived(groups.find((g) => g.id === offen) ?? null);
  const gruppenWinkel = $derived.by(() => {
    const i = groups.findIndex((g) => g.id === offen);
    return i >= 0 ? GRUPPEN_WINKEL[i] : -90;
  });
  /** Bogen um den Gruppenwinkel: 30° Abstand, höchstens 120° Spannweite. */
  function bogenWinkel(n: number, i: number): number {
    const spann = Math.min(120, (n - 1) * 30);
    return gruppenWinkel - spann / 2 + (n > 1 ? (i * spann) / (n - 1) : 0);
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onclose(); } }} />

<div use:portal>
  <!-- svelte-ignore a11y_no_static_element_interactions -- Backdrop schließt nur -->
  <div class="backdrop" onpointerdown={(e) => { e.stopPropagation(); onclose(); }}
       oncontextmenu={(e) => { e.preventDefault(); onclose(); }}></div>
  <div class="radial" role="menu" aria-label="Werkzeuge" tabindex="-1" style:left="{cx}px" style:top="{cy}px"
       onpointerdown={(e) => e.stopPropagation()} oncontextmenu={(e) => e.preventDefault()}>
    <div class="scheibe" aria-hidden="true"></div>
    {#each groups as g, gi (g.id)}
      {@const p = polar(GRUPPEN_WINKEL[gi], R_GRUPPE)}
      <button class="gruppe" class:aktiv={g.id === offen} style:left="{p.x}px" style:top="{p.y}px"
              onclick={() => (offen = offen === g.id ? null : g.id)}>
        <span aria-hidden="true">{g.icon}</span> {g.label}
      </button>
    {/each}
    {#if offeneGruppe}
      {#each offeneGruppe.items as item, i (item.id)}
        {@const p = polar(bogenWinkel(offeneGruppe.items.length, i), R_WERKZEUG)}
        <button class="werkzeug" class:aktiv={item.active} style:left="{p.x}px" style:top="{p.y}px"
                aria-label={item.label} title={item.label} onclick={() => onpick(item.id)}>
          {#if item.chip}<span class="chip" style:background={item.chip}></span>{:else}{item.icon}{/if}
          <small>{item.label}</small>
        </button>
      {/each}
      {#if offeneGruppe.colors}
        {#each offeneGruppe.colors.list as farbe, i (farbe)}
          {@const p = polar(bogenWinkel(offeneGruppe.colors.list.length, i), R_FARBE)}
          <button class="farbe" class:aktiv={farbe === offeneGruppe.colors.active}
                  style:left="{p.x}px" style:top="{p.y}px" style:background={farbe}
                  aria-label="Farbe wählen" onclick={() => oncolor?.(offeneGruppe.id, farbe)}></button>
        {/each}
      {/if}
    {/if}
    <button class="mitte" onclick={onclose} aria-label="Schließen">✕</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 99900; }
  .radial { position: fixed; z-index: 99901; width: 0; height: 0; }
  .scheibe { position: absolute; width: 190px; height: 190px; border-radius: 50%;
             transform: translate(-50%, -50%);
             background: rgba(16, 34, 54, .38);
             backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
             border: 1px solid rgba(255, 255, 255, .22); box-shadow: var(--glass-shadow-lg); }
  .gruppe { position: absolute; transform: translate(-50%, -50%); white-space: nowrap;
            padding: 7px 12px; border-radius: 999px; font-size: 12px; cursor: pointer;
            background: rgba(255, 255, 255, .86); color: var(--brand-navy);
            border: 1px solid rgba(255, 255, 255, .6);
            backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
            box-shadow: 0 4px 12px rgba(0, 0, 0, .3); }
  .gruppe.aktiv { background: var(--brand-navy); color: #fff; }
  .werkzeug { position: absolute; transform: translate(-50%, -50%); width: 46px; height: 46px;
              border-radius: 50%; cursor: pointer; font-size: 19px;
              background: rgba(255, 255, 255, .9); color: var(--brand-navy);
              border: 1px solid rgba(255, 255, 255, .6); box-shadow: 0 4px 14px rgba(0, 0, 0, .25);
              display: flex; align-items: center; justify-content: center;
              animation: auffalten .14s ease-out both; }
  .werkzeug.aktiv { background: var(--brand-navy); color: #fff;
                    box-shadow: 0 0 0 3px var(--glass-active), 0 4px 14px rgba(0, 0, 0, .3); }
  /* Pillen-Unterlage: lesbar über weißem Papier UND dunkler Tischfläche. */
  .werkzeug small { position: absolute; top: 106%; left: 50%; transform: translateX(-50%);
                    font-size: 9px; color: #fff; background: rgba(8, 31, 57, .78);
                    padding: 1px 6px; border-radius: 5px;
                    white-space: nowrap; pointer-events: none; }
  .chip { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(8, 31, 57, .25); }
  .farbe { position: absolute; transform: translate(-50%, -50%); width: 22px; height: 22px;
           border-radius: 50%; cursor: pointer; padding: 0;
           border: 2px solid rgba(255, 255, 255, .9); box-shadow: 0 2px 6px rgba(0, 0, 0, .35);
           animation: auffalten .14s ease-out both; }
  .farbe.aktiv { outline: 3px solid var(--brand-blue); outline-offset: 1px; }
  .mitte { position: absolute; transform: translate(-50%, -50%); width: 48px; height: 48px;
           border-radius: 50%; cursor: pointer; font-size: 16px;
           background: rgba(8, 31, 57, .92); color: #fff;
           border: 1px solid rgba(255, 255, 255, .25); box-shadow: 0 6px 20px rgba(0, 0, 0, .4); }
  @keyframes auffalten { from { opacity: 0; scale: .6; } to { opacity: 1; scale: 1; } }
  @media (prefers-reduced-motion: reduce) { .werkzeug, .farbe { animation: none; } }
</style>
