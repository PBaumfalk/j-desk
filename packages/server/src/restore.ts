import { emptyState, replayJournal, type DesktopState } from '@j-desk/core';
import type { Db } from './db';
import { DeskNotFoundError, getDeskState, type Actor, type DeskState } from './deskStore';
import { appendJournal, journalRange, nearestSnapshot } from './journal';

/** Die historische Zeile lässt sich beim Replay nicht erneut anwenden (unbekannter
 *  Command-Typ, ungültige Zeile) — 422, Zustand bleibt unverändert (P-03). */
export class ReplayFehler extends Error {}

/**
 * Stellt einen Schreibtisch auf den Stand einer früheren Journal-Zeile (`toEntryId`) zurück
 * (D-11, D-07). Reihenfolge ist wesentlich:
 *  1. Die Zielzeile wird geladen und gegen `deskId` geprüft — VOR jedem Schreibzugriff, fail-closed
 *     mit derselben 404-Meldung wie bei unbekannter id (T-04-02: kein Signal über fremde Einträge).
 *  2. Der historische Zustand wird VOR und AUSSERHALB der Transaktion vollständig rekonstruiert
 *     (nächstgelegener Snapshot + Replay). Wirft der Replay, wird nichts geschrieben (P-03).
 *  3. Erst danach: eine einzige Transaktion mit genau drei Schritten — Sicherheits-Snapshot des
 *     aktuellen Standes, Zustands-Ersatz, eigene `stateRestored`-Journal-Zeile (P-01).
 */
export function restoreDeskTo(db: Db, deskId: string, toEntryId: number, actor: Actor): DeskState {
  const vorher = getDeskState(db, deskId);
  if (!vorher) throw new DeskNotFoundError('Schreibtisch nicht gefunden');

  const ziel = db.prepare('SELECT id, desk_id AS deskId, at FROM command_journal WHERE id = ?').get(toEntryId) as
    | { id: number; deskId: string; at: number }
    | undefined;
  if (!ziel || ziel.deskId !== deskId) {
    // Bewusst dieselbe Meldung wie „gibt es nicht" — sonst verrät die Antwort die Existenz
    // eines fremden Eintrags (T-04-02, IDOR-Schutz über die Desk-Grenze).
    throw new DeskNotFoundError('Historieneintrag nicht gefunden');
  }

  const snap = nearestSnapshot(db, deskId, toEntryId);
  const startState: DesktopState = snap ? (JSON.parse(snap.payload) as { state: DesktopState }).state : emptyState();
  const rows = journalRange(db, deskId, snap?.id ?? 0, toEntryId);

  let restoredState: DesktopState;
  try {
    restoredState = replayJournal(startState, rows);
  } catch (fehler) {
    // WR-02 (04-04): die Client-Meldung bleibt bewusst allgemein (keine internen Journal-Details
    // nach außen) — die von replayJournal() um id/rev/type angereicherte Ursache landet im
    // Server-Log, damit ein Betreiber ohne Repro-Skript nachvollziehen kann, welche Zeile brach.
    console.error(`restoreDeskTo: Replay fehlgeschlagen für desk=${deskId} toEntryId=${toEntryId}:`, fehler);
    throw new ReplayFehler(
      'Dieser Stand lässt sich nicht wiederherstellen — die Historie enthält einen Eintrag, der sich nicht erneut anwenden lässt.',
    );
  }

  const txn = db.transaction((): DeskState => {
    const neuRev = vorher.rev + 1;
    // Sicherheits-Snapshot des aktuellen Standes — Pflicht, nicht optional (D-07/P-01): der
    // überschriebene Stand bleibt vollständig rekonstruierbar.
    appendJournal(db, {
      deskId, rev: vorher.rev, type: 'snapshot', payload: { state: vorher.state }, actorId: actor.id, actorName: actor.name,
    });
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(restoredState), neuRev, deskId);
    // Die Wiederherstellung journaliert sich selbst (Repudiation, T-04-05): eigener Typ,
    // Ziel-Zeitpunkt und Ziel-id im Payload, Akteur des Auslösers.
    appendJournal(db, {
      deskId, rev: neuRev, type: 'stateRestored',
      payload: { state: restoredState, targetAt: ziel.at, targetEntryId: toEntryId },
      actorId: actor.id, actorName: actor.name,
    });
    return { rev: neuRev, state: restoredState };
  });
  return txn();
}
