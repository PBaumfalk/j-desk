import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { rotateBackup, restoreDbFile, starteBackupIntervall } from './backup';
import { openDb, openDbRaw, migrate } from './db';
import { createDesk, applyDeskCommand, getDeskState } from './deskStore';

describe('rotateBackup', () => {
  it('tut nichts ohne DB-Datei', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    const db = new Database(':memory:');
    const pfad = await rotateBackup(db, dir);
    expect(pfad).toBe('');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('legt Backups an und behält nur die letzten 5', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    const db = openDb(join(dir, 'desktop.sqlite'));
    for (let i = 0; i < 7; i++) {
      await rotateBackup(db, dir);
      await new Promise((r) => setTimeout(r, 5)); // eindeutige Zeitstempel
    }
    const backups = readdirSync(join(dir, 'backup')).filter((f) => f.endsWith('.sqlite'));
    expect(backups).toHaveLength(5);
    db.close();
  });

  it('CR-01-Regression: pre-migration-Backups zählen NICHT gegen die keep-Rotation und werden nie mitgelöscht', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    const db = openDb(join(dir, 'desktop.sqlite'));
    const backupDir = join(dir, 'backup');
    mkdirSync(backupDir, { recursive: true });
    // Zwei "dauerhafte" Pre-Migration-Backups simulieren (Namensmuster aus migrateSafely.ts),
    // ohne die eigentliche Migrationsmaschinerie zu benötigen — Ziel ist ausschliesslich, die
    // Filterlogik von rotateBackup() gegen dieses Präfix zu prüfen.
    for (const datei of ['pre-migration-2020-01-01T00-00-00-000Z.sqlite', 'pre-migration-2020-01-02T00-00-00-000Z.sqlite']) {
      copyFileSync(join(dir, 'desktop.sqlite'), join(backupDir, datei));
    }
    // Mehr als `keep=5` reguläre Rotationsstände erzeugen — die Rotation muss ausschliesslich
    // die überzähligen 'desktop-…'-Stände entfernen und die beiden Pre-Migration-Dateien in
    // Ruhe lassen.
    for (let i = 0; i < 7; i++) {
      await rotateBackup(db, dir);
      await new Promise((r) => setTimeout(r, 5));
    }
    const nachher = readdirSync(backupDir).filter((f) => f.endsWith('.sqlite'));
    const regulaere = nachher.filter((f) => f.startsWith('desktop-'));
    const preMigration = nachher.filter((f) => f.startsWith('pre-migration-'));
    expect(regulaere).toHaveLength(5);
    expect(preMigration).toHaveLength(2); // beide Pre-Migration-Stände überleben unangetastet
    db.close();
  });

  it('das Boot-Backup entsteht aus der geöffneten Verbindung und lässt sich eigenständig öffnen (Tracer)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    // Boot-Reihenfolge wie in main.ts: erst öffnen (roh), dann sichern, dann migrieren.
    const db = openDbRaw(join(dir, 'desktop.sqlite'));
    const backupPfad = await rotateBackup(db, dir);
    migrate(db);

    expect(backupPfad).not.toBe('');
    const backupDb = new Database(backupPfad, { readonly: true });
    const tabellen = backupDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='desks'")
      .all();
    expect(tabellen).toHaveLength(1);
    backupDb.close();
    db.close();
  });
});

/** Prüfsummen über den ausgelieferten Zustand jedes Schreibtischs plus die Zeilenzahl der
 *  desks-Tabelle — Grundlage der Restore-Integritätsprüfung (D-05). */
function zustandsFingerabdruck(db: Database.Database): { deskCount: number; hashes: string[] } {
  const ids = (db.prepare('SELECT id FROM desks ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  const hashes = ids.map((id) =>
    createHash('sha256').update(JSON.stringify(getDeskState(db, id)!.state)).digest('hex'),
  );
  return { deskCount: ids.length, hashes };
}

describe('Restore-Integrität (D-05)', () => {
  it('ein rotiertes Backup enthält dieselbe Desk-Anzahl und denselben Zustands-Hash wie die Quelldatenbank', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    const db = openDb(join(dir, 'desktop.sqlite'));
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const desk1 = createDesk(db, 'u1', 'Schreibtisch 1');
    const desk2 = createDesk(db, 'u1', 'Schreibtisch 2');
    applyDeskCommand(db, desk1.id, { type: 'addNote', payload: { kind: 'notiz', text: 'Notiz 1', position: { x: 1, y: 2 } } });
    applyDeskCommand(db, desk2.id, { type: 'addNote', payload: { kind: 'notiz', text: 'Notiz 2', position: { x: 3, y: 4 } } });

    const vorher = zustandsFingerabdruck(db);
    const backupPfad = await rotateBackup(db, dir);
    expect(backupPfad).not.toBe('');

    const backupDb = new Database(backupPfad);
    expect(zustandsFingerabdruck(backupDb)).toEqual(vorher);
    backupDb.close();
  });

  it('restoreDbFile spielt das Backup zurück; Desk-Anzahl und Prüfsummen stimmen weiterhin, alte WAL-/SHM-Seitendateien sind verschwunden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    const db = openDb(join(dir, 'desktop.sqlite'));
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const desk = createDesk(db, 'u1', 'Schreibtisch 1');
    applyDeskCommand(db, desk.id, { type: 'addNote', payload: { kind: 'notiz', text: 'Notiz', position: { x: 1, y: 2 } } });
    // migrate() ist idempotent (db.test.ts/migration.real.test.ts) — hier explizit vorgezogen,
    // damit der Vergleich denselben Endzustand sieht, den auch openDb() nach dem Zurückspielen
    // herstellt (openDb() ruft migrate() erneut auf; Backfills wie layerId greifen sonst nur
    // beim zweiten Aufruf und würden fälschlich als Abweichung erscheinen).
    migrate(db);
    const vorher = zustandsFingerabdruck(db);
    const backupPfad = await rotateBackup(db, dir);

    db.close();
    restoreDbFile(dir, backupPfad);

    expect(existsSync(join(dir, 'desktop.sqlite-wal'))).toBe(false);
    expect(existsSync(join(dir, 'desktop.sqlite-shm'))).toBe(false);

    const wiederhergestellt = openDb(join(dir, 'desktop.sqlite'));
    expect(zustandsFingerabdruck(wiederhergestellt)).toEqual(vorher);
    wiederhergestellt.close();
  });
});

