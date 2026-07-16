import { describe, it, expect, beforeEach } from 'vitest';
import { CommandError } from '@digital-desktop/core';
import { openDb, type Db } from './db';
import {
  createDesk, listDesks, renameDesk, deleteDesk, getDeskState,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError,
} from './deskStore';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
});

describe('Desk-CRUD', () => {
  it('legt an, listet, benennt um und löscht', () => {
    const desk = createDesk(db, 'u1', 'Schreibtisch 1');
    expect(listDesks(db, 'u1')).toEqual([{ id: desk.id, name: 'Schreibtisch 1', ownerId: 'u1', ownerName: 'p', isOwner: true }]);
    renameDesk(db, desk.id, 'Projekte');
    expect(listDesks(db, 'u1')[0].name).toBe('Projekte');
    deleteDesk(db, desk.id);
    expect(listDesks(db, 'u1')).toHaveLength(0);
    expect(() => renameDesk(db, desk.id, 'x')).toThrow(DeskNotFoundError);
    expect(() => deleteDesk(db, desk.id)).toThrow(DeskNotFoundError);
  });

  it('neuer Schreibtisch startet leer mit rev 0', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(getDeskState(db, desk.id)).toEqual({ rev: 0, state: { docs: [], links: [], stacks: [] } });
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
