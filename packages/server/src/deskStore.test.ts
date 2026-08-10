import { describe, it, expect, beforeEach } from 'vitest';
import { CommandError, KonfliktError } from '@j-desk/core';
import { openDb, type Db } from './db';
import { listJournal, nearestSnapshot, journalRange, SNAPSHOT_INTERVAL } from './journal';
import {
  createDesk, ensureDesk, ensureBearbeiterRolle, listDesks, renameDesk, deleteDesk, getDeskState,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError, type Actor,
  getRolleForNutzer, pruefeDeskZugriff, pruefeDeskAktion,
} from './deskStore';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
});

/** Schreibtisch mit genau einem Dokument, dessen id `docId` ist. */
function deskMitDoc(db: Db, docId: string): string {
  const desk = createDesk(db, 'u1', 'Neu');
  applyDeskCommand(db, desk.id, {
    type: 'addDoc',
    payload: { fileId: 'file-a', name: 'a.pdf', position: { x: 0, y: 0 }, id: docId },
  });
  return desk.id;
}

describe('Desk-CRUD', () => {
  it('legt an, listet, benennt um und löscht', () => {
    const desk = createDesk(db, 'u1', 'Schreibtisch 1');
    expect(listDesks(db)).toEqual([{ id: desk.id, name: 'Schreibtisch 1', ownerId: 'u1' }]);
    renameDesk(db, desk.id, 'Projekte');
    expect(listDesks(db)[0].name).toBe('Projekte');
    deleteDesk(db, desk.id);
    expect(listDesks(db)).toHaveLength(0);
    expect(() => renameDesk(db, desk.id, 'x')).toThrow(DeskNotFoundError);
    expect(() => deleteDesk(db, desk.id)).toThrow(DeskNotFoundError);
  });

  it('neuer Schreibtisch startet leer mit rev 0', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(getDeskState(db, desk.id)).toEqual({ rev: 0, state: { docs: [], links: [], stacks: [], strokes: [], notes: [], cutouts: [], marks: [], stamps: [], flags: [], clips: [], trash: [], legalObjects: [], tables: [], zeitleisten: [], sitzungsmappen: [] } });
    expect(getDeskState(db, 'gibtsnicht')).toBeNull();
  });
});

describe('applyDeskCommand', () => {
  it('wendet Kommandos an und zählt rev hoch', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const r1 = applyDeskCommand(db, desk.id, {
      type: 'addDoc',
      payload: { fileId: 'file-a', name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' },
    });
    expect(r1.rev).toBe(1);
    expect(r1.state.docs).toHaveLength(1);
    const r2 = applyDeskCommand(db, desk.id, { type: 'moveDoc', payload: { id: 'id-a', position: { x: 9, y: 9 } } });
    expect(r2.rev).toBe(2);
    expect(getDeskState(db, desk.id)!.state.docs[0].position).toEqual({ x: 9, y: 9 });
  });

  it('ungültiges Kommando: CommandError, rev unverändert', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(() => applyDeskCommand(db, desk.id, { type: 'kaputt', payload: {} })).toThrow(CommandError);
    expect(getDeskState(db, desk.id)!.rev).toBe(0);
    expect(() => applyDeskCommand(db, 'gibtsnicht', { type: 'moveDoc', payload: {} })).toThrow(DeskNotFoundError);
  });
});

describe('deskStore reicht Viewer-Commands durch', () => {
  it('expandDoc/setDocPage/resizeDoc landen im gespeicherten Zustand', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    applyDeskCommand(db, desk.id, {
      type: 'addDoc',
      payload: { fileId: 'f', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'id-a' },
    });
    applyDeskCommand(db, desk.id, { type: 'expandDoc', payload: { id: 'id-a' } });
    applyDeskCommand(db, desk.id, { type: 'setDocPage', payload: { id: 'id-a', page: 3 } });
    applyDeskCommand(db, desk.id, { type: 'resizeDoc', payload: { id: 'id-a', size: { w: 800, h: 600 } } });
    const { state } = getDeskState(db, desk.id)!;
    expect(state.docs[0]).toMatchObject({ open: true, page: 3, openSize: { w: 800, h: 600 } });
  });
});

