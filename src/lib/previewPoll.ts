import type { ApiClient } from './api';
import { FILE_STORE, idbGet, idbPut } from './idb';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

/** Vorschau nicht ladbar (Server-Fehler oder Zeitüberschreitung) — Meldung ist für Anzeige gedacht. */
export class PreviewError extends Error {}

/** IDB-Schlüssel für zwischengespeicherte Vorschau-Bytes einer Datei. */
export function previewCacheKey(fileId: string): string {
  return `preview:${fileId}`;
}

/**
 * Lädt die Vorschau-Bytes einer Datei (IDB-Cache -> Server), pollt bei laufender
 * Konvertierung alle 1,5 s bis max. 90 s. Wirft bei 'error' oder Zeitüberschreitung.
 */
export async function fetchPreviewBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const key = previewCacheKey(fileId);
  const cached = await idbGet(FILE_STORE, key).catch(() => null);
  if (cached) return cached;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const r = await api.fetchPreview(fileId);
    if (r.status === 'ready') {
      await idbPut(FILE_STORE, key, r.bytes).catch(() => {}); // Cache ist Komfort
      return r.bytes;
    }
    if (r.status === 'error') throw new PreviewError(r.message);
    if (Date.now() >= deadline) throw new PreviewError('Zeitüberschreitung bei der Vorschau-Erzeugung');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
