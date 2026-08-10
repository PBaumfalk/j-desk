import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { istObjektSichtbarFuer, type DesktopState, type Rolle } from '@j-desk/core';
import type { Db } from './db';
import type { Actor } from './deskStore';
import { broadcast } from './broadcast';

/**
 * Inbox-Register (NOTIF-01, 13-01): Benachrichtigungen als eigene Server-Tabelle statt
 * Journal-Ableitung (Vorentscheidung U1) — das command_journal ist Eigentümer/Bearbeiter-
 * gegatet, desk-scoped und kennt keinen Gelesen-Stand; Kommentatoren und Nur-Lesen-Nutzer
 * bekämen über eine Ableitung strukturell leere Inboxen. Gelesen-Stand ist `read_at` je
 * Zeile (Nutzerhoheit: alle SELECTs/UPDATEs mit WHERE user_id = req.userId, ASVS V4 —
 * bewusst KEIN Desk-Rollen-Shortcut und kein Eintrag in guards/LOESCH_COMMANDS).
 *
 * Das WS-Signal 'benachrichtigungenGeaendert' ist INHALTSFREI (kein Zähler, kein Payload —
 * T-13-01-01): projiziertFuerEmpfaenger projiziert nur state-Felder, jede Nutzlast ginge
 * unprojiziert an alle Sockets des Desk-Rooms (Bugklasse aec4f58/fcda808). Präzedenz:
 * 'vorschlaegeGeaendert' in proposals.ts. Der Client lädt die eigene Liste per GET nach.
 */
export const BENACHRICHTIGUNG_SIGNAL = { event: 'benachrichtigungenGeaendert' } as const;

/** Höchstzahl ausgelieferter Zeilen pro GET (Lärm-/DoS-Bremse, T-13-01-05). */
const LISTE_MAX = 200;
/** Andeutungs-Bremse: der Titel-Auszug in einer Erwähnungs-Zeile ist gekappt (kein Volltext). */
const TITEL_MAX = 60;
/** Erwähnungs-Syntax (linearer Zeichenklassen-Match, keine ReDoS-Fläche — T-13-01-05). */
const ERWAEHNUNG = /@([A-Za-zÄÖÜäöüß0-9._-]+)/g;

export interface Benachrichtigung {
  id: string;
  user_id: string;
  desk_id: string | null;
  art: string;
  payload: Record<string, unknown>;
  created_at: number;
  read_at: number | null;
}

interface RohZeile {
  id: string;
  user_id: string;
  desk_id: string | null;
  art: string;
  payload: string;
  created_at: number;
  read_at: number | null;
}

function alsBenachrichtigung(r: RohZeile): Benachrichtigung {
  return { ...r, payload: JSON.parse(r.payload) as Record<string, unknown> };
}

