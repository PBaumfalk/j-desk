const DB_NAME = 'digital-desktop';
const DB_VERSION = 2;
export const FILE_STORE = 'files';
export const THUMB_STORE = 'thumbnails';
/** 05-01 (SAFE-01, D-17): letzter bestätigter Schreibtisch-Zustand, Schlüssel = deskId. */
export const SNAPSHOT_STORE = 'deskSnapshot';
/** 05-01 (SAFE-01, D-17): ausstehende, noch nicht bestätigte Commands (Plan 05-02, hier nur
 *  angelegt) — Einfügereihenfolge über autoIncrement-`seq`. */
export const QUEUE_STORE = 'pendingCommands';
/** Obergrenze pro Store; ältester Eintrag fliegt zuerst. Gilt NICHT für SNAPSHOT_STORE/
 *  QUEUE_STORE — dort liegt Nutzerarbeit statt Cache (05-PATTERNS.md). */
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
      if (!req.result.objectStoreNames.contains(SNAPSHOT_STORE)) req.result.createObjectStore(SNAPSHOT_STORE);
      if (!req.result.objectStoreNames.contains(QUEUE_STORE)) {
        req.result.createObjectStore(QUEUE_STORE, { keyPath: 'seq', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB nicht verfügbar'));
  });
  return dbPromise;
}

/** Roh-Transaktionshelfer — exportiert für `offlineQueue.ts` (05-02, SAFE-02), dessen
 *  `QUEUE_STORE`-Zugriffe (`add`/`getAll`/`delete`) keine der bestehenden `idbGet*`/`idbPut*`-
 *  Hüllen (Cache-Entry- bzw. Snapshot-Form) passen. */
export function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB-Zugriff fehlgeschlagen'));
      }),
  );
}

/** WR-03: geworfen, wenn `countAndAdd()` das übergebene `limit` bereits erreicht/überschritten
 *  vorfindet — die Transaktion bricht dann ohne Schreibversuch ab. */
export class LimitErreichtError extends Error {}

/**
 * Zählt (gefiltert über `passt`) und fügt `item` nur hinzu, wenn die Zählung noch UNTER `limit`
 * liegt — beides in EINER IndexedDB-Transaktion. `enqueueCommand()`s vorherige Fassung prüfte
 * die Länge über einen eigenständigen `tx()`-Aufruf (eigene Transaktion) und reihte danach über
 * einen ZWEITEN `tx()`-Aufruf ein — zwischen beiden konnte ein gleichzeitiger zweiter Aufruf
 * (mehrere fire-and-forget `command()`-Aufrufe aus `store.svelte.ts`, z. B. `jumpTo()`)
 * denselben Zwischenraum treffen und die Obergrenze um die Anzahl der interleavenden Aufrufe
 * überschreiten (WR-03). Eine einzige `readwrite`-Transaktion macht Zählen+Schreiben atomar:
 * kein zweiter Aufruf kann zwischen `getAll()` und `add()` dieser Transaktion einen weiteren
 * Request auf denselben Store einschieben.
 */
export function countAndAdd<T>(store: string, passt: (wert: T) => boolean, limit: number, item: T): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        let erledigt = false;
        const settleReject = (err: unknown): void => {
          if (erledigt) return;
          erledigt = true;
          reject(err instanceof Error ? err : new Error('IndexedDB-Zugriff fehlgeschlagen'));
        };
        const settleResolve = (): void => {
          if (erledigt) return;
          erledigt = true;
          resolve();
        };

        const t = db.transaction(store, 'readwrite');
        const s = t.objectStore(store);
        const getAllReq = s.getAll();
        getAllReq.onsuccess = () => {
          const alle = getAllReq.result as T[];
          if (alle.filter(passt).length >= limit) {
            settleReject(new LimitErreichtError());
            t.abort();
            return;
          }
          s.add(item);
        };
        getAllReq.onerror = () => settleReject(getAllReq.error);
        t.oncomplete = () => settleResolve();
        t.onerror = () => settleReject(t.error);
        t.onabort = () => settleReject(t.error ?? new Error('IndexedDB-Transaktion abgebrochen'));
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

/** Wie `idbGet`, aber ohne die `{bytes, ts}`-Hülle — für `SNAPSHOT_STORE`/`QUEUE_STORE`, wo
 *  Werte direkt als Objekt gespeichert liegen (05-01, SAFE-01). */
export async function idbGetJson<T>(store: string, key: IDBValidKey): Promise<T | null> {
  const entry = await tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  return entry ?? null;
}

/** Wie `idbPut`, aber speichert das Objekt direkt (keine Altersverdrängung — s. o.). */
export async function idbPutJson(store: string, key: string, wert: unknown): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(wert, key));
}

/** Löscht alle Einträge eines Stores (z. B. Abmelde-Reset des Snapshots, D-18). */
export async function idbDeleteAll(store: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
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
