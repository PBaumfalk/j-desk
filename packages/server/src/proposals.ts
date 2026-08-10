import type { FastifyInstance } from 'fastify';
import {
  CommandError, findeObjekt, GENEHMIGUNGS_FAEHIGE_ARTEN, istObjektSichtbarFuer,
  objektIdAusKorbEintrag, projectStateForActor,
  VorschlagNichtGefundenError, VorschlagStatusError,
  type ActorContext, type DesktopState, type Quelle, type Vorschlag,
} from '@j-desk/core';
import type { Db } from './db';
import { requireDeskAktion, requireDeskRolle } from './guards';
import { actorFromRequest } from './actor';
import { applyDeskCommand, getDeskState, type Actor, type DeskState } from './deskStore';
import { broadcast } from './broadcast';
import {
  erstelleVorschlag, genehmigeVorschlag, lehneVorschlagAb, listeVorschlaege, nimmVorschlagZurueck,
  GenehmigungVerweigertError, RuecknahmeVerweigertError, VorschlagAbgelehntError, VorschlagGeaendertError,
} from './proposalStore';
import { pruefeKommandosFuerActor } from './app';
import { pruefeQuellen, type QuellenGrund } from './quelleServer';
import { ruecknahmeErlaubt } from './vorschlagSichtbarkeit';

/**
 * REST-Fläche des Vorschlags-Registers (Phase 12, AI-01/AI-02). Drei Routen, drei
 * Verantwortlichkeiten: Erstellung schreibt NUR ins Register (der Desk-rev bleibt
 * unverändert — T-12-01-01, keine Seitentür auf desks.state); Genehmigung wirkt
 * ausschließlich über applyDeskCommand (rev/updatedRev, 409, Journal, syncSearchIndex,
 * WS-Broadcast — derselbe Bestandspfad wie menschliche Kommandos); Ablehnung ist eine reine
 * Register-Entscheidung ohne Historien-Marker. Die Entscheidungs-Routen hängen am selben
 * Guard wie die Wiederherstellung (requireDeskAktion 'manage', restore-Route app.ts) —
 * Genehmigung hat dieselbe Tragweite (Vorentscheidung A1).
 *
 * 12-03 (AI-03, Failure Modes 3+5 der AI-SPEC): die Erstellung ist gehärtet — (a) art-
 * Whitelist aus GENEHMIGUNGS_FAEHIGE_ARTEN (Whitelist und Abbildung laufen nie
 * auseinander), (b) art-abhängige Quellenpflicht (INHALTS_ARTEN), (c) Budget-Guardrails,
 * (d) atomare Zitat-Verifikation über pruefeQuellen VOR dem INSERT in EINER Transaktion
 * (Pitfall 8: kein stiller Partial Success — jeder 422-Fall ist persistenzfrei). Alle
 * Ablehnungen tragen { error, grund, betroffeneQuelle? }: die Meldung für Menschen, grund
 * für Maschinen (MCP-Retry-Kanal, Plan 12-05).
 *
 * Das WS-Signal 'vorschlaegeGeaendert' ist INHALTSFREI (kein Zähler, kein Payload —
 * T-12-01-04): projiziertFuerEmpfaenger projiziert nur state-Felder, jede Nutzlast ginge
 * unprojiziert an alle Sockets des Desk-Rooms (Bugklasse aec4f58/fcda808). Präzedenz:
 * event 'restored' in der restore-Route. Der Client lädt die projizierte Liste per GET nach.
 */

/**
 * Vorschlags-arten mit QuellenPFLICHT (Planner-Entscheidung A6): inhaltsbezogene Arten
 * belegen eine Behauptung über Dokumentinhalt und brauchen mindestens eine prüfbare
 * Fundstelle. addStamp/addFlag tragen ihre Fundstelle positionsinhärent (docId + Seite am
 * Seitenrand) — dort ist quelle optional; Ordnungs-arten (move/stack/clip/trash/…) sind
 * quelle-frei. Erweiterung der Menge ist einzeilig und rückwärtskompatibel.
 */
export const INHALTS_ARTEN: ReadonlySet<string> = new Set(['addNote', 'editNote', 'addLink', 'extractPage']);

/** Budget-Grenzen (AI-SPEC Guardrail): die Genehmigungsanzeige muss menschlich prüfbar
 *  bleiben — mehr Quellen/Text wäre stille Umorganisation per Vorschlag (T-12-03-04). */
export const QUELLEN_MAX = 5;
export const PAYLOAD_TEXT_MAX = 2000;
/** WR-05: Zitat-Längenlimit je Quelle (analog TEXT_SNAPSHOT_MAX) — QUELLEN_MAX deckelt nur
 *  die Anzahl; die MCP-Seite deckelt schärfer auf 1000 (QuelleSchema). */
