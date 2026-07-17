import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Doc } from '@digital-desktop/core';
import type { ApiClient } from './api';
import { THUMB_STORE, idbGet, idbPut } from './idb';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const urls = new Map<string, string>();

function remember(fileId: string, bytes: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  urls.set(fileId, url);
  return url;
}

/** Object-URL der Miniatur der ersten Seite (PNG-Cache pro fileId); null, wenn nicht renderbar. */
export async function getThumbnail(api: ApiClient, doc: Doc): Promise<string | null> {
  const cached = urls.get(doc.fileId);
  if (cached) return cached;
  try {
    const stored = await idbGet(THUMB_STORE, doc.fileId).catch(() => null);
    if (stored) return remember(doc.fileId, stored);
    const data = await api.fetchFile(doc.fileId);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const scale = 360 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob fehlgeschlagen'))), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await idbPut(THUMB_STORE, doc.fileId, bytes).catch(() => {});
    return remember(doc.fileId, bytes);
  } catch {
    return null; // defekt oder (noch) nicht ladbar → generisches Symbol
  }
}
