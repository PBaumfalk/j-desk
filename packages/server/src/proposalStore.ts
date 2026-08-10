import { randomUUID } from 'node:crypto';
import { SqliteError } from 'better-sqlite3';
import {
  erstelleVorschlag as baueVorschlag, uebergang, vorschlagAnwenden, inverseFuer,
  findeObjekt, VorschlagNichtGefundenError, VorschlagStatusError,
  type Command, type DesktopState, type Quelle, type Vorschlag, type VorschlagStatus,
} from '@j-desk/core';
import type { Db } from './db';
import { DeskNotFoundError, getDeskState, type Actor } from './deskStore';
import { appendJournal } from './journal';
import type { QuellenFehler } from './quelleServer';

/**
 * SQLite-Register für KI-Vorschläge (Phase 12, AI-01/AI-02): die Tabelle `vorschlaege` liegt
 * bewusst AUSSERHALB von desks.state — ein Genehmigungsstau muss einen Server-Neustart
 * überstehen (kein In-Memory-Register), und Entwürfe können strukturell nicht in Export,
 * Replay oder Suchindex lecken (12-RESEARCH.md Pattern 1). Die Genehmigung bündelt
 * Status-Übergang, Inverse-Berechnung und Kommando-Anwendung in EINER Transaktion: schlägt
 * irgendein Schritt fehl, bleibt der Vorschlag 'ausstehend' und der Desk unberührt
 * (Inversen-Pflicht: keine persistierbare Inverse = keine Genehmigung).
 *
 * 12-03: auch die ERSTELLUNG ist eine Transaktion — die fachliche Vor-Prüfung
 * (Quellen-Verifikation aus quelleServer, als vorInsert-Callback durch die Route
 * durchgereicht) läuft VOR dem INSERT im selben Transaktionskontext: ein Ablehnungs-Fehler
 * hinterlässt garantiert keine Zeile (Pitfall 8 — kein stiller Partial Success).
 */

/** Die Vor-Prüfung des Erstellungspfads hat abgelehnt — trägt den maschinenlesbaren Fehler
 *  (grund + betroffeneQuelle als Eingabe-Spiegel) zur 422-Mapping-Naht der Route. */
export class VorschlagAbgelehntError extends Error {
  constructor(public readonly fehler: QuellenFehler) {
    super(`Vorschlag abgelehnt: ${fehler.grund}`);
    this.name = 'VorschlagAbgelehntError';
  }
}

/** Die Rechteprüfung der abgeleiteten Kommandos hat die Genehmigung verweigert (12-03,
 *  Pitfall 5) — die Message ist die deutsche Verweigerungs-Meldung aus
 *  pruefeKommandosFuerActor und geht fail-honest als 403-Body an den Genehmiger (WR-05). */
export class GenehmigungVerweigertError extends Error {
  constructor(meldung: string) {
    super(meldung);
    this.name = 'GenehmigungVerweigertError';
  }
}

/** Die Rechteprüfung der Rücknahme hat verweigert (WR-01, It. 2: der Rücknehmende ist weder
 *  Eigentümer noch Genehmiger und mindestens ein Anker-Objekt liegt auf einer für ihn
 *  unsichtbaren Ebene) — die Message ist bewusst generisch (kein Inhaltsecho, mandat_fremd-
 *  Muster) und geht als 403-Body an den Rücknehmenden. */
export class RuecknahmeVerweigertError extends Error {
  constructor(meldung: string) {
    super(meldung);
    this.name = 'RuecknahmeVerweigertError';
  }
}

/** updatedRev-Mitschnitt vs. aktueller State: mindestens ein betroffenes Objekt wurde seit
 *  der Übernahme verändert (12-04, T-12-04-01) — die Rücknahme antwortet 409 statt hart
 *  zurückzusetzen; menschliche Zwischenarbeit wird nie still überschrieben (OQ2). */
export class VorschlagGeaendertError extends Error {
  constructor() {
    super('Mindestens ein betroffenes Objekt wurde seit der Übernahme verändert. Die Rücknahme wurde nicht ausgeführt.');
    this.name = 'VorschlagGeaendertError';
  }
}

