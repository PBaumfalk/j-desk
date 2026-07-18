<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as pdfjs from 'pdfjs-dist';
  import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
  import { FILE_STORE, idbGet, idbPut } from '../idb';
  import type { ApiClient } from '../api';
  import { pageCacheKey, PageBitmapCache } from '../pageCache';

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  let { api, fileId, page, targetWidth, onpagecount }:
    { api: ApiClient; fileId: string; page: number; targetWidth: number; onpagecount?: (n: number) => void } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let failed = $state(false);
  const cache = new PageBitmapCache();
  let renderToken = 0;

  async function bytesFor(id: string): Promise<Uint8Array> {
    const cached = await idbGet(FILE_STORE, id).catch(() => null);
    if (cached) return cached;
    const bytes = await api.fetchFile(id);
    await idbPut(FILE_STORE, id, bytes).catch(() => {});
    return bytes;
  }

  async function render(): Promise<void> {
    const token = ++renderToken;
    failed = false;
    try {
      const key = pageCacheKey(fileId, page, targetWidth);
      let bmp = cache.get(key);
      if (!bmp) {
        const data = await bytesFor(fileId);
        if (token !== renderToken) return; // überholter Render: PDF gar nicht erst parsen
        let pdf: pdfjs.PDFDocumentProxy | undefined;
        try {
          pdf = await pdfjs.getDocument({ data }).promise;
          if (token !== renderToken) return;
          onpagecount?.(pdf.numPages);
          const p = Math.min(Math.max(1, page), pdf.numPages); // clampen auf 1..Seitenzahl
          const pg = await pdf.getPage(p);
          const scale = (targetWidth * (window.devicePixelRatio || 1)) / pg.getViewport({ scale: 1 }).width;
          const viewport = pg.getViewport({ scale });
          const off = document.createElement('canvas');
          off.width = Math.ceil(viewport.width);
          off.height = Math.ceil(viewport.height);
          await pg.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport }).promise;
          if (token !== renderToken) return;
          bmp = await createImageBitmap(off);
          cache.set(key, bmp);
        } finally {
          // Dokument stets freigeben (auch im Fehler-/Abbruchfall), sonst Worker-Leak bei vielen Wechseln
          await pdf?.destroy?.();
        }
      }
      if (token !== renderToken || !canvas) return;
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    } catch {
      if (token === renderToken) failed = true;
    }
  }

  $effect(() => {
    // Abhängig von fileId/page/targetWidth neu rendern
    fileId; page; targetWidth;
    if (canvas) void render();
  });

  onDestroy(() => cache.clear());
</script>

<div class="page" style:width="{targetWidth}px">
  <canvas bind:this={canvas}></canvas>
  {#if failed}
    <div class="ph">Seite kann nicht angezeigt werden</div>
  {/if}
</div>

<style>
  .page { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .2); }
  canvas { display: block; width: 100%; height: auto; }
  .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        min-height: 200px; background: #fff; color: #a33; font-size: 13px; padding: 20px; text-align: center; }
</style>
