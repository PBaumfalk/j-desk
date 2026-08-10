import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, migrate } from './db';
import { createDesk } from './deskStore';

/**
 * PERM-05-Fundament: die additive Migration dieser Phase (desk_roles-Tabelle + Eigentümer-
 * Backfill + layerId-Backfill 'kanzlei', s. db.ts) muss gegen gewachsene Bestandsdaten
 * sichtverhaltensneutral und idempotent sein — dieselbe Lehre wie beim files.kind-Vorfall
 * (e410538): additive, schema-basierte Migration statt user_version-Zähler (02-RESEARCH.md
 * Pattern 3). Zwei Teile: (1) ein synthetischer, IMMER laufender Test gegen eine programmatisch
 * gebaute Bestands-DB ohne desk_roles/layerId, (2) ein guarded Lauf gegen eine Kopie einer
 * echten Bestands-DB (test-fixtures/real-desktop.sqlite, gitignored, Nutzer-bereitgestellt).
 */

const VERSIONIERTE_ARTEN_ZUM_PRUEFEN = [
  'docs', 'stacks', 'links', 'strokes', 'notes', 'cutouts', 'marks', 'stamps', 'flags', 'clips',
] as const;

describe('PERM-05: Migrations-Guard — desk_roles additiv, Eigentümer-/layerId-Backfill, idempotent (synthetisch, läuft immer)', () => {
  it('legt desk_roles additiv an, backfillt die Eigentümer-Rolle, versieht Bestandsobjekte ohne layerId mit "kanzlei", ändert die Objektanzahl pro Art nicht und ist beim zweiten Lauf idempotent', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const desk = createDesk(db, 'u1', 'Bestand');

    // Bestands-DB VOR dieser Phase simulieren: desk_roles existiert noch nicht, Objekte tragen
    // keine layerId (analog zum files.kind-Muster in db.test.ts).
    db.exec('DROP TABLE desk_roles');
    const altState = {
      docs: [{ id: 'd1', fileId: 'f1', name: 'A.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }],
      links: [], stacks: [],
      notes: [{ id: 'n1', kind: 'gelb', text: 'Alt-Notiz', position: { x: 0, y: 0 }, zIndex: 2 }],
      cutouts: [{ id: 'c1', fileId: 'f1', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 5, y: 5 }, zIndex: 3 }],
      marks: [{ id: 'm1', docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact' }],
    };
    db.prepare('UPDATE desks SET state = ? WHERE id = ?').run(JSON.stringify(altState), desk.id);

    const holeState = (): Record<string, { id: string }[]> =>
      JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state);
    const zaehlenProArt = (state: Record<string, { id: string }[]>): Record<string, number> => ({
      docs: state.docs.length, notes: state.notes.length, cutouts: state.cutouts.length, marks: state.marks.length,
    });
    const vorher = zaehlenProArt(holeState());

    expect(() => migrate(db)).not.toThrow();

    // (1) desk_roles existiert additiv, der Eigentümer hat eine Zeile.
    const tabellen = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='desk_roles'").all();
    expect(tabellen).toHaveLength(1);
    const eigentuemerZeile = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get(desk.id, 'u1') as
      { rolle: string } | undefined;
    expect(eigentuemerZeile?.rolle).toBe('Eigentümer');

    // (2) keine stille Wegnahme: Objektanzahl pro Art unverändert.
    const stateNachErstemLauf = holeState();
    expect(zaehlenProArt(stateNachErstemLauf)).toEqual(vorher);

    // (3) layerId-Backfill: alle Bestandsobjekte gelten implizit als Kanzlei-Ebene.
    for (const art of ['docs', 'notes', 'cutouts', 'marks'] as const) {
      for (const obj of stateNachErstemLauf[art]) {
        expect((obj as { layerId?: string }).layerId).toBe('kanzlei');
      }
    }

    // (4) Idempotenz: zweiter Lauf ändert weder state noch die Anzahl der desk_roles-Zeilen.
    const stateVorZweitemLauf = (db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state;
    const rollenVorZweitemLauf = (db.prepare('SELECT COUNT(*) AS n FROM desk_roles').get() as { n: number }).n;
    migrate(db);
    const stateNachZweitemLauf = (db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state;
    const rollenNachZweitemLauf = (db.prepare('SELECT COUNT(*) AS n FROM desk_roles').get() as { n: number }).n;
    expect(stateNachZweitemLauf).toBe(stateVorZweitemLauf);
    expect(rollenNachZweitemLauf).toBe(rollenVorZweitemLauf);
  });
});

describe('02-09: Heilungs-Migration — Platzhalter-layerId "privat" wird der Privat-Instanz des Erstellers zugeordnet (synthetisch, läuft immer)', () => {
  /**
   * Fenster zwischen 02-07 (Ebenen-Modell) und CR-04-Guard: Objekte mit der unaufgelösten
   * Platzhalter-id 'privat' sind seit dem Guard für ALLE unsichtbar. Die Migration stellt die
   * ursprüngliche Privat-Absicht wieder her (Ziel IMMER eine privat-Instanz, niemals 'kanzlei').
   */
  const notiz = (id: string, extra: Record<string, unknown> = {}) => ({
    id, kind: 'gelb', text: `Notiz ${id}`, position: { x: 0, y: 0 }, zIndex: 1, layerId: 'privat', ...extra,
  });

  it('loest den Ersteller ueber createdById / createdBy-Name (users-Tabelle) / desks.owner_id auf, dedupliziert Instanzen, aendert die Objektanzahl nicht und ist idempotent', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'anwalt-a', 'h', 0);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u2', 'anwalt-b', 'h', 0);
    const desk = createDesk(db, 'u1', 'Bestand');

    const altState = {
      docs: [], links: [], stacks: [], cutouts: [], marks: [],
      notes: [
        notiz('n-id', { createdBy: 'Anwalt B', createdById: 'u2' }),            // createdById primaer
        notiz('n-name', { createdBy: 'anwalt-b' }),                              // Name ueber users-Tabelle (gleicher Nutzer -> Dedupe)
        notiz('n-unbekannt', { createdBy: 'geloeschter-nutzer' }),               // Name nicht aufloesbar -> owner_id
        notiz('n-owner'),                                                        // kein Ersteller -> owner_id (Dedupe)
      ],
    };
    db.prepare('UPDATE desks SET state = ? WHERE id = ?').run(JSON.stringify(altState), desk.id);

    const holeState = () =>
      JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state) as
        { notes: { id: string; layerId?: string }[]; layers?: { id: string; typ: string; ownerUserId?: string }[] };
    const anzahlVorher = holeState().notes.length;

    expect(() => migrate(db)).not.toThrow();

    const state = holeState();
    const ebeneVon = (id: string) => state.notes.find((n) => n.id === id)!.layerId;
    expect(ebeneVon('n-id')).toBe('privat-u2');
    expect(ebeneVon('n-name')).toBe('privat-u2');
    expect(ebeneVon('n-unbekannt')).toBe('privat-u1');
    expect(ebeneVon('n-owner')).toBe('privat-u1');

    // Genau die zwei noetigen Instanzen (dedupliziert ueber die id), Objektanzahl unveraendert.
    expect(state.notes).toHaveLength(anzahlVorher);
    const instanzen = (state.layers ?? []).filter((e) => e.typ === 'privat');
    expect(instanzen.map((e) => e.id).sort()).toEqual(['privat-u1', 'privat-u2']);
    for (const e of instanzen) {
      expect(e.ownerUserId).toBe(e.id.replace('privat-', ''));
    }

    // Idempotenz: zweiter Lauf ist ein No-Op (state-JSON identisch).
    const vorZweitem = (db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state;
    migrate(db);
    const nachZweitem = (db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state;
    expect(nachZweitem).toBe(vorZweitem);
  });

  it('heilt auch in Korb-Payloads verschachtelte Kopien mit derselben Ersteller-Logik', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'anwalt-a', 'h', 0);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u2', 'anwalt-b', 'h', 0);
    const desk = createDesk(db, 'u1', 'Bestand');

    const altState = {
      docs: [], links: [], stacks: [], notes: [], cutouts: [], marks: [],
      trash: [
        {
          id: 'korb-1', kind: 'doc', name: 'entfernt', trashedAt: '2026-07-01T00:00:00Z',
          payload: {
            docs: [
              { id: 'd-priv', fileId: 'f1', name: 'geheim.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, layerId: 'privat', createdById: 'u2' },
            ],
            notes: [notiz('n-korb', { createdBy: 'anwalt-b' })],
            cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [],
          },
        },
      ],
    };
    db.prepare('UPDATE desks SET state = ? WHERE id = ?').run(JSON.stringify(altState), desk.id);

    migrate(db);

    const state = JSON.parse((db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state) as {
      trash: { payload: { docs: { layerId?: string }[]; notes: { layerId?: string }[] } }[];
      layers?: { id: string }[];
    };
    expect(state.trash[0].payload.docs[0].layerId).toBe('privat-u2');
    expect(state.trash[0].payload.notes[0].layerId).toBe('privat-u2');
    expect((state.layers ?? []).map((e) => e.id)).toEqual(['privat-u2']);

    // Idempotenz auch im Korb-Fall.
    const vorZweitem = (db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state;
    migrate(db);
    expect((db.prepare('SELECT state FROM desks WHERE id = ?').get(desk.id) as { state: string }).state).toBe(vorZweitem);
  });
});

/** Phase 12 (AI-01): die vorschlaege-Tabelle ist ein On-Disk-Vertrag — die 16 Spaltennamen
 *  werden hier literal gepinnt (eine Umbenennung erfordert eine Datenmigration). */
const VORSCHLAEGE_SPALTEN = [
  'id', 'desk_id', 'art', 'payload', 'quellen', 'zusammenfassung', 'status', 'inverse',
  'genehmigte_objekte', 'idempotenz_key', 'created_by', 'created_by_id', 'created_at',
  'decided_by', 'decided_by_id', 'decided_at',
] as const;

describe('12-01: vorschlaege-Migration — additiv und idempotent (synthetisch, läuft immer)', () => {
  it('legt die per DROP entfernte vorschlaege-Tabelle additiv wieder an, ohne Bestandszeilen zu verändern', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const desk = createDesk(db, 'u1', 'Bestand');

    // Künstlich gealterte Bestands-DB: die Tabelle fehlt (Stand vor Phase 12).
    db.exec('DROP TABLE vorschlaege');
    const desksVorher = (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n;
    const journalVorher = (db.prepare('SELECT COUNT(*) AS n FROM command_journal').get() as { n: number }).n;

    expect(() => migrate(db)).not.toThrow();

    const spalten = (db.prepare('PRAGMA table_info(vorschlaege)').all() as { name: string }[]).map((c) => c.name);
    expect(spalten).toEqual([...VORSCHLAEGE_SPALTEN]);
    // Indizes: Unique-Idempotenz + Desk/Status-Lookup.
    const indizes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vorschlaege'").all() as { name: string }[]).map((i) => i.name);
    expect(indizes).toContain('vorschlaege_idempotenz');
    expect(indizes).toContain('vorschlaege_desk');

    // Bestandszeilen unverändert; alle Desks laden fehlerfrei.
    expect((db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n).toBe(desksVorher);
    expect((db.prepare('SELECT COUNT(*) AS n FROM command_journal').get() as { n: number }).n).toBe(journalVorher);
    for (const zeile of db.prepare('SELECT state FROM desks').all() as { state: string }[]) {
      expect(() => JSON.parse(zeile.state)).not.toThrow();
    }
    expect(desk.id).toBeTruthy();
  });

  it('lässt eine DB, die die Tabelle bereits hat, beim zweiten Lauf byte-identisch (sqlite_master unverändert)', () => {
    const db = openDb(':memory:');

    const schemaVorher = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    migrate(db);
    const schemaNachher = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

    expect(schemaNachher).toEqual(schemaVorher);
  });
});

/** Phase 13 (NOTIF-01, 13-01): die benachrichtigungen-Tabelle ist ein On-Disk-Vertrag — die
 *  7 Spaltennamen werden hier literal gepinnt (eine Umbenennung erfordert eine Datenmigration,
 *  additive art-Werte in 13-04 bleiben dagegen schema-frei, TEXT ohne CHECK). */
const BENACHRICHTIGUNGEN_SPALTEN = ['id', 'user_id', 'desk_id', 'art', 'payload', 'created_at', 'read_at'] as const;

describe('13-01: benachrichtigungen-Migration — additiv und idempotent (synthetisch, läuft immer)', () => {
  it('legt die per DROP entfernte benachrichtigungen-Tabelle additiv wieder an, ohne Bestandszeilen zu verändern', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const desk = createDesk(db, 'u1', 'Bestand');

    // Künstlich gealterte Bestands-DB: die Tabelle fehlt (Stand vor Phase 13).
    db.exec('DROP TABLE benachrichtigungen');
    const desksVorher = (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n;
    const journalVorher = (db.prepare('SELECT COUNT(*) AS n FROM command_journal').get() as { n: number }).n;
    const rollenVorher = (db.prepare('SELECT COUNT(*) AS n FROM desk_roles').get() as { n: number }).n;

    expect(() => migrate(db)).not.toThrow();

    // (1) Tabelle existiert additiv mit genau den 7 Vertragsspalten (PRAGMA table_info).
    const spalten = (db.prepare('PRAGMA table_info(benachrichtigungen)').all() as { name: string }[]).map((c) => c.name);
    expect(spalten).toEqual([...BENACHRICHTIGUNGEN_SPALTEN]);
    const indizes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='benachrichtigungen'").all() as { name: string }[]).map((i) => i.name);
    expect(indizes).toContain('benachrichtigungen_user');

    // (2) Zeilenzahlen aller Bestandstabellen unverändert; alle Desks laden fehlerfrei.
    expect((db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n).toBe(desksVorher);
    expect((db.prepare('SELECT COUNT(*) AS n FROM command_journal').get() as { n: number }).n).toBe(journalVorher);
    expect((db.prepare('SELECT COUNT(*) AS n FROM desk_roles').get() as { n: number }).n).toBe(rollenVorher);
    for (const zeile of db.prepare('SELECT state FROM desks').all() as { state: string }[]) {
      expect(() => JSON.parse(zeile.state)).not.toThrow();
    }
    expect(desk.id).toBeTruthy();

    // (3) Zweiter migrate()-Lauf ist ein No-Op (sqlite_master byte-identisch).
    const schemaVorZweitem = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    migrate(db);
    expect(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schemaVorZweitem);
  });

  it('lässt eine frische DB, die die Tabelle bereits hat, beim zweimaligen Migrieren schema-identisch', () => {
    const db = openDb(':memory:');

    const schemaVorher = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    migrate(db);
    migrate(db);
    const schemaNachher = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

    expect(schemaNachher).toEqual(schemaVorher);
  });
});

describe('PERM-05: Migrationslauf gegen eine echte Bestands-DB-Kopie (Nutzer-bereitgestellt)', () => {  /**
   * Kopie der echten desktop.sqlite unter diesem gitignorierten Pfad (s. .gitignore
   * `/test-fixtures/`), analog zum PROV-04-Muster in db.test.ts. Ohne die Datei wird dieser
   * Block sauber übersprungen (existsSync-Guard über it.skipIf) — macht CI/`npm test` nicht
   * rot, wenn die private Kopie fehlt. Die Kopie selbst wird nie committet.
   */
  const echteDbPfad = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-fixtures', 'real-desktop.sqlite');
  const vorhanden = existsSync(echteDbPfad);

  it.skipIf(!vorhanden)(
    'migrate() legt desk_roles additiv an, backfillt jeden Desk-Eigentümer, versieht Bestandsobjekte mit layerId, ändert kein Sichtverhalten (Zeilenzahlen unverändert) und ist beim zweiten Lauf idempotent',
    () => {
      // Auf einer TEMP-Kopie arbeiten, damit die bereitgestellte Fixture selbst über wiederholte
      // Testläufe unangetastet bleibt (migrate()/openDb() schreiben additiv in die geöffnete Datei).
      const tempDir = mkdtempSync(join(tmpdir(), 'jdesk-migration-real-'));
      const tempPfad = join(tempDir, 'real-desktop.sqlite');
      copyFileSync(echteDbPfad, tempPfad);

      const zaehlen = (db: Database.Database): Record<string, number> => {
        // Zeilenzahlen der Bestandstabellen (soweit im Fixture vorhanden — desk_roles/file_pages
        // fehlen in sehr alten Ständen) — 12-01: desk_roles/file_pages ergänzt.
        const ergebnis: Record<string, number> = {
          desks: (db.prepare('SELECT COUNT(*) AS n FROM desks').get() as { n: number }).n,
          users: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
          files: (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n,
          command_journal: (db.prepare('SELECT COUNT(*) AS n FROM command_journal').get() as { n: number }).n,
        };
        for (const tabelle of ['desk_roles', 'file_pages'] as const) {
          if (db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(tabelle)) {
            ergebnis[tabelle] = (db.prepare(`SELECT COUNT(*) AS n FROM ${tabelle}`).get() as { n: number }).n;
          }
        }
        return ergebnis;
      };

      try {
        // Vorher-Zustand über eine reine Leseverbindung (kein openDb()/migrate() vorher).
        const vorDb = new Database(tempPfad, { readonly: true });
        const vorher = zaehlen(vorDb);
        const hatteDeskRolesVorher =
          vorDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='desk_roles'").all().length === 1;
        vorDb.close();

        // openDb() ruft migrate() intern auf — derselbe Öffnungspfad wie main.ts ihn nutzt.
        const db = openDb(tempPfad);

        const nachher = zaehlen(db);
        // Pro vorhandener Bestandstabelle: Zeilenzahl unverändert (neu hinzugekommene Tabellen
        // wie desk_roles in sehr alten Fixtures sind additiv und kein Zeilenverlust).
        for (const [tabelle, anzahl] of Object.entries(vorher)) {
          expect(nachher[tabelle], `Zeilenzahl ${tabelle}`).toBe(anzahl);
        }

        const deskRolesTabelle = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='desk_roles'").all();
        expect(deskRolesTabelle).toHaveLength(1);

        // 12-01: vorschlaege existiert nach migrate() additiv mit allen 16 Vertragsspalten.
        const vorschlagSpalten = (db.prepare('PRAGMA table_info(vorschlaege)').all() as { name: string }[]).map((c) => c.name);
        expect(vorschlagSpalten).toEqual([...VORSCHLAEGE_SPALTEN]);

        // 13-01: benachrichtigungen existiert nach migrate() additiv mit allen 7 Vertragsspalten.
        const benachrichtigungSpalten = (db.prepare('PRAGMA table_info(benachrichtigungen)').all() as { name: string }[]).map((c) => c.name);
        expect(benachrichtigungSpalten).toEqual([...BENACHRICHTIGUNGEN_SPALTEN]);

        const desks = db.prepare('SELECT id, owner_id, state FROM desks').all() as
          { id: string; owner_id: string; state: string }[];
        expect(desks).toHaveLength(vorher.desks);
        for (const desk of desks) {
          // Jeder Desk-Eigentümer hat nach der Migration eine Eigentümer-Zeile (T-02-06 — sonst
          // sperrt sich der Ersteller eines Bestands-Desks an seinem eigenen Schreibtisch aus).
          const rolle = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get(desk.id, desk.owner_id) as
            { rolle: string } | undefined;
          expect(rolle?.rolle).toBe('Eigentümer');

          // Alle Objekte aller VERSIONIERTE_ARTEN tragen nach der Migration eine layerId.
          const state = JSON.parse(desk.state) as Record<string, unknown>;
          for (const art of VERSIONIERTE_ARTEN_ZUM_PRUEFEN) {
            const liste = state[art];
            if (!Array.isArray(liste)) continue;
            for (const obj of liste as Record<string, unknown>[]) {
              expect(obj.layerId).toBeDefined();
            }
          }
        }

        // Zweiter Lauf: idempotent — keine weitere Änderung an desks.state oder der Zeilenzahl von desk_roles.
        const stateVorZweitemLauf = db.prepare('SELECT id, state FROM desks ORDER BY id').all();
        const rollenVorZweitemLauf = (db.prepare('SELECT COUNT(*) AS n FROM desk_roles').get() as { n: number }).n;
        migrate(db);
        const stateNachZweitemLauf = db.prepare('SELECT id, state FROM desks ORDER BY id').all();
        const rollenNachZweitemLauf = (db.prepare('SELECT COUNT(*) AS n FROM desk_roles').get() as { n: number }).n;
        expect(stateNachZweitemLauf).toEqual(stateVorZweitemLauf);
        expect(rollenNachZweitemLauf).toBe(rollenVorZweitemLauf);

        // Beobachtung für die PERM-05-Abnahme (auch im Testlauf-Output sichtbar, keine Inhalte):
        console.info(
          `[PERM-05] realer Bestands-DB-Migrationslauf: ${vorher.desks} Desk(s), ${vorher.users} Nutzer, ` +
            `${vorher.files} Datei(en), ${vorher.command_journal} Journal-Einträge — desk_roles vorher: ` +
            `${hatteDeskRolesVorher}, nachher: vorhanden. Zeilenzahlen vor/nach migrate() identisch, zweiter Lauf idempotent.`,
        );

        db.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