describe('putDeskState', () => {
  it('ersetzt den Zustand komplett und validiert die Struktur', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const state = {
      docs: [{ id: 'id-a', fileId: 'file-a', name: 'a.pdf', position: { x: 0, y: 0 }, rotation: 1, zIndex: 1 }],
      links: [],
      stacks: [],
    };
    const r = putDeskState(db, desk.id, state);
    expect(r.rev).toBe(1);
    expect(getDeskState(db, desk.id)!.state.docs).toHaveLength(1);
    expect(() => putDeskState(db, desk.id, { docs: 5 })).toThrow(InvalidStateError);
    expect(() => putDeskState(db, 'gibtsnicht', state)).toThrow(DeskNotFoundError);
  });
});

describe('Actor + Journal', () => {
  const actor: Actor = { id: 'u1', name: 'Frau Müller' };

  it('Kommando mit Actor: Journal-Eintrag mit Typ/rev/actorName UND State gestempelt', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const r = applyDeskCommand(db, desk.id, {
      type: 'addNote', payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 } },
    }, actor);
    expect(r.rev).toBe(1);
    expect(r.state.notes[0].createdBy).toBe('Frau Müller');
    const entries = listJournal(db, desk.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      rev: 1, type: 'addNote', actorId: 'u1', actorName: 'Frau Müller',
      payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 } },
    });
  });

  it('Kommando ohne Actor: kein Journal-Eintrag, kein Stempel (Altverhalten)', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const r = applyDeskCommand(db, desk.id, {
      type: 'addNote', payload: { kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 } },
    });
    expect(r.state.notes[0].createdBy).toBeUndefined();
    expect(listJournal(db, desk.id)).toHaveLength(0);
  });

  it('CommandError: kein Journal-Eintrag (Transaktion)', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(() => applyDeskCommand(db, desk.id, { type: 'kaputt', payload: {} }, actor)).toThrow(CommandError);
    expect(listJournal(db, desk.id)).toHaveLength(0);
  });

  it('putDeskState mit journal-Option: stateReplaced-Eintrag mit neuem State', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const state = { docs: [], links: [], stacks: [] };
    const r = putDeskState(db, desk.id, state, { type: 'stateReplaced', actor });
    expect(r.rev).toBe(1);
    const entries = listJournal(db, desk.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      rev: 1, type: 'stateReplaced', actorId: 'u1', actorName: 'Frau Müller',
    });
    // listJournal kürzt den State-Payload state-tragender Typen auf '…' (Antwort schlank halten);
    // der volle State steht bereits in getDeskState.
    expect(entries[0].payload).toEqual({ state: '…' });
  });

  it('createDesk/ensureDesk mit Actor: genau EIN deskCreated-Eintrag auch bei zweimaligem ensureDesk', () => {
    const desk = createDesk(db, 'u1', 'Akte 1', actor);
    let entries = listJournal(db, desk.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rev: 0, type: 'deskCreated', actorId: 'u1', actorName: 'Frau Müller', payload: { name: 'Akte 1' } });

    ensureDesk(db, 'fixe-id', 'u1', 'Akte 2', actor);
    ensureDesk(db, 'fixe-id', 'u1', 'Akte 2', actor);
    entries = listJournal(db, 'fixe-id');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rev: 0, type: 'deskCreated', actorId: 'u1', actorName: 'Frau Müller', payload: { name: 'Akte 2' } });
  });
});

