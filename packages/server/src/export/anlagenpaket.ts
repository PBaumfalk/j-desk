import { PDFDocument } from 'pdf-lib';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { effektiveFreigabe, projectStateForActor, schwaerzendeMarks, type DesktopState, type Doc } from '@j-desk/core';
import type { Db } from '../db';
import { getDeskState } from '../deskStore';
import { requireDeskAktion } from '../guards';
import { appendJournal } from '../journal';
import { actorFromRequest } from '../actor';
import { contentDisposition, dateiname } from '../download';
import { ExportFehler, erzeugeAnnotierteDokumentKopie } from './pdfExport';
import { erzeugeVorspann, zeichneInhaltsfuesse, type VerzeichnisEintrag } from './anlagenpaketDeckblatt';
import { fuegeLesezeichenEin, type Lesezeichen } from './outline';
import { extrahiereSeiten } from './verify';
import {
  bestimmeSeitenBefunde,
  findeDubletten,
  findeLeerseiten,
  findeUnbeurteilbare,
  type SeitenBefund,
} from './seitentexte';

/**
 * Anlagenpaket (KONV-01, 10-01): das Paket entsteht AUSSCHLIESSLICH aus den Ergebnissen von
 * erzeugeAnnotierteDokumentKopie() — an dieser Stelle wird zu keinem Zeitpunkt eine
 * Quelldatei, ein Vorschau-Cache oder ein Dateipfad geöffnet. Wer diese Regel bricht, umgeht
 * Schwärzung, Overlays, Scrub und Verifikationsgate in einem Schritt (Phase-9-Lehre: genau an
 * einer solchen Zustandsgrenze gab es ein echtes Schwärzungsleck). Dieselbe Freigabeprüfung
 * läuft daher je Unterlage erneut innerhalb der aufgerufenen Funktion — hier gibt es keine
 * zweite, abweichende Freigabelogik.
 */

/** DoS-Schutz (T-10-04): Deckel für die Zahl der ausgewählten Unterlagen — er greift VOR dem
 *  ersten Kopierlauf, weil jede Unterlage die volle Redaktions-/Overlay-/Scrub-/
 *  Verifikationspipeline einmal durchläuft und das die eigentlichen Kosten sind. */
export const ANLAGENPAKET_DOKUMENT_LIMIT = 50;

/** DoS-Schutz (T-10-04): Deckel für die laufende Summe der tatsächlich übernommenen Seiten
 *  über alle Unterlagen — verhindert ein Riesenpaket aus vielen mittelgroßen Dokumenten, die
 *  einzeln unter DOKUMENT_SEITEN_LIMIT bleiben. */
export const ANLAGENPAKET_SEITEN_LIMIT = 1500;

/** DoS-Schutz (T-10-04, WR-01): Deckel für die Zahl der Einträge in der Ausschlussliste —
 *  anders als eintraege und die laufende Seitensumme war dieser Wert bislang ungedeckelt, obwohl
 *  sammleAuswahl() ihn je akzeptierter Unterlage neu verarbeitet. */
export const ANLAGENPAKET_AUSGESCHLOSSENE_SEITEN_LIMIT = 5000;

export interface AnlagenpaketEintrag {
  docId: string;
  bezeichnung: string;
}

export interface AnlagenpaketWunsch {
  deckblattTitel: string;
  eintraege: AnlagenpaketEintrag[];
  ausgeschlosseneSeiten?: { docId: string; seite: number }[];
}

/** Eine Seite im fertigen Paket — die Landkarte, aus der Plan 10-02 Inhaltsverzeichnis,
 *  Seitenfüße und Lesezeichen zeichnet, statt die Reihenfolge ein zweites Mal herzuleiten. */
export interface PaketSeite {
  docId: string;
  bezeichnung: string;
  nummer: number; // K-Nummer, 1-basiert, aus der Position der tatsächlich aufgenommenen Unterlagen
  lokaleSeite: number; // 1-basierte Seite in der Quellunterlage
}

export interface AnlagenpaketErgebnis {
  bytes: Uint8Array;
  ausgelassen: number;
  seitenGesamt: number;
  seiten: PaketSeite[];
  vorspannSeiten: number;
}

/** Ergebnis der Prüfung (KONV-03, 10-04): ausschließlich Positionen und Zahlen — kein
 *  Seitentext, kein Hashwert, kein Dokumentname. Der Client kennt die Namen aus seinem
 *  eigenen Zustand. */
