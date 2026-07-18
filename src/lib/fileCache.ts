import { FILE_STORE, idbGet, idbPut } from './idb';
import type { ApiClient } from './api';

const urls = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

/** Objekt-URL der Datei; lädt einmalig vom Server und hält die Bytes in IndexedDB. */
export function getFileUrl(api: ApiClient, fileId: string, mime = 'application/pdf'): Promise<string> {
  const known = urls.get(fileId);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(fileId);
  if (pending) return pending;
  const p = (async () => {
    let bytes = await idbGet(FILE_STORE, fileId).catch(() => null);
    if (!bytes) {
      bytes = await api.fetchFile(fileId);
      await idbPut(FILE_STORE, fileId, bytes).catch(() => {}); // Cache ist Komfort
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    urls.set(fileId, url);
    return url;
  })().finally(() => inFlight.delete(fileId));
  inFlight.set(fileId, p);
  return p;
}

/** Gibt alle erzeugten Objekt-URLs frei (z. B. beim Abmelden). */
export function revokeFileUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}
