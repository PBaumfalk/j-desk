import { randomUUID } from 'node:crypto';
import {
  ALLE_ROLLEN, applyCommand, darfAktion, emptyState, isValidState, KonfliktError, pruefeErwartung, stempeleGeaenderte,
  stelleErzeugerIdSicher,
  type Command, type CommandMeta, type DesktopState, type Erwartet, type GefahrlicheAktion, type Rolle,
} from '@j-desk/core';
import type { Db } from './db';
import { appendJournal, vielleichtSnapshot } from './journal';
import { syncSearchIndex } from './search/searchSync';
import { verarbeiteErwaehnungen, verarbeiteAufgabenAusloeser } from './benachrichtigungen';

export class DeskNotFoundError extends Error {}
export class InvalidStateError extends Error {}
/** Zugriff verweigert (403) — bewusst unterscheidbar von DeskNotFoundError (404): der Desk
 *  existiert, der Nutzer hat nur keine (ausreichende) Rolle dafür. Guards (guards.ts, 02-03
 *  Task 3) bilden diesen Fehler auf 403 ab, DeskNotFoundError weiterhin auf 404. */
export class ZugriffVerweigertError extends Error {}
/** Rollenvergabe: unbekannter Nutzer(name) bzw. unbekannte/ungültige Rolle (02-04 Task 3). */
export class UnbekannterNutzerError extends Error {}
export class UngueltigeRolleError extends Error {}

/** Wer eine Aktion ausgelöst hat — journaliert und (bei Commands) als CommandMeta gestempelt. */
export interface Actor {
  id: string | null;
  name: string;
}

export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
}

export interface DeskState {
  rev: number;
  state: DesktopState;
}

/**
 * `initial` (TMPL-01, 13-07): optionaler vorgegebener Start-State (Mandatsvorlagen-Anlage,
 * vorlagen.ts `initialerStateAusVorlage`) — fehlt er, entsteht wie bisher `emptyState()`.
 * Alles Übrige (Transaktion, Eigentümer-Rolle, deskCreated-Journal) bleibt wortgleich: die
 * Vorlagenanlage erbt die T-02-06-Integrität, keine zweite Anlage-Maschinerie.
 */
