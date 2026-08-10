import {
  findeObjekt, istObjektSichtbarFuer, objektIdFuerCommand, projectStateForActor, INHALT_OBJEKT_ID,
  ZUSTANDS_TRAGENDE_JOURNAL_TYPEN,
  type ActorContext, type DesktopState, type Vorschlag,
} from '@j-desk/core';
import type { Db } from './db';
import { ruecknahmeErlaubt } from './vorschlagSichtbarkeit';

/** Typen mit vollem State-Payload — im listJournal-Ergebnis wird `state` mit Betrachter-Kontext
 *  projiziert (PERM-05), ohne Kontext weiterhin auf '…' gekürzt (Bestandsverhalten/fail-closed).
 *  Abgeleitet aus der Core-Wahrheit (04-01): `stateRestored` ist damit automatisch mit erfasst,
 *  ohne die Menge hier ein zweites Mal literal zu pflegen. */
const STATE_TRAGENDE_TYPEN: ReadonlySet<string> = ZUSTANDS_TRAGENDE_JOURNAL_TYPEN;

/**
 * CR-02: die Doppelstempel-Marker der KI-Vertrauensschicht. Ihre Nutzlast ist seit CR-02
 * INHALTSFREI (nur Metadaten: vorschlagId, art, kiAkteur, approvedBy) — der Auslieferungspfad
 * bereinigt sie zusätzlich beim LESEN (s. listJournal unten): Alt-Zeilen aus der Zeit vor dem
 * Fix tragen noch `zusammenfassung` mit bis zu 120 Zeichen deanonymisiertem Klartext
 * (z. B. „Notiz-Text ersetzen: …"), und der Projektionsfilter (INHALT_OBJEKT_ID) kennt die
 * Marker-Typen nicht — ohne die Lese-Bereinigung gingen die Alt-Schnipsel ungefiltert an alle
 * manage-Berechtigten (Vertraulichkeits-Bugklasse aec4f58/fcda808). Byte-genau generisch:
 * die ausgelieferte Zeile ist reine Funktion der Metadaten, nie des Register-Inhalts.
 */
const INHALTSFREIE_MARKER_TYPEN: ReadonlySet<string> = new Set(['vorschlagGenehmigt', 'vorschlagZurueckgenommen']);

/**
 * CR-03: die Sichtprüfung gilt generisch für ALLE Command-Typen mit Objekt-Bezug
 * (INHALT_OBJEKT_ID, @j-desk/core/objektbezug) — nicht mehr nur für addCutout/moveCutout/
 * addMark. Kriterium unverändert (Pitfall 2, T-02-04): der Payload trägt sensible Objektfelder
 * (Text, textSnapshot, Position oder Ersteller) eines möglicherweise privaten Objekts — das
 * trifft addNote/editNote (kompletter Zettel-Text), addFlag (label), addStamp (text),
 * addStroke (Punkte), die move-Commands, setLinkNote u. a. genauso. Geprüft wird der CURRENT
 * Sichtbarkeitsstatus (das Objekt kann NACH dem Command privat gestellt worden sein — die
 * historische Journal-Zeile muss dem folgen). Lösch-/Korb-Lifecycle-Commands stehen bewusst
 * nicht in INHALT_OBJEKT_ID (s. objektbezug.ts) — ihre inhaltsleeren Einträge blieben sonst
 * für NIEMANDEN mehr sichtbar.
 */

/** Neuer Journal-Eintrag (vor der Persistierung); `at` default `Date.now()`. */
export interface JournalEintrag {
  deskId: string;
  rev: number;
  type: string;
  payload?: unknown;
  actorId?: string | null;
  actorName: string;
  at?: number;
}

/** Gelesener Journal-Eintrag; `payload` bereits JSON-geparst (Snapshot-`state` bei Bedarf projiziert/gekürzt). */
export interface JournalZeile {
  id: number;
  rev: number;
  type: string;
  payload: unknown;
  actorId: string | null;
  actorName: string;
  at: number;
}