export const ZITAT_MAX = 2000;

/** Deutsche Meldung je maschinenlesbarem grund — 'mandat_fremd' bleibt bewusst generisch
 *  (keine Existenz-Auskunft über Fremddokumente, T-12-03-05). */
const GRUND_MELDUNGEN: Record<QuellenGrund, string> = {
  mandat_fremd: 'Die Quellenangabe konnte nicht geprüft werden.',
  text_nicht_extrahiert: 'Für die angegebene Seite liegt kein extrahierter Text vor.',
  zitat_nicht_auflösbar: 'Das Zitat konnte auf der angegebenen Seite nicht gefunden werden.',
};

/**
 * Sev-2-Frühwarnung (AI-SPEC Section 7): häufen sich 'mandat_fremd'-Ablehnungen desselben
 * Token-Inhabers (≥ 3 innerhalb von 10 Minuten), wird ein Security-Log geschrieben — OHNE
 * dokumentId oder Zitat (niemals Mandatsinhalt in Logs). Schlüssel ist die Actor-Identität
 * (users.id), nicht das rohe Token — ein Token gehört genau einem Nutzer, und rohe Tokens
 * gehören in keine langlebige In-Memory-Struktur. In-Memory ist bewusst: Frühwarn-Signal,
 * kein Audit-Pfad; ein Neustart setzt das Zeitfenster zurück (dokumentiertes Restrisiko —
 * ein persistenter Zähler wäre Phase-14/OPS-02-Stoff).
 */
const MANDAT_FREMD_FENSTER_MS = 10 * 60 * 1000;
const MANDAT_FREMD_SCHWELLE = 3;
const mandatFremdZaehler = new Map<string, number[]>();

function meldeMandatFremd(deskId: string, actor: Actor): void {
  const schluessel = actor.id ?? actor.name;
  const jetzt = Date.now();
  const zeiten = (mandatFremdZaehler.get(schluessel) ?? []).filter((t) => jetzt - t < MANDAT_FREMD_FENSTER_MS);
  zeiten.push(jetzt);
  mandatFremdZaehler.set(schluessel, zeiten);
  if (zeiten.length >= MANDAT_FREMD_SCHWELLE) {
    console.error('[SECURITY] mandat_fremd-Häufung', { deskId, akteur: actor.name, anzahl: zeiten.length });
  }
}

function quellenPruefen(v: unknown): Quelle[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const quellen: Quelle[] = [];
  for (const q of v) {
    if (q === null || typeof q !== 'object') return undefined;
    const { dokumentId, seite, zitat } = q as Record<string, unknown>;
    // WR-05: zitat-Längenlimit (analog TEXT_SNAPSHOT_MAX; die MCP-Seite deckelt auf 1000,
    // QuelleSchema) und seite als ganze Zahl ≥ 1 — sonst landen Megabyte-Zitate in der DB
    // und werden bei jeder Prüfung normalisiert, und krumme Seitenzahlen laufen erst in der
    // Verifikation auf.
    if (
      typeof dokumentId !== 'string'
      || !Number.isInteger(seite) || (seite as number) < 1
      || typeof zitat !== 'string' || zitat.length > ZITAT_MAX
    ) {
      return undefined;
    }
    quellen.push({ dokumentId, seite: seite as number, zitat });
  }
  return quellen;
}

/** WR-05: Budget-Stufe (c) jetzt REKURSIV — Top-Level-Strings reichten nicht mehr, sobald
 *  verschachtelte Formen (stamp.text/flag.label in der Kommando-Form, künftige arten)
 *  Texte tragen. Tiefenlauf über Objekte/Arrays, gedeckelt auf Tiefe 3. */
function stringUeberschreitetBudget(wert: unknown, tiefe: number): boolean {
  if (typeof wert === 'string') return wert.length > PAYLOAD_TEXT_MAX;
  if (tiefe >= 3 || wert === null || typeof wert !== 'object') return false;
  const werte = Array.isArray(wert) ? wert : Object.values(wert);
  return werte.some((e) => stringUeberschreitetBudget(e, tiefe + 1));
}

function payloadTextUeberschreitetBudget(payload: Record<string, unknown>): boolean {
  return Object.values(payload).some((wert) => stringUeberschreitetBudget(wert, 0));
}

