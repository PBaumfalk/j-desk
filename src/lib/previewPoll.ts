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
 *
 * @param isCancelled Optional — wird vor jedem Poll-Durchlauf und nach jedem Sleep geprüft;
 *   liefert sie true, bricht der Poll sofort mit PreviewError ab (kein Fehlerstatus vom
 *   Server, sondern ein reiner Abbruch — z. B. weil die aufrufende Komponente unmounted
 *   oder die Seite gewechselt hat).
 */
export async function fetchPreviewBytes(
  api: ApiClient,
  fileId: string,
  isCancelled?: () => boolean,
): Promise<Uint8Array> {
  const key = previewCacheKey(fileId);
  // Bekannte Grenze: Dieser Schlüssel ist nicht versioniert. Der Server cacht die Vorschau
  // je changeDate, aber der Client erkennt eine nach externer Änderung (z. B. in j-lawyer)
  // neu erzeugte Vorschau nicht automatisch — bis der IDB-Cache geleert wird, kann hier eine
  // veraltete Vorschau ausgeliefert werden. Ein Versionssignal (z. B. changeDate im Schlüssel)
  // wäre eine sinnvolle Folgerunde, ist aber bewusst nicht Teil dieses Fixes.
  const cached = await idbGet(FILE_STORE, key).catch(() => null);
  if (cached) return cached;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (isCancelled?.()) throw new PreviewError('abgebrochen');
    const r = await api.fetchPreview(fileId);
    if (r.status === 'ready') {
      await idbPut(FILE_STORE, key, r.bytes).catch(() => {}); // Cache ist Komfort
      return r.bytes;
    }
    if (r.status === 'error') throw new PreviewError(r.message);
    if (Date.now() >= deadline) throw new PreviewError('Zeitüberschreitung bei der Vorschau-Erzeugung');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (isCancelled?.()) throw new PreviewError('abgebrochen');
  }
}