export interface AnlagenpaketPruefung {
  dubletten: { docId: string; lokaleSeite: number; gleichWieDocId: string; gleichWieLokaleSeite: number }[];
  leerseiten: { docId: string; lokaleSeite: number }[];
  unbeurteilbar: { docId: string; lokaleSeite: number }[];
  seitenGesamt: number;
  ausgelassen: number;
}

const TEXT_LIMIT = 200;

function gekuerzterText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, TEXT_LIMIT);
}

/**
 * Anfragekörper-Prüfung (T-10-03, nach der Konvention aus app.ts:1204-1216): manueller
 * typisierter Cast plus ausdrückliche Prüfungen, kein Schema-Validator. Jeder Verstoß wirft
 * ExportFehler('ungueltige-anfrage', …) mit einer Meldung, die keine Eingabewerte zurückspiegelt.
 */
export function lesAnlagenpaketWunsch(body: unknown): AnlagenpaketWunsch {
  if (typeof body !== 'object' || body === null) {
    throw new ExportFehler('ungueltige-anfrage', 'Der Anfragekörper hat nicht die erwartete Form.');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.deckblattTitel !== 'string') {
    throw new ExportFehler('ungueltige-anfrage', 'Der Deckblatt-Titel fehlt oder ist ungültig.');
  }
  const deckblattTitel = gekuerzterText(b.deckblattTitel);

  if (!Array.isArray(b.eintraege) || b.eintraege.length === 0) {
    throw new ExportFehler('ungueltige-anfrage', 'Es wurde keine Unterlage ausgewählt.');
  }

  const gesehen = new Set<string>();
  const eintraege: AnlagenpaketEintrag[] = b.eintraege.map((roh) => {
    if (typeof roh !== 'object' || roh === null) {
      throw new ExportFehler('ungueltige-anfrage', 'Ein Auswahleintrag hat nicht die erwartete Form.');
    }
    const e = roh as Record<string, unknown>;
    if (typeof e.docId !== 'string' || e.docId.trim() === '') {
      throw new ExportFehler('ungueltige-anfrage', 'Ein Auswahleintrag hat keine gültige Dokument-id.');
    }
    if (gesehen.has(e.docId)) {
      throw new ExportFehler('ungueltige-anfrage', 'Ein Dokument ist mehrfach in der Auswahl enthalten.');
    }
    gesehen.add(e.docId);
    // Fehlende/leere Bezeichnung ist zulässig — erzeugeAnlagenpaket ergänzt sie aus dem
    // Dokumentnamen (Festlegung 10-01).
    return { docId: e.docId, bezeichnung: gekuerzterText(e.bezeichnung) };
  });

  let ausgeschlosseneSeiten: { docId: string; seite: number }[] | undefined;
  if (b.ausgeschlosseneSeiten !== undefined) {
    if (!Array.isArray(b.ausgeschlosseneSeiten)) {
      throw new ExportFehler('ungueltige-anfrage', 'Die ausgeschlossenen Seiten haben nicht die erwartete Form.');
    }
    if (b.ausgeschlosseneSeiten.length > ANLAGENPAKET_AUSGESCHLOSSENE_SEITEN_LIMIT) {
      throw new ExportFehler('ungueltige-anfrage', 'Zu viele ausgeschlossene Seiten in der Anfrage.');
    }
    ausgeschlosseneSeiten = b.ausgeschlosseneSeiten.map((roh) => {
      if (typeof roh !== 'object' || roh === null) {
        throw new ExportFehler('ungueltige-anfrage', 'Ein Eintrag für ausgeschlossene Seiten hat nicht die erwartete Form.');
      }
      const e = roh as Record<string, unknown>;
      if (typeof e.docId !== 'string' || e.docId.trim() === '') {
        throw new ExportFehler('ungueltige-anfrage', 'Ein Eintrag für ausgeschlossene Seiten hat keine gültige Dokument-id.');
      }
      if (typeof e.seite !== 'number' || !Number.isInteger(e.seite) || e.seite < 1) {
        throw new ExportFehler('ungueltige-anfrage', 'Ein Eintrag für ausgeschlossene Seiten nennt keine gültige Seitenzahl.');
      }
      return { docId: e.docId, seite: e.seite };
    });
  }

  return { deckblattTitel, eintraege, ausgeschlosseneSeiten };
}