/**
 * Das Live-Signal aller Vorschlags-Mutationspfade (12-03 Task 3): INHALTSFREI — genau ein
 * Schlüssel, kein Zähler, kein Payload. broadcast.ts:70-76 (projiziertFuerEmpfaenger)
 * projiziert NUR state-Felder; jede andere Nutzlast ginge UNVERÄNDERT an alle Sockets des
 * Desk-Rooms (Broadcast-Leck-Bugklasse aec4f58/fcda808). Auch ein Zähler ist verboten
 * (Andeutungs-Verbot: ein projizierter Zähler variierte pro Empfänger und verriete, dass es
 * Unsichtbares gibt). Alle vier Pfade (erstellen, genehmigen, ablehnen, zuruecknehmen in
 * Plan 12-04) senden wortgleich DIESES Objekt.
 */
export const VORSCHLAG_SIGNAL = { event: 'vorschlaegeGeaendert' } as const;

/**
 * Die Doc-Referenzen eines Vorschlags (Projektions-Filter der GET-Liste, PERM-05):
 * VERBINDLICH sind quellen[].dokumentId und payload.docId. Bewusst NICHT geprüft wird
 * payload.id — bei addNote ist das die NEUE Notiz-id (noch kein Desk-Objekt); Notiz-/Link-
 * ids stehen ohnehin nie im docIds-Set, ein Durchwinken unbekannter ids wäre aber genau die
 * falsche Fail-Richtung, darum zählt nur, was eine Doc-id SEIN kann. KOMMENTAR PFLICHT:
 * kommen in 12-04 neue arten mit Doc-Referenzen im payload dazu (addLink.fromId/toId,
 * extractPage.docId), muss diese Funktion sie aufnehmen — sonst kippt die Regel „fehlt
 * komplett, wenn auch nur EINE Referenz unsichtbar ist" still.
 */
export function referenzierteDocIds(v: Vorschlag): string[] {
  const ids = v.quellen.map((q) => q.dokumentId);
  const docId = v.payload.docId;
  if (typeof docId === 'string' && docId !== '') ids.push(docId);
  return ids;
}

/**
 * payload-Felder je art, die ein BESTEHENDES Desk-Objekt referenzieren (12-04) — im
 * Gegensatz zu Erzeugungs-ids (addNote.id ist die NEUE Notiz, addLink.id der neue Link):
 * die tauchen hier bewusst NICHT auf. Erfüllt die Kommentar-Pflicht aus 12-03: jede neue
 * art mit Objekt-Referenzen im payload muss einen Eintrag bekommen, sonst kippt die Regel
 * „fehlt komplett, wenn auch nur EINE Referenz unsichtbar ist" still.
 */
const REFERENZ_FELDER: Record<string, readonly string[]> = {
  moveDoc: ['id'],
  stackDocs: ['draggedId', 'targetId'],
  removeFromStack: ['docId'],
  dissolveStack: ['stackId'],
  renameStack: ['stackId'],
  moveStack: ['stackId'],
  stapleStack: ['stackId'],
  unstapleStack: ['stackId'],
  addLink: ['fromId', 'toId'],
  editNote: ['id'],
  setNoteDone: ['id'],
  addStamp: ['docId'],
  addFlag: ['docId'],
  addClip: ['aId', 'bId'],
  trashObject: ['objectId'],
  extractPage: ['docId'],
  setLinkNote: ['linkId'],
};

/**
 * Bestehende Objekt-Referenzen eines Vorschlags (Docs, Stapel, Notizen, Links, Klammern).
 * Die GET-Liste prüft sie gegen Voll- und Projektions-State: existiert die Referenz im
 * vollen State, fehlt sie aber in der Projektion, ist sie für den Betrachter unsichtbar →
 * der Vorschlag fehlt KOMPLETT. Unbekannte ids (Erzeugungs-ids, verwaiste Referenzen)
 * werden ignoriert — fail-closed wirkt nur gegen nachweisbar Existierendes.
 */
export function referenzierteObjektIds(v: Vorschlag): string[] {
  const felder = REFERENZ_FELDER[v.art] ?? [];
  const ids: string[] = [];
  for (const f of felder) {
    const wert = v.payload[f];
    if (typeof wert === 'string' && wert !== '') ids.push(wert);
  }
  return ids;
}

/**
 * WR-07: Sichtprüfung der Korb-Referenz eines restoreObject-Vorschlags. REFERENZ_FELDER
 * kann trashId nicht abbilden (findeObjekt durchsucht bewusst keine Korb-Einträge), darum
 * eigene Auflösung: der Korb-Eintrag trägt Vollkopien der enthaltenen Objekte samt layerId
 * (Muster: referenziertesObjektSichtbar in journal.ts) — ist auch nur EINES der enthaltenen
 * Objekte für den Betrachter unsichtbar, fehlt der Vorschlag KOMPLETT (dieselbe Regel wie
 * die übrigen Referenzen; zusammenfassung/trashId verrieten sonst die Existenz der
 * Korb-Aktion an ein ggf. privates Objekt). Unbekannte trashId/leerer Eintrag → ignorieren
 * (fail-closed nur gegen nachweisbar Existierendes, wie bei referenzierteObjektIds).
 */
