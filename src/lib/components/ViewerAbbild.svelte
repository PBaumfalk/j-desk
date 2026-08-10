<script lang="ts">
  import { DEFAULT_OPEN_SIZE, type Doc, type Size } from '@j-desk/core';
  import { desktop } from '../store.svelte';
  import PageRenderer from './PageRenderer.svelte';
  import ImagePage from './ImagePage.svelte';
  import InkOverlay from './InkOverlay.svelte';
  import MarkLayer from './MarkLayer.svelte';
  import StampLayer from './StampLayer.svelte';

  // Statisches Abbild eines aufgeschlagenen Dokuments für die Lupe (Wunsch A8.5):
  // Seite + Annotationen ohne Interaktion und ohne die Effekte/Commands des echten Viewers.
  let { doc }: { doc: Doc } = $props();

  const size = $derived(doc.openSize ?? DEFAULT_OPEN_SIZE);
  const pageWidth = $derived(Math.round(size.w - 20));
  const kind = $derived(doc.kind ?? 'pdf');
  const bildmodus = $derived(kind === 'image');
  const seitenQuelle = $derived(kind === 'convertible' ? 'preview' : 'original');
  const page = $derived(bildmodus ? 1 : (doc.pageOnly ?? doc.page ?? 1));
  let pageCount = $state<number | null>(null);
  let baseSize = $state<Size | null>(null);
</script>

<div class="abbild" aria-hidden="true"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px" style:z-index={doc.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="kopf">
    <span class="titel">{doc.name}</span>
    <span class="pos">{bildmodus ? 'Bild' : `S. ${page}${pageCount ? ` / ${pageCount}` : ''}`}</span>
  </div>
  <div class="body">
    <div class="pagewrap">
      {#if desktop.api}
        {#if bildmodus}
          <ImagePage api={desktop.api} fileId={doc.fileId} name={doc.name} targetWidth={pageWidth}
            onbasesize={(s) => (baseSize = s)} />
        {:else}
          <PageRenderer api={desktop.api} fileId={doc.fileId} {page} targetWidth={pageWidth} source={seitenQuelle}
            onpagecount={(n) => (pageCount = n)} onbasesize={(s) => (baseSize = s)} />
        {/if}
        <InkOverlay docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} tool={null} />
        <MarkLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} active={null} />
        <StampLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} active={false} />
      {/if}
    </div>
  </div>
</div>

<style>
  /* Optik an den echten Viewer angelehnt — aber rein dekorativ, keine Interaktion. */
  .abbild { position: absolute; display: flex; flex-direction: column; background: #f5f2ea;
            border-radius: 10px; overflow: hidden; box-shadow: 0 14px 40px rgba(0, 0, 0, .4);
            pointer-events: none; }
  .kopf { display: flex; justify-content: space-between; align-items: center; gap: 8px;
          padding: 8px 12px; background: rgba(20, 32, 28, .92); color: #ece5d4;
          font-size: 12px; flex: none; }
  .titel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pos { font-variant-numeric: tabular-nums; opacity: .8; flex: none; }
  .body { flex: 1; overflow: hidden; display: flex; justify-content: center; padding: 10px; }
  .pagewrap { position: relative; height: fit-content; }
</style>