export function createDesk(db: Db, ownerId: string, name: string, actor?: Actor, initial?: DesktopState): DeskInfo {
  const id = randomUUID();
  const txn = db.transaction((): void => {
    db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(
      id, name, ownerId, JSON.stringify(initial ?? emptyState()), Date.now(),
    );
    // Eigentümer-Rolle in DERSELBEN Transaktion — sonst sperrt sich der Ersteller an seinem
    // eigenen Schreibtisch selbst aus (T-02-06). INSERT OR IGNORE: rein defensiv, es kann bei
    // einer frisch erzeugten id noch keine Zeile geben.
    db.prepare('INSERT OR IGNORE INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(id, ownerId, 'Eigentümer' satisfies Rolle);
    if (actor) {
      appendJournal(db, {
        deskId: id, rev: 0, type: 'deskCreated', payload: { name }, actorId: actor.id, actorName: actor.name,
      });
    }
  });
  txn();
  return { id, name, ownerId };
}

/** Desk mit vorgegebener ID (j-lawyer-Akten-ID) — legt ihn beim ersten Öffnen an. */
export function ensureDesk(db: Db, id: string, ownerId: string, name: string, actor?: Actor): void {
  const txn = db.transaction((): void => {
    const result = db
      .prepare('INSERT OR IGNORE INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, name, ownerId, JSON.stringify(emptyState()), Date.now());
    // Eigentümer-Rolle wie bei createDesk — aber NUR, wenn der Desk hier tatsächlich neu
    // entstanden ist (WR-02): bis zur Review lief das desk_roles-Insert bei JEDEM Aufruf,
    // sodass jeder weitere j-lawyer-berechtigte Nutzer, der die Akte öffnete, still zum
    // zweiten 'Eigentümer' wurde (inkl. Lösch-/Rollenverwaltungsrecht auf die fremde Akte).
    if (result.changes > 0) {
      db.prepare('INSERT OR IGNORE INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(id, ownerId, 'Eigentümer' satisfies Rolle);
    }
    if (actor && result.changes > 0) {
      appendJournal(db, {
        deskId: id, rev: 0, type: 'deskCreated', payload: { name }, actorId: actor.id, actorName: actor.name,
      });
    }
  });
  txn();
}

/**
 * j-lawyer-Modus (WR-02): weist dem zugreifenden Nutzer die Bearbeiter-Rolle zu, NACHDEM die
 * jl-seitige Berechtigung erwiesen ist (erfolgreicher listDocuments-/createDocument-Abruf in
 * syncCaseDesk/POST /cases/:id/documents — j-lawyer bleibt das führende Berechtigungssystem).
 * INSERT OR IGNORE: eine vorhandene Rolle (Eigentümer des Erst-Öffners, explizit vergebene
 * Rollen) wird nie überschrieben/herabgestuft.
 */
export function ensureBearbeiterRolle(db: Db, deskId: string, userId: string): void {
  db.prepare('INSERT OR IGNORE INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, userId, 'Bearbeiter' satisfies Rolle);
}

/** Feste Rolle eines Nutzers an einem Desk, oder null bei fehlendem Zugriff (PERM-03). */
export function getRolleForNutzer(db: Db, deskId: string, userId: string): Rolle | null {
  const row = db.prepare('SELECT rolle FROM desk_roles WHERE desk_id = ? AND user_id = ?').get(deskId, userId) as
    | { rolle: Rolle }
    | undefined;
  return row ? row.rolle : null;
}

/**
 * Prüft Desk-Zugriff (PERM-04-Fundament): wirft ZugriffVerweigertError, wenn der Nutzer keine
 * oder — bei angegebenen `erforderlicheRollen` — keine ausreichende Rolle hat. Liefert sonst
 * die ermittelte Rolle (für den Aufrufer, z. B. um sie an req.rolle zu hängen).
 */
export function pruefeDeskZugriff(db: Db, deskId: string, userId: string, erforderlicheRollen?: Rolle[]): Rolle {
  const rolle = getRolleForNutzer(db, deskId, userId);
  if (!rolle) {
    // 02-04: erst jetzt (mit Guards an echten Routen) sichtbar geworden — ein NICHT
    // existierender Desk muss weiterhin 404 liefern (Bestandsverhalten mehrerer Routen), ein
    // existierender Desk ohne Rolle für diesen Nutzer 403. getRolleForNutzer allein kann beides
    // nicht unterscheiden (liefert in beiden Fällen null).
    const existiert = db.prepare('SELECT 1 FROM desks WHERE id = ?').get(deskId);
    if (!existiert) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    throw new ZugriffVerweigertError('Kein Zugriff auf diesen Schreibtisch.');
  }
  if (erforderlicheRollen && !erforderlicheRollen.includes(rolle)) {
    throw new ZugriffVerweigertError('Unzureichende Berechtigung für diese Aktion.');
  }
  return rolle;
}

/** Wie pruefeDeskZugriff, zusätzlich fail-closed gegen die Rechte-Matrix (darfAktion, PERM-04). */
export function pruefeDeskAktion(db: Db, deskId: string, userId: string, aktion: GefahrlicheAktion): Rolle {
  const rolle = pruefeDeskZugriff(db, deskId, userId);
  if (!darfAktion(rolle, aktion)) {
    throw new ZugriffVerweigertError(`Berechtigung verweigert: ${aktion}`);
  }
  return rolle;
}

export function listDesks(db: Db): DeskInfo[] {
  return db
    .prepare('SELECT id, name, owner_id AS ownerId FROM desks ORDER BY created_at')
    .all() as DeskInfo[];
}

/** Wie listDesks, aber nur die Schreibtische EINES Eigentümers — Grundlage des
 *  fail-closed-Ausfall-Fallbacks im j-lawyer-Modus (siehe app.ts): Ohne j-lawyer
 *  können wir Rechte nicht prüfen, also liefert der Fallback ausschließlich Akten,
 *  die dieser Nutzer selbst geöffnet hat. */
export function listDesksOwnedBy(db: Db, ownerId: string): DeskInfo[] {
  return db
    .prepare('SELECT id, name, owner_id AS ownerId FROM desks WHERE owner_id = ? ORDER BY created_at')
    .all(ownerId) as DeskInfo[];
}

/** Nur der Eigentümer einer Desk-Zeile — genutzt vom Ausfall-Fallback, um zu prüfen,
 *  ob der zwischengespeicherte Stand diesem Nutzer gehört, ohne den vollen State zu laden. */
export function getDeskOwner(db: Db, deskId: string): string | null {
  const row = db.prepare('SELECT owner_id AS ownerId FROM desks WHERE id = ?').get(deskId) as
    | { ownerId: string }
    | undefined;
  return row ? row.ownerId : null;
}

export function renameDesk(db: Db, deskId: string, name: string): void {
  const result = db.prepare('UPDATE desks SET name = ? WHERE id = ?').run(name, deskId);
  if (result.changes === 0) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
}

export function deleteDesk(db: Db, deskId: string): void {
  // WR-02 (07-Review): search_fts ist eine Virtual Table ohne Foreign Keys (anders als
  // desk_roles/desk_members, die per ON DELETE CASCADE mitgehen) — ohne diese Zeile bliebe der
  // indexierte Objekttext des gelöschten Desks unbegrenzt in search_fts liegen.
  const loeschen = db.transaction(() => {
    const result = db.prepare('DELETE FROM desks WHERE id = ?').run(deskId);
    if (result.changes === 0) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    db.prepare('DELETE FROM search_fts WHERE desk_id = ?').run(deskId);
  });
  loeschen();
}

export function getDeskState(db: Db, deskId: string): DeskState | null {
  const row = db.prepare('SELECT state, rev FROM desks WHERE id = ?').get(deskId) as
    | { state: string; rev: number }
    | undefined;
  return row ? { rev: row.rev, state: JSON.parse(row.state) as DesktopState } : null;
}

/**
 * Wendet einen Command an — mit Vorbedingungsprüfung und Versionsstempel.
 *
 * Reihenfolge ist wesentlich: Die Erwartung wird INNERHALB der Transaktion gegen den
 * frisch gelesenen Zustand geprüft, bevor irgendetwas geschrieben wird. Ein Konflikt
 * lässt Zustand UND Journal unberührt.
 */
export function applyDeskCommand(
  db: Db,
  deskId: string,
  cmd: Command & { erwartet?: Erwartet },
  actor?: Actor,
): DeskState {
  const txn = db.transaction((): DeskState => {
    // WR-02: erzeugende Commands ohne clientvergebene ID (jl-Upload, Sprung-Pfad, MCP —
    // die ID ist Client-Konvention, keine Pflicht) bekommen serverseitig eine, BEVOR der
    // Command angewendet und journaliert wird. optId() im Core übernimmt sie: Objekt und
    // Journal-Eintrag tragen dieselbe ID und der Eintrag bleibt für die Journal-Projektion
    // (CR-03-Filter, journal.ts) auflösbar — sonst fiele er fail-closed aus der Historie
    // ALLER Betrachter (z. B. jeder j-lawyer-Upload).
    stelleErzeugerIdSicher(cmd, randomUUID);
    const row = db.prepare('SELECT state, rev FROM desks WHERE id = ?').get(deskId) as
      | { state: string; rev: number }
      | undefined;
    if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    const vorher = JSON.parse(row.state) as DesktopState;

    const konflikt = pruefeErwartung(vorher, cmd.erwartet);
    if (konflikt) throw new KonfliktError(konflikt);

    const jetzt = new Date().toISOString();
    // WR-05: createdById (stabile users.id) neben dem Username stempeln — der Name ist nach
    // Konto-Löschung neu vergebbar und damit als Berechtigungs-Anker ungeeignet. System-
    // Aufrufer ohne userId (actor.id === null) bekommen bewusst kein createdById.
    const meta: CommandMeta | undefined = actor
      ? { createdBy: actor.name, createdAt: jetzt, ...(actor.id ? { createdById: actor.id } : {}) }
      : undefined;
    const rev = row.rev + 1;
    // Stempel NACH applyCommand per Referenzvergleich — siehe stempel.ts, warum zentral
    // und nicht in den einzelnen Handlern.
    const next = stempeleGeaenderte(vorher, applyCommand(vorher, cmd, meta), {
      rev, at: jetzt, by: actor?.name ?? 'System',
    });

    // SEARCH-01/04 (07-01): Index-Sync direkt an DIESEM State-Schreibpunkt, in DERSELBEN
    // Transaktion wie das UPDATE — die zweite Aufrufstelle steht in putDeskState() unten.
    syncSearchIndex(db, deskId, vorher, next);
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(next), rev, deskId);
    if (actor) {
      appendJournal(db, {
        deskId, rev, type: cmd.type, payload: cmd.payload, actorId: actor.id, actorName: actor.name,
      });
    }
    // D-09: nach dem Write, innerhalb derselben Transaktion — friert nur einen bereits
    // geschriebenen Zustand ein (P-04).
    vielleichtSnapshot(db, deskId, rev, next);
    // NOTIF-01 (13-01/13-04, U2): Auslöser NACH Anwendung und Journalierung, innerhalb
    // derselben Transaktion — applyDeskCommand ist die einzige Stelle, durch die ALLE
    // Schreibwege laufen (Browser-Route, MCP, Offline-Nachspielen); nur hier ist die
    // Erkennung vollständig. Ein Fehler in einem Auslöser darf die Kommando-Transaktion
    // NICHT scheitern lassen (graceful degradation: eine defekte Erwähnung/Zuweisung darf
    // keinen Command verhindern) — die Sichtprüfung IN den Auslösern bleibt dagegen
    // fail-closed. verarbeiteAufgabenAusloeser braucht `vorher` für die O2-Operationalisierung
    // (Empfänger einer Statuszeile = assignee VOR diesem Kommando).
    try {
      verarbeiteErwaehnungen(db, deskId, cmd, next, actor);
      verarbeiteAufgabenAusloeser(db, deskId, cmd, vorher, next, actor);
    } catch (e) {
      console.error('Benachrichtigungs-Auslöser fehlgeschlagen (Kommando bleibt wirksam):', e);
    }
    return { rev, state: next };
  });
  return txn();
}

export interface Mitglied {
  userId: string;
  username: string;
  rolle: Rolle;
}

/** Alle Mitglieder eines Desks samt Rolle (Teilen-Dialog, PERM-03) — Eigentümer zuerst. */
export function listMembers(db: Db, deskId: string): Mitglied[] {
  return db.prepare(
    `SELECT dr.user_id AS userId, u.username AS username, dr.rolle AS rolle
     FROM desk_roles dr JOIN users u ON u.id = dr.user_id
     WHERE dr.desk_id = ?
     ORDER BY CASE dr.rolle WHEN 'Eigentümer' THEN 0 ELSE 1 END, u.username`,
  ).all(deskId) as Mitglied[];
}

/**
 * Weist einem EXISTIERENDEN Nutzer (per userId) eine Rolle zu, oder ändert sie (PERM-03/PERM-04).
 * Nur Rollenvergabe für bekannte Konten — keine Einladungscodes/Admin-Konten (Research Open
 * Question 1, explizit out of scope). Der Eigentümer selbst ist über diesen Weg schreibgeschützt
 * (Besitzübertragung ist nicht im Umfang dieser Phase, s. UI-SPEC).
 */
export function setRolleFuerNutzer(db: Db, deskId: string, userId: string, rolle: string): void {
  if (!ALLE_ROLLEN.includes(rolle as Rolle)) throw new UngueltigeRolleError(`Unbekannte Rolle: ${rolle}`);
  const nutzerExistiert = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!nutzerExistiert) throw new UnbekannterNutzerError(`Unbekannter Nutzer: ${userId}`);
  const owner = getDeskOwner(db, deskId);
  if (owner !== null && owner === userId) {
    throw new UngueltigeRolleError('Die Rolle des Eigentümers kann nicht geändert werden.');
  }
  db.prepare(
    'INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?) '
    + 'ON CONFLICT (desk_id, user_id) DO UPDATE SET rolle = excluded.rolle',
  ).run(deskId, userId, rolle);
}

/** Wie setRolleFuerNutzer, aber per Nutzername (POST /members-Route: der Aufrufer kennt nur
 *  den Namen, nicht die interne userId) — wirft UnbekannterNutzerError bei unbekanntem Namen.
 *  Liefert die userId des betroffenen Nutzers (WR-01: die Route braucht sie, um offene
 *  WS-Sockets des Nutzers über die neue Rolle zu informieren). */
export function setRolle(db: Db, deskId: string, username: string, rolle: string): string {
  const nutzer = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | undefined;
  if (!nutzer) throw new UnbekannterNutzerError(`Unbekannter Nutzer: ${username}`);
  setRolleFuerNutzer(db, deskId, nutzer.id, rolle);
  return nutzer.id;
}

/** Entfernt die Mitgliedschaft eines Nutzers (nicht des Eigentümers) an einem Desk. */
export function removeRolle(db: Db, deskId: string, userId: string): void {
  const owner = getDeskOwner(db, deskId);
  if (owner !== null && owner === userId) {
    throw new UngueltigeRolleError('Der Eigentümer kann nicht entfernt werden.');
  }
  db.prepare('DELETE FROM desk_roles WHERE desk_id = ? AND user_id = ?').run(deskId, userId);
}

export function putDeskState(
  db: Db,
  deskId: string,
  state: unknown,
  journal?: { type: 'stateReplaced' | 'caseSync'; actor: Actor },
): DeskState {
  if (!isValidState(state)) throw new InvalidStateError('Ungültiger Schreibtisch-Zustand');
  const txn = db.transaction((): DeskState => {
    const row = db.prepare('SELECT state, rev FROM desks WHERE id = ?').get(deskId) as
      | { state: string; rev: number }
      | undefined;
    if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    const rev = row.rev + 1;
    // SEARCH-01/04 (07-01): zweite Aufrufstelle — die erste steht in applyDeskCommand() oben.
    // Dieser Pfad (j-lawyer-Abgleich/Import) ersetzt den GESAMTEN State auf einen Schlag statt
    // per Diff eines einzelnen Commands, braucht deshalb den VORHERIGEN State (bislang nur rev
    // gelesen) für denselben Referenzvergleich wie syncSearchIndex ihn überall sonst nutzt.
    const vorher = JSON.parse(row.state) as DesktopState;
    syncSearchIndex(db, deskId, vorher, state as DesktopState);
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(state), rev, deskId);
    if (journal) {
      appendJournal(db, {
        deskId,
        rev,
        type: journal.type,
        payload: { state },
        actorId: journal.actor.id,
        actorName: journal.actor.name,
      });
    }
    // D-09: identischer Trigger wie in applyDeskCommand — ohne diese Stelle bliebe der
    // j-lawyer-Abgleich-/Import-Pfad ohne Snapshot-Beschleunigung.
    vielleichtSnapshot(db, deskId, rev, state as DesktopState);
    return { rev, state };
  });
  return txn();
}