describe('applyDeskCommand mit Erwartung', () => {
  it('stempelt das beruehrte Objekt mit der neuen rev', () => {
    const deskId = deskMitDoc(db, 'd1');
    const { rev, state } = applyDeskCommand(db, deskId, { type: 'moveDoc', payload: { id: 'd1', position: { x: 9, y: 9 } } }, { id: 'u1', name: 'Frau Meier' });
    const d1 = state.docs.find((d) => d.id === 'd1')!;
    expect(d1.updatedRev).toBe(rev);
    expect(d1.updatedBy).toBe('Frau Meier');
  });

  it('nimmt eine passende Erwartung an', () => {
    const deskId = deskMitDoc(db, 'd1');
    const erste = applyDeskCommand(db, deskId, { type: 'moveDoc', payload: { id: 'd1', position: { x: 1, y: 1 } } }, { id: 'u1', name: 'A' });
    const version = erste.state.docs.find((d) => d.id === 'd1')!.updatedRev!;

    expect(() =>
      applyDeskCommand(db, deskId, { type: 'moveDoc', payload: { id: 'd1', position: { x: 2, y: 2 } }, erwartet: { d1: version } }, { id: 'u1', name: 'A' }),
    ).not.toThrow();
  });

  it('wirft KonfliktError bei abweichender Erwartung und laesst alles unveraendert', () => {
    const deskId = deskMitDoc(db, 'd1');
    applyDeskCommand(db, deskId, { type: 'moveDoc', payload: { id: 'd1', position: { x: 1, y: 1 } } }, { id: 'u1', name: 'Frau Meier' });
    const vorher = getDeskState(db, deskId)!;
    const journalVorher = (db.prepare('SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ?').get(deskId) as { n: number }).n;

    try {
      applyDeskCommand(db, deskId, { type: 'moveDoc', payload: { id: 'd1', position: { x: 5, y: 5 } }, erwartet: { d1: 999 } }, { id: 'u2', name: 'Herr Klein' });
      expect.unreachable('haette werfen muessen');
    } catch (e) {
      expect(e).toBeInstanceOf(KonfliktError);
      expect((e as KonfliktError).konflikt).toMatchObject({ objektId: 'd1', art: 'geaendert', von: 'Frau Meier' });
    }

    const nachher = getDeskState(db, deskId)!;
    expect(nachher.rev).toBe(vorher.rev);
    expect(nachher.state).toEqual(vorher.state);
    const journalNachher = (db.prepare('SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ?').get(deskId) as { n: number }).n;
    expect(journalNachher).toBe(journalVorher);
  });
});

describe('WR-02: erzeugende Commands ohne Client-ID bekommen serverseitig eine (Journal-Auflösbarkeit)', () => {
  const actor: Actor = { id: 'u1', name: 'Frau Müller' };

  it('addDoc ohne id: Objekt und Journal-Eintrag tragen dieselbe serververgebene ID — der Eintrag bleibt für die CR-03-Projektion auflösbar', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    applyDeskCommand(db, desk.id, {
      type: 'addDoc', payload: { fileId: 'file-a', name: 'a.pdf', position: { x: 0, y: 0 } },
    }, actor);

    const { state } = getDeskState(db, desk.id)!;
    const docId = state.docs[0].id;
    expect(docId).toBeTruthy();

    // Der journalierte Payload trägt die injizierte ID (vor dem Fix: kein id-Feld —
    // der CR-03-Filter blendete den Eintrag für ALLE Betrachter aus, z. B. bei jedem
    // j-lawyer-Upload).
    const eintrag = listJournal(db, desk.id).find((e) => e.type === 'addDoc')!;
    expect((eintrag.payload as { id?: string }).id).toBe(docId);

    // Auflösbarkeit-Endprobe: mit Betrachter-Kontext + State bleibt der Eintrag sichtbar.
    const projiziert = listJournal(db, desk.id, {
      ctx: { userId: 'u1', rolle: 'Eigentümer' }, state,
    });
    expect(projiziert.find((e) => e.type === 'addDoc')).toBeDefined();
  });

  it('addMark ohne mark.id: die verschachtelte ID wird injiziert und mit dem Objekt synchron journaliert', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    applyDeskCommand(db, desk.id, {
      type: 'addDoc', payload: { fileId: 'file-a', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd1' },
    }, actor);
    applyDeskCommand(db, desk.id, {
      type: 'addMark',
      payload: { mark: { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact' } },
    }, actor);

    const { state } = getDeskState(db, desk.id)!;
    const markId = (state.marks ?? [])[0].id;
    expect(markId).toBeTruthy();
    const eintrag = listJournal(db, desk.id).find((e) => e.type === 'addMark')!;
    expect(((eintrag.payload as { mark: { id?: string } }).mark.id)).toBe(markId);
  });

  it('clientvergebene ID wird NICHT überschrieben', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    applyDeskCommand(db, desk.id, {
      type: 'addNote', payload: { id: 'n-eigen', kind: 'notiz', text: 'Hallo', position: { x: 1, y: 2 } },
    }, actor);
    expect(getDeskState(db, desk.id)!.state.notes[0].id).toBe('n-eigen');
    const eintrag = listJournal(db, desk.id).find((e) => e.type === 'addNote')!;
    expect((eintrag.payload as { id?: string }).id).toBe('n-eigen');
  });

  it('mutierende Commands bekommen KEINE erfundene ID (fehlende Ziel-ID bleibt CommandError)', () => {
    const deskId = deskMitDoc(db, 'd1');
    expect(() => applyDeskCommand(db, deskId, { type: 'moveDoc', payload: { position: { x: 9, y: 9 } } }, actor)).toThrow(CommandError);
    expect(listJournal(db, deskId).find((e) => e.type === 'moveDoc')).toBeUndefined();
  });
});