/** Eine Zeile ins Register schreiben (Empfänger-, nicht Auslöser-perspektivisch). */
export function schreibeBenachrichtigung(
  db: Db,
  e: { userId: string; deskId: string | null; art: string; payload: Record<string, unknown> },
): void {
  db.prepare(
    'INSERT INTO benachrichtigungen (id, user_id, desk_id, art, payload, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).run(randomUUID(), e.userId, e.deskId, e.art, JSON.stringify(e.payload), Date.now());
}

/** Eigene Zeilen eines Nutzers, neueste zuerst (strikt user-scoped — Nutzerhoheit). */
export function listBenachrichtigungen(db: Db, userId: string): Benachrichtigung[] {
  const zeilen = db.prepare(
    'SELECT id, user_id, desk_id, art, payload, created_at, read_at FROM benachrichtigungen WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(userId, LISTE_MAX) as RohZeile[];
  return zeilen.map(alsBenachrichtigung);
}

/** Einzelne Zeile als gelesen markieren — nur eigene (liefert false bei fremder/unbekannter id). */
export function markiereGelesen(db: Db, userId: string, id: string): boolean {
  const res = db.prepare('UPDATE benachrichtigungen SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
    .run(Date.now(), id, userId);
  return res.changes > 0;
}

/** Alle eigenen Zeilen als gelesen markieren (zustandsbezogen, online-only — siehe Client). */
export function markiereAlleGelesen(db: Db, userId: string): void {
  db.prepare('UPDATE benachrichtigungen SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), userId);
}

/**
 * Erwähnungs-Auslöser (U2): erkennt „@username" in addNote-/editNote-Nutzlasten und
 * schreibt je erkanntem Desk-Mitglied (≠ Auslöser) eine 'erwaehnung'-Zeile. Läuft
 * ausschließlich aus applyDeskCommand heraus — der einzige Pfad, durch den Browser, MCP
 * und Offline-Nachspielen gehen.
 *
 * Vertraulichkeits-Regel (U1, fail-closed): die Zeile entsteht NUR, wenn die Notiz für
 * den Empfänger sichtbar ist (istObjektSichtbarFuer) — eine Erwähnung in einer fremden
 * Privat-Notiz erzeugt gar keine Zeile; ein Fehler in der Sichtprüfung gilt als „nicht
 * sichtbar". Dedupe: dieselbe Notiz-id + derselbe Empfänger + dieselbe art erzeugt keine
 * zweite Zeile (deckt A1 „gleicher Textstand" ab und hält zusätzlich den Lärm-Regel-Fall
 * „Name bleibt, Text ändert sich" still; die Erst-Zeile trägt ihren textStand im Payload).
 */
export function verarbeiteErwaehnungen(
  db: Db,
  deskId: string,
  cmd: { type: string; payload?: unknown },
  neuerState: DesktopState,
  actor?: Actor,
): void {
  if (cmd.type !== 'addNote' && cmd.type !== 'editNote') return;
  const p = (cmd.payload ?? {}) as { id?: unknown; text?: unknown };
  const text = typeof p.text === 'string' ? p.text : '';
  const treffer = new Set([...text.matchAll(ERWAEHNUNG)].map((m) => m[1].toLocaleLowerCase('de')));
  if (treffer.size === 0 || typeof p.id !== 'string') return;
  const notizId = p.id;
  const notiz = (neuerState.notes ?? []).find((n) => n.id === notizId);
  if (!notiz) return;

  const mitglieder = db.prepare(
    `SELECT dr.user_id AS userId, u.username AS username, dr.rolle AS rolle
     FROM desk_roles dr JOIN users u ON u.id = dr.user_id WHERE dr.desk_id = ?`,
  ).all(deskId) as { userId: string; username: string; rolle: Rolle }[];

  const dedupe = db.prepare(
    `SELECT 1 FROM benachrichtigungen
     WHERE desk_id = ? AND art = 'erwaehnung' AND user_id = ? AND json_extract(payload, '$.notizId') = ?`,
  );

  let geschrieben = 0;
  for (const m of mitglieder) {
    if (actor?.id && m.userId === actor.id) continue; // keine Selbst-Benachrichtigung
    if (!treffer.has(m.username.toLocaleLowerCase('de'))) continue;
    // Sichtprüfung fail-closed: jeder Fehler gilt als „nicht sichtbar" → keine Zeile.
    let sichtbar = false;
    try {
      sichtbar = istObjektSichtbarFuer(notiz.layerId, { userId: m.userId, rolle: m.rolle }, neuerState.layers);
    } catch {
      sichtbar = false;
    }
    if (!sichtbar) continue;
    if (dedupe.get(deskId, m.userId, notizId)) continue;
    schreibeBenachrichtigung(db, {
      userId: m.userId,
      deskId,
      art: 'erwaehnung',
      payload: {
        notizId,
        notizTitel: notiz.text.slice(0, TITEL_MAX),
        vonName: actor?.name ?? 'unbekannt',
        textStand: notiz.text,
      },
    });
    geschrieben += 1;
  }
  // Inhaltsfrei — der Empfänger-Kreis bleibt dem user-scoped GET überlassen (T-13-01-01).
  if (geschrieben > 0) broadcast(deskId, BENACHRICHTIGUNG_SIGNAL);
}

/**
 * Aufgaben-Auslöser (13-04, TASK-01 × NOTIF-01): setTaskAssignee (Variante 'zuweisung')
 * und setTaskStatus (Variante 'status', Vorentscheidung O2, 13-RESEARCH.md Open Question 2).
 * `assignee` ist Freitext (legalObjects.ts:61, Kommentar an setTaskAssignee) — der
 * Empfänger-Match läuft EXAKT wie die Erwähnungs-Erkennung (U2, lowercase-de) gegen die
 * Usernamen der Desk-Mitglieder; ein assignee ohne Desk-Mitgliedschaft findet keinen
 * Empfänger (kein Verzeichnis außerhalb der Mitglieder).
 *
 * O2-Operationalisierung: der Empfänger einer Statuszeile ist NICHT aus dem Kommando
 * selbst ableitbar (setTaskStatus trägt keinen "wer hat zugewiesen"-Wert und ein
 * Journal-Rückgriff wäre eine zweite Schreibmaschinerie) — darum gilt: Empfänger = der
 * assignee-Wert der Aufgabe UNMITTELBAR VOR diesem Kommando (vorherState), sofern
 * dieser sich per Username-Match auflösen lässt und ≠ Ausführender ist. Fachliche
 * Abnahme dieser Operationalisierung: UAT (13-04-PLAN.md Planner-Annahmen).
 *
 * Dedupe (Präzedenz 13-01, verarbeiteErwaehnungen): je (aufgabeId, user_id, variante)
 * genau eine Zeile — ohne weiteren Stand-Vergleich. Bekannte Grenze wie bei Erwähnungen:
 * eine erneute (identische) Zuweisung bzw. ein weiterer Statuswechsel an denselben
 * Empfänger benachrichtigt nicht ein zweites Mal — Lärm-Regel-konform, dokumentierte
 * Vereinfachung statt einer zweiten Dedupe-Dimension.
 */
export function verarbeiteAufgabenAusloeser(
  db: Db,
  deskId: string,
  cmd: { type: string; payload?: unknown },
  vorherState: DesktopState,
  neuerState: DesktopState,
  actor?: Actor,
): void {
  if (cmd.type !== 'setTaskAssignee' && cmd.type !== 'setTaskStatus') return;
  const p = (cmd.payload ?? {}) as { id?: unknown; assignee?: unknown; status?: unknown };
  if (typeof p.id !== 'string') return;
  const aufgabeId = p.id;

  const mitglieder = db.prepare(
    `SELECT dr.user_id AS userId, u.username AS username, dr.rolle AS rolle
     FROM desk_roles dr JOIN users u ON u.id = dr.user_id WHERE dr.desk_id = ?`,
  ).all(deskId) as { userId: string; username: string; rolle: Rolle }[];

  function empfaengerAusFreitext(freitext: string): { userId: string; username: string; rolle: Rolle } | undefined {
    const gesucht = freitext.trim().toLocaleLowerCase('de');
    if (gesucht === '') return undefined;
    return mitglieder.find((m) => m.username.toLocaleLowerCase('de') === gesucht);
  }

  const dedupe = db.prepare(
    `SELECT 1 FROM benachrichtigungen
     WHERE desk_id = ? AND art = 'aufgabe' AND user_id = ?
     AND json_extract(payload, '$.aufgabeId') = ? AND json_extract(payload, '$.variante') = ?`,
  );

  function schreibeAufgabenZeile(
    empfaenger: { userId: string; rolle: Rolle },
    variante: 'zuweisung' | 'status',
    zusatz: Record<string, unknown>,
  ): void {
    if (actor?.id && empfaenger.userId === actor.id) return; // Selbst-Zuweisung/-Statuswechsel ist still
    const aufgabe = (neuerState.legalObjects ?? []).find((o) => o.id === aufgabeId && o.kind === 'aufgabe');
    if (!aufgabe) return;
    // Sichtprüfung fail-closed: jeder Fehler gilt als „nicht sichtbar" → keine Zeile.
    let sichtbar = false;
    try {
      sichtbar = istObjektSichtbarFuer(aufgabe.layerId, { userId: empfaenger.userId, rolle: empfaenger.rolle }, neuerState.layers);
    } catch {
      sichtbar = false;
    }
    if (!sichtbar) return;
    if (dedupe.get(deskId, empfaenger.userId, aufgabeId, variante)) return;
    schreibeBenachrichtigung(db, {
      userId: empfaenger.userId, deskId, art: 'aufgabe',
      payload: { aufgabeId, titel: aufgabe.text, variante, ...zusatz },
    });
    broadcast(deskId, BENACHRICHTIGUNG_SIGNAL);
  }

  if (cmd.type === 'setTaskAssignee') {
    if (typeof p.assignee !== 'string') return;
    const empfaenger = empfaengerAusFreitext(p.assignee);
    if (!empfaenger) return;
    const aufgabe = (neuerState.legalObjects ?? []).find((o) => o.id === aufgabeId && o.kind === 'aufgabe');
    schreibeAufgabenZeile(empfaenger, 'zuweisung', {
      vonName: actor?.name ?? 'unbekannt',
      ...(aufgabe?.dueDate !== undefined ? { faellig: aufgabe.dueDate } : {}),
    });
    return;
  }

  // setTaskStatus — O2: Empfänger ist der VOR dem Kommando zugewiesene Nutzer.
  if (typeof p.status !== 'string') return;
  const vorherigeAufgabe = (vorherState.legalObjects ?? []).find((o) => o.id === aufgabeId && o.kind === 'aufgabe');
  const vorherigerAssignee = vorherigeAufgabe?.assignee;
  if (typeof vorherigerAssignee !== 'string') return;
  const empfaenger = empfaengerAusFreitext(vorherigerAssignee);
  if (!empfaenger) return;
  schreibeAufgabenZeile(empfaenger, 'status', { status: p.status });
}

/**
 * Geteilt-Auslöser (O3, Vorentscheidung, 13-RESEARCH.md Open Question 3): AUSSCHLIESSLICH
 * der POST-Handler für neue Mitgliedschaften ruft dies auf — PUT (Rollenwechsel) und
 * DELETE (Entzug) bleiben bewusst still (Lärm-Regel). Keine Sichtprüfung nötig: der Desk
 * wurde dem Empfänger gerade geteilt, er hat per Definition Zugriff (anders als
 * Erwähnung/Aufgabe/Sync, wo ein ANDERES Objekt sichtbar sein muss). Kein Dedupe: jede
 * POST-Zuteilung ist eine eigenständige Handlung des Eigentümers, O3 begrenzt die Lärm-
 * Fläche bereits auf genau diesen einen Aufruf.
 */
export function verarbeiteGeteiltAusloeser(
  db: Db,
  deskId: string,
  deskName: string,
  userId: string,
  rolle: string,
  actor?: Actor,
): void {
  if (actor?.id && userId === actor.id) return; // defensiv: setRolleFuerNutzer schützt den Eigentümer bereits vor sich selbst
  schreibeBenachrichtigung(db, {
    userId, deskId, art: 'geteilt',
    payload: { deskId, deskName, rolle, vonName: actor?.name ?? 'unbekannt' },
  });
  broadcast(deskId, BENACHRICHTIGUNG_SIGNAL);
}

/**
 * Sync-Auslöser (13-04): AUSSCHLIESSLICH der j-lawyer-Abgleich (app.ts::syncCaseDesk)
 * sammelt echte Übergangs-Ereignisse (KEINE Zustands-Differenz im Nachhinein — nur
 * Transitionen, die der Abgleich SELBST erkannt hat) und ruft dies NACH dem Persistieren
 * des abgeglichenen States auf. 'ersetzt' feuert NUR, wenn das Dokument mindestens eine
 * Annotation trägt (A5, NOTIF-01-Wortlaut „ersetzte annotierte Dokumente") — 'quelle'
 * (sourceGone) kennt diese Bremse nicht (die Quelle ist unabhängig von Annotationen
 * verloren). Empfängerkreis wie bei Erwähnung/Aufgabe: alle Desk-Mitglieder mit
 * Sichtrecht (fail-closed), INKLUSIVE des auslösenden Nutzers selbst — die Änderung
 * kommt von außen (j-lawyer), nicht von ihm (Planner-Annahme, Abnahme im UAT).
 *
 * Dedupe (Präzedenz wie oben): je (art, dokumentId, user_id) genau eine Zeile — bekannte
 * Grenze: eine zweite echte Ersetzung/ein zweites Verschwinden desselben Dokuments
 * benachrichtigt nicht erneut (Lärm-Regel-konform, dokumentierte Vereinfachung). Ein
 * wiederholter Abgleich OHNE neue Transition ruft diese Funktion ohnehin nie mit
 * derselben dokumentId auf — `transitionen` enthält ausschließlich frisch erkannte
 * Übergänge aus GENAU diesem Abgleichsdurchlauf.
 */
export function verarbeiteSyncAusloeser(
  db: Db,
  deskId: string,
  transitionen: { art: 'ersetzt' | 'quelle'; dokumentId: string }[],
  neuerState: DesktopState,
): void {
  if (transitionen.length === 0) return;
  const mitglieder = db.prepare(
    `SELECT dr.user_id AS userId, u.username AS username, dr.rolle AS rolle
     FROM desk_roles dr JOIN users u ON u.id = dr.user_id WHERE dr.desk_id = ?`,
  ).all(deskId) as { userId: string; username: string; rolle: Rolle }[];

  const dedupe = db.prepare(
    `SELECT 1 FROM benachrichtigungen
     WHERE desk_id = ? AND art = ? AND user_id = ? AND json_extract(payload, '$.dokumentId') = ?`,
  );

  // Annotations-Mengenprüfung (A5): marks/strokes/stamps/flags referenzieren docId direkt;
  // Cutouts referenzieren die Quelldatei über fileId statt docId (Ausschnitte überleben das
  // Entfernen der Karte — jump.ts-Kopfkommentar), darum hier über doc.fileId geprüft.
  const hatAnnotationen = (doc: { id: string; fileId: string }): boolean =>
    (neuerState.marks ?? []).some((m) => m.docId === doc.id)
    || (neuerState.strokes ?? []).some((st) => st.docId === doc.id)
    || (neuerState.stamps ?? []).some((st) => st.docId === doc.id)
    || (neuerState.flags ?? []).some((f) => f.docId === doc.id)
    || (neuerState.cutouts ?? []).some((c) => c.fileId === doc.fileId);

  let geschrieben = 0;
  for (const t of transitionen) {
    const dok = neuerState.docs.find((d) => d.id === t.dokumentId);
    if (!dok) continue;
    if (t.art === 'ersetzt' && !hatAnnotationen(dok)) continue; // A5-Lärmbremse
    for (const m of mitglieder) {
      let sichtbar = false;
      try {
        sichtbar = istObjektSichtbarFuer(dok.layerId, { userId: m.userId, rolle: m.rolle }, neuerState.layers);
      } catch {
        sichtbar = false;
      }
      if (!sichtbar) continue;
      if (dedupe.get(deskId, t.art, m.userId, t.dokumentId)) continue;
      schreibeBenachrichtigung(db, {
        userId: m.userId, deskId, art: t.art,
        payload: { dokumentId: t.dokumentId, dokumentName: dok.name },
      });
      geschrieben += 1;
    }
  }
  if (geschrieben > 0) broadcast(deskId, BENACHRICHTIGUNG_SIGNAL);
}

/**
 * REST-Fläche des Registers: drei Routen, alle strikt user-scoped (req.userId aus dem
 * Auth-Hook; Auth allein reicht, es gibt keinen Desk-Kontext an diesen Pfaden). Bewusst
 * KEIN requireDeskRolle/requireDeskAktion-Guard — Nutzerhoheit über die eigene Inbox
 * (ASVS V4). Fremde Zeilen-ids liefern 404: fail-closed ohne Existenz-Auskunft
 * (T-13-01-03, dokumentierte Wahl gegenüber 403).
 */
export function registerBenachrichtigungen(app: FastifyInstance, db: Db): void {
  app.get('/api/v1/benachrichtigungen', async (req) => {
    const userId = (req as FastifyRequest & { userId: string }).userId;
    return { benachrichtigungen: listBenachrichtigungen(db, userId) };
  });

  app.post('/api/v1/benachrichtigungen/:id/gelesen', async (req, reply) => {
    const userId = (req as FastifyRequest & { userId: string }).userId;
    const { id } = req.params as { id: string };
    if (!markiereGelesen(db, userId, id)) {
      return reply.code(404).send({ error: 'Benachrichtigung nicht gefunden' });
    }
    return { ok: true };
  });

  app.post('/api/v1/benachrichtigungen/alle-gelesen', async (req) => {
    const userId = (req as FastifyRequest & { userId: string }).userId;
    markiereAlleGelesen(db, userId);
    return { ok: true };
  });
}
