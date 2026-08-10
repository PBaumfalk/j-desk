import type { Rolle } from '@j-desk/core';
import type { Db } from './db';
import { getDeskState } from './deskStore';
import { buildPackage } from './jdesk';
import { createDocument } from './jlawyer';
import { parseHours } from './envConfig';

/** Mindestabstand zwischen zwei Automatiksicherungen desselben Schreibtischs, in Stunden.
 *  `0` schaltet die Automatik vollständig ab (D-13). WR-02: ein nicht-numerischer Wert (Tippfehler)
 *  wird laut protokolliert und fällt auf den Standardwert zurück, statt still als NaN in
 *  sollArchivieren() zu landen (dort archiviert ein NaN-Intervall genau einmal und verstummt
 *  danach für immer, ohne jeden Hinweis auf die Fehlkonfiguration). */
export const ARCHIVE_INTERVAL_STUNDEN = parseHours('JDESK_ARCHIVE_INTERVAL_HOURS', process.env.JDESK_ARCHIVE_INTERVAL_HOURS, 24);

/** Merker über die letzte erfolgreiche Automatiksicherung eines Schreibtischs (desk_auto_backup). */
export interface ArchivMerker {
  deskId: string;
  lastRev: number;
  lastAt: number;
  lastDocId: string | null;
}

export function leseArchivMerker(db: Db, deskId: string): ArchivMerker | null {
  const row = db
    .prepare('SELECT desk_id, last_rev, last_at, last_doc_id FROM desk_auto_backup WHERE desk_id = ?')
    .get(deskId) as { desk_id: string; last_rev: number; last_at: number; last_doc_id: string | null } | undefined;
  if (!row) return null;
  return { deskId: row.desk_id, lastRev: row.last_rev, lastAt: row.last_at, lastDocId: row.last_doc_id };
}

/** D-13/T-05-23: Automatiksicherung nur bei tatsächlicher Zustandsänderung (rev > lastRev) UND
 *  verstrichenem Mindestabstand — beide Bedingungen müssen gelten, sonst müllt die Automatik die
 *  Akte mit nahezu identischen Paketen zu. `intervallStunden <= 0` schaltet die Automatik ab. */
export function sollArchivieren(db: Db, deskId: string, rev: number, jetzt: number, intervallStunden: number): boolean {
  if (intervallStunden <= 0) return false;
  const merker = leseArchivMerker(db, deskId);
  if (!merker) return true;
  return rev > merker.lastRev && jetzt - merker.lastAt >= intervallStunden * 3_600_000;
}

export function merkeArchiv(db: Db, deskId: string, rev: number, at: number, docId: string | null): void {
  db.prepare(
    `INSERT INTO desk_auto_backup (desk_id, last_rev, last_at, last_doc_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(desk_id) DO UPDATE SET last_rev = excluded.last_rev, last_at = excluded.last_at, last_doc_id = excluded.last_doc_id`,
  ).run(deskId, rev, at, docId);
}

/** D-22: prozessinterner Nebenläufigkeitsschutz — verhindert, dass zwei gleichzeitige Abgleiche
 *  derselben Akte zwei Automatiksicherungen gleichzeitig anstoßen. */
const laufendeSicherungen = new Set<string>();

/** Ersetzt Zeichen außerhalb von Buchstaben/Ziffern/Bindestrich/Unterstrich, damit der Dateiname
 *  in jeder j-lawyer-Instanz unproblematisch ist. */
function archivDateiname(deskName: string, jetzt: number): string {
  const sicher = deskName.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${sicher}-${jetzt}.jdesk`;
}

export interface VielleichtArchiviereOpts {
  db: Db;
  dataDir: string;
  jlBase: string;
  creds: { username: string; password: string };
  deskId: string;
  userId: string;
  rolle: Rolle;
  actorName: string;
  jetzt?: number;
  intervallStunden?: number;
}

/**
 * D-13 (05-RESEARCH Open Question 1 / Pitfall 4): opportunistische, per-Akte .jdesk-
 * Automatiksicherung in die j-lawyer-Akte — ausgelöst vom nächsten erfolgreichen,
 * authentifizierten Akten-Abgleich statt an rotateBackup() (dort existieren weder deskId noch
 * {userId, rolle} noch j-lawyer-Zugangsdaten).
 *
 * Läuft unter der echten Rolle des auslösenden Nutzers — buildPackage() projiziert den Zustand
 * VOR der Export-Bereinigung (T-05-21), es gibt keinen synthetischen Vollzugriffs-Akteur.
 * Wirft nie: ein Fehlschlag wird protokolliert und der Merker NICHT fortgeschrieben (D-12),
 * damit der nächste Abgleich es erneut versucht.
 */
export async function vielleichtArchiviere(opts: VielleichtArchiviereOpts): Promise<void> {
  const { db, dataDir, jlBase, creds, deskId, userId, rolle, actorName } = opts;
  const jetzt = opts.jetzt ?? Date.now();
  const intervallStunden = opts.intervallStunden ?? ARCHIVE_INTERVAL_STUNDEN;

  if (laufendeSicherungen.has(deskId)) return;
  laufendeSicherungen.add(deskId);
  try {
    const zustand = getDeskState(db, deskId);
    if (!zustand) return;
    if (!sollArchivieren(db, deskId, zustand.rev, jetzt, intervallStunden)) return;

    const paket = buildPackage(db, dataDir, deskId, { createdBy: actorName, jlawyer: true, userId, rolle });
    const row = db.prepare('SELECT name FROM desks WHERE id = ?').get(deskId) as { name: string } | undefined;
    const dateiname = archivDateiname(row?.name ?? deskId, jetzt);
    const { id: docId } = await createDocument(jlBase, creds.username, creds.password, deskId, dateiname, paket);
    merkeArchiv(db, deskId, zustand.rev, jetzt, docId);
  } catch (fehler) {
    console.error('Automatische .jdesk-Sicherung in die Akte fehlgeschlagen:', fehler);
  } finally {
    laufendeSicherungen.delete(deskId);
  }
}