function korbReferenzSichtbar(state: DesktopState, v: Vorschlag, ctx: ActorContext): boolean {
  if (v.art !== 'restoreObject') return true;
  const trashId = v.payload.trashId;
  if (typeof trashId !== 'string' || trashId === '') return true;
  const eintrag = (state.trash ?? []).find((t) => t.id === trashId);
  if (!eintrag) return true; // verwaiste Referenz — kein fail-closed gegen Nichtexistierendes
  const kopien = Object.values(eintrag.payload).flat() as { layerId?: string }[];
  if (kopien.length === 0) return true;
  return kopien.every((k) => istObjektSichtbarFuer(k.layerId, ctx, state.layers));
}

/** Öffentliche Felder des Listenpfads — inverse und genehmigteObjekte sind Entscheidungs-
 *  Interna (Rücknahme-Anker) und verlassen den Server nicht im Listenpfad (T-12-03-06);
 *  decidedBy/decidedAt werden bewusst mit ausgeliefert (Prüflast soll im Team sichtbar sein). */
function oeffentlicheFelder(v: Vorschlag): Record<string, unknown> {
  return {
    id: v.id,
    art: v.art,
    payload: v.payload,
    quellen: v.quellen,
    zusammenfassung: v.zusammenfassung,
    status: v.status,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    ...(v.decidedBy !== undefined ? { decidedBy: v.decidedBy } : {}),
    ...(v.decidedAt !== undefined ? { decidedAt: v.decidedAt } : {}),
  };
}

/**
 * Objekt-ids, die ein Kommando unmittelbar berührt — Grundlage des updatedRev-Mitschnitts
 * (genehmigte_objekte, Rücknahme-Anker 12-04). payload.id deckt die meisten arten ab;
 * link-/stapel-/doc-keyed Kommandos tragen ihre Ziel-ids in eigenen Feldern (setLinkNote,
 * moveStack, removeFromStack, stackDocs mit draggedId+targetId). Erzeugte Objekte werden
 * nach der Anwendung gestempelt gefunden; unveränderte (z. B. das Quelldokument bei
 * extractPage) bleiben ungestempelt und werden seit WR-02 am Aufnahme-Kriterium
 * `updatedRev === result.rev` aussortiert — die Schranke prüft nur, was die Genehmigung
 * tatsächlich verändert hat (kein falscher 409-Blocker durch Alt-updatedRevs).
 */
function mitschnittIds(cmd: { payload?: Record<string, unknown> }): string[] {
  const p = cmd.payload ?? {};
  const ids: string[] = [];
  for (const key of ['id', 'linkId', 'stackId', 'docId', 'draggedId', 'targetId']) {
    const wert = p[key];
    if (typeof wert === 'string' && wert !== '') ids.push(wert);
  }
  // WR-01 (It. 3): addStamp/addFlag tragen ihre neue Objekt-id VERSCHACHTELT in der
  // Kommando-Form ({ stamp: { id } } / { flag: { id } }, vorschlagAnwenden) — die Register-
  // Form ist flach, die Verschachtelung entsteht erst beim Abbilden aufs Kommando, und
  // mitschnittIds läuft ausschließlich über die Kommando-Form. Ohne diesen Zweig bliebe
  // genehmigteObjekte für beide arten leer und die Rücknahme-Schranke (Weg 3,
  // ruecknahmeAnkerSichtbar) vakuum wahr — Rücknahme-by-Proxy auf fremden Privat-Ebenen.
  // Defensiv beide Formen (verschachtelt + flache id oben) abgedeckt.
  for (const key of ['stamp', 'flag']) {
    const wert = (p[key] as Record<string, unknown> | undefined)?.id;
    if (typeof wert === 'string' && wert !== '') ids.push(wert);
  }
  return ids;
}

/**
 * Objekt-id eines restoreObject-Kommandos aus dem Zustand VOR der Anwendung (CR-03):
 * mitschnittIds kennt den trashId-Schlüssel nicht und nach der Anwendung ist der Korb-
 * Eintrag weg — der Rücknahme-Anker des wiederhergestellten Objekts muss deshalb VORHER
 * aufgelöst werden. Auflösung über dieselbe Vorschrift wie die Inverse (objektIdAusKorbEintrag).
 * Unbekannte/leere Einträge liefern undefined (kein Anker): inverseFuer hat eine Genehmigung
 * mit unlesbarem Korb-Eintrag bereits vorher verworfen.
 */