describe('Rollen-Fundament (PERM-03/PERM-04): Eigentümer-Rolle + Rollen-Lookup + Rechteprüfung', () => {
  beforeEach(() => {
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u2', 'fremd', 'h', 0);
  });

  it('createDesk legt in derselben Transaktion eine Eigentümer-Zeile an; getRolleForNutzer liefert danach "Eigentümer"', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(getRolleForNutzer(db, desk.id, 'u1')).toBe('Eigentümer');
  });

  it('ensureDesk legt beim ersten Anlegen ebenfalls die Eigentümer-Rolle an', () => {
    ensureDesk(db, 'akte-1', 'u1', 'Akte 1');
    expect(getRolleForNutzer(db, 'akte-1', 'u1')).toBe('Eigentümer');
    // zweiter Aufruf (bereits vorhandener Desk) darf die Rolle nicht duplizieren/fehlschlagen.
    expect(() => ensureDesk(db, 'akte-1', 'u1', 'Akte 1')).not.toThrow();
    expect(getRolleForNutzer(db, 'akte-1', 'u1')).toBe('Eigentümer');
  });

  it('WR-02: ensureDesk macht Folge-Öffner NICHT zu Mit-Eigentümern; ensureBearbeiterRolle weist Bearbeiter zu ohne Abstufung', () => {
    ensureDesk(db, 'akte-1', 'u1', 'Akte 1');
    // Zweiter Nutzer öffnet dieselbe Akte: Desk existiert bereits — keine Eigentümer-Rolle
    // (bis zur Review wurde u2 hier still zweiter 'Eigentümer', inkl. Lösch-/Verwaltungsrecht).
    ensureDesk(db, 'akte-1', 'u2', 'Akte 1');
    expect(getRolleForNutzer(db, 'akte-1', 'u1')).toBe('Eigentümer');
    expect(getRolleForNutzer(db, 'akte-1', 'u2')).toBeNull();

    // Nach erwiesener jl-Berechtigung: Bearbeiter für den Folge-Öffner …
    ensureBearbeiterRolle(db, 'akte-1', 'u2');
    expect(getRolleForNutzer(db, 'akte-1', 'u2')).toBe('Bearbeiter');
    // … und keine Abstufung des Eigentümers (INSERT OR IGNORE).
    ensureBearbeiterRolle(db, 'akte-1', 'u1');
    expect(getRolleForNutzer(db, 'akte-1', 'u1')).toBe('Eigentümer');
  });

  it('getRolleForNutzer liefert null für einen fremden Nutzer ohne desk_roles-Zeile', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(getRolleForNutzer(db, desk.id, 'u2')).toBeNull();
  });

  it('pruefeDeskZugriff wirft bei fehlender Rolle und bei unzureichender Rolle; liefert die Rolle bei ausreichendem Zugriff', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(() => pruefeDeskZugriff(db, desk.id, 'u2')).toThrow();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, 'u2', 'Kommentator');
    expect(() => pruefeDeskZugriff(db, desk.id, 'u2', ['Eigentümer', 'Bearbeiter'])).toThrow();
    expect(pruefeDeskZugriff(db, desk.id, 'u1')).toBe('Eigentümer');
  });

  it('pruefeDeskAktion respektiert darfAktion: Kommentator darf nicht löschen, Eigentümer schon', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, 'u2', 'Kommentator');

    expect(() => pruefeDeskAktion(db, desk.id, 'u2', 'delete')).toThrow();
    expect(pruefeDeskAktion(db, desk.id, 'u1', 'delete')).toBe('Eigentümer');
  });
});

