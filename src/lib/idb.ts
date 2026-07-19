const DB_NAME = 'digital-desktop';
const DB_VERSION = 1;
export const FILE_STORE = 'files';
export const THUMB_STORE = 'thumbnails';
/** Obergrenze pro Store; ältester Eintrag fliegt zuerst. */
const MAX_ENTRIES = 200;

interface Entry {
  bytes: Uint8Array;
  ts: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const store of [FILE_STORE, THUMB_STORE]) {
        if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB nicht verfügbar'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB-Zugriff fehlgeschlagen'));
      }),
  );
}

export async function idbGet(store: string, key: string): Promise<Uint8Array | null> {
  const entry = await tx<Entry | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<Entry | undefined>);
  return entry?.bytes ?? null;
}

export async function idbPut(store: string, key: string, bytes: Uint8Array): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put({ bytes, ts: Date.now() } satisfies Entry, key));
  await trimStore(store, MAX_ENTRIES);
}

/**
 * Verdrängung nach Alter: behält höchstens `max` Einträge, löscht die ältesten.
 * Läuft in einer einzigen readwrite-Transaktion — parallele Puts können also weder
 * die Schlüssel-/Wert-Zuordnung verschieben noch zwischen Lesen und Löschen funken.
 */
export async function trimStore(store: string, max: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    const countReq = s.count();
    countReq.onsuccess = () => {
      const excess = countReq.result - max;
      if (excess <= 0) return; // nichts zu tun — Transaktion läuft leer aus
      const items: { key: IDBValidKey; ts: number }[] = [];
      const cursorReq = s.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          items.push({ key: cursor.key, ts: (cursor.value as Entry).ts ?? 0 });
          cursor.continue();
        } else {
          items.sort((a, b) => a.ts - b.ts);
          for (const { key } of items.slice(0, excess)) s.delete(key);
        }
      };
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB-Zugriff fehlgeschlagen'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB-Transaktion abgebrochen'));
  });
}
