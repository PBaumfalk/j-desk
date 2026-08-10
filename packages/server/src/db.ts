import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { VERSIONIERTE_ARTEN } from '@j-desk/core';
import { migrateSearchIndex } from './search/searchIndex';

export type Db = Database.Database;

/** Öffnet die Datenbank und legt das Basisschema an, OHNE die Migration zu fahren — Grundlage
 *  für das Boot-Backup (SAFE-03): der Aufrufer zieht dazwischen einen Snapshot des Vorzustands,
 *  bevor migrate() ihn verändert. openDb() bleibt der reguläre Weg für alle bestehenden
 *  Aufrufer (D-19) und ruft intern genau diese Funktion gefolgt von migrate(). */
export function openDbRaw(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      state TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desk_members (
      desk_id TEXT NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (desk_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS desk_roles (
      desk_id TEXT NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rolle TEXT NOT NULL,
      PRIMARY KEY (desk_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_desk_roles_user ON desk_roles(user_id);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'pdf'
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_journal (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id    TEXT NOT NULL,        -- bewusst ohne FK: Journal überlebt Desk-Löschung
      rev        INTEGER NOT NULL,     -- Rev NACH Anwendung (deckungsgleich mit Broadcast)
      type       TEXT NOT NULL,        -- Command-Typ oder deskCreated|stateReplaced|caseSync|snapshot
      payload    TEXT,                 -- JSON (Command-Payload bzw. State-Snapshot)
      actor_id   TEXT,                 -- users.id; NULL = System (Migration, Abgleich)
      actor_name TEXT NOT NULL,        -- Benutzername-Snapshot bzw. Systemkennung
      at         INTEGER NOT NULL      -- Unix-Millisekunden
    );
    CREATE INDEX IF NOT EXISTS idx_journal_desk ON command_journal(desk_id, id);
    CREATE TABLE IF NOT EXISTS jl_file_hashes (
      doc_id      TEXT NOT NULL,   -- j-lawyer-Dokument-ID (fremdes ID-Schema, keine FK)
      change_date INTEGER NOT NULL, -- jl-changeDate (Epoch-Millis) der gehashten Fassung
      sha256      TEXT NOT NULL,
      PRIMARY KEY (doc_id, change_date)
    );
    CREATE TABLE IF NOT EXISTS desk_auto_backup (
      desk_id      TEXT PRIMARY KEY, -- bewusst ohne FK: Merker soll eine gelöschte Akte überleben können
      last_rev     INTEGER NOT NULL, -- desks.rev zum Zeitpunkt der letzten Automatiksicherung
      last_at      INTEGER NOT NULL, -- Unix-Millisekunden der letzten Automatiksicherung
      last_doc_id  TEXT               -- j-lawyer-Dokument-ID des zuletzt hochgeladenen Pakets
    );
    CREATE TABLE IF NOT EXISTS benachrichtigungen (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,      -- Empfänger (Nutzerhoheit: Lesen/Markieren strikt user-scoped)
      desk_id    TEXT,               -- Herkunfts-Desk; NULL erlaubt (desk-übergreifende Anlässe)
      art        TEXT NOT NULL,      -- 'erwaehnung' (13-01); weitere Werte additiv in 13-04, keine CHECK-Constraint
      payload    TEXT NOT NULL,      -- JSON (art-spezifisch; bei Erwähnung: notizId/notizTitel/vonName/textStand)
      created_at INTEGER NOT NULL,
      read_at    INTEGER             -- Gelesen-Stand je Zeile; NULL = ungelesen
    );
    CREATE INDEX IF NOT EXISTS benachrichtigungen_user ON benachrichtigungen(user_id, read_at);
  `);
  return db;
}

/** Bestandsverhalten unverändert (D-19): Öffnen + Basisschema + Migration in einem Aufruf. */
export function openDb(path: string): Db {
  const db = openDbRaw(path);
  migrate(db);
  return db;
}

/** Schema-Migrationen für Bestands-Datenbanken (neue DBs erhalten das Zielschema bereits über CREATE TABLE oben). */
export function migrate(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;

  // Bewusst NICHT an user_version gehängt: Datenbanken aus dem nie gemergten TP3-Zweig tragen
  // dessen `user_version = 1` (is_admin/uploader_id/invites) — dieselbe Nummer, die hier die
  // kind-Migration beansprucht. Bei ihnen wurde die Spalte nie angelegt, die späteren
  // Migrationen hoben den Zähler trotzdem auf 3, und jeder Upload endete im 500er (storeFile
  // schreibt in eine nicht existierende Spalte). Sobald zwei Zweige Versionsnummern vergeben,
  // ist die Nummer keine verlässliche Aussage mehr über das Schema — der Spaltenbestand ist es.
  // Die Prüfung ist idempotent und kostet nur ein PRAGMA pro Start.
  const dateiSpalten = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map((c) => c.name);
  if (!dateiSpalten.includes('kind')) {
    db.exec("ALTER TABLE files ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf'");
  }

  // jl_file_hashes kam mit dieser Phase (Datei-Hash auch im j-lawyer-Cache-Pfad) — additive
  // Tabelle, keine Backfill-Pflicht (lazy Befüllung beim nächsten Cache-Zugriff). Dieselbe
  // schema-basierte Prüfung wie bei files.kind: PRAGMA table_info liefert eine leere Liste,
  // solange die Tabelle noch nicht existiert.
  const jlHashSpalten = (db.prepare('PRAGMA table_info(jl_file_hashes)').all() as { name: string }[]).map((c) => c.name);
  if (jlHashSpalten.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jl_file_hashes (
        doc_id      TEXT NOT NULL,
        change_date INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        PRIMARY KEY (doc_id, change_date)
      )
    `);
  }

  // Objektversionen für Bestands-Schreibtische: alle Objekte bekommen die aktuelle
  // desk-rev, damit der Fall „Objekt ohne Version" danach eindeutig „Alt-Paket" heisst
  // und nicht „Bestandsdatenbank". Am Inhalt erkannt statt an user_version — dieselbe
  // Lehre wie bei files.kind (siehe oben).
  const desksOhneVersion = db.prepare('SELECT id, state, rev FROM desks').all() as { id: string; state: string; rev: number }[];
  const setzeState = db.prepare('UPDATE desks SET state = ? WHERE id = ?');
  const versionieren = db.transaction((zeilen: typeof desksOhneVersion): void => {
    for (const desk of zeilen) {
      const state = JSON.parse(desk.state) as Record<string, unknown>;
      let geaendert = false;
      for (const art of VERSIONIERTE_ARTEN) {
        const liste = state[art];
        if (!Array.isArray(liste)) continue;
        state[art] = liste.map((o: Record<string, unknown>) => {
          if (o === null || typeof o !== 'object' || o.updatedRev !== undefined) return o;
          geaendert = true;
          return { ...o, updatedRev: desk.rev };
        });
      }
      if (geaendert) setzeState.run(JSON.stringify(state), desk.id);
    }
  });
  versionieren(desksOhneVersion);

  // desk_auto_backup kam mit dieser Phase (SAFE-06, .jdesk-Automatiksicherung in die j-lawyer-
  // Akte) — additive Tabelle für Bestands-DBs, dieselbe schema-basierte Prüfung wie bei
  // jl_file_hashes oben (PRAGMA table_info, kein Versionszähler — Lehre e410538).
  const autoBackupSpalten = (db.prepare('PRAGMA table_info(desk_auto_backup)').all() as { name: string }[]).map((c) => c.name);
  if (autoBackupSpalten.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desk_auto_backup (
        desk_id      TEXT PRIMARY KEY,
        last_rev     INTEGER NOT NULL,
        last_at      INTEGER NOT NULL,
        last_doc_id  TEXT
      )
    `);
  }

  // desk_roles kam mit dieser Phase (PERM-03-Fundament) — additive Tabelle für Bestands-DBs,
  // dieselbe schema-basierte Prüfung wie bei jl_file_hashes oben (PRAGMA table_info, nicht an
  // die Versionsnummer gehängt — Lehre e410538, siehe Kommentar am Kopf von migrate()).
  const deskRolesSpalten = (db.prepare('PRAGMA table_info(desk_roles)').all() as { name: string }[]).map((c) => c.name);
  if (deskRolesSpalten.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desk_roles (
        desk_id TEXT NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rolle TEXT NOT NULL,
        PRIMARY KEY (desk_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_desk_roles_user ON desk_roles(user_id);
    `);
  }

  // vorschlaege kam mit Phase 12 (AI-01: KI-Vertrauensschicht — Genehmigungs-Register
  // AUSSERHALB von desks.state) — additive Tabelle, dieselbe schema-basierte Prüfung wie bei
  // jl_file_hashes/desk_roles oben (PRAGMA table_info, NICHT an user_version gehängt —
  // Lehre e410538, siehe Kommentar am Kopf von migrate()). inverse/genehmigte_objekte bleiben
  // NULL bis zur Genehmigung (Inversen-Pflicht: sie werden in derselben Transaktion wie der
  // Status-Übergang geschrieben, BEVOR das erste Kommando wirkt). idempotenz_key ist
  // NULL-tolerant: SQLite lässt mehrere NULLs im Unique-Index zu — Zeilen ohne Schlüssel
  // kollidieren nie. decided_* trägt den Flywheel-Stempel je Übergang (Statusverteilung,
  // Genehmigungslatenz und Rücknahme-Rate müssen per SQL auswertbar sein — Pitfall 10).
  const vorschlagSpalten = (db.prepare('PRAGMA table_info(vorschlaege)').all() as { name: string }[]).map((c) => c.name);
  if (vorschlagSpalten.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vorschlaege (
        id                 TEXT PRIMARY KEY,
        desk_id            TEXT NOT NULL,
        art                TEXT NOT NULL,
        payload            TEXT NOT NULL,
        quellen            TEXT NOT NULL DEFAULT '[]',
        zusammenfassung    TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'ausstehend',
        inverse            TEXT,
        genehmigte_objekte TEXT,
        idempotenz_key     TEXT,
        created_by         TEXT NOT NULL,
        created_by_id      TEXT,
        created_at         INTEGER NOT NULL,
        decided_by         TEXT,
        decided_by_id      TEXT,
        decided_at         INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vorschlaege_idempotenz ON vorschlaege(desk_id, created_by, idempotenz_key);
      CREATE INDEX IF NOT EXISTS vorschlaege_desk ON vorschlaege(desk_id, status);
    `);
  }

  // benachrichtigungen kam mit Phase 13 (NOTIF-01, 13-01: Inbox-Register als eigene Tabelle
  // statt Journal-Ableitung — das Journal ist Eigentümer/Bearbeiter-gegatet, desk-scoped und
  // kennt keinen Gelesen-Stand, Vorentscheidung U1) — additive Tabelle, dieselbe
  // schema-basierte Prüfung wie bei vorschlaege/desk_roles oben (PRAGMA table_info, NICHT an
  // user_version gehängt — Lehre e410538, siehe Kommentar am Kopf von migrate()). art ist
  // bewusst TEXT ohne CHECK-Constraint: die übrigen Auslöser-Arten (13-04) bleiben eine
  // rein additive Erweiterung ohne Schema-Änderung.
  const benachrichtigungSpalten = (db.prepare('PRAGMA table_info(benachrichtigungen)').all() as { name: string }[]).map((c) => c.name);
  if (benachrichtigungSpalten.length === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS benachrichtigungen (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        desk_id    TEXT,
        art        TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS benachrichtigungen_user ON benachrichtigungen(user_id, read_at);
    `);
  }

  // Eigentümer-Backfill: Bestands-Desks, die vor dieser Phase (also ohne createDesk/ensureDesk-
  // Eigentümer-Insert, siehe deskStore.ts) angelegt wurden, bekommen hier nachträglich die
  // Eigentümer-Rolle für ihren owner_id — sonst sperrt sich der Ersteller an seinem eigenen
  // Schreibtisch aus (T-02-06). INSERT OR IGNORE: bereits vorhandene Zeilen (z. B. durch
  // createDesk in derselben Sitzung) bleiben unangetastet.
  db.exec(`
    INSERT OR IGNORE INTO desk_roles (desk_id, user_id, rolle)
    SELECT id, owner_id, 'Eigentümer' FROM desks
  `);

  // layerId-Backfill: Bestandsobjekte ohne layerId gelten implizit als Kanzlei-Ebene (T-02-10 —
  // stille Wegnahme von Sichtbarkeit wäre fachlich kritisch). Analog zum updatedRev-Backfill
  // oben: nur Objekte OHNE das Feld werden geändert, Referenzidentität sonst erhalten.
  // CR-02/IN-04: seit der Papierkorb-Projektion (projection.ts) gilt dieselbe Logik für die in
  // Korb-Payloads verschachtelten Kopien entfernter Objekte — ein Objekt ohne layerId fiele dort
  // auf den „implizit Kanzlei/sichtbar"-Fallback zurück, der Backfill erreicht sie deshalb auch.
  const desksOhneLayerId = db.prepare('SELECT id, state FROM desks').all() as { id: string; state: string }[];
  const setzeLayerId = db.prepare('UPDATE desks SET state = ? WHERE id = ?');
  const backfillLayerId = db.transaction((zeilen: typeof desksOhneLayerId): void => {
    for (const desk of zeilen) {
      const state = JSON.parse(desk.state) as Record<string, unknown>;
      let geaendert = false;
      const mitLayerId = (o: Record<string, unknown>): Record<string, unknown> => {
        if (o === null || typeof o !== 'object' || o.layerId !== undefined) return o;
        geaendert = true;
        return { ...o, layerId: 'kanzlei' };
      };
      for (const art of VERSIONIERTE_ARTEN) {
        // 13-02 (U4-Gebot): Zonen tragen BEWUSST kein layerId-Feld — sie sind referenzfreie
        // Orientierungsstruktur; der Backfill darf ihnen keine Ebene aufstempeln (13-02-PLAN
        // must_haves/prohibitions).
        if (art === 'zones') continue;
        const liste = state[art];
        if (!Array.isArray(liste)) continue;
        state[art] = liste.map(mitLayerId);
      }
      const korb = state.trash;
      if (Array.isArray(korb)) {
        state.trash = korb.map((eintrag: Record<string, unknown>) => {
          if (eintrag === null || typeof eintrag !== 'object') return eintrag;
          const payload = eintrag.payload;
          if (payload === null || typeof payload !== 'object') return eintrag;
          const neuesPayload = { ...(payload as Record<string, unknown>) };
          for (const [schluessel, liste] of Object.entries(neuesPayload)) {
            if (!Array.isArray(liste)) continue;
            neuesPayload[schluessel] = liste.map(mitLayerId);
          }
          return { ...eintrag, payload: neuesPayload };
        });
      }
      if (geaendert) setzeLayerId.run(JSON.stringify(state), desk.id);
    }
  });
  backfillLayerId(desksOhneLayerId);

  // Heilung der Platzhalter-layerId 'privat' (02-09): im Fenster zwischen 02-07 (Ebenen-Modell)
  // und dem CR-04-Guard konnten Objekte mit der unaufgelösten Platzhalter-id 'privat'
  // persistiert werden; seit dem Guard sind sie für ALLE unsichtbar (der SYSTEM_EBENEN-
  // Platzhalter trägt kein ownerUserId). Die Migration ordnet jedes solche Objekt der
  // Privat-Instanz seines Erstellers zu und stellt so die ursprüngliche Privat-Absicht wieder
  // her — das Ziel ist IMMER eine privat-Instanz, niemals 'kanzlei', ein Fehlgriff verbirgt
  // also höchstens weiter, statt zu exposen (T-02-09-05). Ersteller-Auflösung: createdById,
  // sonst createdBy-Name über die users-Tabelle, sonst owner_id des Desks. Dasselbe
  // Instanz-id-Schema wie die Lazy-Erzeugung ('privat-<userId>') — keine zwei Erzeugungswege.
  // Idempotent: Instanzen werden über ihre id dedupliziert, geheilte Objekte tragen danach
  // keine Platzhalter-id mehr; Schreiben nur bei geaendert (Muster des layerId-Backfills oben).
  const nutzerIdNachName = new Map(
    (db.prepare('SELECT id, username FROM users').all() as { id: string; username: string }[]).map((u) => [u.username, u.id]),
  );
  const desksMitPlatzhalter = db.prepare('SELECT id, owner_id, state FROM desks').all() as { id: string; owner_id: string; state: string }[];
  const setzeGeheiltenState = db.prepare('UPDATE desks SET state = ? WHERE id = ?');
  const heilePlatzhalterPrivat = db.transaction((zeilen: typeof desksMitPlatzhalter): void => {
    for (const desk of zeilen) {
      const state = JSON.parse(desk.state) as Record<string, unknown>;
      let geaendert = false;
      const layers: Record<string, unknown>[] = Array.isArray(state.layers) ? (state.layers as Record<string, unknown>[]) : [];
      const instanzIdFuer = (o: Record<string, unknown>): string => {
        const erstellerId =
          (typeof o.createdById === 'string' ? o.createdById : undefined) ??
          (typeof o.createdBy === 'string' ? nutzerIdNachName.get(o.createdBy) : undefined) ??
          desk.owner_id;
        const instanzId = `privat-${erstellerId}`;
        if (!layers.some((e) => e.id === instanzId)) {
          layers.push({ id: instanzId, typ: 'privat', name: 'Privat', ownerUserId: erstellerId });
        }
        return instanzId;
      };
      const heilen = (o: Record<string, unknown>): Record<string, unknown> => {
        if (o === null || typeof o !== 'object' || o.layerId !== 'privat') return o;
        geaendert = true;
        return { ...o, layerId: instanzIdFuer(o) };
      };
      for (const art of VERSIONIERTE_ARTEN) {
        const liste = state[art];
        if (!Array.isArray(liste)) continue;
        state[art] = liste.map(heilen);
      }
      const korb = state.trash;
      if (Array.isArray(korb)) {
        state.trash = korb.map((eintrag: Record<string, unknown>) => {
          if (eintrag === null || typeof eintrag !== 'object') return eintrag;
          const payload = eintrag.payload;
          if (payload === null || typeof payload !== 'object') return eintrag;
          const neuesPayload = { ...(payload as Record<string, unknown>) };
          for (const [schluessel, liste] of Object.entries(neuesPayload)) {
            if (!Array.isArray(liste)) continue;
            neuesPayload[schluessel] = liste.map(heilen);
          }
          return { ...eintrag, payload: neuesPayload };
        });
      }
      if (geaendert) {
        state.layers = layers;
        setzeGeheiltenState.run(JSON.stringify(state), desk.id);
      }
    }
  });
  heilePlatzhalterPrivat(desksMitPlatzhalter);

  // Tote desk_members-Tabelle (nie reaktiviert, siehe 02-CONTEXT) defensiv nach desk_roles
  // übernehmen: vorhandene Zeilen gewährten früher stillen Zugriff ohne Rollenmodell —
  // 'Bearbeiter' ist die sicherste Näherung. INSERT OR IGNORE lässt bereits vergebene Rollen
  // (z. B. Eigentümer aus dem Backfill oben) unangetastet.
  db.exec(`
    INSERT OR IGNORE INTO desk_roles (desk_id, user_id, rolle)
    SELECT desk_id, user_id, 'Bearbeiter' FROM desk_members
  `);

  if (version < 1) {
    db.pragma('user_version = 1');
  }
  if (version < 2) {
    // settings kam nach v1; CREATE IF NOT EXISTS oben deckt neue DBs, hier Bestands-DBs.
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.pragma('user_version = 2');
  }
  if (version < 3) {
    // command_journal kam nach v2; CREATE IF NOT EXISTS oben deckt neue DBs, hier Bestands-DBs.
    db.exec(`
      CREATE TABLE IF NOT EXISTS command_journal (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        desk_id    TEXT NOT NULL,
        rev        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT,
        actor_id   TEXT,
        actor_name TEXT NOT NULL,
        at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journal_desk ON command_journal(desk_id, id);
    `);
    // Baseline-Snapshot für jeden Bestands-Desk, damit die Journal-Historie lückenlos bei der Migration beginnt.
    const desks = db.prepare('SELECT id, state, rev FROM desks').all() as { id: string; state: string; rev: number }[];
    const insert = db.prepare(
      'INSERT INTO command_journal (desk_id, rev, type, payload, actor_id, actor_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = Date.now();
    for (const desk of desks) {
      insert.run(desk.id, desk.rev, 'snapshot', JSON.stringify({ state: JSON.parse(desk.state) }), null, 'Migration', now);
    }
    db.pragma('user_version = 3');
  }

  // search_fts (07-01, SEARCH-01/SEARCH-04) kam nach v3 — additive Virtual-Table, intern
  // idempotent und NICHT an user_version gehängt (eigener Zähler in settings, s. searchIndex.ts
  // und der Kommentar am Kopf dieser Funktion). Unbedingter Aufruf, analog zur Aufrufkonvention
  // der übrigen additiven Blöcke oben.
  migrateSearchIndex(db);
}

/** Server-Einstellung lesen (z. B. jlawyer_url aus dem Setup-Dialog). */
export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Betriebsmodus der Ersteinrichtung atomar beanspruchen — true nur für den ersten Aufrufer.
 *
 * Die Setup-Route prüft VOR dem Probe-Await, ob noch nichts konfiguriert ist, und schreibt
 * danach. In diesem Fenster passieren zwei parallele Erststart-POSTs beide die Prüfung. Ein
 * blosses setSetting liesse beide schreiben (letzter gewinnt) und beiden 200 melden — der
 * Server liefe dann womöglich gegen eine andere j-lawyer-Instanz als die, die dem antwortenden
 * Client bestätigt wurde. Im Erststart-Fenster ist die Route unauthentifiziert, also nicht nur
 * ein Komfortproblem. Prüfung und Schreiben laufen deshalb hier in EINER Transaktion
 * (better-sqlite3 ist synchron — kein Await kann sie aufreissen).
 *
 * Mitgeprüft wird die Kontolage: existiert bereits ein Benutzer, wurde der Standalone-Modus
 * gewählt und der j-lawyer-Modus darf nicht mehr nachträglich gesetzt werden.
 */
export function claimBetriebsmodus(db: Db, url: string): boolean {
  const beanspruchen = db.transaction((): boolean => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (n > 0) return false;
    const res = db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run('jlawyer_url', url);
    return res.changes === 1;
  });
  return beanspruchen();
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Kennung DIESER Installation, beim ersten Abruf erzeugt. Steckt im .jdesk-Manifest,
    damit ein Import erkennen kann, ob ein Paket von hier stammt oder umgezogen ist. */
export function instanceId(db: Db): string {
  const vorhanden = getSetting(db, 'instance_id');
  if (vorhanden !== null) return vorhanden;
  const neu = randomUUID();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('instance_id', neu);
  return getSetting(db, 'instance_id') ?? neu;
}