describe('D-09: automatischer Snapshot alle SNAPSHOT_INTERVAL Zustandsänderungen', () => {
  const actor: Actor = { id: 'u1', name: 'Frau Müller' };

  /** SNAPSHOT_INTERVAL viele addDoc-Commands über applyDeskCommand, jedes mit eigener fileId
   *  (addDoc ist ein No-op bei bereits vorhandener fileId — documents.ts). */
  function fuelleUeberApplyDeskCommand(deskId: string, anzahl: number): void {
    for (let i = 1; i <= anzahl; i += 1) {
      applyDeskCommand(db, deskId, {
        type: 'addDoc',
        payload: { fileId: `file-${i}`, name: `${i}.pdf`, position: { x: i, y: i }, id: `doc-${i}` },
      }, actor);
    }
  }

  it('genau EINE snapshot-Zeile bei rev=SNAPSHOT_INTERVAL, mit vollständigem Zustands-Payload', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    fuelleUeberApplyDeskCommand(desk.id, SNAPSHOT_INTERVAL);

    const snapshots = db
      .prepare("SELECT rev, payload FROM command_journal WHERE desk_id = ? AND type = 'snapshot'")
      .all(desk.id) as { rev: number; payload: string }[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].rev).toBe(SNAPSHOT_INTERVAL);
    const payload = JSON.parse(snapshots[0].payload) as { state: { docs: unknown[] } };
    expect(payload.state.docs).toHaveLength(SNAPSHOT_INTERVAL);
  });

  it('bei rev=SNAPSHOT_INTERVAL-1 und rev=SNAPSHOT_INTERVAL+1 existiert keine zusätzliche snapshot-Zeile', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    fuelleUeberApplyDeskCommand(desk.id, SNAPSHOT_INTERVAL - 1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ? AND type = 'snapshot'").get(desk.id) as { n: number }).n,
    ).toBe(0);

    fuelleUeberApplyDeskCommand(desk.id, 2); // rev SNAPSHOT_INTERVAL und SNAPSHOT_INTERVAL+1
    const snapshots = db
      .prepare("SELECT rev FROM command_journal WHERE desk_id = ? AND type = 'snapshot'")
      .all(desk.id) as { rev: number }[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].rev).toBe(SNAPSHOT_INTERVAL);
  });

  it('putDeskState löst denselben Trigger aus — Snapshot bei rev=SNAPSHOT_INTERVAL auch auf dem Import-/j-lawyer-Pfad', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    for (let i = 1; i <= SNAPSHOT_INTERVAL; i += 1) {
      putDeskState(db, desk.id, { docs: [], links: [], stacks: [] });
    }
    const snapshots = db
      .prepare("SELECT rev FROM command_journal WHERE desk_id = ? AND type = 'snapshot'")
      .all(desk.id) as { rev: number }[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].rev).toBe(SNAPSHOT_INTERVAL);
  });

  it('nearestSnapshot findet den Snapshot bei rev=SNAPSHOT_INTERVAL; journalRange ab dort liefert höchstens SNAPSHOT_INTERVAL Zeilen', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    fuelleUeberApplyDeskCommand(desk.id, SNAPSHOT_INTERVAL);
    fuelleUeberApplyDeskCommand(desk.id, 5); // rev SNAPSHOT_INTERVAL+1 .. SNAPSHOT_INTERVAL+5

    const zielZeile = (
      db.prepare('SELECT id FROM command_journal WHERE desk_id = ? AND rev = ?').get(desk.id, SNAPSHOT_INTERVAL + 5) as { id: number }
    );
    const snap = nearestSnapshot(db, desk.id, zielZeile.id)!;
    expect(snap).toBeDefined();
    const snapRow = db.prepare('SELECT rev FROM command_journal WHERE id = ?').get(snap.id) as { rev: number };
    expect(snapRow.rev).toBe(SNAPSHOT_INTERVAL);

    const range = journalRange(db, desk.id, snap.id, zielZeile.id);
    expect(range.length).toBeLessThanOrEqual(SNAPSHOT_INTERVAL);
    expect(range).toHaveLength(5); // genau die 5 addDoc-Zeilen nach dem Snapshot
  });
});
