import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Doc } from '@j-desk/core';
import type { ApiClient } from './api';
import { THUMB_STORE, idbGet, idbPut } from './idb';
import { PreviewError, fetchPreviewBytes } from './previewPoll';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const urls = new Map<string, string>();

function remember(key: string, bytes: Uint8Array, mime = 'image/png'): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  urls.set(key, url);
  return url;
}

/** Leitet den Bild-MIME-Typ aus der Dateiendung ab (der Server liefert keinen MIME-Typ beim Abruf). */
export function imageMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * Object-URL der Miniatur; null, wenn nicht renderbar. Bilddateien (`doc.kind === 'image'`)
 * nehmen einen Kurzweg — Bytes direkt als Bild-URL, kein pdfjs (das würde an Bilddaten scheitern).
 * `source: 'preview'` lädt bei PDFs die konvertierte Vorschau-PDF (mit Poll) statt der Originaldatei.
 * Bei Konvertierungsfehlern/Zeitüberschreitung wirft diese Funktion `PreviewError` weiter, damit der
 * Aufrufer die Servermeldung anzeigen kann; andere Fehler (defekt/nicht ladbar) liefern still `null`.
 */
export async function getThumbnail(api: ApiClient, doc: Doc, source: 'original' | 'preview' = 'original'): Promise<string | null> {
  if (doc.kind === 'image') {
    const key = `image:${doc.fileId}`;
    const cached = urls.get(key);
    if (cached) return cached;
    const mime = imageMime(doc.name);
    try {
      const stored = await idbGet(THUMB_STORE, key).catch(() => null);
      if (stored) return remember(key, stored, mime);
      const bytes = await api.fetchFile(doc.fileId);
      await idbPut(THUMB_STORE, key, bytes).catch(() => {});
      return remember(key, bytes, mime);
    } catch {
      return null;
    }
  }
  // Zuletzt aufgeschlagene Seite (doc.page) statt stur Seite 1 — Wunsch A2.8.
  const seite = doc.pageOnly ?? doc.page ?? 1;
  const base = seite === 1 ? doc.fileId : `${doc.fileId}:${seite}`;
  const key = source === 'preview' ? `preview:${base}` : base;
  const cached = urls.get(key);
  if (cached) return cached;
  try {
    const stored = await idbGet(THUMB_STORE, key).catch(() => null);
    if (stored) return remember(key, stored);
    const data = source === 'preview' ? await fetchPreviewBytes(api, doc.fileId) : await api.fetchFile(doc.fileId);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(Math.min(seite, pdf.numPages));
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
    await idbPut(THUMB_STORE, key, bytes).catch(() => {});
    return remember(key, bytes);
  } catch (e) {
    if (e instanceof PreviewError) throw e;
    return null; // defekt oder (noch) nicht ladbar → generisches Symbol
  }
}