/** Seitenwahl je Unterlage (Pitfall 4, `konvolutPages()`-Regel aus `packages/core/src/konvolut.ts`
 *  gespiegelt): `pageOnly` steuert genau diese eine Seite bei, sonst der volle Umfang. `null`
 *  bedeutet: der `pageOnly`-Wert liegt außerhalb des Dokuments — die Unterlage wird ausgelassen. */
function seitenIndizesFuer(doc: Doc, seitenzahl: number): number[] | null {
  if (doc.pageOnly !== undefined) {
    if (doc.pageOnly < 1 || doc.pageOnly > seitenzahl) return null;
    return [doc.pageOnly - 1];
  }
  return Array.from({ length: seitenzahl }, (_, i) => i);
}

/** Ausschlussliste einmalig nach docId gruppieren (WR-01) — löst die O(Unterlagen ×
 *  Ausschlusszeilen)-Wiederholung ab, die sammleAuswahl() vorher je akzeptierter Unterlage
 *  erneut durchlief. */
function gruppiereAusschlussNachDoc(liste: { docId: string; seite: number }[] | undefined): Map<string, Set<number>> {
  const nachDoc = new Map<string, Set<number>>();
  for (const a of liste ?? []) {
    let set = nachDoc.get(a.docId);
    if (!set) {
      set = new Set<number>();
      nachDoc.set(a.docId, set);
    }
    set.add(a.seite);
  }
  return nachDoc;
}

/** Gründe, unter denen erzeugeAnnotierteDokumentKopie() eine Unterlage lautlos auslässt
 *  (F-02): unbekannt, unsichtbar/Papierkorb (⇒ 'quelle-fehlt'), Vorschau fehlt, Art nicht
 *  exportierbar, nicht freigegeben — alle vier Fälle sehen von außen identisch aus. */
const AUSLASSBARE_GRUENDE = new Set(['quelle-fehlt', 'cache-fehlt', 'art-nicht-exportierbar', 'doc-nicht-freigegeben']);

/** Eine akzeptierte Unterlage samt der tatsächlich übernommenen (0-basierten) Seitenindizes —
 *  gemeinsames Zwischenergebnis von sammleAuswahl(), von erzeugeAnlagenpaket() UND
 *  pruefeAnlagenpaket() weiterverarbeitet. */
interface AuswahlTeil {
  doc: Doc;
  bezeichnung: string;
  bytes: Uint8Array;
  indizes: number[];
}

/**
 * Gemeinsamer Auswahl- und Deckelschritt für Prüfung UND Erzeugung (KONV-01/03, 10-04): läuft
 * die Auswahl in der gelieferten Reihenfolge ab, ruft je Unterlage AUSSCHLIESSLICH
 * erzeugeAnnotierteDokumentKopie() auf, löst `pageOnly` auf und wendet — sofern gewünscht — die
 * Ausschlussliste an. Es gibt genau EINE Herleitung dieser Schritte; erzeugeAnlagenpaket() und
 * pruefeAnlagenpaket() rufen beide diesen Helfer auf, damit es nie zwei Wahrheiten über "was ist
 * die Auswahl" gibt.
 *
 * `wendeAusschlussAn = false` (Prüfroute): die Ausschlussliste bleibt unangewendet — geprüft
 * wird die VOLLSTÄNDIGE Auswahl, denn der Nutzer soll erst anhand des Prüfergebnisses
 * entscheiden, was er ausschließt.
 */
