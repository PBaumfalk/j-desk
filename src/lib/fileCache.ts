import { FILE_STORE, idbGet, idbPut } from './idb';
import type { ApiClient } from './api';

const urls = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

/** Objekt-URL der Datei; lädt einmalig vom Server und hält die Bytes in IndexedDB.
 *  Cache-Schlüssel ist `fileId:mime` — derselbe fileId kann von verschiedenen Aufrufern mit
 *  unterschiedlichem MIME angefragt werden (z. B. Bild-Dokument per Menü ohne Kenntnis des
 *  Bild-MIMEs vs. Kartenansicht mit `imageMime(doc.name)`); ein gemeinsamer Schlüssel würde
 *  sonst den zuerst angeforderten Blob-Typ für die ganze Sitzung einfrieren. */
export function getFileUrl(api: ApiClient, fileId: string, mime = 'application/pdf'): Promise<string> {
  const key = `${fileId}:${mime}`;
  const known = urls.get(key);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    let bytes = await idbGet(FILE_STORE, fileId).catch(() => null);
    if (!bytes) {
      bytes = await api.fetchFile(fileId);
      await idbPut(FILE_STORE, fileId, bytes).catch(() => {}); // Cache ist Komfort
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    urls.set(key, url);
    return url;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Gibt alle erzeugten Objekt-URLs frei (z. B. beim Abmelden). */
export function revokeFileUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}
