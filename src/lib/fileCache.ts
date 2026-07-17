import { FILE_STORE, idbGet, idbPut } from './idb';
import type { ApiClient } from './api';

const urls = new Map<string, string>();

/** Objekt-URL der PDF; lädt einmalig vom Server und hält die Bytes in IndexedDB. */
export async function getFileUrl(api: ApiClient, fileId: string): Promise<string> {
  const known = urls.get(fileId);
  if (known) return known;
  let bytes = await idbGet(FILE_STORE, fileId).catch(() => null);
  if (!bytes) {
    bytes = await api.fetchFile(fileId);
    await idbPut(FILE_STORE, fileId, bytes).catch(() => {}); // Cache ist Komfort
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  urls.set(fileId, url);
  return url;
}