async function sammleAuswahl(
  db: Db,
  dataDir: string,
  projiziert: DesktopState,
  wunsch: AnlagenpaketWunsch,
  wendeAusschlussAn: boolean
): Promise<{ teile: AuswahlTeil[]; ausgelassen: number }> {
  if (wunsch.eintraege.length > ANLAGENPAKET_DOKUMENT_LIMIT) {
    throw new ExportFehler('limit', `Zu viele Unterlagen für ein Anlagenpaket (${wunsch.eintraege.length} von ${ANLAGENPAKET_DOKUMENT_LIMIT})`);
  }

  let ausgelassen = 0;
  let seitenGesamt = 0;
  const teile: AuswahlTeil[] = [];

  // WR-01: einmal nach docId gruppieren statt je akzeptierter Unterlage die gesamte
  // Ausschlussliste erneut zu filtern (bis zu ANLAGENPAKET_DOKUMENT_LIMIT Wiederholungen) —
  // zusammen mit dem Größendeckel auf ausgeschlosseneSeiten (lesAnlagenpaketWunsch) macht das die
  // Gesamtkosten dieses Schritts unabhängig von der Zahl der Unterlagen.
  const ausschlussNachDoc = wendeAusschlussAn ? gruppiereAusschlussNachDoc(wunsch.ausgeschlosseneSeiten) : new Map<string, Set<number>>();

  for (const eintrag of wunsch.eintraege) {
    const doc = projiziert.docs.find((d) => d.id === eintrag.docId);
    // Unbekannt, unsichtbar oder im Papierkorb: dieselbe Behandlung wie eine fehlende
    // Freigabe (F-02) — kein Fehler, kein Unterschied im beobachtbaren Verhalten.
    if (!doc || effektiveFreigabe(doc, projiziert.layers) !== 'export') {
      ausgelassen++;
      continue;
    }

    let kopie: Awaited<ReturnType<typeof erzeugeAnnotierteDokumentKopie>>;
    try {
      kopie = await erzeugeAnnotierteDokumentKopie(db, dataDir, projiziert, eintrag.docId);
    } catch (e) {
      if (e instanceof ExportFehler && AUSLASSBARE_GRUENDE.has(e.reason)) {
        ausgelassen++;
        continue;
      }
      // 'verifikation-fehlgeschlagen', 'parse-fehler' und 'limit' brechen die Erzeugung ab —
      // ein Dokument, dessen Schwärzung nicht verifiziert werden konnte, darf niemals
      // stillschweigend weggelassen werden.
      throw e;
    }

    const indizes = seitenIndizesFuer(doc, kopie.seitenzahl);
    if (indizes === null) {
      ausgelassen++;
      continue;
    }
    const ausschluss = ausschlussNachDoc.get(eintrag.docId) ?? new Set<number>();
    const gefiltert = indizes.filter((i) => !ausschluss.has(i + 1));
    if (gefiltert.length === 0) {
      ausgelassen++;
      continue;
    }

    // Laufende Summe VOR dem Kopieren der nächsten Unterlage prüfen (T-10-04).
    seitenGesamt += gefiltert.length;
    if (seitenGesamt > ANLAGENPAKET_SEITEN_LIMIT) {
      throw new ExportFehler('limit', `Zu viele Seiten für ein Anlagenpaket (${seitenGesamt} von ${ANLAGENPAKET_SEITEN_LIMIT})`);
    }

    teile.push({ doc, bezeichnung: eintrag.bezeichnung || doc.name, bytes: kopie.bytes, indizes: gefiltert });
  }

  return { teile, ausgelassen };
}

/**
 * Zusammenbau des Anlagenpakets (KONV-01/02/03, 10-01): fügt die von sammleAuswahl() (MIT
 * angewendeter Ausschlussliste) gelieferten, bereits redigierten/gescrubbten/verifizierten
 * Seiten zusammen.
 */
