import { VERSIONIERTE_ARTEN, type DesktopState } from '@j-desk/core';
import { getSetting, setSetting, type Db } from '../db';
import { indexZeileFuer } from './searchSync';

/**
 * Version der indizierten Oberfläche (SEARCH-01/SEARCH-04): erhöht sich, wenn sich ändert,
 * WELCHE Objektarten/Felder indiziert werden — erzwingt dann automatisch einen Vollreindex
 * aller Bestandsdatenbanken beim nächsten Serverstart (s. migrateSearchIndex).
 *
 * Auf 2 angehoben (07-02): `indexZeileFuer` deckt jetzt zusätzlich marks/stamps/cutouts/links/
 * flags ab (vorher nur docs/stacks/notes) — Bestandsdatenbanken bekommen dadurch beim nächsten
 * Start automatisch einen Vollreindex über die breitere Oberfläche, ohne dass ein Objekt
 * angefasst werden muss.
 */
export const SEARCH_INDEX_VERSION = 2;

/**
 * Additive Migration nach demselben Muster wie `jl_file_hashes`/`desk_auto_backup` in db.ts.
 *
 * Existenzprüfung über `sqlite_master` statt `PRAGMA table_info` — Letzteres meldet für
 * FTS5-Virtual-Tables keine verlässliche Spaltenliste (07-01-PLAN.md). Der SQLite-Schema-
 * Versionspragma wird bewusst weder gelesen noch geschrieben (dieselbe Lehre wie im Kommentar
 * am Kopf von `migrate()` in db.ts, dokumentiert am historischen Migrationsvorfall e410538):
 * der Zähler für die indizierte Oberfläche steht stattdessen in `settings`
 * (`search_index_version`), unabhängig vom Schema-Versionszähler.
 *
 * `ersteller`/`datum` sind bewusst INDIZIERT (kein `UNINDEXED`) — SEARCH-01 verlangt
 * ausdrücklich die Suche nach Ersteller und Datum, nicht nur nach Objekttext. `file_pages`/
 * `file_pages_fts` gehören NICHT in diesen Plan (07-04 legt sie an).
 */
export function migrateSearchIndex(db: Db): void {
  const hatSearchFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_fts'")
    .get();
  if (!hatSearchFts) {
    db.exec(`
      CREATE VIRTUAL TABLE search_fts USING fts5(
        desk_id UNINDEXED, obj_type UNINDEXED, obj_id UNINDEXED, layer_id UNINDEXED,
        text, ersteller, datum
      );
    `);
  }

  // file_pages/file_extract kamen mit 07-04 (Datei-Text-Extraktion, SEARCH-01/SEARCH-03) —
  // additive, gewöhnliche Tabellen. Existenzprüfung über `PRAGMA table_info` wie die übrigen
  // additiven Blöcke in db.ts (jl_file_hashes, desk_auto_backup, desk_roles) — NICHT über
  // `SEARCH_INDEX_VERSION` unten: diese Marke steuert ausschließlich den Reindex der
  // desk-gebundenen Objekte aus `desks.state` (search_fts), Dateitexte lassen sich daraus nicht
  // rekonstruieren (die Bytes liegen in der Ablage, nicht im State) und werden deshalb nicht über
  // diesen Weg neu aufgebaut. Bestandsdateien werden nachträglich extrahiert, sobald sie das
  // nächste Mal durch einen Ingestionsweg laufen (storeFile-Dedupe-Pfad, cachedDocBytes); ein
  // Rückwärts-Extraktionslauf über ALLE Bestandsdateien ist bewusst NICHT Teil dieser Phase
  // (Umfang/Laufzeit) und wäre, falls gewünscht, ein eigener Betriebsbefehl (Phase 14).
  const hatFilePages = (db.prepare('PRAGMA table_info(file_pages)').all() as { name: string }[]).length > 0;
  if (!hatFilePages) {
    db.exec(`
      CREATE TABLE file_pages (
        file_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        pdf_text TEXT,
        ocr_text TEXT,
        ocr_confidence INTEGER,
        PRIMARY KEY (file_id, page)
      );
    `);
  }
  const hatFileExtract = (db.prepare('PRAGMA table_info(file_extract)').all() as { name: string }[]).length > 0;
  if (!hatFileExtract) {
    db.exec(`
      CREATE TABLE file_extract (
        file_id TEXT PRIMARY KEY,
        stand TEXT NOT NULL,
        seiten INTEGER,
        fehler TEXT,
        aktualisiert_am INTEGER NOT NULL
      );
    `);
  }
  // file_pages_fts ist wie search_fts eine Virtual Table — `PRAGMA table_info` liefert dafür
  // keine verlässliche Spaltenliste, Existenzprüfung deshalb über `sqlite_master` (s. Kommentar
  // oben bei search_fts).
  const hatFilePagesFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_pages_fts'")
    .get();
  if (!hatFilePagesFts) {
    db.exec(`
      CREATE VIRTUAL TABLE file_pages_fts USING fts5(
        file_id UNINDEXED, page UNINDEXED, pdf_text, ocr_text
      );
    `);
  }

  // Bestandsdatenbanken UND der allererste Start (kein Eintrag = null) bekommen hier einen
  // Vollreindex: ohne ihn hätte jede vor dieser Phase angelegte Desk eine leere Suche, bis
  // jedes Objekt einmal angefasst wird (die Sync-Verdrahtung in deskStore.ts greift nur bei
  // KÜNFTIGEN Schreibvorgängen). Idempotent, kostet nur einen Settings-Lookup pro Start,
  // solange die Version unverändert bleibt.
  const aktuelleVersion = getSetting(db, 'search_index_version');
  if (aktuelleVersion !== String(SEARCH_INDEX_VERSION)) {
    reindexAlleDesks(db);
    setSetting(db, 'search_index_version', String(SEARCH_INDEX_VERSION));
  }
}

/** Baut den Suchindex EINES Desks komplett neu auf. */
export function reindexDesk(db: Db, deskId: string, state: DesktopState): void {
  db.prepare('DELETE FROM search_fts WHERE desk_id = ?').run(deskId);
  const insert = db.prepare(
    `INSERT INTO search_fts (desk_id, obj_type, obj_id, layer_id, text, ersteller, datum)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const art of VERSIONIERTE_ARTEN) {
    const liste = (state as unknown as Record<string, { id: string; layerId?: string }[] | undefined>)[art];
    if (!liste) continue;
    for (const obj of liste) {
      const zeile = indexZeileFuer(art, obj);
      if (!zeile) continue;
      insert.run(deskId, art, obj.id, obj.layerId ?? null, zeile.text, zeile.ersteller, zeile.datum);
    }
  }
}

/** Alle Desks in EINER Transaktion neu indizieren — ein Abbruch hinterlässt so keinen halben Index. */
export function reindexAlleDesks(db: Db): void {
  const alle = db.prepare('SELECT id, state FROM desks').all() as { id: string; state: string }[];
  const txn = db.transaction((zeilen: typeof alle): void => {
    for (const desk of zeilen) {
      reindexDesk(db, desk.id, JSON.parse(desk.state) as DesktopState);
    }
  });
  txn(alle);
}
