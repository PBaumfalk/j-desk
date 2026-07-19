import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { FILE_STORE, idbGet, idbPut } from './idb';
import type { ApiClient } from './api';
import { fetchPreviewBytes } from './previewPoll';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Seitenzahlen je Datei — fürs Konvolut-Blättern. Cache + In-Flight-Dedup. */
const counts = new Map<string, number>();
const inFlight = new Map<string, Promise<number>>();

async function bytesFor(api: ApiClient, fileId: string, source: 'original' | 'preview'): Promise<Uint8Array> {
  if (source === 'preview') return fetchPreviewBytes(api, fileId);
  const cached = await idbGet(FILE_STORE, fileId).catch(() => null);
  if (cached) return cached;
  const bytes = await api.fetchFile(fileId);
  await idbPut(FILE_STORE, fileId, bytes).catch(() => {});
  return bytes;
}

export function getPageCount(api: ApiClient, fileId: string, source: 'original' | 'preview' = 'original'): Promise<number> {
  const cacheKey = `${source}:${fileId}`;
  const bekannt = counts.get(cacheKey);
  if (bekannt !== undefined) return Promise.resolve(bekannt);
  const laufend = inFlight.get(cacheKey);
  if (laufend) return laufend;
  const p = (async () => {
    const data = await bytesFor(api, fileId, source);
    let pdf: pdfjs.PDFDocumentProxy | undefined;
    try {
      pdf = await pdfjs.getDocument({ data }).promise;
      counts.set(cacheKey, pdf.numPages);
      return pdf.numPages;
    } finally {
      await pdf?.destroy?.();
    }
  })().finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, p);
  return p;
}

/** Nur für Tests. */
export function invalidatePageCounts(): void {
  counts.clear();
  inFlight.clear();
}