/** Eingabe aus dem REST-Body (bereits formal geprüft); die art-Fachprüfung liegt im Core. */
export interface VorschlagEingabeRest {
  art: string;
  payload: Record<string, unknown>;
  quellen?: Quelle[];
  zusammenfassung: string;
  idempotenzKey?: string;
}

interface VorschlagRow {
  id: string;
  desk_id: string;
  art: string;
  payload: string;
  quellen: string;
  zusammenfassung: string;
  status: string;
  inverse: string | null;
  genehmigte_objekte: string | null;
  idempotenz_key: string | null;
  created_by: string;
  created_by_id: string | null;
  created_at: number;
  decided_by: string | null;
  decided_by_id: string | null;
  decided_at: number | null;
}

function rowNachVorschlag(row: VorschlagRow): Vorschlag {
  return {
    id: row.id,
    deskId: row.desk_id,
    art: row.art,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    quellen: JSON.parse(row.quellen) as Quelle[],
    zusammenfassung: row.zusammenfassung,
    status: row.status as Vorschlag['status'],
    ...(row.inverse !== null ? { inverse: JSON.parse(row.inverse) as Command[] } : {}),
    ...(row.genehmigte_objekte !== null
      ? { genehmigteObjekte: JSON.parse(row.genehmigte_objekte) as { id: string; updatedRev: number }[] }
      : {}),
    ...(row.idempotenz_key !== null ? { idempotenzKey: row.idempotenz_key } : {}),
    createdBy: row.created_by,
    ...(row.created_by_id !== null ? { createdById: row.created_by_id } : {}),
    createdAt: row.created_at,
    ...(row.decided_by !== null ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_by_id !== null ? { decidedById: row.decided_by_id } : {}),
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
  };
}

function leseZeile(db: Db, deskId: string, vorschlagId: string): VorschlagRow | undefined {
  return db.prepare('SELECT * FROM vorschlaege WHERE desk_id = ? AND id = ?').get(deskId, vorschlagId) as
    VorschlagRow | undefined;
}

function lesePerIdempotenzKey(db: Db, deskId: string, createdBy: string, key: string): VorschlagRow | undefined {
  return db.prepare(
    'SELECT * FROM vorschlaege WHERE desk_id = ? AND created_by = ? AND idempotenz_key = ?',
  ).get(deskId, createdBy, key) as VorschlagRow | undefined;
}

/**
 * Legt einen Vorschlag im Register ab (status 'ausstehend') — KEIN Desk-Kommando, der
 * Desk-rev bleibt unverändert. Idempotenz (T-12-01-05): bei vorhandenem idempotenzKey wird
 * zuerst die Bestandszeile gesucht; ein im Rennen zweier gleichzeitiger Aufrufe verlierender
 * INSERT fängt die UNIQUE-Verletzung und liefert ebenfalls die Bestandszeile — ein
 * Agenten-Retry erzeugt nie ein Duplikat (und nie einen 500er). Ein Idempotenz-Treffer
 * kehrt VOR der Vor-Prüfung zurück: der ursprüngliche Insert wurde bereits geprüft, ein
 * Retry nach Erfolg darf nicht an einer zwischenzeitlich unauflösbar gewordenen Quelle
 * scheitern.
 *
 * 12-03: `vorInsert` ist die fachliche Vor-Prüfung der Route (Quellen-Verifikation über
 * pruefeQuellen, quelleServer.ts). Sie läuft in DERSELBEN Transaktion VOR dem INSERT —
 * liefert sie einen QuellenFehler, wirft die Transaktion VorschlagAbgelehntError und rollt
 * zurück: kein 422-Fall hinterlässt je eine Registerzeile (Rollback-Beweis per COUNT-Test).
 */