describe('WAL-Konsistenz (05-RESEARCH Pitfall 2)', () => {
  it('ein Commit, der nur im WAL-Seitenspeicher steht (kein Checkpoint, keine geschlossene Verbindung), landet trotzdem im Backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    // openDbRaw setzt journal_mode = WAL — derselbe Modus wie beim Boot-Backup in main.ts.
    const db = openDbRaw(join(dir, 'desktop.sqlite'));
    migrate(db);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    const desk = createDesk(db, 'u1', 'WAL-Schreibtisch');

    // Absicherung: der Commit steht zu diesem Zeitpunkt tatsächlich (auch) im WAL-Seitenspeicher
    // und nicht bereits vollständig in der Hauptdatei eingerechnet.
    const walPfad = join(dir, 'desktop.sqlite-wal');
    expect(existsSync(walPfad)).toBe(true);
    expect(statSync(walPfad).size).toBeGreaterThan(0);

    // Bewusst KEIN checkpoint, KEIN close() vor dem Backup.
    const backupPfad = await rotateBackup(db, dir);
    expect(backupPfad).not.toBe('');

    const backupDb = new Database(backupPfad, { readonly: true });
    const desks = backupDb.prepare('SELECT id FROM desks').all() as { id: string }[];
    expect(desks.map((d) => d.id)).toContain(desk.id);
    backupDb.close();
    db.close();
  });
});

describe('starteBackupIntervall (D-14)', () => {
  it('Takt 1 Stunde erzeugt nach einer simulierten Stunde ein weiteres Backup', async () => {
    // Nur setInterval/clearInterval faken: db.backup() nutzt intern setImmediate für seine
    // seitenweise Übertragung — würde dieser Timer mitgefakt, würde der echte Backup-Lauf nie
    // fortschreiten und der Test liefe in den Timeout.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
      const db = openDb(join(dir, 'desktop.sqlite'));
      await rotateBackup(db, dir);
      const vorher = readdirSync(join(dir, 'backup')).filter((f) => f.endsWith('.sqlite'));
      expect(vorher).toHaveLength(1);

      const timer = starteBackupIntervall(db, dir, 1);
      expect(timer).not.toBeNull();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      // db.backup() läuft über echtes setImmediate (bewusst nicht mitgefakt, s.o.) — eine kurze
      // reale Wartezeit lässt die seitenweise Übertragung tatsächlich abschließen.
      await new Promise((r) => setTimeout(r, 50));

      const nachher = readdirSync(join(dir, 'backup')).filter((f) => f.endsWith('.sqlite'));
      expect(nachher.length).toBeGreaterThan(vorher.length);

      clearInterval(timer!);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Takt 0 startet nichts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    const db = openDb(join(dir, 'desktop.sqlite'));
    const timer = starteBackupIntervall(db, dir, 0);
    expect(timer).toBeNull();
    expect(existsSync(join(dir, 'backup'))).toBe(false);
    db.close();
  });

  it('Fehler im periodischen Lauf wird protokolliert und beendet nichts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
      const db = openDb(join(dir, 'desktop.sqlite'));
      const backupSpy = vi.spyOn(db, 'backup').mockRejectedValue(new Error('Platte voll'));

      const timer = starteBackupIntervall(db, dir, 1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      // Der Fehler wird protokolliert und reisst keine unbehandelte Ausnahme mit.
      expect(consoleErrorSpy).toHaveBeenCalledWith('Periodisches Backup fehlgeschlagen:', expect.any(Error));

      clearInterval(timer!);
      backupSpy.mockRestore();
      db.close();
    } finally {
      consoleErrorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
