import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { isValidState } from '@j-desk/core';
import { openDb, migrate, getSetting, setSetting } from './db';
import { createDesk } from './deskStore';

describe('openDb', () => {
  it('legt alle Tabellen an', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['users', 'sessions', 'desks', 'desk_members', 'files', 'desk_roles']) {
      expect(names).toContain(t);
    }
  });

  it('erzwingt eindeutige Benutzernamen', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
    ins.run('u1', 'patrick', 'h', 0);
    expect(() => ins.run('u2', 'patrick', 'h', 0)).toThrow();
  });
});

describe('settings', () => {
  it('liefert null für unbekannte Schlüssel', () => {
    const db = openDb(':memory:');
    expect(getSetting(db, 'jlawyer_url')).toBeNull();
  });

  it('speichert und überschreibt Werte (Upsert)', () => {
    const db = openDb(':memory:');
    setSetting(db, 'jlawyer_url', 'http://a:8080/j-lawyer-io');
    expect(getSetting(db, 'jlawyer_url')).toBe('http://a:8080/j-lawyer-io');
    setSetting(db, 'jlawyer_url', 'http://b:8080/j-lawyer-io');
    expect(getSetting(db, 'jlawyer_url')).toBe('http://b:8080/j-lawyer-io');
  });

  it('migriert Bestands-DBs auf mindestens user_version 2 mit settings-Tabelle', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true }) as number).toBeGreaterThanOrEqual(2);
    const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").all();
    expect(tabellen).toHaveLength(1);
  });
});

describe('files.kind bei kollidierender Versionsnummer', () => {
  /**
   * Befund aus dem Betrieb: Datenbanken, die durch den nie gemergten TP3-Zweig gelaufen sind,
   * tragen dessen `user_version = 1` (is_admin/uploader_id/invites) — dieselbe Nummer, die auf
   * main die kind-Migration beansprucht. Die Spalte wurde dadurch nie angelegt, die späteren
   * Migrationen hoben den Zähler trotzdem auf 3, und jeder Upload endete im 500er, weil
   * storeFile in eine nicht existierende Spalte schreibt. Die Versionsnummer ist deshalb keine
   * verlässliche Aussage über das Schema — der Spaltenbestand ist es.
   */
  function dbOhneKindAberVersion3() {
    const db = openDb(':memory:');
    // Zielschema hat kind bereits — Bestandszustand nachstellen: Spalte entfernen, Zähler oben lassen.
    db.exec(`
      CREATE TABLE files_alt (
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, original_name TEXT NOT NULL,
        size INTEGER NOT NULL, created_at INTEGER NOT NULL, uploader_id TEXT
      );
      DROP TABLE files;
      ALTER TABLE files_alt RENAME TO files;
    `);
    db.pragma('user_version = 3');
    return db;
  }

  it('ergänzt kind auch dann, wenn user_version die Migration längst übersprungen hat', () => {
    const db = dbOhneKindAberVersion3();
    expect(spalten(db)).not.toContain('kind');

    migrate(db);

    expect(spalten(db)).toContain('kind');
  });

  it('lässt eine vorhandene kind-Spalte unangetastet (idempotent)', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO files (id, sha256, original_name, size, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)')
      .run('f1', 'abc', 'schriftsatz.pdf', 10, 0, 'image');

    migrate(db);

    const zeile = db.prepare('SELECT kind FROM files WHERE id = ?').get('f1') as { kind: string };
    expect(zeile.kind).toBe('image');
  });
});

function spalten(db: ReturnType<typeof openDb>): string[] {
  return (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name);
}

describe('command_journal (Migration v3)', () => {
  it('legt für frische DBs die Tabelle command_journal an und setzt user_version = 3', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='command_journal'").all();
    expect(tabellen).toHaveLength(1);
  });

  it('frische DBs ohne Bestands-Desks erhalten keine Baseline-Snapshots', () => {
    const db = openDb(':memory:');
    const rows = db.prepare('SELECT * FROM command_journal').all();
    expect(rows).toHaveLength(0);
  });

  it('legt für Bestands-DBs (user_version 2, mit Desk) einen Baseline-Snapshot pro Desk an', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const desk = createDesk(db, 'u1', 'Akte A');

    // Bestands-DB auf Stand v2 zurückversetzen simulieren (v3 noch nicht durchlaufen).
    db.exec('DROP TABLE command_journal');
    db.pragma('user_version = 2');

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const rows = db.prepare('SELECT desk_id AS deskId, type, rev, actor_id AS actorId, actor_name AS actorName, payload FROM command_journal').all() as
      { deskId: string; type: string; rev: number; actorId: string | null; actorName: string; payload: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].deskId).toBe(desk.id);
    expect(rows[0].type).toBe('snapshot');
    expect(rows[0].rev).toBe(0);
    expect(rows[0].actorId).toBeNull();
    expect(rows[0].actorName).toBe('Migration');
    const payload = JSON.parse(rows[0].payload) as { state: unknown };
    expect(payload.state).toBeDefined();
  });
});

