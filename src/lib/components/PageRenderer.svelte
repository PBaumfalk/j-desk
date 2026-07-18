<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as pdfjs from 'pdfjs-dist';
  import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
  import { FILE_STORE, idbGet, idbPut } from '../idb';
  import type { ApiClient } from '../api';
  import { pageCacheKey, PageBitmapCache } from '../pageCache';
  import { fetchPreviewBytes, PreviewError } from '../previewPoll';

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  let { api, fileId, page, targetWidth, sourceRect, source = 'original', onpagecount, onbasesize }:
    { api: ApiClient; fileId: string; page: number; targetWidth: number;
      /** Nur diesen Seitenausschnitt rendern (Basiskoordinaten) — für Scheren-Ausschnitte. */
      sourceRect?: { x: number; y: number; w: number; h: number };
      /** 'preview' lädt die konvertierte Vorschau-PDF (mit Poll) statt der Originaldatei. */
      source?: 'original' | 'preview';
      onpagecount?: (n: number) => void;
      /** Seitengröße im Basisraum (PDF-Viewport bei scale = 1) — für die Zeichenebene. */
      onbasesize?: (s: { w: number; h: number }) => void } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let failed = $state(false);
  let failMessage = $state<string | null>(null);
  const cache = new PageBitmapCache();
  const baseSizes = new Map<string, { w: number; h: number }>(); // Seiten können unterschiedlich groß sein
  let renderToken = 0;

  async function bytesFor(id: string): Promise<Uint8Array> {
    if (source === 'preview') return fetchPreviewBytes(api, id);
    const cached = await idbGet(FILE_STORE, id).catch(() => null);
    if (cached) return cached;
    const bytes = await api.fetchFile(id);
    await idbPut(FILE_STORE, id, bytes).catch(() => {});
    return bytes;
  }

  async function render(): Promise<void> {
    const token = ++renderToken;
    failed = false;
    failMessage = null;
    try {
      const key = pageCacheKey(fileId, page, targetWidth)
        + (sourceRect ? `:${sourceRect.x},${sourceRect.y},${sourceRect.w},${sourceRect.h}` : '')
        + (source === 'preview' ? ':preview' : '');
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
          const baseVp = pg.getViewport({ scale: 1 });
          baseSizes.set(`${fileId}:${page}`, { w: baseVp.width, h: baseVp.height });
          const scale = (targetWidth * (window.devicePixelRatio || 1)) / (sourceRect?.w ?? baseVp.width);
          const viewport = pg.getViewport({
            scale,
            ...(sourceRect ? { offsetX: -sourceRect.x * scale, offsetY: -sourceRect.y * scale } : {}),
          });
          const off = document.createElement('canvas');
          off.width = Math.ceil(sourceRect ? sourceRect.w * scale : viewport.width);
          off.height = Math.ceil(sourceRect ? sourceRect.h * scale : viewport.height);
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
      const bs = baseSizes.get(`${fileId}:${page}`);
      if (bs) onbasesize?.(bs);
    } catch (e) {
      if (token === renderToken) {
        failed = true;
        failMessage = e instanceof PreviewError ? e.message : null;
      }
    }
  }

  $effect(() => {
    // Abhängig von fileId/page/targetWidth/source neu rendern
    fileId; page; targetWidth; sourceRect; source;
    if (canvas) void render();
  });

  onDestroy(() => cache.clear());
</script>

<div class="page" style:width="{targetWidth}px">
  <canvas bind:this={canvas}></canvas>
  {#if failed}
    <div class="ph">{failMessage ?? 'Seite kann nicht angezeigt werden'}</div>
  {/if}
</div>

<style>
  .page { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .2); }
  canvas { display: block; width: 100%; height: auto; }
  .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        min-height: 200px; background: #fff; color: #a33; font-size: 13px; padding: 20px; text-align: center; }
</style>
