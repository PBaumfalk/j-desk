import { describe, it, expect } from 'vitest';
import { openDb, type Db } from './db';
import { createDesk } from './deskStore';
import { appendJournal, listJournal } from './journal';

function dbMitBenutzer(): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
  return db;
}

describe('appendJournal/listJournal', () => {
  it('liefert Einträge neueste zuerst', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    appendJournal(db, { deskId: desk.id, rev: 1, type: 'documentAdded', actorId: 'u1', actorName: 'patrick' });
    appendJournal(db, { deskId: desk.id, rev: 2, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });
    appendJournal(db, { deskId: desk.id, rev: 3, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });

    const list = listJournal(db, desk.id);
    expect(list.map((e) => e.rev)).toEqual([3, 2, 1]);
  });

  it('setzt at auf Date.now() wenn nicht angegeben', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    const before = Date.now();
    appendJournal(db, { deskId: desk.id, rev: 1, type: 'documentAdded', actorId: 'u1', actorName: 'patrick' });
    const after = Date.now();

    const [entry] = listJournal(db, desk.id);
    expect(entry.at).toBeGreaterThanOrEqual(before);
    expect(entry.at).toBeLessThanOrEqual(after);
  });

  it('speichert und parst payload als JSON, NULL bleibt null', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    appendJournal(db, {
      deskId: desk.id, rev: 1, type: 'documentAdded', payload: { docId: 'd1' }, actorId: 'u1', actorName: 'patrick',
    });
    appendJournal(db, { deskId: desk.id, rev: 2, type: 'deskCreated', actorId: null, actorName: 'System' });

    const list = listJournal(db, desk.id);
    expect(list.find((e) => e.rev === 1)?.payload).toEqual({ docId: 'd1' });
    expect(list.find((e) => e.rev === 2)?.payload).toBeNull();
    expect(list.find((e) => e.rev === 2)?.actorId).toBeNull();
  });

  it('begrenzt auf limit (default 50, max 200)', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    for (let i = 1; i <= 60; i++) {
      appendJournal(db, { deskId: desk.id, rev: i, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });
    }
    expect(listJournal(db, desk.id)).toHaveLength(50);
    expect(listJournal(db, desk.id, { limit: 5 })).toHaveLength(5);
    expect(listJournal(db, desk.id, { limit: 500 })).toHaveLength(60);
  });

  it('klemmt negative limit-Werte auf 0 statt sie an SQLite als "kein Limit" durchzureichen', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    for (let i = 1; i <= 60; i++) {
      appendJournal(db, { deskId: desk.id, rev: i, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });
    }
    expect(listJournal(db, desk.id, { limit: -1 })).toHaveLength(0);
  });

  it('liefert eine leere Liste bei limit: 0', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    appendJournal(db, { deskId: desk.id, rev: 1, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });
    expect(listJournal(db, desk.id, { limit: 0 })).toHaveLength(0);
  });

  it('rundet ein Float-limit ab statt es ungerundet an SQLite zu binden (sonst "datatype mismatch" an LIMIT ?)', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    for (let i = 1; i <= 5; i++) {
      appendJournal(db, { deskId: desk.id, rev: i, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });
    }
    expect(() => listJournal(db, desk.id, { limit: 2.5 })).not.toThrow();
    expect(listJournal(db, desk.id, { limit: 2.5 })).toHaveLength(2);
  });

  it('rundet ein Float-before ab statt es ungerundet an SQLite zu binden', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    for (let i = 1; i <= 5; i++) {
      appendJournal(db, { deskId: desk.id, rev: i, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });
    }
    const firstPage = listJournal(db, desk.id, { limit: 2 });
    const beforeId = firstPage[firstPage.length - 1].id;
    expect(() => listJournal(db, desk.id, { before: beforeId + 0.7 })).not.toThrow();
  });

  it('paginiert per Keyset (before = id < before)', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    for (let i = 1; i <= 5; i++) {
      appendJournal(db, { deskId: desk.id, rev: i, type: 'noteAdded', actorId: 'u1', actorName: 'patrick' });
    }
    const firstPage = listJournal(db, desk.id, { limit: 2 });
    expect(firstPage.map((e) => e.rev)).toEqual([5, 4]);

    const secondPage = listJournal(db, desk.id, { limit: 2, before: firstPage[firstPage.length - 1].id });
    expect(secondPage.map((e) => e.rev)).toEqual([3, 2]);
  });

  it('kürzt state-Feld im Payload auf "…" bei snapshot/stateReplaced/caseSync', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    appendJournal(db, {
      deskId: desk.id, rev: 1, type: 'snapshot', payload: { state: { objects: [] }, extra: 'x' }, actorId: null, actorName: 'Migration',
    });
    appendJournal(db, {
      deskId: desk.id, rev: 2, type: 'stateReplaced', payload: { state: { objects: [] } }, actorId: 'u1', actorName: 'patrick',
    });
    appendJournal(db, {
      deskId: desk.id, rev: 3, type: 'caseSync', payload: { state: { objects: [] } }, actorId: null, actorName: 'j-lawyer-Abgleich',
    });
    appendJournal(db, {
      deskId: desk.id, rev: 4, type: 'documentAdded', payload: { state: 'sollte nicht gekürzt werden' }, actorId: 'u1', actorName: 'patrick',
    });

    const list = listJournal(db, desk.id);
    const byRev = (r: number) => list.find((e) => e.rev === r)!;
    expect((byRev(1).payload as { state: unknown; extra: string }).state).toBe('…');
    expect((byRev(1).payload as { extra: string }).extra).toBe('x');
    expect((byRev(2).payload as { state: unknown }).state).toBe('…');
    expect((byRev(3).payload as { state: unknown }).state).toBe('…');
    expect((byRev(4).payload as { state: unknown }).state).toBe('sollte nicht gekürzt werden');
  });

  it('kürzt/projiziert stateRestored genauso wie snapshot/stateReplaced/caseSync (04-01, T-04-01)', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    const stateMitPrivatemUndOeffentlichemObjekt = {
      docs: [], links: [], stacks: [],
      layers: [{ id: 'privat-u1', typ: 'privat', name: 'Privat', ownerUserId: 'u1' }],
      notes: [
        { id: 'n-privat', kind: 'notiz', text: 'geheim', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-u1' },
        { id: 'n-oeffentlich', kind: 'notiz', text: 'für alle', position: { x: 1, y: 1 }, zIndex: 2 },
      ],
    };
    appendJournal(db, {
      deskId: desk.id, rev: 5, type: 'stateRestored',
      payload: { state: stateMitPrivatemUndOeffentlichemObjekt, targetAt: 1000, targetEntryId: 1 },
      actorId: 'u1', actorName: 'patrick',
    });

    // Ohne Betrachter-Kontext: wörtlich '…' — exakt wie snapshot/stateReplaced/caseSync.
    const ohneKontext = listJournal(db, desk.id);
    const eintragOhne = ohneKontext.find((e) => e.type === 'stateRestored')!;
    expect((eintragOhne.payload as { state: unknown }).state).toBe('…');

    // Mit Betrachter-Kontext (fremder Nutzer ohne Zugriff auf die private Ebene): projizierter
    // State statt Kürzung — das private Objekt fehlt, das öffentliche bleibt.
    const mitKontext = listJournal(db, desk.id, { ctx: { userId: 'fremd', rolle: 'Bearbeiter' } });
    const eintragMit = mitKontext.find((e) => e.type === 'stateRestored')!;
    const projiziert = (eintragMit.payload as { state: { notes: { id: string }[] } }).state;
    expect(projiziert.notes.map((n) => n.id)).not.toContain('n-privat');
    expect(projiziert.notes.map((n) => n.id)).toContain('n-oeffentlich');
  });

  it('kürzt nicht in der DB gespeicherte Daten — voller Snapshot bleibt erhalten', () => {
    const db = dbMitBenutzer();
    const desk = createDesk(db, 'u1', 'Akte A');
    appendJournal(db, {
      deskId: desk.id, rev: 1, type: 'snapshot', payload: { state: { objects: ['voll'] } }, actorId: null, actorName: 'Migration',
    });

    const row = db.prepare('SELECT payload FROM command_journal WHERE rev = 1').get() as { payload: string };
    const raw = JSON.parse(row.payload) as { state: { objects: string[] } };
    expect(raw.state.objects).toEqual(['voll']);
  });
});