/** Alle SNAPSHOT_INTERVAL Zustandsänderungen entsteht automatisch ein Snapshot (D-09) — der
 *  Hebel, der `restoreDeskTo` bei jeder Wiederherstellung auf höchstens diese Zahl an Journal-
 *  Zeilen deckelt (D-11/D-12), unabhängig davon, wie lang das Journal insgesamt ist.
 *
 *  WR-01 (04-04): dieser Deckel gilt exakt für ein Journal aus ausschließlich `rev`-erhöhenden
 *  Zeilen (Commands, `stateRestored`, `snapshot` selbst). Nebenwirkungsfreie Zeilen wie
 *  `exported` (HIST-04, s. `NEBENWIRKUNGSFREIE_JOURNAL_TYPEN` in `@j-desk/core`) verbrauchen
 *  bewusst keinen `rev` und lösen deshalb auch keinen automatischen Snapshot aus — der
 *  tatsächlich pro Wiederherstellung gelesene Zeilenbereich kann in einem Desk mit vielen
 *  Exports zwischen zwei Commands entsprechend größer als `SNAPSHOT_INTERVAL` ausfallen. Der
 *  Deckel ist also ein Best-Effort-Bound für rein command-getriebene Journale, kein hartes
 *  Limit über jede mögliche Journal-Zusammensetzung. */
export const SNAPSHOT_INTERVAL = 200;

/**
 * Schreibt bei jedem SNAPSHOT_INTERVAL-ten `rev` eine zusätzliche `snapshot`-Zeile mit dem
 * VOLLSTÄNDIGEN, bereits geschriebenen Zustand (P-04: der Aufrufer garantiert per Aufrufreihenfolge,
 * dass `state` schon persistiert ist — dieser Aufruf friert also nie eine noch nicht geschriebene
 * Zukunft ein). `actorId: null` + Systemkennung 'System' folgt dem Bestandsmuster des Migrations-
 * Baseline-Snapshots (db.ts): ein automatischer Snapshot ist keine Nutzeraktion.
 */
export function vielleichtSnapshot(db: Db, deskId: string, rev: number, state: DesktopState): void {
  if (rev % SNAPSHOT_INTERVAL !== 0) return;
  appendJournal(db, { deskId, rev, type: 'snapshot', payload: { state }, actorId: null, actorName: 'System' });
}

/** Journal-Eintrag anhängen (Command-Anwendung, Systemereignis oder Baseline-Snapshot). */
export function appendJournal(db: Db, e: JournalEintrag): void {
  db.prepare(
    'INSERT INTO command_journal (desk_id, rev, type, payload, actor_id, actor_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    e.deskId,
    e.rev,
    e.type,
    e.payload === undefined ? null : JSON.stringify(e.payload),
    e.actorId ?? null,
    e.actorName,
    e.at ?? Date.now(),
  );
}

/**
 * Prüft, ob das über `objectId` referenzierte Objekt (aktueller State, nicht historischer
 * Zustand zum Zeitpunkt des Commands) für `ctx` sichtbar ist. Fail-closed: fehlt `state`,
 * fehlt `objectId`, oder ist das Objekt weder im Live-State noch im Papierkorb nachweisbar
 * (z. B. endgültig geschreddert) — als NICHT sichtbar behandelt, da wir seine (ggf.
 * private) Herkunft dann nicht mehr nachweisen können.
 *
 * WR-01: der Papierkorb ist ein BESTIMMBARER Zustand, kein Unbekannter — `trashObject()`
 * legt Vollkopien inklusive layerId in den Korb-Payloads ab (trash.ts). Ohne diesen Zweig
 * fiel die gesamte Vorgeschichte jedes weggeworfenen Objekts (addNote/editNote/…)
 * fail-closed aus der Historie ALLER Betrachter — auch bei vollständig öffentlichen
 * Objekten und auch für den Desk-Eigentümer (empirisch nachgewiesene Regression des
 * CR-03-Fixes). Das CR-03-Leck bleibt geschlossen: die Korb-Kopie trägt dieselbe layerId,
 * eine privat gestellte Notiz bleibt für Nicht-Eigentümer der Ebene auch im Korb
 * unsichtbar.
 */
