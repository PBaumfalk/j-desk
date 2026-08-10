import { describe, it, expect } from 'vitest';
import { openDb } from '../db';
import { createUser } from '../auth';
import { createDesk, putDeskState } from '../deskStore';
import { migrateSearchIndex, reindexDesk, SEARCH_INDEX_VERSION } from './searchIndex';

function zeilen(db: ReturnType<typeof openDb>, deskId: string) {
  return db.prepare('SELECT obj_type AS objType, obj_id AS objId, text FROM search_fts WHERE desk_id = ?').all(deskId) as {
    objType: string;
    objId: string;
    text: string;
  }[];
}

describe('migrateSearchIndex', () => {
  it('legt search_fts an und ist bei zweimaligem Aufruf idempotent', () => {
    const db = openDb(':memory:'); // migrate() ruft migrateSearchIndex bereits einmal auf
    const tabellen = () =>
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_fts'").all();
    expect(tabellen()).toHaveLength(1);
    // Zweiter, expliziter Aufruf darf nicht erneut CREATE VIRTUAL TABLE versuchen (würde sonst werfen).
    expect(() => migrateSearchIndex(db)).not.toThrow();
    expect(tabellen()).toHaveLength(1);
  });

  it('setzt search_index_version nach dem ersten Lauf', () => {
    const db = openDb(':memory:');
    const version = db.prepare('SELECT value FROM settings WHERE key = ?').get('search_index_version') as
      | { value: string }
      | undefined;
    expect(version?.value).toBe(String(SEARCH_INDEX_VERSION));
  });

  it('indiziert eine Bestandsdatenbank (Desk+Objekte vor dem ersten migrateSearchIndex-Lauf dieser Version) vollständig', async () => {
    const db = openDb(':memory:');
    const userId = await createUser(db, 'nutzer-a', 'test-passwort');
    const desk = createDesk(db, userId, 'Akte A', { id: userId, name: 'A' });
    putDeskState(db, desk.id, {
      docs: [{ id: 'doc-1', fileId: 'f1', name: 'Kündigungsschreiben Müller', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });

    // Bestands-Simulation: search_fts UND der Versionsmarker verschwinden wieder — genau der
    // Zustand einer Datenbank, die bereits lief, bevor diese Phase existierte (Lehre wie bei
    // db.test.ts „files.kind bei kollidierender Versionsnummer").
    db.exec('DROP TABLE search_fts');
    db.prepare('DELETE FROM settings WHERE key = ?').run('search_index_version');

    migrateSearchIndex(db);

    const treffer = zeilen(db, desk.id);
    expect(treffer.map((z) => z.objId)).toContain('doc-1');
    expect(treffer.find((z) => z.objId === 'doc-1')?.text).toBe('Kündigungsschreiben Müller');
  });
});

describe('reindexDesk', () => {
  it('ersetzt einen vorhandenen Indexstand vollständig (keine Karteileichen alter Objekte)', async () => {
    const db = openDb(':memory:');
    const userId = await createUser(db, 'nutzer-a', 'test-passwort');
    const desk = createDesk(db, userId, 'Akte A', { id: userId, name: 'A' });
    reindexDesk(db, desk.id, {
      docs: [{ id: 'doc-alt', fileId: 'f1', name: 'Alte Karte', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    expect(zeilen(db, desk.id).map((z) => z.objId)).toContain('doc-alt');

    reindexDesk(db, desk.id, {
      docs: [{ id: 'doc-neu', fileId: 'f2', name: 'Neue Karte', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
    });
    const nachher = zeilen(db, desk.id);
    expect(nachher.map((z) => z.objId)).toContain('doc-neu');
    expect(nachher.map((z) => z.objId)).not.toContain('doc-alt');
  });
});
