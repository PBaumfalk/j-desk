import type { DesktopState } from '@j-desk/core';
import { SNAPSHOT_STORE, idbDeleteAll, idbGetJson, idbPutJson } from './idb';
import { debounce } from './debounce';

/** Letzter vom Server bestätigter Schreibtisch-Zustand (SAFE-01, D-04). */
export interface DeskSnapshot {
  deskId: string;
  rev: number;
  state: DesktopState;
  at: number;
}

/** Liest den gecachten Stand eines Schreibtischs; fehlende Verfügbarkeit (kein Eintrag,
 *  IndexedDB gesperrt/nicht unterstützt) ist Bestandsverhalten, kein Fehlerfall — deshalb
 *  `null` statt einer geworfenen Ausnahme. */
export async function readSnapshot(deskId: string): Promise<DeskSnapshot | null> {
  try {
    return await idbGetJson<DeskSnapshot>(SNAPSHOT_STORE, deskId);
  } catch {
    return null;
  }
}

/** Schreibt den aktuell bestätigten Stand. Kontingent erschöpft o. ä. darf keine Aktion
 *  abbrechen — die Ausnahme wird geschluckt (Bestandsverhalten ohne Cache). */
export async function writeSnapshot(deskId: string, rev: number, state: DesktopState): Promise<void> {
  try {
    await idbPutJson(SNAPSHOT_STORE, deskId, { deskId, rev, state, at: Date.now() } satisfies DeskSnapshot);
  } catch {
    // s. o. — Schreibfehler degradieren geräuschlos auf das bisherige Server-Roundtrip-Verhalten
  }
}

/** Entprellte Fassung von `writeSnapshot` für die häufigen Schreibpfade (D-04) — feuert
 *  frühestens 400 ms nach dem letzten Aufruf. */
export const writeSnapshotDebounced = debounce(400, writeSnapshot);

/** Löscht den Cache aller Schreibtische (Abmelden, D-18, Vertraulichkeit). */
export async function clearAllSnapshots(): Promise<void> {
  await idbDeleteAll(SNAPSHOT_STORE);
}
