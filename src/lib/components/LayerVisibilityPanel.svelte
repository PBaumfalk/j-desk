<script lang="ts">
  import type { Ebene } from '@j-desk/core';
  import { desktop, EBENE_ICON, sortierteEbenenFuerPanel } from '../store.svelte';
  import { showToast } from '../ui.svelte';

  const ebenen = $derived(sortierteEbenenFuerPanel(desktop.state));

  const BEARBEITUNGSRECHT: Record<Ebene['typ'], string> = {
    kanzlei: 'alle Bearbeiter',
    privat: 'nur ich',
    'ki-vorschlaege': 'nur via Übernahme',
    // 'exportierbar' ist ein Systemebenen-Typ, kein eigener Bearbeitungsrecht-Typ — darfEbeneBearbeiten()
    // (@j-desk/core) behandelt ihn wie 'kanzlei' (Bearbeiter-aufwärts, 02-01-Decision).
    exportierbar: 'alle Bearbeiter',
    custom: 'alle Bearbeiter',
  };

  function meta(ebene: Ebene): string | null {
    if (ebene.typ !== 'custom') return null; // Systemebenen haben keinen Ersteller (Copywriting Contract)
    const datum = ebene.createdAt ? new Date(ebene.createdAt).toLocaleDateString('de-DE') : '';
    return [ebene.createdBy && `angelegt von ${ebene.createdBy}`, datum].filter(Boolean).join(' · ');
  }

  let neueEbeneOffen = $state(false);
  let nameEntwurf = $state('');

  function neueEbeneStarten(): void {
    neueEbeneOffen = true;
    nameEntwurf = '';
  }

  async function neueEbeneAnlegen(): Promise<void> {
    const name = nameEntwurf.trim();
    if (!name) return;
    try {
      await desktop.command('addCustomLayer', { name });
      neueEbeneOffen = false;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ebene konnte nicht angelegt werden');
    }
  }
</script>

<div class="panel" role="dialog" aria-label="Ebenen">
  <div class="titel">Ebenen</div>
  <ul>
    {#each ebenen as ebene (ebene.id)}
      <li>
        <input
          type="checkbox"
          checked={desktop.visibleLayers.has(ebene.id)}
          onchange={() => desktop.toggleLayerVisibility(ebene.id)}
          aria-label={`Ebene ${ebene.name} anzeigen`}
        />
        <span class="icon" aria-hidden="true">{EBENE_ICON[ebene.typ]}</span>
        <span class="name-meta">
          <span class="name" title={ebene.name}>{ebene.name}</span>
          {#if meta(ebene)}<span class="meta">{meta(ebene)}</span>{/if}
        </span>
        {#if desktop.kannEbenenVerwalten && ebene.typ === 'custom'}
          <input
            type="checkbox"
            checked={ebene.exportierbar === true}
            onchange={(e) => void desktop.command('setLayerExportierbar', { layerId: ebene.id, exportierbar: e.currentTarget.checked })}
            aria-label={`Ebene ${ebene.name} für Export freigeben`}
            title="Exportierbar"
          />
        {:else}
          <span></span>
        {/if}
        <span class="recht">{BEARBEITUNGSRECHT[ebene.typ]}</span>
      </li>
    {/each}
  </ul>
  {#if desktop.kannEbenenVerwalten}
    {#if neueEbeneOffen}
      <div class="neu-zeile">
        <!-- svelte-ignore a11y_autofocus -- einziger Zweck dieser Zeile ist die Eingabe -->
        <input
          autofocus
          class="neu-eingabe"
          placeholder="Name der neuen Kanzlei-Ebene"
          maxlength="40"
          bind:value={nameEntwurf}
          onkeydown={(e) => {
            if (e.key === 'Enter') void neueEbeneAnlegen();
            if (e.key === 'Escape') { e.stopPropagation(); neueEbeneOffen = false; }
          }}
        />
        <button class="ok" onclick={() => void neueEbeneAnlegen()}>OK</button>
      </div>
    {:else}
      <button class="neu-button" onclick={neueEbeneStarten}>+ Kanzlei-Ebene…</button>
    {/if}
  {/if}
</div>

<style>
  /* Panel-Grundstil: exakt TrashCan.svelte .panel — hier unterhalb der Toolbar statt über dem Papierkorb. */
  .panel { position: fixed; top: 52px; right: 12px; z-index: 9400; width: 320px; max-height: 60vh; overflow: auto;
           background: var(--glass-panel-bg); color: var(--glass-text);
           border: 1px solid var(--glass-border); border-radius: 12px; padding: 10px;
           backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
           box-shadow: var(--glass-shadow-lg); font-size: 12px; }
  .titel { font-size: 15px; font-weight: 600; padding: 0 2px 8px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: grid; grid-template-columns: auto auto 1fr auto auto; gap: 8px; align-items: center;
       background: var(--glass-hover); border-radius: 8px; padding: 6px 8px; }
  input[type='checkbox'] { accent-color: var(--brand-blue); }
  .icon { font-size: 14px; }
  .name-meta { display: flex; flex-direction: column; min-width: 0; }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { color: var(--glass-text-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .recht { color: var(--glass-text-secondary); font-size: 11px; white-space: nowrap; }
  .neu-button { margin-top: 8px; width: 100%; border: none; border-radius: 6px; background: var(--glass-active);
                color: var(--glass-text); cursor: pointer; font-size: 12px; padding: 6px 8px; text-align: left; }
  .neu-button:hover { background: var(--brand-blue-soft); }
  .neu-zeile { margin-top: 8px; display: flex; gap: 4px; }
  .neu-eingabe { flex: 1; padding: 6px 8px; border: 1px solid var(--glass-separator); border-radius: 6px;
                 background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 12px; }
  .ok { border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text);
        cursor: pointer; font-size: 12px; padding: 6px 10px; }
  .ok:hover { background: var(--brand-blue-soft); }
</style>
