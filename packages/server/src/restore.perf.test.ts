import { describe, it, expect } from 'vitest';
import { applyCommand, emptyState, type DesktopState } from '@j-desk/core';
import { openDb, type Db } from './db';
import { createDesk, type Actor } from './deskStore';
import { appendJournal, nearestSnapshot, journalRange, SNAPSHOT_INTERVAL } from './journal';
import { restoreDeskTo } from './restore';

/** D-12: die reine Wiederherstellungsdauer bleibt bei einem 5.000-Zeilen-Journal unter
 *  dieser Schwelle — der Performance-Nachweis für HIST-03 (edge-fallback, A-05). */
const RESTORE_SCHWELLE_MS = 500;
const JOURNAL_GROESSE = 5000;
const ZIEL_REV = 4900;

function dbMitBenutzer(): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
  return db;
}

/**
 * Baut synthetisch ein Journal mit `anzahl` addDoc-Zeilen auf — plus bei jedem SNAPSHOT_INTERVAL-
 * ten `rev` eine `snapshot`-Zeile, genau das, was `vielleichtSnapshot` im Betrieb schreibt.
 * ALLES in EINER db.transaction() (sonst dominiert der Transaktions-Overhead die Messung), der
 * Zustand wird dabei über `applyCommand` fortlaufend mitgeführt statt erfunden.
 */
function baueJournal(db: Db, deskId: string, actor: Actor, anzahl: number): DesktopState {
  let state = emptyState();
  const txn = db.transaction((): void => {
    for (let rev = 1; rev <= anzahl; rev += 1) {
      const payload = { fileId: `file-${rev}`, name: `${rev}.pdf`, position: { x: rev, y: rev }, id: `doc-${rev}` };
      state = applyCommand(state, { type: 'addDoc', payload });
      appendJournal(db, { deskId, rev, type: 'addDoc', payload, actorId: actor.id, actorName: actor.name });
      if (rev % SNAPSHOT_INTERVAL === 0) {
        appendJournal(db, { deskId, rev, type: 'snapshot', payload: { state }, actorId: null, actorName: 'System' });
      }
    }
  });
  txn();
  db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(state), anzahl, deskId);
  return state;
}

