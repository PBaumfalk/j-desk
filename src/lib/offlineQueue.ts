import { erzeugendeCommandTypen, findeObjekt, objektIdFuerCommand, type Command, type DesktopState, type Erwartet } from '@j-desk/core';
import { countAndAdd, LimitErreichtError, QUEUE_STORE, tx } from './idb';

/** Erzeugende Command-Typen (D-15/T-05-05) — Grundlage der Dubletten-Erkennung beim Nachspielen. */
export const ERZEUGEND = new Set(erzeugendeCommandTypen());

/** Harte Obergrenze der Warteschlange (D-16, T-05-07): beim Erreichen wird das NEUE Command
 *  sichtbar abgelehnt statt einen vorhandenen Eintrag zu verdrängen. */
export const MAX_QUEUE = 500;

/** Geworfen, wenn die Warteschlange beim Einreihen bereits `MAX_QUEUE` Einträge trägt (D-16). */
export class QueueVollError extends Error {
  constructor() {
    super('Warteschlange voll');
  }
}

/**
 * Ausstehender, noch nicht bestätigter Command (SAFE-02, D-01/D-02): entsteht, wenn `command()`
 * bei fehlender Verbindung ausgelöst wird oder wenn die Serverantwort eines Online-Commands
 * unterwegs verloren geht (Netzfehler nach dem Senden). `seq` wird von IndexedDB per
 * `autoIncrement` vergeben und ist deshalb beim Schreiben optional (Einfügereihenfolge).
 */
export interface QueueEintrag {
  seq?: number;
  deskId: string;
  cmd: Command & { erwartet?: Erwartet };
  queuedAt: number;
  /** WR-06: Anzahl bisheriger, an einem transienten 5xx-Serverfehler gescheiterter
   *  Sendeversuche beim Nachspielen (`drainQueue()`) — über Wiederverbindungen hinweg persistiert,
   *  damit ein dauerhaft fehlschlagender Server nicht bei jedem einzelnen Reconnect bei 0 anfängt.
   *  `undefined`/fehlend heißt "noch kein Versuch fehlgeschlagen". */
  retries?: number;
}

/**
 * Reiht ein Command in die Warteschlange EINES Schreibtischs ein. Nutzt `add`, nicht `put` —
 * `seq` fehlt beim Schreiben (autoIncrement), `put` würde daran scheitern. Für diesen Store gilt
 * ausdrücklich KEINE Verdrängungsstrategie (kein Aufruf von `trimStore` aus `idb.ts`): hier liegt
 * unübertragene Nutzerarbeit, kein Zwischenspeicher (05-PATTERNS.md).
 *
 * WR-03: Zählung UND Einreihung laufen in EINER IndexedDB-Transaktion (`countAndAdd()`) statt in
 * zwei getrennten Aufrufen — `store.svelte.ts` löst `command()` mehrfach fire-and-forget aus
 * (z. B. `jumpTo()`s `void this.command(...)` gefolgt von einem weiteren `void this.command(...)`),
 * ein check-then-act über zwei separate Transaktionen könnte dort interleaven und die harte
 * Obergrenze `MAX_QUEUE` überschreiten, bevor sie greift.
 */
export async function enqueueCommand(deskId: string, cmd: Command & { erwartet?: Erwartet }): Promise<void> {
  const eintrag: QueueEintrag = { deskId, cmd, queuedAt: Date.now() };
  try {
    await countAndAdd<QueueEintrag>(QUEUE_STORE, (e) => e.deskId === deskId, MAX_QUEUE, eintrag);
  } catch (e) {
    if (e instanceof LimitErreichtError) throw new QueueVollError();
    throw e;
  }
}

/** Alle Einträge EINES Schreibtischs, aufsteigend nach Einfügereihenfolge (`seq`). */
export async function readQueue(deskId: string): Promise<QueueEintrag[]> {
  const alle = await tx<QueueEintrag[]>(QUEUE_STORE, 'readonly', (s) => s.getAll());
  return alle.filter((e) => e.deskId === deskId).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function removeFromQueue(seq: number): Promise<void> {
  await tx(QUEUE_STORE, 'readwrite', (s) => s.delete(seq));
}

/**
 * WR-06: schreibt `entry` mit erhöhtem `retries`-Zähler zurück, OHNE ihn aus der Warteschlange zu
 * entfernen — genutzt von `drainQueue()`, wenn ein Sendeversuch an einem transienten 5xx-Fehler
 * scheitert (im Unterschied zu einem deterministischen 400/404, der sofort verworfen wird). `put`
 * überschreibt den bestehenden Eintrag anhand seines `seq`-Schlüssels in derselben Reihenfolge.
 */
export async function bumpRetry(entry: QueueEintrag, retries: number): Promise<void> {
  await tx(QUEUE_STORE, 'readwrite', (s) => s.put({ ...entry, retries } satisfies QueueEintrag));
}

export async function queueLength(deskId: string): Promise<number> {
  return (await readQueue(deskId)).length;
}

/** Löscht alle Einträge eines Schreibtischs (z. B. Test-Aufräumen). */
export async function clearQueue(deskId: string): Promise<void> {
  for (const e of await readQueue(deskId)) if (e.seq !== undefined) await removeFromQueue(e.seq);
}

/**
 * D-15/T-05-05: `true`, wenn `cmd` ein ERZEUGENDES Command ist, dessen Zielobjekt im
 * übergebenen (frisch geholten) Zustand bereits existiert — dann NICHT erneut senden
 * (Dublettenschutz beim Nachspielen). Für alle anderen Command-Typen liefert sie `false`;
 * mutierende Commands verlassen sich weiterhin auf die bestehende erwartet/409-Mechanik (D-02).
 */
export function istBereitsAngewendet(freshState: DesktopState, cmd: Command): boolean {
  if (!ERZEUGEND.has(cmd.type)) return false;
  const id = objektIdFuerCommand(cmd);
  if (id === undefined) return false;
  return findeObjekt(freshState, id) !== undefined;
}
