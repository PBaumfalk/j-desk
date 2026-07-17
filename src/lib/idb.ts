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

/** Verdrängung nach Alter: behält höchstens `max` Einträge, löscht die ältesten. */
export async function trimStore(store: string, max: number): Promise<void> {
  const [keys, entries] = await Promise.all([
    tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()),
    tx<Entry[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<Entry[]>),
  ]);
  if (keys.length <= max) return;
  const byAge = keys.map((key, i) => ({ key, ts: entries[i]?.ts ?? 0 })).sort((a, b) => a.ts - b.ts);
  for (const { key } of byAge.slice(0, keys.length - max)) {
    await tx(store, 'readwrite', (s) => s.delete(key));
  }
}