export async function erzeugeAnlagenpaket(
  db: Db,
  dataDir: string,
  projiziert: DesktopState,
  wunsch: AnlagenpaketWunsch
): Promise<AnlagenpaketErgebnis> {
  const { teile: akzeptiert, ausgelassen } = await sammleAuswahl(db, dataDir, projiziert, wunsch, true);

  if (akzeptiert.length === 0) {
    throw new ExportFehler('keine-dokumente', 'Keine der ausgewählten Unterlagen ist für den Export verfügbar.');
  }

  const paket = await PDFDocument.create();
  const seiten: PaketSeite[] = [];
  let nummer = 0;
  for (const { doc, bezeichnung, bytes, indizes } of akzeptiert) {
    nummer++;
    const quelle = await PDFDocument.load(bytes);
    const kopierteSeiten = await paket.copyPages(quelle, indizes);
    kopierteSeiten.forEach((seite, idx) => {
      paket.addPage(seite);
      seiten.push({ docId: doc.id, bezeichnung, nummer, lokaleSeite: indizes[idx] + 1 });
    });
  }

  // Inhaltsverzeichnis-Zeilen (KONV-02): je Anlagennummer der erste Eintrag aus der `seiten`-
  // Landkarte, damit Verzeichnis, Seitenfüße (unten) und Lesezeichen (Plan 10-02 Task 3) alle
  // aus derselben einen Liste lesen — es gibt keine zweite Herleitung der Reihenfolge.
  const verzeichnis: VerzeichnisEintrag[] = [];
  for (let i = 0; i < seiten.length; i++) {
    const s = seiten[i];
    if (verzeichnis.some((v) => v.nummer === s.nummer)) continue;
    verzeichnis.push({
      nummer: s.nummer,
      bezeichnung: s.bezeichnung,
      startSeite: i + 1,
      seiten: seiten.filter((x) => x.nummer === s.nummer).length,
    });
  }

  const vorspann = await erzeugeVorspann(wunsch.deckblattTitel, verzeichnis, seiten.length, ausgelassen);
  const vorspannSeiten = vorspann.getPageCount();
  // Dasselbe Kopierprimitiv wie beim Zusammenfügen der Anlagen oben — kein zweiter Mechanismus.
  const vorspannKopien = await paket.copyPages(vorspann, vorspann.getPageIndices());
  vorspannKopien.forEach((seite, i) => paket.insertPage(i, seite));

  await zeichneInhaltsfuesse(paket, vorspannSeiten, seiten.map((s) => s.nummer));

  // Lesezeichenbaum als LETZTER Schritt vor save() (KONV-02, Task 3): der Katalogeintrag für
  // Lesezeichen wird vom Bereinigungslauf bedingungslos entfernt (scrub.ts); jede Quellunterlage
  // ist bereits einzeln bereinigt (innerhalb von erzeugeAnnotierteDokumentKopie), das
  // zusammengefügte Dokument darf deshalb keinen weiteren Bereinigungslauf sehen. Diese
  // Bedingung ist kein Stilhinweis, sondern der Grund dafür, dass die Funktion überhaupt wirkt —
  // ein Bereinigungslauf HIER oder danach würde die Lesezeichen lautlos wieder löschen.
  const lesezeichen: Lesezeichen[] = [
    { titel: 'Anlagenverzeichnis', seite: paket.getPage(0) },
    ...verzeichnis.map((e) => ({
      titel: `K${e.nummer} — ${e.bezeichnung}`,
      seite: paket.getPage(vorspannSeiten + e.startSeite - 1),
    })),
  ];
  fuegeLesezeichenEin(paket, lesezeichen);

  // Das zusammengefügte Dokument wird NICHT noch einmal gescrubbt — jede Quelle ist bereits
  // einzeln bereinigt (innerhalb von erzeugeAnnotierteDokumentKopie), und ein weiterer Lauf
  // würde den Katalogeintrag für Lesezeichen entfernen, den Plan 10-02 anlegt (Pitfall 1).
  const bytes = await paket.save();
  // seiten.length entspricht exakt der Summe der in sammleAuswahl() akzeptierten Seiten — jeder
  // Index in `indizes` liefert genau eine kopierte Seite (kopierteSeiten.forEach oben).
  return { bytes, ausgelassen, seitenGesamt: seiten.length, seiten, vorspannSeiten };
}

/**
 * Prüfung ohne Erzeugung (KONV-03, 10-04): dieselbe Auswahl-/Deckellogik wie erzeugeAnlagenpaket
 * (sammleAuswahl), aber OHNE Ausschlussliste — geprüft wird die vollständige Auswahl, denn der
 * Nutzer soll erst anhand des Prüfergebnisses entscheiden, was er ausschließt. Liest je Unterlage
 * ausschließlich das bereits geschwärzte Ergebnis von erzeugeAnnotierteDokumentKopie() — nie die
 * Quelldatei — und erzeugt kein Artefakt, keinen Journaleintrag, keinen Seitentext in der
 * Antwort.
 */
export async function pruefeAnlagenpaket(
  db: Db,
  dataDir: string,
  projiziert: DesktopState,
  wunsch: AnlagenpaketWunsch
): Promise<AnlagenpaketPruefung> {
  const { teile, ausgelassen } = await sammleAuswahl(db, dataDir, projiziert, wunsch, false);

  const alleBefunde: SeitenBefund[] = [];
  for (const { doc, bytes, indizes } of teile) {
    // KOPIE (dieselbe Notwendigkeit wie im Verifikationsgate): pdfjs übernimmt den Buffer als
    // Transferable — ohne slice() wären die Bytes danach nicht mehr verwendbar.
    const seitenTexte = await extrahiereSeiten(bytes.slice());
    const lokaleSeiten = indizes.map((i) => i + 1);
    // Dieselben Markierungen, die erzeugeAnnotierteDokumentKopie() tatsächlich einbrennt (eine
    // Wahrheit, kein zweiter Filter): das ist seit dem Schwärzungs-Fix JEDE projizierte
    // redact-/tippex-Markierung, unabhängig von ihrer Freigabe-Stufe — eine Schwärzung ist
    // subtraktiv und wirkt stufenunabhängig (schwaerzendeMarks, freigabe.ts). Über
    // freigabeFilter gelesen hätte diese Prüfung intern eingestufte Schwärzungen übersehen und
    // die Textquellenregel auf einer Seite falsch entschieden, die im Artefakt sehr wohl
    // geschwärzt ist.
    const seitenMitSchwaerzung = new Set(
      lokaleSeiten.filter((seite) => schwaerzendeMarks(projiziert, doc.id, seite).length > 0)
    );
    const seitenTexteFuerAuswahl = indizes.map((i) => seitenTexte[i] ?? '');
    alleBefunde.push(...bestimmeSeitenBefunde(db, doc, lokaleSeiten, seitenTexteFuerAuswahl, seitenMitSchwaerzung));
  }

  return {
    dubletten: findeDubletten(alleBefunde),
    leerseiten: findeLeerseiten(alleBefunde),
    unbeurteilbar: findeUnbeurteilbare(alleBefunde),
    seitenGesamt: alleBefunde.length,
    ausgelassen,
  };
}