describe(`Performance: Wiederherstellung gegen ein ${JOURNAL_GROESSE}-Zeilen-Journal (HIST-03/D-12)`, () => {
  // WR-01 (04-04): die SNAPSHOT_INTERVAL-Kappung gilt für ein reines Command-Journal (dieser
  // Test baut ausschließlich addDoc- + automatische snapshot-Zeilen, s. baueJournal()) — sie
  // ist kein universeller Bound über jede mögliche Journal-Zusammensetzung. Nebenwirkungsfreie
  // Zeilen wie 'exported' verbrauchen keinen rev und können den tatsächlichen Replay-Bereich
  // über SNAPSHOT_INTERVAL hinaus vergrößern (s. Doku bei SNAPSHOT_INTERVAL in journal.ts und
  // den Gegenbeweis-Test weiter unten).
  it(`restoreDeskTo() bleibt unter ${RESTORE_SCHWELLE_MS} ms und liest höchstens SNAPSHOT_INTERVAL Journal-Zeilen (reines Command-Journal)`, () => {
    const db = dbMitBenutzer();
    const actor: Actor = { id: 'u1', name: 'Frau Müller' };
    const desk = createDesk(db, 'u1', 'Perf-Desk');
    baueJournal(db, desk.id, actor, JOURNAL_GROESSE);

    const zielZeile = db
      .prepare("SELECT id FROM command_journal WHERE desk_id = ? AND rev = ? AND type = 'addDoc'")
      .get(desk.id, ZIEL_REV) as { id: number };
    expect(zielZeile).toBeDefined();

    // Struktureller Nachweis: der replaybare Bereich ab dem nächstgelegenen Snapshot ist
    // durch SNAPSHOT_INTERVAL gedeckelt, unabhängig von der Journal-Gesamtlänge (D-11).
    const snap = nearestSnapshot(db, desk.id, zielZeile.id)!;
    expect(snap).toBeDefined();
    const range = journalRange(db, desk.id, snap.id, zielZeile.id);
    expect(range.length).toBeLessThanOrEqual(SNAPSHOT_INTERVAL);

    const start = performance.now();
    const ergebnis = restoreDeskTo(db, desk.id, zielZeile.id, actor);
    const dauerMs = performance.now() - start;

    expect(dauerMs).toBeLessThan(RESTORE_SCHWELLE_MS);
    // Korrektheit, nicht nur Geschwindigkeit: bis rev=ZIEL_REV wurden genau ZIEL_REV Dokumente angelegt.
    expect(ergebnis.state.docs).toHaveLength(ZIEL_REV);
  }, 30_000);

  // WR-01 (04-04): Gegenbeweis zur oben getesteten Kappung — 'exported'-Zeilen verbrauchen
  // keinen rev und lösen daher keinen automatischen Snapshot aus. Genug davon zwischen zwei
  // Commands lassen den tatsächlich gelesenen Replay-Bereich SNAPSHOT_INTERVAL überschreiten,
  // obwohl replayJournal() sie dank CR-01 folgenlos überspringt (kein Fehler, nur mehr Zeilen).
  it('exported-Zeilen zwischen zwei Commands lassen den Replay-Bereich SNAPSHOT_INTERVAL überschreiten', () => {
    const db = dbMitBenutzer();
    const actor: Actor = { id: 'u1', name: 'Frau Müller' };
    const desk = createDesk(db, 'u1', 'Export-Deckel-Desk');

    let state = emptyState();
    const ersterPayload = { fileId: 'file-1', name: '1.pdf', position: { x: 1, y: 1 }, id: 'doc-1' };
    state = applyCommand(state, { type: 'addDoc', payload: ersterPayload });
    appendJournal(db, { deskId: desk.id, rev: 1, type: 'addDoc', payload: ersterPayload, actorId: actor.id, actorName: actor.name });

    // Mehr 'exported'-Zeilen als SNAPSHOT_INTERVAL — alle mit demselben rev=1, da ein Export
    // keinen rev verbraucht (Muster wie beim GET /export-Route in app.ts).
    for (let i = 0; i < SNAPSHOT_INTERVAL + 10; i += 1) {
      appendJournal(db, { deskId: desk.id, rev: 1, type: 'exported', payload: { format: 'jdesk' }, actorId: actor.id, actorName: actor.name });
    }

    const zweiterPayload = { fileId: 'file-2', name: '2.pdf', position: { x: 2, y: 2 }, id: 'doc-2' };
    state = applyCommand(state, { type: 'addDoc', payload: zweiterPayload });
    appendJournal(db, { deskId: desk.id, rev: 2, type: 'addDoc', payload: zweiterPayload, actorId: actor.id, actorName: actor.name });
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(state), 2, desk.id);

    const zielZeile = db
      .prepare("SELECT id FROM command_journal WHERE desk_id = ? AND rev = 2 AND type = 'addDoc'")
      .get(desk.id) as { id: number };

    // Kein Snapshot existiert (rev nie durch SNAPSHOT_INTERVAL teilbar) — nearestSnapshot()
    // liefert undefined, journalRange() liest ab dem Anfang des Journals.
    expect(nearestSnapshot(db, desk.id, zielZeile.id)).toBeUndefined();
    const range = journalRange(db, desk.id, 0, zielZeile.id);
    expect(range.length).toBeGreaterThan(SNAPSHOT_INTERVAL);

    // Trotzdem korrekt und ohne Fehler (CR-01) — nur eben nicht auf SNAPSHOT_INTERVAL gedeckelt.
    const ergebnis = restoreDeskTo(db, desk.id, zielZeile.id, actor);
    expect(ergebnis.state.docs).toHaveLength(2);
  });
});