function referenziertesObjektSichtbar(state: DesktopState | undefined, objectId: string | undefined, ctx: ActorContext): boolean {
  if (!state || !objectId) return false;
  const treffer = findeObjekt(state, objectId);
  if (treffer) {
    const layerId = (treffer.obj as { layerId?: string }).layerId;
    return istObjektSichtbarFuer(layerId, ctx, state.layers);
  }
  for (const t of state.trash ?? []) {
    for (const liste of Object.values(t.payload)) {
      const kopie = (liste as { id: string; layerId?: string }[]).find((o) => o.id === objectId);
      if (kopie) return istObjektSichtbarFuer(kopie.layerId, ctx, state.layers);
    }
  }
  return false; // endgültig vernichtet (geschreddert/geleert) oder unbekannt bleibt fail-closed
}

/** Journal-Historie eines Schreibtischs, neueste zuerst; Keyset-Pagination über `before` (id < before).
 *  `ctx` + `state` (aktueller Desk-Zustand): ohne beide bleibt das Bestandsverhalten unangetastet
 *  (state-tragende Payloads auf '…' gekürzt, sensible Payload-Felder ungefiltert — z. B. für
 *  interne/systemseitige Aufrufer ohne Betrachter-Kontext). */
export function listJournal(
  db: Db,
  deskId: string,
  opts?: { limit?: number; before?: number; ctx?: ActorContext; state?: DesktopState },
): JournalZeile[] {
  // Nach unten auf 0 klemmen: SQLite interpretiert ein negatives LIMIT als "kein Limit"
  // und würde die 200er-Kappung sonst umgehen. Math.floor: better-sqlite3 bindet Fließkommazahlen
  // nicht an LIMIT/id-Vergleiche (SqliteError "datatype mismatch") — Ganzzahl schützt alle Aufrufer.
  const limit = Math.floor(Math.min(Math.max(opts?.limit ?? 50, 0), 200));
  const before = opts?.before !== undefined ? Math.floor(opts.before) : undefined;
  const rows = (
    before !== undefined
      ? db
          .prepare(
            'SELECT id, rev, type, payload, actor_id AS actorId, actor_name AS actorName, at FROM command_journal WHERE desk_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
          )
          .all(deskId, before, limit)
      : db
          .prepare(
            'SELECT id, rev, type, payload, actor_id AS actorId, actor_name AS actorName, at FROM command_journal WHERE desk_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(deskId, limit)
  ) as { id: number; rev: number; type: string; payload: string | null; actorId: string | null; actorName: string; at: number }[];

  const ctx = opts?.ctx;
  const zeilen = rows.map((row): JournalZeile | null => {
    const payload = row.payload === null ? null : (JSON.parse(row.payload) as unknown);

    if (STATE_TRAGENDE_TYPEN.has(row.type) && payload && typeof payload === 'object' && 'state' in payload) {
      const payloadObj = payload as Record<string, unknown>;
      payloadObj.state = ctx ? projectStateForActor(payloadObj.state as DesktopState, ctx) : '…';
    } else if (ctx && payload && typeof payload === 'object' && row.type in INHALT_OBJEKT_ID) {
      const objectId = objektIdFuerCommand({ type: row.type, payload: payload as Record<string, unknown> });
      if (!referenziertesObjektSichtbar(opts?.state, objectId, ctx)) {
        return null; // Eintrag ausgelassen (Pitfall 2) — Sichtrecht auf das referenzierte Objekt fehlt
      }
    }

    // CR-02: Marker-Nutzlasten sind inhaltsfrei — Alt-Zeilen (vor dem Fix geschrieben) werden
    // beim Lesen bereinigt, damit kein Alt-Schnipsel (zusammenfassung mit Klartext) je wieder
    // den Auslieferungspfad passiert. Wirkt mit UND ohne Betrachter-Kontext: der Inhalt ist
    // für NIEMANDEN mehr über die Historie erreichbar (die Registerzeile bleibt die
    // projizierte Einsichtsstelle).
    if (INHALTSFREIE_MARKER_TYPEN.has(row.type) && payload && typeof payload === 'object' && 'zusammenfassung' in payload) {
      delete (payload as Record<string, unknown>).zusammenfassung;
    }

    // WR-01 (It. 2): pro Empfänger berechnetes Auslieferungs-Flag 'zuruecknehmenErlaubt' am
    // vorschlagGenehmigt-Marker — die Client-Zeilenaktion „Zurücknehmen" (ActivityOverlay)
    // blendet sich aus, wenn DIESELBE Rechtepositions-Regel wie an der zuruecknehmen-Route
    // verweigern würde (PERM-04-Ausblendemuster: Komfort, keine Sicherheitsgrenze — der
    // generische 403 der Route bleibt die Wahrheit). Berechnung über das geteilte Modul
    // vorschlagSichtbarkeit.ts, damit Grenze und Komfort nie auseinanderlaufen. Fehlt die
    // Registerzeile (Datenfehler), gilt fail-closed false — die Route antwortete ohnehin 404.
    // Ohne Betrachter-Kontext/State (interne Aufrufer) bleibt das Flag ungesetzt.
    if (row.type === 'vorschlagGenehmigt' && ctx && opts?.state && payload && typeof payload === 'object') {
      const vorschlagId = (payload as Record<string, unknown>).vorschlagId;
      const zeile = typeof vorschlagId === 'string'
        ? db.prepare(
            'SELECT decided_by_id AS decidedById, genehmigte_objekte AS genehmigteObjekte '
            + 'FROM vorschlaege WHERE desk_id = ? AND id = ?',
          ).get(deskId, vorschlagId) as { decidedById: string | null; genehmigteObjekte: string | null } | undefined
        : undefined;
      (payload as Record<string, unknown>).zuruecknehmenErlaubt = zeile !== undefined
        && ruecknahmeErlaubt({
          ...(zeile.decidedById !== null ? { decidedById: zeile.decidedById } : {}),
          genehmigteObjekte: zeile.genehmigteObjekte !== null
            ? JSON.parse(zeile.genehmigteObjekte) as Vorschlag['genehmigteObjekte']
            : undefined,
        }, opts.state, ctx);
    }

    return {
      id: row.id,
      rev: row.rev,
      type: row.type,
      payload,
      actorId: row.actorId,
      actorName: row.actorName,
      at: row.at,
    };
  });

  return zeilen.filter((z): z is JournalZeile => z !== null);
}

/**
 * Nächstgelegener Snapshot bis (einschließlich) `zielId` — Startpunkt der Wiederherstellung
 * (D-11): der Payload wird bewusst UNGEPARST als Roh-JSON zurückgegeben, der Aufrufer
 * (`restoreDeskTo`, `packages/server/src/restore.ts`) parst und liest ausschließlich `state`.
 */
export function nearestSnapshot(db: Db, deskId: string, zielId: number): { id: number; payload: string } | undefined {
  return db
    .prepare(
      "SELECT id, payload FROM command_journal WHERE desk_id = ? AND type = 'snapshot' AND id <= ? ORDER BY id DESC LIMIT 1",
    )
    .get(deskId, zielId) as { id: number; payload: string } | undefined;
}

/**
 * Journal-Zeilen eines Desks im Bereich `(afterId, uptoId]`, aufsteigend nach `id` — die
 * Replay-Reihenfolge für `replayJournal` (D-11). Eigene Funktion statt Zweckentfremdung von
 * `listJournal` (das ist absteigend, auf 200 gedeckelt und projiziert/kürzt state-tragende
 * Payloads — beides für den internen Replay-Pfad falsch).
 */
export function journalRange(db: Db, deskId: string, afterId: number, uptoId: number): JournalZeile[] {
  const rows = db
    .prepare(
      'SELECT id, rev, type, payload, actor_id AS actorId, actor_name AS actorName, at FROM command_journal '
      + 'WHERE desk_id = ? AND id > ? AND id <= ? ORDER BY id ASC',
    )
    .all(deskId, afterId, uptoId) as { id: number; rev: number; type: string; payload: string | null; actorId: string | null; actorName: string; at: number }[];
  return rows.map((row) => ({
    id: row.id,
    rev: row.rev,
    type: row.type,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
    actorId: row.actorId,
    actorName: row.actorName,
    at: row.at,
  }));
}
