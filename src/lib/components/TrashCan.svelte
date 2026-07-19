<script lang="ts">
  import { onMount } from 'svelte';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';

  const items = $derived(desktop.state.trash ?? []);
  let el = $state<HTMLDivElement | null>(null);

  function messen() {
    if (!el) return;
    const r = el.getBoundingClientRect();
    ui.trashRect = { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  onMount(() => {
    messen();
    window.addEventListener('resize', messen);
    return () => { window.removeEventListener('resize', messen); ui.trashRect = null; };
  });

  const KIND_LABEL: Record<string, string> = { doc: 'Dokument', note: 'Zettel', cutout: 'Ausschnitt', stack: 'Stapel' };

  function zeit(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function wiederherstellen(id: string) {
    desktop.command('restoreObject', { trashId: id }).catch((e) => showToast(e instanceof Error ? e.message : 'Wiederherstellen fehlgeschlagen'));
  }

  function leeren() {
    const jl = desktop.mode === 'jlawyer'
      ? ' In j-lawyer wird nichts gelöscht — Akten-Dokumente kämen beim nächsten Abgleich als frische Karte zurück.'
      : '';
    if (!confirm(`Papierkorb endgültig leeren (${items.length} Einträge)?${jl}`)) return;
    void desktop.command('emptyTrash', {});
    ui.trashOpen = false;
  }

  function schreddern(t: { id: string; name: string }) {
    const jl = desktop.mode === 'jlawyer'
      ? ' In j-lawyer wird nichts gelöscht — das Dokument käme beim nächsten Abgleich als frische Karte zurück.'
      : '';
    if (!confirm(`„${t.name}" endgültig schreddern?${jl}`)) return;
    desktop.command('shredTrashItem', { trashId: t.id }).catch((e) => showToast(e instanceof Error ? e.message : 'Schreddern fehlgeschlagen'));
  }
</script>

<div class="korb" bind:this={el}>
  <button class="eimer" onclick={() => (ui.trashOpen = !ui.trashOpen)}
          aria-label="Papierkorb" title="Papierkorb" aria-expanded={ui.trashOpen}>
    🗑{#if items.length > 0}<span class="badge">{items.length}</span>{/if}
  </button>
</div>
{#if ui.trashOpen}
  <div class="panel" role="dialog" aria-label="Papierkorb">
    {#if items.length === 0}
      <div class="leer">Der Papierkorb ist leer.</div>
    {:else}
      <ul>
        {#each items as t (t.id)}
          <li>
            <span class="art">{KIND_LABEL[t.kind] ?? t.kind}</span>
            <span class="name" title={t.name}>{t.name}</span>
            <span class="wann">{zeit(t.trashedAt)}</span>
            <button onclick={() => wiederherstellen(t.id)}>Wiederherstellen</button>
            <button class="schreddern" onclick={() => schreddern(t)}>Schreddern…</button>
          </li>
        {/each}
      </ul>
      <button class="leeren" onclick={leeren}>Korb leeren…</button>
    {/if}
  </div>
{/if}

<style>
  /* Papierkorb im Glass-Design wie DeskControls. */
  .korb { position: fixed; right: 16px; bottom: 16px; z-index: 9000; }
  .eimer { position: relative; width: 52px; height: 52px; border-radius: 12px; cursor: pointer;
           border: 1px solid var(--glass-border);
           background: var(--glass-card-bg); color: var(--glass-text); font-size: 24px;
           backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
           box-shadow: var(--glass-shadow); }
  .eimer:hover { background: var(--glass-elevated-bg); }
  .badge { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; border-radius: 10px;
           background: var(--brand-red); color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; padding: 0 4px; }
  .panel { position: fixed; right: 16px; bottom: 76px; z-index: 9400; width: 320px; max-height: 50vh; overflow: auto;
           background: var(--glass-panel-bg); color: var(--glass-text);
           border: 1px solid var(--glass-border); border-radius: 12px; padding: 10px;
           backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
           box-shadow: var(--glass-shadow-lg); font-size: 12px; }
  .leer { padding: 10px; color: var(--glass-text-secondary); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li { display: grid; grid-template-columns: auto 1fr auto auto auto; gap: 8px; align-items: center;
       background: var(--glass-hover); border-radius: 8px; padding: 6px 8px; }
  .art { color: var(--glass-text-secondary); }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wann { color: var(--glass-text-secondary); font-variant-numeric: tabular-nums; }
  li button, .leeren { border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text);
                       cursor: pointer; font-size: 11px; padding: 4px 8px; }
  li button:hover, .leeren:hover { background: var(--brand-blue-soft); }
  li button.schreddern { background: var(--brand-red-soft); color: var(--brand-red); }
  li button.schreddern:hover { background: rgba(238, 24, 30, .28); }
  .leeren { margin-top: 8px; width: 100%; }
</style>