/**
 * Erzeugungs- und Prüfungsrouten (10-01/10-04): dieselbe Sicherheitskette wie alle übrigen
 * Übergaberouten (requireDeskAktion('export') → getDeskState → projectStateForActor). Wichtig:
 * freigabeFilter wird bei der Erzeugung HIER nicht erneut aufgerufen — die Filterung geschieht
 * je Unterlage innerhalb von erzeugeAnnotierteDokumentKopie, damit es genau eine Wahrheit gibt.
 */
export function registriereAnlagenpaketRouten(app: FastifyInstance, db: Db, dataDir: string): void {
  app.post(
    '/api/v1/desks/:id/export/pdf/anlagenpaket',
    { preHandler: requireDeskAktion(db, 'export') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = db.prepare('SELECT name FROM desks WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
      const result = getDeskState(db, id);
      if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
      const userId = (req as FastifyRequest & { userId?: string }).userId;
      const projiziert = projectStateForActor(result.state, { userId, rolle: req.rolle! });

      try {
        const wunsch = lesAnlagenpaketWunsch(req.body);
        const ergebnis = await erzeugeAnlagenpaket(db, dataDir, projiziert, wunsch);

        // HIST-04: kein Dokumentname und keine Anzahl im Nutzdatensatz (dasselbe Muster wie
        // der Einzeldokument-Export).
        const actor = actorFromRequest(db, req);
        appendJournal(db, {
          deskId: id, rev: result.rev, type: 'exported', payload: { format: 'anlagenpaket' },
          actorId: actor.id, actorName: actor.name,
        });
        reply.header('content-type', 'application/pdf');
        reply.header('x-anlagenpaket-ausgelassen', String(ergebnis.ausgelassen));
        reply.header('content-disposition', contentDisposition(dateiname(`${row.name}-anlagenpaket`, '.pdf')));
        return Buffer.from(ergebnis.bytes);
      } catch (e) {
        if (e instanceof ExportFehler) {
          return reply.code(422).send({ error: e.message, reason: e.reason });
        }
        throw e; // Bestandsmuster: Unerwartetes bleibt 500 im Server-Log
      }
    }
  );

  // Prüfroute (KONV-03, 10-04): dieselbe Sicherheitskette wie die Erzeugung, aber OHNE
  // Journal-Aufruf — die Prüfung erzeugt kein Artefakt, es gibt nichts zu protokollieren. Das
  // ist kein Vergessen, sondern eine bewusste Abweichung vom Erzeugungspfad (s. Docstring
  // pruefeAnlagenpaket).
  app.post(
    '/api/v1/desks/:id/export/anlagenpaket/pruefung',
    { preHandler: requireDeskAktion(db, 'export') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = getDeskState(db, id);
      if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
      const userId = (req as FastifyRequest & { userId?: string }).userId;
      const projiziert = projectStateForActor(result.state, { userId, rolle: req.rolle! });

      try {
        const wunsch = lesAnlagenpaketWunsch(req.body);
        const pruefung = await pruefeAnlagenpaket(db, dataDir, projiziert, wunsch);
        return pruefung;
      } catch (e) {
        if (e instanceof ExportFehler) {
          return reply.code(422).send({ error: e.message, reason: e.reason });
        }
        throw e; // Bestandsmuster: Unerwartetes bleibt 500 im Server-Log
      }
    }
  );
}