describe('jl_file_hashes (additive Tabelle für den j-lawyer-Hash-Cache)', () => {
  it('legt jl_file_hashes bereits auf einer frischen DB mit dem Zielschema an', () => {
    const db = openDb(':memory:');
    const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jl_file_hashes'").all();
    expect(tabellen).toHaveLength(1);
    const spalten = (db.prepare('PRAGMA table_info(jl_file_hashes)').all() as { name: string }[]).map((c) => c.name);
    expect(spalten).toEqual(expect.arrayContaining(['doc_id', 'change_date', 'sha256']));
  });

  it('migrate() legt jl_file_hashes additiv auf einer Bestands-DB ohne die Tabelle an, ohne andere Tabellen/Daten zu verändern', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    createDesk(db, 'u1', 'Bestand');
    // Bestands-DB ohne die Tabelle simulieren (sie kam erst mit dieser Phase).
    db.exec('DROP TABLE jl_file_hashes');

    migrate(db);

    const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jl_file_hashes'").all();
    expect(tabellen).toHaveLength(1);
    const desks = db.prepare('SELECT name FROM desks').all();
    expect(desks).toEqual([{ name: 'Bestand' }]);
  });
});

describe('PROV-04: additive Migration gegen Alt-Objekte ohne Provenienz (Bestands-DB-Nachweis)', () => {
  /**
   * Bestandsdaten aus der Zeit vor der Provenienz-Phase: docs/notes/cutouts/marks tragen
   * createdBy/createdAt/fileSha256/textSnapshot schlicht nicht (RESEARCH Pitfall 1 — Alt-Objekte
   * haben die Felder nicht gesetzt, nicht leer gesetzt). migrate() darf diese Alt-Objekte nur um
   * die bereits separat getestete Konflikterkennung (updatedRev, siehe "Objektversionen" oben)
   * ergänzen — niemals um Provenienzschlüssel, niemals mit Datenverlust.
   */
  it('lässt Alt-Objekte (Doc/Mark/Cutout/Note) ohne Provenienzfelder inhaltlich unverändert, injiziert keine Provenienzschlüssel und legt jl_file_hashes additiv an', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);

    const altDoc = { id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 };
    const altNote = { id: 'n1', kind: 'gelb', text: 'Alt-Notiz', position: { x: 10, y: 10 }, zIndex: 2 };
    const altCutout = { id: 'c1', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 20, y: 20 }, zIndex: 3 };
    const altMark = { id: 'm1', docId: 'd1', page: 1, rect: { x: 5, y: 5, w: 10, h: 10 }, kind: 'redact' };
    const altState = { docs: [altDoc], links: [], stacks: [], notes: [altNote], cutouts: [altCutout], marks: [altMark] };

    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Bestand', 'u1', JSON.stringify(altState), 7, Date.now(),
    );
    // Bestands-DB ohne jl_file_hashes simulieren (kam erst mit dieser Phase, siehe 01-04).
    db.exec('DROP TABLE jl_file_hashes');

    const zaehlen = (): Record<string, number> => ({
      desks: (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n,
      users: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
      files: (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n,
      command_journal: (db.prepare('SELECT COUNT(*) AS n FROM command_journal').get() as { n: number }).n,
    });
    const vorher = zaehlen();

    migrate(db);

    // (c) jl_file_hashes existiert danach.
    const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jl_file_hashes'").all();
    expect(tabellen).toHaveLength(1);

    // (d) keine bestehende Tabelle verlor Zeilen.
    expect(zaehlen()).toEqual(vorher);

    const state = JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state) as {
      docs: Record<string, unknown>[];
      notes: Record<string, unknown>[];
      cutouts: Record<string, unknown>[];
      marks: Record<string, unknown>[];
    };

    // Dieselben Objekt-IDs, keine verlorenen/zusätzlichen Objekte.
    expect(state.docs.map((o) => o.id)).toEqual(['d1']);
    expect(state.notes.map((o) => o.id)).toEqual(['n1']);
    expect(state.cutouts.map((o) => o.id)).toEqual(['c1']);
    expect(state.marks.map((o) => o.id)).toEqual(['m1']);

    // Keine neu injizierten Provenienzschlüssel an den Alt-Objekten.
    const provenienzSchluessel = ['createdBy', 'createdAt', 'updatedAt', 'updatedBy', 'fileSha256', 'textSnapshot'];
    for (const objekt of [state.docs[0], state.notes[0], state.cutouts[0], state.marks[0]]) {
      for (const schluessel of provenienzSchluessel) {
        expect(objekt).not.toHaveProperty(schluessel);
      }
    }

    // (a) Alt-Objekte sind feld-/wertgleich erhalten. updatedRev und layerId sind die einzigen
    // zulässigen Abweichungen: eigene, bereits separat getestete additive Migrationen
    // (Konflikterkennung bzw. Ebenen-Fundament dieser Phase — kein Provenienzfeld).
    const { updatedRev: _rd, layerId: layerIdD, ...docRest } = state.docs[0];
    expect(docRest).toEqual(altDoc);
    expect(layerIdD).toBe('kanzlei');
    const { updatedRev: _rn, layerId: layerIdN, ...noteRest } = state.notes[0];
    expect(noteRest).toEqual(altNote);
    expect(layerIdN).toBe('kanzlei');
    const { updatedRev: _rc, layerId: layerIdC, ...cutoutRest } = state.cutouts[0];
    expect(cutoutRest).toEqual(altCutout);
    expect(layerIdC).toBe('kanzlei');
    const { updatedRev: _rm, layerId: layerIdM, ...markRest } = state.marks[0];
    expect(markRest).toEqual(altMark);
    expect(layerIdM).toBe('kanzlei');

    // (b) isValidState bleibt true — der bestehende Lade-/Validierungspfad akzeptiert den Zustand.
    expect(isValidState(state)).toBe(true);
  });
});