export function erstelleVorschlag(
  db: Db,
  deskId: string,
  eingabe: VorschlagEingabeRest,
  actor: Actor,
  vorInsert?: () => QuellenFehler | null,
): Vorschlag {
  const txn = db.transaction((): Vorschlag => {
    if (eingabe.idempotenzKey) {
      const bestehend = lesePerIdempotenzKey(db, deskId, actor.name, eingabe.idempotenzKey);
      if (bestehend) return rowNachVorschlag(bestehend);
    }
    if (vorInsert) {
      const fehler = vorInsert();
      if (fehler) throw new VorschlagAbgelehntError(fehler);
    }
    const v = baueVorschlag({
      id: randomUUID(),
      deskId,
      art: eingabe.art,
      payload: eingabe.payload,
      quellen: eingabe.quellen ?? [],
      zusammenfassung: eingabe.zusammenfassung,
      ...(eingabe.idempotenzKey !== undefined ? { idempotenzKey: eingabe.idempotenzKey } : {}),
      createdBy: actor.name,
      ...(actor.id !== null ? { createdById: actor.id } : {}),
    }, Date.now());
    try {
      db.prepare(
        `INSERT INTO vorschlaege
          (id, desk_id, art, payload, quellen, zusammenfassung, status, idempotenz_key, created_by, created_by_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        v.id, v.deskId, v.art, JSON.stringify(v.payload), JSON.stringify(v.quellen),
        v.zusammenfassung, v.status, v.idempotenzKey ?? null, v.createdBy, v.createdById ?? null, v.createdAt,
      );
    } catch (e) {
      if (eingabe.idempotenzKey && e instanceof SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const bestehend = lesePerIdempotenzKey(db, deskId, actor.name, eingabe.idempotenzKey);
        if (bestehend) return rowNachVorschlag(bestehend);
      }
      throw e;
    }
    return v;
  });
  return txn();
}

export function findeVorschlag(db: Db, deskId: string, vorschlagId: string): Vorschlag | undefined {
  const row = leseZeile(db, deskId, vorschlagId);
  return row ? rowNachVorschlag(row) : undefined;
}

/**
 * Liest die Registerliste eines Desks (12-03, GET-Listenpfad) — Default nur 'ausstehend'
 * (die Arbeitsliste der Genehmigungsanzeige; Entscheidungen sind Register-Fakt und bleiben
 * über findeVorschlag/journal einsehbar). ORDER BY created_at mit rowid-Tiebreak, damit
 * die Reihenfolge auch bei gleichem Millisekunden-Stempel stabil ist (FIFO-Prüflast).
 * Die SICHTBARKEITS-Projektion liegt bewusst NICHT hier, sondern in der Route
 * (referenzierteDocIds ∩ projiziert.docs — einzige Sichtbarkeits-Naht: projectStateForActor).
 */
export function listeVorschlaege(db: Db, deskId: string, status: VorschlagStatus = 'ausstehend'): Vorschlag[] {
  const rows = db.prepare(
    'SELECT * FROM vorschlaege WHERE desk_id = ? AND status = ? ORDER BY created_at ASC, rowid ASC',
  ).all(deskId, status) as VorschlagRow[];
  return rows.map(rowNachVorschlag);
}

/** Ergebnis des anwenden-Callbacks: neue Desk-rev + updatedRev-Mitschnitt der betroffenen Objekte. */
export interface AnwendungsErgebnis {
  rev: number;
  objekte: { id: string; updatedRev: number; korb?: boolean }[];
}

/**
 * Genehmigt einen ausstehenden Vorschlag. EINE Transaktion: (a) Zeile lesen, (b) Status-
 * Übergang (VorschlagStatusError bei nicht-ausstehend), (c) Kommandos ableiten,
 * (c2) vorAnwendung-Prüfung (12-03, Pitfall 5: die Route reicht hier die Kommando-/
 * Ebenen-Rechteprüfung mit dem GENEHMIGER als Actor durch — liefert sie eine Meldung,
 * wirft die Transaktion GenehmigungVerweigertError und rollt zurück: Status bleibt
 * 'ausstehend', keine Inverse, Desk unberührt), (d) Inverse aus dem FRISCH gelesenen
 * Desk-State berechnen — schlägt (c) oder (d) fehl, rollt alles zurück
 * (Mengenbegrenzung/Inversen-Pflicht), (e) anwenden-Callback (der Aufrufer reicht
 * applyDeskCommand pro Kommando durch und sammelt die gestempelten updatedRevs), (f) Zeile
 * mit status/inverse/genehmigte_objekte/decided_* aktualisieren, (g) Doppelstempel-Marker
 * 'vorschlagGenehmigt' in DERSELBEN Transaktion (WR-01: ein Marker-Fehler NACH dem Commit
 * hinterließe eine vollzogene Genehmigung ohne Historien-Marker — Repudiation-Lücke; die
 * Nutzlast ist seit CR-02 inhaltsfrei: vorschlagId, art, kiAkteur, approvedBy). Jeder Wurf —
 * Statusfehler, Rechteverweigerung, Inverse-Berechnung, Anwendung, Marker — lässt Register
 * UND Desk unverändert. WS-Broadcasts der angewendeten Kommandos liegen bewusst NICHT hier:
 * die Route sammelt die anwenden-Ergebnisse und broadcastet erst nach dem Commit (WR-01,
 * keine Phantom-States mit nie persistierten revs). Die Reihenfolge ist verbindlich: die
 * Statusprüfung (b) läuft VOR jeder Rechteprüfung — ein entschiedener Vorschlag beantwortet
 * 409, nie 403 (Guard-Reihenfolge, Test bewiesen).
 */
export function genehmigeVorschlag(
  db: Db,
  deskId: string,
  vorschlagId: string,
  actor: Actor,
  anwenden: (kommandos: Command[], actor: Actor) => AnwendungsErgebnis,
  vorAnwendung?: (kommandos: Command[]) => string | null,
): { vorschlag: Vorschlag; rev: number } {
  const txn = db.transaction((): { vorschlag: Vorschlag; rev: number } => {
    const row = leseZeile(db, deskId, vorschlagId);
    if (!row) throw new VorschlagNichtGefundenError(`Vorschlag nicht gefunden: ${vorschlagId}`);
    const v = rowNachVorschlag(row);
    const entschieden = uebergang(v, 'genehmigen', { ...(actor.id !== null ? { id: actor.id } : {}), name: actor.name }, Date.now());
    const kommandos = vorschlagAnwenden(v);
    if (vorAnwendung) {
      const verweigert = vorAnwendung(kommandos);
      if (verweigert) throw new GenehmigungVerweigertError(verweigert);
    }
    const desk = getDeskState(db, deskId);
    if (!desk) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    const inverse = inverseFuer(desk.state, kommandos);
    const ergebnis = anwenden(kommandos, actor);
    db.prepare(
      `UPDATE vorschlaege
       SET status = ?, inverse = ?, genehmigte_objekte = ?, decided_by = ?, decided_by_id = ?, decided_at = ?
       WHERE id = ?`,
    ).run(
      entschieden.status, JSON.stringify(inverse), JSON.stringify(ergebnis.objekte),
      entschieden.decidedBy ?? null, entschieden.decidedById ?? null, entschieden.decidedAt ?? null, v.id,
    );
    // (g) Doppelstempel-Marker (T-12-01-07) in DERSELBEN Transaktion (WR-01) — KI-Akteur
    // (Vorschlags-Ersteller) UND Genehmiger; die angewendeten Kommandos selbst journaliert
    // applyDeskCommand regulär mit dem Genehmiger als Akteur. Inhaltsfrei (CR-02).
    appendJournal(db, {
      deskId,
      rev: ergebnis.rev,
      type: 'vorschlagGenehmigt',
      payload: {
        vorschlagId,
        art: v.art,
        kiAkteur: v.createdBy,
        approvedBy: actor.name,
      },
      actorId: actor.id,
      actorName: actor.name,
    });
    return { vorschlag: { ...entschieden, inverse, genehmigteObjekte: ergebnis.objekte }, rev: ergebnis.rev };
  });
  return txn();
}

/**
 * Nimmt einen genehmigten Vorschlag zurück (12-04, AI-02). EINE Transaktion:
 *  (a) Zeile lesen + Status-Übergang 'zuruecknehmen' (VorschlagStatusError → 409 durch die
 *      Route; 'zurückgenommen' ist terminal — die Rücknahme einer Rücknahme ist unmöglich),
 *  (a2) vorAbspielen-Rechteprüfung (WR-01, It. 2): die Route reicht hier die Rechtepositions-
 *      Prüfung aus vorschlagSichtbarkeit.ts durch (Eigentümer/Genehmiger/Anker-Sichtbarkeit) —
 *      liefert sie eine Meldung, wirft die Transaktion RuecknahmeVerweigertError und rollt
 *      zurück: Status bleibt 'genehmigt', keine Inverse, Desk unberührt. Sie läuft VOR dem
 *      updatedRev-Mitschnitt, damit 200-vs-409 für Unberechtigte kein Seitenkanal darüber ist,
 *      ob ein unsichtbares Objekt seither angefasst wurde — und VOR dem Abspielen, damit die
 *      Inverse nie blind auf einer fremden Privat-Ebene schreibt,
 *  (b) updatedRev-Mitschnitt (genehmigte_objekte) gegen den FRISCH gelesenen Desk-State
 *      prüfen: weicht auch nur ein betroffenes Objekt ab oder fehlt es, wirft die
 *      Transaktion VorschlagGeaendertError und rollt zurück — OQ2-Entscheidung
 *      (12-RESEARCH.md Open Question 2): fail-honest 409 statt hartem Zurücksetzen;
 *      menschliche Zwischenarbeit wird nie still überschrieben,
 *  (c) spieleAb-Callback mit der persistierten Inverse (der Aufrufer mappt auf
 *      applyDeskCommand mit dem Rücknehmenden als Akteur),
 *  (d) Zeile UPDATE status 'zurückgenommen' + decided_*,
 *  (e) Journal-Marker 'vorschlagZurueckgenommen' mit Doppelstempel (vorschlagId, kiAkteur
 *      = Vorschlags-Ersteller, approvedBy = Rücknehmender) — die Inverse-Kommandos selbst
 *      journaliert applyDeskCommand regulär mit dem Rücknehmenden.
 * Jeder Wurf lässt Register UND Desk unverändert (Rollback). Die Reihenfolge ist verbindlich:
 * Status (a) VOR Rechten (a2) VOR Mitschnitt (b) — ein entschiedener Vorschlag beantwortet
 * 409, nie 403 (dieselbe Guard-Reihenfolge wie bei der Genehmigung).
 */
export function nimmVorschlagZurueck(
  db: Db,
  deskId: string,
  vorschlagId: string,
  actor: Actor,
  spieleAb: (kommandos: Command[], actor: Actor) => { rev: number },
  vorAbspielen?: (v: Vorschlag, state: DesktopState) => string | null,
): { vorschlag: Vorschlag; rev: number } {
  const txn = db.transaction((): { vorschlag: Vorschlag; rev: number } => {
    const row = leseZeile(db, deskId, vorschlagId);
    if (!row) throw new VorschlagNichtGefundenError(`Vorschlag nicht gefunden: ${vorschlagId}`);
    const v = rowNachVorschlag(row);
    const entschieden = uebergang(v, 'zuruecknehmen', { ...(actor.id !== null ? { id: actor.id } : {}), name: actor.name }, Date.now());
    // Ein 'genehmigter' Vorschlag trägt garantiert eine persistierte Inverse (atomarer
    // Status+Inverse-Commit bei der Genehmigung) — fehlt sie dennoch, ist das ein
    // Datenfehler und keine Rücknahme-Bedingung: fail-closed als Statusfehler.
    if (!v.inverse || v.inverse.length === 0) {
      throw new VorschlagStatusError(`Vorschlag "${vorschlagId}" hat keine persistierte Inverse — Rücknahme unmöglich`);
    }
    const desk = getDeskState(db, deskId);
    if (!desk) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    // (a2) Rechteposition der Rücknahme (WR-01, It. 2) — VOR dem Mitschnitt (Seitenkanal)
    // und VOR dem Abspielen (blinder Schreibzugriff auf unsichtbaren Ebenen).
    if (vorAbspielen) {
      const verweigert = vorAbspielen(v, desk.state);
      if (verweigert) throw new RuecknahmeVerweigertError(verweigert);
    }
    // (b) updatedRev-Mitschnitt gegen den aktuellen State — die 409-Schranke zwischen
    // KI-Rücknahme und Menschenarbeit (T-12-04-01).
    for (const o of v.genehmigteObjekte ?? []) {
      // CR-03: Korb-Anker einer trashObject-Genehmigung — Korb-Einträge sind unversioniert,
      // die Schranke prüft reine EXISTENZ: hat ein Mensch den Eintrag zwischenzeitlich
      // manuell wiederhergestellt oder geschreddert, antwortet die Rücknahme mit dem
      // ehrlichen 409 (statt bisher: die restoreObject-Inverse wirft CommandError erst beim
      // Abspielen → ungemappter 500).
      if (o.korb === true) {
        if (!(desk.state.trash ?? []).some((t) => t.id === o.id)) throw new VorschlagGeaendertError();
        continue;
      }
      const treffer = findeObjekt(desk.state, o.id);
      if (!treffer || treffer.obj.updatedRev !== o.updatedRev) throw new VorschlagGeaendertError();
    }
    // (c) Inverse abspielen — Konfliktstempelung, Journal, syncSearchIndex und Broadcast
    // greifen über den regulären applyDeskCommand-Pfad unverändert.
    const ergebnis = spieleAb(v.inverse, actor);
    // (d) Register-Entscheidung persistieren.
    db.prepare(
      'UPDATE vorschlaege SET status = ?, decided_by = ?, decided_by_id = ?, decided_at = ? WHERE id = ?',
    ).run(entschieden.status, entschieden.decidedBy ?? null, entschieden.decidedById ?? null, entschieden.decidedAt ?? null, v.id);
    // (e) Doppelstempel-Marker (T-12-04-05, Repudiation): die Rücknahme ist als eigener,
    // akteursbezogener Vorgang rekonstruierbar — KI-Akteur UND Rücknehmender im Payload.
    // CR-02: INHALTSFREI wie der vorschlagGenehmigt-Marker (nur Metadaten) — die Register-
    // zusammenfassung kann deanonymisierte Inhaltsschnipsel privater Objekte tragen und der
    // Journal-Projektionsfilter kennt die Marker-Typen nicht; sie bleibt im Register
    // einsehbar (projizierte GET-Liste, findeVorschlag).
    appendJournal(db, {
      deskId,
      rev: ergebnis.rev,
      type: 'vorschlagZurueckgenommen',
      payload: {
        vorschlagId,
        art: v.art,
        kiAkteur: v.createdBy,
        approvedBy: actor.name,
      },
      actorId: actor.id,
      actorName: actor.name,
    });
    return { vorschlag: entschieden, rev: ergebnis.rev };
  });
  return txn();
}

/**
 * Lehnt einen ausstehenden Vorschlag ab — ohne jede Desk-Wirkung und ohne Journal-Marker
 * (die Ablehnung ist kein Historien-Ereignis in Phase 12; die Registerzeile dokumentiert sie).
 */
export function lehneVorschlagAb(db: Db, deskId: string, vorschlagId: string, actor: Actor): Vorschlag {
  const txn = db.transaction((): Vorschlag => {
    const row = leseZeile(db, deskId, vorschlagId);
    if (!row) throw new VorschlagNichtGefundenError(`Vorschlag nicht gefunden: ${vorschlagId}`);
    const entschieden = uebergang(rowNachVorschlag(row), 'ablehnen', { ...(actor.id !== null ? { id: actor.id } : {}), name: actor.name }, Date.now());
    db.prepare(
      'UPDATE vorschlaege SET status = ?, decided_by = ?, decided_by_id = ?, decided_at = ? WHERE id = ?',
    ).run(entschieden.status, entschieden.decidedBy ?? null, entschieden.decidedById ?? null, entschieden.decidedAt ?? null, entschieden.id);
    return entschieden;
  });
  return txn();
}