function korbObjektId(state: DesktopState, trashId: unknown): string | undefined {
  if (typeof trashId !== 'string' || trashId === '') return undefined;
  const eintrag = (state.trash ?? []).find((t) => t.id === trashId);
  if (!eintrag) return undefined;
  try {
    return objektIdAusKorbEintrag(eintrag);
  } catch {
    return undefined;
  }
}

export function registerProposals(app: FastifyInstance, db: Db): void {
  // Einsicht in die Vorschlagsliste ist kein Eingriff — JEDE Desk-Rolle darf lesen
  // (requireDeskRolle ohne Rollen-Argument); die Vertraulichkeit sichert die serverseitige
  // Projektion unten, nicht der Guard.
  app.get('/api/v1/desks/:id/vorschlaege', { preHandler: requireDeskRolle(db) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const actor = actorFromRequest(db, req);
    const desk = getDeskState(db, id);
    if (!desk) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    // Einzige Sichtbarkeits-Naht (PERM-05, Bugklasse aec4f58/fcda808): die Erlaubnisliste
    // kommt AUSSCHLIESSLICH aus projectStateForActor — ein Vorschlag fehlt KOMPLETT, wenn
    // auch nur EINE seiner Doc-Referenzen für den Betrachter unsichtbar ist (kein
    // Platzhalter, keine Teilredaktion).
    const projiziert = projectStateForActor(desk.state, { userId: actor.id ?? '', rolle: req.rolle! });
    const sichtbareDocIds = new Set(projiziert.docs.map((d) => d.id));
    const betrachterCtx: ActorContext = { userId: actor.id ?? '', rolle: req.rolle! };
    const vorschlaege = listeVorschlaege(db, id)
      .filter((v) => referenzierteDocIds(v).every((docId) => sichtbareDocIds.has(docId)))
      .filter((v) => referenzierteObjektIds(v).every((objektId) =>
        // 12-04: existiert die Referenz im VOLLEN State (findeObjekt über alle versionierten
        // Arten), aber nicht in der Projektion, ist sie für den Betrachter unsichtbar →
        // komplettes Fehlen. Unbekannte/Erzeugungs-ids fallen durch (kein fail-closed
        // gegen Nichtexistierendes).
        !findeObjekt(desk.state, objektId) || findeObjekt(projiziert, objektId) !== undefined))
      // WR-07: restoreObject-Korb-Referenz gegen den Betrachter-Kontext (Korb-Eintrag trägt
      // Vollkopie samt layerId — dieselbe Regel wie die übrigen Objekt-Referenzen).
      .filter((v) => korbReferenzSichtbar(desk.state, v, betrachterCtx))
      .map(oeffentlicheFelder);
    return { vorschlaege };
  });

  // Erstellung = MCP-Arbeitskonto-Rollen (Vorentscheidung OQ3: Eigentümer + Bearbeiter).
  app.post('/api/v1/desks/:id/vorschlaege', { preHandler: requireDeskRolle(db, ['Eigentümer', 'Bearbeiter']) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const art = typeof body.art === 'string' && body.art !== '' ? body.art : undefined;
    const payload = body.payload !== null && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : undefined;
    const zusammenfassung = typeof body.zusammenfassung === 'string' ? body.zusammenfassung : undefined;
    const quellen = quellenPruefen(body.quellen);
    const idempotenzKey = typeof body.idempotenzKey === 'string' && body.idempotenzKey !== '' ? body.idempotenzKey : undefined;
    if (!art || !payload || zusammenfassung === undefined || (body.quellen !== undefined && quellen === undefined)) {
      return reply.code(400).send({ error: 'Body muss art, payload und zusammenfassung enthalten (quellen optional als Quelle-Array)' });
    }

    // (a) art-Whitelist: nur Arten mit Genehmigungs-Abbildung werden überhaupt registriert.
    if (!GENEHMIGUNGS_FAEHIGE_ARTEN.includes(art)) {
      return reply.code(422).send({
        error: `Vorschlagsart „${art}" ist nicht genehmigungsfähig.`,
        grund: 'art_nicht_genehmigungsfähig',
      });
    }
    // (b) Quellenpflicht für inhaltsbezogene arten (A6): ohne Fundstelle keine Registrierung.
    if (INHALTS_ARTEN.has(art) && (!quellen || quellen.length === 0)) {
      return reply.code(422).send({
        error: 'Dieser Vorschlag benötigt mindestens eine Quellenangabe (Fundstelle).',
        grund: 'quelle_fehlt',
      });
    }
    // (c) Budget-Guardrails: quellen ≤ 5, Textfelder ≤ 2000 (zusammenfassung wird im Core
    // gekappt statt abgelehnt — kappeTextSnapshot-Präzedenz, s. vorschlag.ts).
    if ((quellen?.length ?? 0) > QUELLEN_MAX || payloadTextUeberschreitetBudget(payload)) {
      return reply.code(422).send({
        error: `Budget überschritten: höchstens ${QUELLEN_MAX} Quellen und ${PAYLOAD_TEXT_MAX} Zeichen pro Textfeld.`,
        grund: 'budget_überschritten',
      });
    }

    const actor = actorFromRequest(db, req);
    const ctx: ActorContext = { userId: actor.id ?? '', rolle: req.rolle! };
    try {
      // (d)+(e) atomar: pruefeQuellen läuft als vorInsert-Callback VOR dem INSERT in derselben
      // Transaktion (proposalStore) — ein Ablehnungs-Fehler hinterlässt keine Zeile.
      const v = erstelleVorschlag(db, id, {
        art, payload, ...(quellen !== undefined ? { quellen } : {}), zusammenfassung,
        ...(idempotenzKey !== undefined ? { idempotenzKey } : {}),
      }, actor, quellen && quellen.length > 0
        ? () => {
            const ergebnis = pruefeQuellen(db, id, quellen, ctx);
            return Array.isArray(ergebnis) ? null : ergebnis;
          }
        : undefined);
      broadcast(id, VORSCHLAG_SIGNAL);
      return { vorschlagId: v.id, status: v.status };
    } catch (e) {
      if (e instanceof VorschlagAbgelehntError) {
        if (e.fehler.grund === 'mandat_fremd') meldeMandatFremd(id, actor);
        return reply.code(422).send({
          error: GRUND_MELDUNGEN[e.fehler.grund],
          grund: e.fehler.grund,
          betroffeneQuelle: e.fehler.betroffeneQuelle,
        });
      }
      throw e;
    }
  });

  app.post('/api/v1/desks/:id/vorschlaege/:vorschlagId/genehmigen', { preHandler: requireDeskAktion(db, 'manage') }, async (req, reply) => {
    const { id, vorschlagId } = req.params as { id: string; vorschlagId: string };
    const actor = actorFromRequest(db, req);
    try {
      // WR-01: die State-Broadcasts werden INNERHALB der Genehmigungs-Transaktion nur
      // gesammelt und erst NACH dem Commit ausgestrahlt — ein Rollback (Verweigerung,
      // Anwendungs-/Marker-Fehler) hinterlässt sonst Phantom-States mit revs auf den
      // WS-Clients, die in der DB nie existiert haben.
      const ausstehendeBroadcasts: DeskState[] = [];
      const ergebnis = genehmigeVorschlag(db, id, vorschlagId, actor, (kommandos, akteur: Actor) => {
        let rev = 0;
        const objekte: { id: string; updatedRev: number; korb?: boolean }[] = [];
        // CR-03: der Zustand VOR dem jeweiligen Kommando — restoreObject-Anker brauchen die
        // Objekt-id aus dem Korb-Eintrag (nach der Anwendung ist der Eintrag weg).
        let vorherigerState = getDeskState(db, id)?.state;
        for (const cmd of kommandos) {
          const restoreZielId = cmd.type === 'restoreObject' && vorherigerState !== undefined
            ? korbObjektId(vorherigerState, cmd.payload?.trashId)
            : undefined;
          const result = applyDeskCommand(db, id, cmd, akteur);
          rev = result.rev;
          vorherigerState = result.state;
          // WR-01: sammeln statt sofort ausstrahlen — Versand erst nach dem Commit (unten).
          ausstehendeBroadcasts.push(result);
          // 12-04: Mitschnitt über alle berührten Objekt-ids (nicht nur payload.id) —
          // sonst blieben link-/stapel-keyed Kommandos ohne Rücknahme-Anker.
          // WR-02: aufgenommen wird nur, was DIESES Kommando tatsächlich neu gestempelt hat
          // (updatedRev === die rev dieses Kommandos) — unveränderte Nebenobjekte mit
          // Alt-updatedRev (z. B. das Quelldokument bei extractPage, das viewer.ts nie
          // anrührt) blockierten sonst jede spätere Rücknahme als falsche 409, obwohl die
          // Inverse sie gar nicht berührt.
          for (const objId of mitschnittIds(cmd)) {
            const treffer = findeObjekt(result.state, objId);
            if (treffer && treffer.obj.updatedRev === result.rev) {
              objekte.push({ id: objId, updatedRev: treffer.obj.updatedRev });
            }
          }
          // CR-03 (a): trashObject verankert die erzeugte KORB-id — das getrashte Objekt
          // liegt nach der Genehmigung im Papierkorb, findeObjekt durchsucht nur die
          // Live-Listen (trash fehlt bewusst in VERSIONIERTE_ARTEN): ohne diesen Anker bliebe
          // der Mitschnitt konstruktiv leer und eine manuelle Wiederherstellung durch einen
          // Menschen ende im CommandError-500 statt im ehrlichen 409.
          if (cmd.type === 'trashObject') {
            const trashId = cmd.payload?.trashId;
            if (typeof trashId === 'string' && trashId !== '') {
              objekte.push({ id: trashId, updatedRev: 0, korb: true });
            }
          }
          // CR-03 (b): restoreObject verankert das wiederhergestellte OBJEKT mit seiner
          // frisch gestempelten updatedRev — die Inverse (trashObject) re-trasht danach nur
          // unberührte Objekte; Menschenarbeit am wiederhergestellten Objekt wird mit 409
          // beantwortet statt still überschrieben zu werden (OQ2).
          if (restoreZielId !== undefined) {
            const treffer = findeObjekt(result.state, restoreZielId);
            if (treffer && treffer.obj.updatedRev === result.rev) {
              objekte.push({ id: restoreZielId, updatedRev: treffer.obj.updatedRev });
            }
          }
        }
        return { rev, objekte };
      }, (kommandos) =>
        // Pitfall 5 (12-CONTEXT.md Leitplanke 2): geprüft wird der GENEHMIGER
        // (actorFromRequest), nicht der KI-Akteur — dieselbe Kommando-/Ebenen-Rechte-
        // maschinerie wie menschliche Aktionen (extrahierte Sequenz der /commands-Route).
        // Ein Bearbeiter kann nichts genehmigen, das er manuell nicht dürfte; die
        // Verweigerung rollt die Genehmigung vollständig zurück (403, fail-honest WR-05).
        pruefeKommandosFuerActor(db, id, req.rolle!, actor, kommandos));
      // Der Doppelstempel-Marker (T-12-01-07) wird seit WR-01 INNERHALB der Transaktion
      // journaliert (genehmigeVorschlag, Schritt g) — atomar mit Status+Inverse+Kommandos.
      // WR-01: Broadcasts erst jetzt (nach dem Commit) — die gesammelten Kommando-States
      // entsprechen garantiert persistierten revs.
      for (const result of ausstehendeBroadcasts) broadcast(id, result);
      broadcast(id, VORSCHLAG_SIGNAL);
      return { ok: true, rev: ergebnis.rev };
    } catch (e) {
      // Fail-honest (WR-05): die deutsche Fehlermeldung des Statusfehlers geht als 409-Body raus.
      if (e instanceof VorschlagNichtGefundenError) return reply.code(404).send({ error: e.message });
      if (e instanceof VorschlagStatusError) return reply.code(409).send({ error: e.message });
      // Genehmigungs-Guard: die Verweigerungs-Meldung aus pruefeKommandosFuerActor (Rollback
      // ist bereits passiert — Status 'ausstehend', keine Inverse).
      if (e instanceof GenehmigungVerweigertError) return reply.code(403).send({ error: e.message });
      // WR-03: CommandError aus der Abbildung/Inverse-Berechnung (Alltagsfall: das Zielobjekt
      // wurde zwischen Einreichung und Genehmigung gelöscht — „Keine Inverse definierbar …")
      // ist ein erwartbarer Fachfall, kein Serverfehler — ehrlicher 409 statt ungemapptem 500;
      // die Transaktion hat bereits zurückgerollt, der Prüfer kann den Vorschlag ablehnen.
      if (e instanceof CommandError) return reply.code(409).send({ error: e.message, grund: 'kommando_nicht_anwendbar' });
      throw e;
    }
  });

  app.post('/api/v1/desks/:id/vorschlaege/:vorschlagId/zuruecknehmen', { preHandler: requireDeskAktion(db, 'manage') }, async (req, reply) => {
    const { id, vorschlagId } = req.params as { id: string; vorschlagId: string };
    const actor = actorFromRequest(db, req);
    try {
      // WR-01: Broadcasts der Inverse-Kommandos sammeln, Versand erst nach dem Commit.
      const ausstehendeBroadcasts: DeskState[] = [];
      const ergebnis = nimmVorschlagZurueck(db, id, vorschlagId, actor, (kommandos, akteur: Actor) => {
        let rev = 0;
        for (const cmd of kommandos) {
          // Bewusste Guard-Umgehung — exakt das restoreDeskTo-Muster (restore.ts:50-67):
          // die Inverse enthält Kommandos, die der Routen-Guard für diese Rolle ablehnen
          // würde (z. B. removeNote als Inverse von addNote — Eigentümer-only über
          // /commands; removeDoc als Inverse von extractPage). Die Rechtefrage wurde
          // bereits bei der GENEHMIGUNG mit dem Genehmiger geprüft (pruefeKommandosFuerActor);
          // die Rücknahme kehrt nur das Geprüfte um. Ersatzkontrollen (T-12-04-01/02):
          // 'manage'-Guard an dieser Route + updatedRev-Mitschnitt gegen Menschenarbeit +
          // seit It. 2 (WR-01) die Rechtepositions-Prüfung vorAbspielen (Eigentümer/
          // Genehmiger/Anker-Sichtbarkeit) — die Rechtegleichheit zwischen Genehmiger und
          // Rücknehmendem ist damit erzwungen statt implizit vorausgesetzt.
          const result = applyDeskCommand(db, id, cmd, akteur);
          rev = result.rev;
          ausstehendeBroadcasts.push(result);
        }
        return { rev };
      },
      // WR-01 (It. 2): Rechteposition der Rücknahme VOR dem Mitschnitt und VOR dem
      // Abspielen — Eigentümer ODER Genehmiger (decidedById) ODER vollständige Sichtbarkeit
      // aller Anker-Objekte (vorschlagSichtbarkeit.ts, Begründung dort). Verhindert den
      // Rücknahme-by-Proxy-Fall: ein fremder manage-Berechtigter konnte über den für alle
      // manage-Rollen sichtbaren Journal-Marker eine Genehmigung auf einer fremden Privat-
      // Ebene rückgängig machen — die Inverse lief blind am Ebenen-Guard vorbei, und
      // 200-vs-409 war ein Seitenkanal über seitherige Bearbeitung unsichtbarer Objekte.
      (v, state) => ruecknahmeErlaubt(v, state, { userId: actor.id ?? '', rolle: req.rolle! })
        ? null
        : 'Die Rücknahme ist für diesen Vorschlag nicht zulässig.');
      for (const result of ausstehendeBroadcasts) broadcast(id, result);
      broadcast(id, VORSCHLAG_SIGNAL);
      return { ok: true, rev: ergebnis.rev };
    } catch (e) {
      if (e instanceof VorschlagNichtGefundenError) return reply.code(404).send({ error: e.message });
      if (e instanceof VorschlagStatusError) return reply.code(409).send({ error: e.message });
      // WR-01 (It. 2): Rechteverweigerung der Rücknahme — generischer 403 ohne Inhaltsecho
      // (mandat_fremd-Muster: keine Auskunft über das unsichtbare Anker-Objekt).
      if (e instanceof RuecknahmeVerweigertError) return reply.code(403).send({ error: e.message });
      // OQ2-Entscheidung (12-RESEARCH.md Open Question 2): fail-honest statt hartem
      // Zurücksetzen — menschliche Zwischenarbeit wird nie still überschrieben. AI-02
      // „ohne Rückstände" bezieht sich auf die KI-Aktion, nie auf Menschenarbeit; der
      // Nutzer löst den 409 wie jeden Konflikt manuell (ansehen, ggf. Objekt
      // zurücksetzen, erneut zurücknehmen). grund ist der maschinenlesbare Retry-Kanal.
      if (e instanceof VorschlagGeaendertError) {
        return reply.code(409).send({ error: e.message, grund: 'objekt_seit_uebernahme_geaendert' });
      }
      // WR-03: CommandError beim Abspielen der persistierten Inverse (z. B. Strukturbruch
      // jenseits des updatedRev-Mitschnitts) — ehrlicher 409 statt ungemapptem 500; Rollback
      // ist bereits passiert, Status bleibt 'genehmigt'.
      if (e instanceof CommandError) return reply.code(409).send({ error: e.message, grund: 'kommando_nicht_anwendbar' });
      throw e;
    }
  });

  app.post('/api/v1/desks/:id/vorschlaege/:vorschlagId/ablehnen', { preHandler: requireDeskAktion(db, 'manage') }, async (req, reply) => {
    const { id, vorschlagId } = req.params as { id: string; vorschlagId: string };
    const actor = actorFromRequest(db, req);
    try {
      lehneVorschlagAb(db, id, vorschlagId, actor);
      broadcast(id, VORSCHLAG_SIGNAL);
      return { ok: true };
    } catch (e) {
      if (e instanceof VorschlagNichtGefundenError) return reply.code(404).send({ error: e.message });
      if (e instanceof VorschlagStatusError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });
}