describe('PROV-04: Migrationslauf gegen eine echte Bestands-DB-Kopie (Nutzer-bereitgestellt, Task 3)', () => {
  /**
   * Der Nutzer legt eine Kopie seiner echten desktop.sqlite unter diesem vereinbarten,
   * gitignorierten Pfad ab (siehe 01-08-PLAN.md Checkpoint + .gitignore). Ohne die Datei wird
   * dieser Block sauber übersprungen (existsSync-Guard über it.skipIf) — macht CI/`npm test`
   * nicht rot, wenn die private Kopie fehlt. Die Kopie selbst wird nie committet.
   */
  const echteDbPfad = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-fixtures', 'real-desktop.sqlite');
  const vorhanden = existsSync(echteDbPfad);

  it.skipIf(!vorhanden)(
    'migrate() ist additiv/nicht-destruktiv gegen eine echte, gewachsene Bestands-DB: Zeilenzahlen unverändert, jl_file_hashes additiv, Desks laden fehlerfrei',
    () => {
      // Auf einer TEMP-Kopie arbeiten, damit die bereitgestellte Fixture selbst über wiederholte
      // Testläufe unangetastet bleibt (migrate()/openDb() schreiben additiv in die geöffnete Datei).
      const tempDir = mkdtempSync(join(tmpdir(), 'jdesk-real-db-'));
      const tempPfad = join(tempDir, 'real-desktop.sqlite');
      copyFileSync(echteDbPfad, tempPfad);

      const zaehlen = (db: Database.Database): Record<string, number> => ({
        desks: (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n,
        users: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
        files: (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n,
        command_journal: (db.prepare('SELECT COUNT(*) AS n FROM command_journal').get() as { n: number }).n,
      });

      try {
        // Vorher-Zustand über eine reine Leseverbindung feststellen (kein openDb()/migrate()
        // vorher), damit die Zeilenzahlen nicht bereits vom Test selbst beeinflusst sind.
        const vorDb = new Database(tempPfad, { readonly: true });
        const vorher = zaehlen(vorDb);
        const hatteJlHashesVorher =
          vorDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jl_file_hashes'").all().length === 1;
        vorDb.close();

        // openDb() ruft migrate() intern auf — derselbe Öffnungspfad wie main.ts ihn nutzt.
        // Eine Exception hier lässt den Test regulär fehlschlagen (Nachweis "keine Exception").
        const db = openDb(tempPfad);

        const nachher = zaehlen(db);
        expect(nachher).toEqual(vorher);

        const jlHashesTabelle = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jl_file_hashes'").all();
        expect(jlHashesTabelle).toHaveLength(1);

        const desks = db.prepare('SELECT id, state FROM desks').all() as { id: string; state: string }[];
        expect(desks).toHaveLength(vorher.desks);
        for (const desk of desks) {
          const state = JSON.parse(desk.state) as unknown;
          expect(isValidState(state)).toBe(true);
        }

        // Beobachtung für die PROV-04-Abnahme (auch im Testlauf-Output sichtbar, keine Inhalte):
        console.info(
          `[PROV-04] realer Bestands-DB-Lauf: ${vorher.desks} Desk(s), ${vorher.users} Nutzer, ${vorher.files} Datei(en), ` +
            `${vorher.command_journal} Journal-Einträge — jl_file_hashes vorher: ${hatteJlHashesVorher}, nachher: vorhanden. ` +
            'Zeilenzahlen vor/nach migrate() identisch.',
        );

        db.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe('Objektversionen (Migration Bestands-Desks)', () => {
  it('setzt updatedRev bestehender Objekte auf die aktuelle desk-rev', () => {
    const db = openDb(':memory:');
    // owner_id hat einen Fremdschlüssel auf users(id); ohne die Zeile scheitert
    // der folgende INSERT mit "FOREIGN KEY constraint failed" (siehe app.test.ts: deskMitBesitzer).
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Alt', 'u1',
      JSON.stringify({ docs: [{ id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }], links: [], stacks: [], notes: [{ id: 'n1', text: 'x', position: { x: 0, y: 0 }, zIndex: 2 }] }),
      12, Date.now(),
    );

    migrate(db);

    const state = JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state);
    expect(state.docs[0].updatedRev).toBe(12);
    expect(state.notes[0].updatedRev).toBe(12);
  });

  it('lässt bereits versionierte Objekte bei einem zweiten Lauf unangetastet (idempotent)', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Alt', 'u1',
      JSON.stringify({ docs: [{ id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }], links: [], stacks: [], notes: [] }),
      12, Date.now(),
    );

    migrate(db);
    const vorher = (db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state;

    // Zwischen den beiden Migrationsläufen ändert sich die desk-rev (echte Bearbeitung nach dem
    // ersten Serverstart, ohne dass d1 selbst angefasst wurde). Ein Wächter, der wirklich nur
    // unversionierte Objekte stempelt, lässt d1 unangetastet; ein Wächter ohne Wirkung würde d1
    // beim zweiten Lauf auf die neue rev umstempeln — genau das soll der Vergleich unten fangen.
    db.prepare('UPDATE desks SET rev = ? WHERE id = ?').run(99, 'desk1');

    migrate(db);
    const nachher = (db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state;

    expect(nachher).toBe(vorher);
  });
});

describe('desk_roles (PERM-03-Fundament)', () => {
  it('legt desk_roles mit PK (desk_id, user_id) und Spalte rolle an', () => {
    const db = openDb(':memory:');
    const spalten = (db.prepare('PRAGMA table_info(desk_roles)').all() as { name: string; pk: number }[]);
    const namen = spalten.map((s) => s.name);
    expect(namen).toEqual(expect.arrayContaining(['desk_id', 'user_id', 'rolle']));
    const pkSpalten = spalten.filter((s) => s.pk > 0).map((s) => s.name).sort();
    expect(pkSpalten).toEqual(['desk_id', 'user_id']);
  });

  it('Eigentümer-Backfill: Bestands-Desk ohne desk_roles-Zeile erhält eine Eigentümer-Zeile für den Besitzer', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    // Bestands-Desk simulieren: direkt in die desks-Tabelle eingefügt, OHNE über createDesk() zu
    // gehen (das würde bereits eine desk_roles-Zeile schreiben) — genau der Fall vor dieser Migration.
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Bestand', 'u1', JSON.stringify({ docs: [], links: [], stacks: [] }), 0, Date.now(),
    );

    migrate(db);

    const zeile = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get('desk1', 'u1') as
      | { rolle: string }
      | undefined;
    expect(zeile?.rolle).toBe('Eigentümer');
  });

  it('layerId-Backfill: Objekte ohne layerId erhalten layerId="kanzlei", vorhandene layerId bleibt unangetastet', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const altDoc = { id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 };
    const docMitLayer = { id: 'd2', fileId: 'f2', name: 'B.pdf', position: { x: 1, y: 1 }, rotation: 0, zIndex: 2, layerId: 'privat-u2' };
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Bestand', 'u1', JSON.stringify({ docs: [altDoc, docMitLayer], links: [], stacks: [] }), 0, Date.now(),
    );

    migrate(db);

    const state = JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state) as {
      docs: { id: string; layerId?: string }[];
    };
    expect(state.docs.find((d) => d.id === 'd1')!.layerId).toBe('kanzlei');
    expect(state.docs.find((d) => d.id === 'd2')!.layerId).toBe('privat-u2');
  });

  it('layerId-Backfill (CR-02/IN-04): auch in Papierkorb-Payloads verschachtelte Objekte erhalten layerId="kanzlei"', () => {    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const korb = [{
      id: 'k1', kind: 'doc', name: 'Alt.pdf', trashedAt: '2026-01-01T00:00:00Z',
      payload: {
        docs: [{ id: 'd-alt', fileId: 'f1', name: 'Alt.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
        notes: [{ id: 'n-mit-layer', kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat-u2' }],
        cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [],
      },
    }];
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Bestand', 'u1', JSON.stringify({ docs: [], links: [], stacks: [], trash: korb }), 0, Date.now(),
    );

    migrate(db);

    const state = JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state) as {
      trash: { payload: { docs: { id: string; layerId?: string }[]; notes: { id: string; layerId?: string }[] } }[];
    };
    expect(state.trash[0]!.payload.docs[0]!.layerId).toBe('kanzlei');
    expect(state.trash[0]!.payload.notes[0]!.layerId).toBe('privat-u2');
  });

  it('layerId-Backfill lässt Zonen feldlos (13-02, U4-Gebot: eine Zone trägt BEWUSST kein layerId-Feld)', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    // Zonen liegen seit 13-02 in VERSIONIERTE_ARTEN — ohne die Ausnahme im Backfill bekäme
    // jede gespeicherte Zone beim nächsten Serverstart ein layerId: 'kanzlei' aufgestempelt
    // (Referenzfeld-Verbot, 13-02-PLAN must_haves/prohibitions).
    const zone = { id: 'z1', name: 'Orientierung', rect: { x: 0, y: 0, w: 100, h: 100 } };
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Bestand', 'u1', JSON.stringify({ docs: [], links: [], stacks: [], zones: [zone] }), 0, Date.now(),
    );

    migrate(db);

    const state = JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state) as {
      zones: { id: string; layerId?: string }[];
    };
    expect(state.zones[0]!.layerId).toBeUndefined();
  });

  it('Migration ist idempotent (zweiter Lauf ändert nichts, kein Fehler)', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Bestand', 'u1',
      JSON.stringify({ docs: [{ id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }], links: [], stacks: [] }),
      0, Date.now(),
    );

    migrate(db);
    const stateNachErstemLauf = (db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state;
    const rollenNachErstemLauf = db.prepare('SELECT desk_id AS deskId, user_id AS userId, rolle FROM desk_roles').all();

    expect(() => migrate(db)).not.toThrow();

    const stateNachZweitemLauf = (db.prepare('SELECT state FROM desks WHERE id = ?').get('desk1') as { state: string }).state;
    const rollenNachZweitemLauf = db.prepare('SELECT desk_id AS deskId, user_id AS userId, rolle FROM desk_roles').all();
    expect(stateNachZweitemLauf).toBe(stateNachErstemLauf);
    expect(rollenNachZweitemLauf).toEqual(rollenNachErstemLauf);
  });

  it('defensiv: vorhandene desk_members-Zeilen werden zu desk_roles "Bearbeiter", ohne bestehende desk_roles-Zeilen zu überschreiben', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u2', 'q', 'h', 0);
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'desk1', 'Bestand', 'u1', JSON.stringify({ docs: [], links: [], stacks: [] }), 0, Date.now(),
    );
    // Tote desk_members-Tabelle trägt eine Zeile aus Alt-Zeiten (u2 auf desk1 geteilt).
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run('desk1', 'u2');
    // u1 hat bereits (z. B. durch createDesk) eine Eigentümer-Zeile — darf NICHT überschrieben werden.
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run('desk1', 'u1', 'Eigentümer');

    migrate(db);

    const u2Rolle = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get('desk1', 'u2') as
      | { rolle: string }
      | undefined;
    expect(u2Rolle?.rolle).toBe('Bearbeiter');
    const u1Rolle = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get('desk1', 'u1') as
      | { rolle: string }
      | undefined;
    expect(u1Rolle?.rolle).toBe('Eigentümer');
  });
});
