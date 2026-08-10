<script lang="ts">
  import type { Size } from '@j-desk/core';
  import type { ApiClient } from '../api';
  import { getFileUrl } from '../fileCache';
  import { imageMime } from '../thumbnails';

  let { api, fileId, name, targetWidth, onbasesize }:
    { api: ApiClient; fileId: string; name: string; targetWidth: number;
      /** Natürliche Bildgröße (Pixel) — Basiskoordinaten für die Zeichenebene, analog PageRenderer. */
      onbasesize?: (s: Size) => void } = $props();

  let src = $state<string | null>(null);
  let failed = $state(false);
  let loadToken = 0;

  async function load(): Promise<void> {
    const token = ++loadToken;
    failed = false;
    src = null;
    try {
      const url = await getFileUrl(api, fileId, imageMime(name));
      if (token !== loadToken) return;
      src = url;
    } catch {
      if (token === loadToken) failed = true;
    }
  }

  function onImgLoad(e: Event) {
    const img = e.currentTarget as HTMLImageElement;
    onbasesize?.({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function onImgError() {
    failed = true;
  }

  $effect(() => {
    // Abhängig von fileId/name neu laden (Blob-URL ist pro fileId+mime gecacht)
    fileId; name;
    void load();
  });
</script>

<div class="page" style:width="{targetWidth}px">
  {#if src && !failed}
    <img {src} alt="" onload={onImgLoad} onerror={onImgError} />
  {/if}
  {#if failed}
    <div class="ph">Bild kann nicht angezeigt werden</div>
  {/if}
</div>

<style>
  .page { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .2); }
  img { display: block; width: 100%; height: auto; }
  .ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        min-height: 200px; background: #fff; color: #a33; font-size: 13px; padding: 20px; text-align: center; }
</style>
