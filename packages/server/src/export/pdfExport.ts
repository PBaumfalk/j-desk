import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  effektiveFreigabe, freigabeFilter, projectStateForActor, VERSIONIERTE_ARTEN,
  type DesktopState, type Freigabe,
} from '@j-desk/core';
import type { Db } from '../db';
import { getDeskState } from '../deskStore';
import { requireDeskAktion } from '../guards';
import { appendJournal } from '../journal';
import { actorFromRequest } from '../actor';
import { contentDisposition, dateiname } from '../download';
import { MAX_SIZE, getFilePath } from '../files';
import { previewCachePath } from '../convert';
import { basisNachUserSpace, seiteBrauchtFallback, seitenGeometrieVon } from './coordinates';
import { redactiereSeite } from './redact';
import { scrubbePdf } from './scrub';
import { brenneOverlaysEin } from './overlays';
import { rasteriereSeiteFailClosed } from './raster';
import { extrahiereText } from './verify';
import {
  erzeugeArgumentationPdf,
  erzeugeAufgabenlistePdf,
  erzeugeBeweismittelPdf,
  erzeugeFundstellenPdf,
  erzeugeSnapshotPdf,
  sammleFundstellenKandidaten,
} from './uebersichten';

/** Grund-Diskriminator für Export-Fehler (ConvertError-Muster aus convert.ts). */
export type ExportFehlerReason =
  | 'limit' // DoS-Schutz: Seiten-/Objekt-/Größenlimit überschritten (T-03-04-03, T-03-07-04, T-03-08-04)
  | 'doc-nicht-freigegeben' // Doc-Gate: effektive freigabe ≠ 'export' (Open Question 2, T-03-07-02)
  | 'quelle-fehlt' // Originaldatei nicht auf der Platte
  | 'cache-fehlt' // Convertible ohne Vorschau-Cache (Pitfall 5, T-03-07-03)
  | 'art-nicht-exportierbar' // kind 'other' / nicht einbettbares Bildformat
  | 'parse-fehler' // korrupte/präparierte PDF-Bytes (T-03-07-04)
  | 'verifikation-fehlgeschlagen' // Gate-Treffer oder Fallback ohne Rasterer (T-03-07-01)
  | 'keine-fundstellen' // Fundstellen-Route: leere (freigegebene) Fundstellen-Menge (03-08)
  | 'unbekannte-fundstelle' // Fundstellen-Route: ids enthält unbekannte/nicht freigegebene id (03-08)
  | 'unbekanntes-format' // Statistik-Route: format-Query weder bekannt noch leer (03-10)
  | 'keine-dokumente' // Anlagenpaket: nach dem Auslassen bleibt keine Unterlage übrig (10-01)
  | 'ungueltige-anfrage'; // Anlagenpaket: Anfragekörper hat nicht die erwartete Form (10-01)

/**
 * Export-Fehler mit reason-Discriminator (ConvertError-Muster aus convert.ts): die Route
 * mappt Gründe auf Statuscodes, statt Fehlertexte zu raten. 'limit' ist der DoS-Schutz
 * (03-RESEARCH Security, T-03-04-03); weitere Gründe folgen mit den Formaten.
 */
export class ExportFehler extends Error {
  constructor(readonly reason: ExportFehlerReason, message: string) {
    super(message);
    this.name = 'ExportFehler';
  }
}

/**
 * DoS-Schutz (T-03-04-03): Deckel für die Objektzahl je Übersichts-Export — ein riesiger
 * Desk erzeugt sonst ein Riesen-PDF mit langer Renderzeit. Gezählt wird der bereits
 * gefilterte State; die Meldung nennt nur die Zahl der FREIGEGEBENEN Objekte (kein Leck).
 */
export const UEBERSICHT_OBJEKT_LIMIT = 2000;

function pruefeUebersichtLimit(state: DesktopState): void {
  const n =
    state.docs.length +
    state.links.length +
    state.stacks.length +
    (state.notes?.length ?? 0) +
    (state.cutouts?.length ?? 0) +
    (state.marks?.length ?? 0) +
    (state.stamps?.length ?? 0) +
    (state.flags?.length ?? 0) +
    (state.clips?.length ?? 0) +
    (state.strokes?.length ?? 0);
  if (n > UEBERSICHT_OBJEKT_LIMIT) {
    throw new ExportFehler('limit', `Zu viele freigegebene Objekte für die Übersicht (${n} von ${UEBERSICHT_OBJEKT_LIMIT})`);
  }
}

type UebersichtErzeuger = (state: DesktopState, titel: string) => Promise<Uint8Array>;

/**
 * PDF-Export-Routen (EXP-03/EXP-05, D-02): die Erzeugung läuft AUSSCHLIESSLICH serverseitig
 * — eine clientseitige Erzeugung ließe sich an der Phase-2-Projektionsgarantie vorbei
 * betreiben; der Client löst nur aus und lädt herunter (D-13).
 *
 * Sicherheitskette jeder Route — die Reihenfolge IST die Garantie (D-02), darum genau EIN
 * registrierender Helfer für alle Übersichtsformate (keine Route kann den Filter vergessen,
 * T-03-04-02):
 *   requireDeskAktion('export')  → Rolle + Aktionsrecht im preHandler (unumgänglich)
 *   getDeskState                 → voller State (404 wie Bestand)
 *   projectStateForActor         → erst die rollengerechte Sicht (PERM-05)
 *   freigabeFilter               → dann die Freigabe (EXP-03): lautlos, ohne jeden Hinweis
 *   Pipeline                     → pdf-lib; Antwort application/pdf + Content-Disposition
 * Projektion VOR Filter (analog buildPackage in jdesk.ts): der Filter muss auf dem Stand
 * arbeiten, den der Anfragende sehen darf — umgekehrt könnte die Export-Entscheidung über
 * ein für ihn unsichtbares Objekt indirekt Information liefern.
 */
function registriereUebersichtRoute(
  app: FastifyInstance,
  db: Db,
  pfad: string,
  formatTitel: string,
  dateiSuffix: string,
  erzeuger: UebersichtErzeuger,
): void {
  app.get(`/api/v1/desks/:id/export/pdf/${pfad}`, { preHandler: requireDeskAktion(db, 'export') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Der Dateiname kommt aus dem Schreibtischnamen, niemals aus Roheingabe (Bestandsmuster).
    const row = db.prepare('SELECT name FROM desks WHERE id = ?').get(id) as { name: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const userId = (req as FastifyRequest & { userId?: string }).userId;
    const projiziert = projectStateForActor(result.state, { userId, rolle: req.rolle! });
    const freigegeben = freigabeFilter(projiziert);
    try {
      pruefeUebersichtLimit(freigegeben);
      const bytes = await erzeuger(freigegeben, `${formatTitel} — ${row.name}`);
      // HIST-04 (P-06/P-07): journalisiert NACH erfolgreicher Erzeugung, VOR der Auslieferung —
      // deckt alle vier Übersichtsformate ab, weil `pfad` bereits die stabile Format-Kennung
      // trägt. Kein Journal-Eintrag, falls pruefeUebersichtLimit/erzeuger im 422-Pfad landet.
      const actor = actorFromRequest(db, req);
      appendJournal(db, { deskId: id, rev: result.rev, type: 'exported', payload: { format: pfad }, actorId: actor.id, actorName: actor.name });
      reply.header('content-type', 'application/pdf');
      reply.header('content-disposition', contentDisposition(dateiname(`${row.name}-${dateiSuffix}`, '.pdf')));
      return Buffer.from(bytes);
    } catch (e) {
      if (e instanceof ExportFehler && e.reason === 'limit') {
        return reply.code(422).send({ error: e.message });
      }
      throw e;
    }
  });
}

/** DoS-Schutz (T-03-07-04): Seitendeckel je Dokument-Export — Riesen-PDFs binden sonst
 *  Parser und Renderer über Gebühr; die Meldung nennt nur die Seitenzahl. */
export const DOKUMENT_SEITEN_LIMIT = 500;

/** Einseitiges PDF aus einem Bild (kind 'image'): kein Rewrite nötig — ein Bild trägt keinen
 *  extrahierbaren Text; Overlays laufen danach über die gemeinsame Pipeline. pdf-lib kann
 *  nur JPEG/PNG einbetten — GIF/WebP werden mit klarer Meldung abgelehnt. */
async function pdfAusBild(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const istPng = bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const istJpg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!istPng && !istJpg) {
    throw new ExportFehler('art-nicht-exportierbar', 'Dieses Bildformat kann nicht als PDF exportiert werden (nur JPEG/PNG)');
  }
  const bild = istPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const seite = doc.addPage([bild.width, bild.height]);
  seite.drawImage(bild, { x: 0, y: 0, width: bild.width, height: bild.height });
  return doc;
}

/** Weißraum-Normalisierung für den Gate-Vergleich: pdfjs-Extraktionen (Client-Snapshot UND
 *  Gate) brechen Zeilen/Leerräume unterschiedlich auf — verglichen wird auf Wortebene.
 *  Exportiert, weil Plan 10-04 dieselbe Weißraumregel braucht — zwei Kopien wären zwei
 *  Wahrheiten. */
export function normalisiere(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Ergebnis einer annotierten PDF-Kopie (EXP-01/10-01): die Bytes haben die vollständige
 *  Sicherheitskette durchlaufen (Redaktion → Overlays → Scrub → Verifikation). */
export interface AnnotierteKopie {
  bytes: Uint8Array;
  seitenzahl: number;
}

/**
 * Pfad zur Originaldatei eines Dokuments — die EINE Stelle, an der beide Betriebsarten
 * zusammenlaufen.
 *
 * Eigenständiger Betrieb: die Datei liegt inhaltsadressiert in der lokalen Ablage
 * (files-Tabelle, getFilePath). Im j-lawyer-Modus liegt sie dort NIE — führendes System ist
 * j-lawyer, der Server hält nur den Plattencache unter `data/jlcache`, den cachedDocBytes()
 * (app.ts) beim ersten Anzeigen des Dokuments füllt. Ohne diesen zweiten Weg scheiterte JEDER
 * Export, der das Original braucht (annotierte Kopie, Fundstellen-PDF und darüber auch das
 * Anlagenpaket), im Normalbetrieb mit 'quelle-fehlt'.
 *
 * Schlüsselkonvention identisch zu cachedDocBytes(): `<bereinigte fileId>-<changeDate>.pdf`;
 * `sourceChangeDate` im Modell IST das j-lawyer-changeDate. Läuft die Konvention hier und dort
 * auseinander, fällt der Export still auf 'quelle-fehlt' zurück.
 */
function originalPfad(
  db: Db,
  dataDir: string,
  doc: { fileId: string; sourceChangeDate?: number },
): string | null {
  const lokal = getFilePath(db, dataDir, doc.fileId);
  if (lokal) return lokal;
  if (doc.sourceChangeDate === undefined) return null;
  const safe = doc.fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const pfad = join(dataDir, 'jlcache', `${safe}-${doc.sourceChangeDate}.pdf`);
  return existsSync(pfad) ? pfad : null;
}

/**
 * Annotierte PDF-Kopie (EXP-01, D-04, 10-01): die Pipeline-Reihenfolge IST die
 * Sicherheitsgarantie (03-RESEARCH Architektur) — Doc-Gate → Quelle wählen → load →
 * Redaktion (echte Schwärzung) → Overlays einbrennen → Scrub → save → Verifikationsgate.
 * Kein Pfad darf ein ungeprüftes Artefakt ausliefern (T-03-07-01). Dies ist der EINZIGE
 * Weg, auf dem Dokumentbytes für ein PDF-Artefakt entstehen dürfen — jeder weitere
 * Erzeugungsweg (z. B. das Anlagenpaket, 10-01) muss diese Funktion aufrufen statt die
 * Kette nachzubauen.
 */
export async function erzeugeAnnotierteDokumentKopie(
  db: Db,
  dataDir: string,
  projiziert: DesktopState,
  docId: string
): Promise<AnnotierteKopie> {
  const doc = projiziert.docs.find((d) => d.id === docId);
  if (!doc) throw new ExportFehler('quelle-fehlt', 'Dokument nicht gefunden');

  // Doc-Gate (fail-closed, T-03-07-02): ohne effektive Doc-Freigabe 'export' wird
  // nichts ausgeliefert — auch dann nicht, wenn einzelne Annotationen freigegeben sind.
  if (effektiveFreigabe(doc, projiziert.layers) !== 'export') {
    throw new ExportFehler(
      'doc-nicht-freigegeben',
      `Das Dokument "${doc.name}" ist nicht für den Export freigegeben`
    );
  }
  // Ab hier zählt nur noch die freigegebene Sicht (Annotationen mit freigabe ≠ export
  // fehlen restlos, D-05/D-06/D-08).
  const freigegeben = freigabeFilter(projiziert);

  // Quelle wählen (Pitfall 5, T-03-07-03): convertible IMMER aus dem Vorschau-Cache —
  // die Geometrie der Annotationen bezieht sich auf das Vorschau-PDF, das der Nutzer sah.
  const kind = doc.kind ?? 'pdf';
  let quellBytes: Uint8Array | null = null;
  let pdfDoc: PDFDocument;
  if (kind === 'convertible') {
    // cacheKey-Konvention aus app.ts: eigene Ablage = fileId (inhaltsadressiert);
    // j-lawyer-Docs = docId-changeDate (versioniert, sourceChangeDate im Modell).
    const cacheKey =
      doc.sourceChangeDate !== undefined ? `${doc.fileId}-${doc.sourceChangeDate}` : doc.fileId;
    const cachePfad = previewCachePath(dataDir, cacheKey);
    if (!existsSync(cachePfad)) {
      throw new ExportFehler(
        'cache-fehlt',
        'Für dieses Dokument liegt noch keine Vorschau vor — bitte zuerst die Vorschau öffnen und danach erneut exportieren'
      );
    }
    quellBytes = readFileSync(cachePfad);
  } else if (kind === 'pdf' || kind === 'image') {
    const pfad = originalPfad(db, dataDir, doc);
    if (!pfad) throw new ExportFehler('quelle-fehlt', 'Die Originaldatei wurde nicht gefunden');
    quellBytes = readFileSync(pfad);
  } else {
    throw new ExportFehler('art-nicht-exportierbar', 'Diese Datei-Art kann nicht als PDF exportiert werden');
  }
  if (quellBytes.length > MAX_SIZE) {
    throw new ExportFehler('limit', 'Das Dokument ist zu groß für den Export');
  }

  try {
    pdfDoc =
      kind === 'image'
        ? await pdfAusBild(quellBytes)
        : await PDFDocument.load(quellBytes, { ignoreEncryption: true });
  } catch (e) {
    if (e instanceof ExportFehler) throw e;
    // Korrupte/präparierte Bytes: 422 mit klarer Meldung, kein Stacktrace (T-03-07-04)
    throw new ExportFehler('parse-fehler', 'Das Dokument konnte nicht gelesen werden (beschädigt oder kein gültiges PDF)');
  }
  const seiten = pdfDoc.getPages();
  if (seiten.length > DOKUMENT_SEITEN_LIMIT) {
    throw new ExportFehler('limit', `Das Dokument hat zu viele Seiten für den Export (${seiten.length} von ${DOKUMENT_SEITEN_LIMIT})`);
  }

  // Pipeline: pro Seite erst redigieren (echte Schwärzung), dann Overlays einbrennen.
  const angewendeteSnapshots: string[] = [];
  for (let i = 0; i < seiten.length; i++) {
    const seite = seiten[i];
    const geo = seitenGeometrieVon(seite);
    const marks = (freigegeben.marks ?? []).filter((m) => m.docId === docId && m.page === i + 1);
    const strokes = (freigegeben.strokes ?? []).filter((s) => s.docId === docId && s.page === i + 1);
    const stamps = (freigegeben.stamps ?? []).filter((s) => s.docId === docId && s.page === i + 1);

    // Rotations-Check GILT FÜR JEDE Seite, nicht nur für welche mit Schwärzungen (WR-01):
    // overlays.ts' Invariante "Overlays kommen nur auf unrotierten Seiten zum Zug" gilt
    // auch für Seiten mit Strokes/Stamps, aber ohne redact/tippex-Mark — sonst würden
    // Stempel/Striche mit den unrotierten coordinates.ts-Transforms falsch positioniert
    // eingebrannt (fachlich relevant z. B. bei einem Kanzlei-Stempel).
    if (seiteBrauchtFallback(geo)) {
      if (marks.length + strokes.length + stamps.length > 0) {
        // Fallback-Pfad (Open Question 1/4): Seite rasterisieren — ohne installierten
        // Rasterer bricht rasterisiereSeite den Export fail-closed ab. NIE einfach
        // weitermachen, als wäre die Seite sauber redigiert/positioniert.
        await rasteriereSeiteFailClosed(quellBytes, i);
      }
      continue; // niemals Overlays auf eine Seite brennen, deren Geometrie wir nicht trauen
    }

    // redact UND tippex schwärzen echt (D-01): beide löschen den darunterliegenden Text
    const schwaerzungen = marks.filter((m) => m.kind === 'redact' || m.kind === 'tippex');
    if (schwaerzungen.length > 0) {
      const rects = schwaerzungen.map((m) => basisNachUserSpace(m.rect, geo));
      const erg = redactiereSeite(pdfDoc, seite, rects, geo);
      if (erg.rotationsAbgelehnt || erg.xobjectTextVerdacht > 0) {
        // Fallback-Pfad (Open Question 1/4): Seite rasterisieren — ohne installierten
        // Rasterer bricht rasterisiereSeite den Export fail-closed ab. NIE einfach
        // weitermachen, als wäre die Seite sauber redigiert.
        await rasteriereSeiteFailClosed(quellBytes, i);
      }
      for (const m of schwaerzungen) {
        if (m.textSnapshot !== undefined && m.textSnapshot !== '') angewendeteSnapshots.push(m.textSnapshot);
      }
    }
    await brenneOverlaysEin(seite, { marks, strokes, stamps }, geo);
  }

  scrubbePdf(pdfDoc);
  const ergebnisBytes = await pdfDoc.save();

  // Verifikationsgate (fail-closed, T-03-07-01): die ERGEBNIS-Bytes werden erneut per
  // pdfjs gelesen und gegen JEDEN angewendeten textSnapshot geprüft. Ein Treffer heißt:
  // Rest-Text hat überlebt — dann gibt es kein Artefakt (Raster-Fallback ist oben schon
  // versucht bzw. nicht verfügbar).
  // KOPIE: pdfjs übernimmt den übergebenen Buffer als Transferable (detach) — ohne
  // slice() wären ergebnisBytes nach dem Gate leer und die Route läge ein 0-Byte-PDF bei.
  const extraktion = normalisiere(await extrahiereText(ergebnisBytes.slice()));
  for (const snapshot of angewendeteSnapshots) {
    if (extraktion.includes(normalisiere(snapshot))) {
      throw new ExportFehler(
        'verifikation-fehlgeschlagen',
        'Die Schwärzung konnte nicht verifiziert werden; der Export wurde abgebrochen, damit kein ungeprüftes Dokument entsteht'
      );
    }
  }

  return { bytes: ergebnisBytes, seitenzahl: seiten.length };
}

/**
 * Route für den Einzeldokument-Export (EXP-01): dünner Mantel um
 * erzeugeAnnotierteDokumentKopie() — Params lesen, State projizieren, Doc-Sichtbarkeit
 * prüfen (404), die Kopier-Pipeline aufrufen, danach Journal/Antwortkopf setzen.
 */
function registriereDokumentRoute(app: FastifyInstance, db: Db, dataDir: string): void {
  app.get(
    '/api/v1/desks/:id/export/pdf/dokument/:docId',
    { preHandler: requireDeskAktion(db, 'export') },
    async (req, reply) => {
      const { id, docId } = req.params as { id: string; docId: string };
      const result = getDeskState(db, id);
      if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
      const userId = (req as FastifyRequest & { userId?: string }).userId;
      // Projektion VOR dem Doc-Gate: 'nicht vorhanden' und 'für diese Rolle nicht sichtbar'
      // bekommen dieselbe 404-Meldung (Existenz-Leck, T-03-07-05). Die Freigabe-Prüfung ist
      // dagegen bewusst 422 mit klarer Meldung (Open Question 2) — die Existenz des Docs
      // ist für den Anfragenden ohnehin sichtbar.
      const projiziert = projectStateForActor(result.state, { userId, rolle: req.rolle! });
      const doc = projiziert.docs.find((d) => d.id === docId);
      if (!doc) return reply.code(404).send({ error: 'Dokument nicht gefunden' });

      try {
        const { bytes: ergebnisBytes } = await erzeugeAnnotierteDokumentKopie(db, dataDir, projiziert, docId);

        // HIST-04 (P-06/P-07): journalisiert erst nach dem Verifikationsgate — kein docId,
        // kein Dokumentname im Payload (das wäre Phase-12-Scope und spiegelte den
        // Aktendateinamen ins Journal).
        const actor = actorFromRequest(db, req);
        appendJournal(db, { deskId: id, rev: result.rev, type: 'exported', payload: { format: 'dokument' }, actorId: actor.id, actorName: actor.name });
        reply.header('content-type', 'application/pdf');
        reply.header('content-disposition', contentDisposition(dateiname(`${doc.name}-annotiert`, '.pdf')));
        return Buffer.from(ergebnisBytes);
      } catch (e) {
        if (e instanceof ExportFehler) {
          return reply.code(422).send({ error: e.message, reason: e.reason });
        }
        throw e; // Bestandsmuster: Unerwartetes bleibt 500 im Server-Log
      }
    }
  );
}

/**
 * Quelle wählen für die Fundstellen-Pipeline (03-08): derselbe Cache-/Datei-Wahlweg wie die
 * annotierte Kopie (03-07, Pitfall 5) — convertible IMMER aus dem Vorschau-Cache, sonst das
 * Original. Wirft ExportFehler bei fehlender/nicht unterstützter Quelle; erzeugeFundstellenPdf
 * fängt das pro Fundstelle ab (die Fundstelle fällt lautlos weg, D-15) statt die ganze Route
 * abzubrechen — ein einzelnes kaputtes Quelldokument darf den restlichen Export nicht verhindern.
 */
function macheLadeDocBytes(db: Db, dataDir: string, state: DesktopState): (docId: string) => Promise<Uint8Array> {
  return async (docId: string): Promise<Uint8Array> => {
    const doc = state.docs.find((d) => d.id === docId);
    if (!doc) throw new ExportFehler('quelle-fehlt', 'Dokument nicht gefunden');
    const kind = doc.kind ?? 'pdf';
    if (kind === 'convertible') {
      const cacheKey = doc.sourceChangeDate !== undefined ? `${doc.fileId}-${doc.sourceChangeDate}` : doc.fileId;
      const cachePfad = previewCachePath(dataDir, cacheKey);
      if (!existsSync(cachePfad)) {
        throw new ExportFehler('cache-fehlt', 'Für dieses Dokument liegt noch keine Vorschau vor');
      }
      return readFileSync(cachePfad);
    }
    if (kind === 'pdf') {
      const pfad = originalPfad(db, dataDir, doc);
      if (!pfad) throw new ExportFehler('quelle-fehlt', 'Die Originaldatei wurde nicht gefunden');
      return readFileSync(pfad);
    }
    throw new ExportFehler('art-nicht-exportierbar', 'Diese Datei-Art unterstützt keine Fundstellen');
  };
}

/**
 * Fundstellen-Route (EXP-02, D-04, 03-08): derselbe Guard-Dreischritt wie alle Übergabe-Routen
 * (Sicherheitskette in registriereUebersichtRoute oben) — zusätzlich validiert die Route den
 * optionalen `ids`-Query-Parameter (untrusted Eingabe, 03-RESEARCH V5) serverseitig GEGEN die
 * bereits freigabe-gefilterte Kandidatenmenge: jede angeforderte id muss dort existieren, sonst
 * 422 (unbekannte ID UND „existiert, ist aber nicht freigegeben" erhalten bewusst dieselbe
 * Meldung — beides ist für den Anfragenden gleich uninformativ, kein Existenz-Leck).
 */
function registriereFundstellenRoute(app: FastifyInstance, db: Db, dataDir: string): void {
  app.get(
    '/api/v1/desks/:id/export/pdf/fundstellen',
    { preHandler: requireDeskAktion(db, 'export') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = db.prepare('SELECT name FROM desks WHERE id = ?').get(id) as { name: string } | undefined;
      if (!row) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
      const result = getDeskState(db, id);
      if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
      const userId = (req as FastifyRequest & { userId?: string }).userId;
      const projiziert = projectStateForActor(result.state, { userId, rolle: req.rolle! });
      const freigegeben = freigabeFilter(projiziert);

      try {
        const kandidaten = sammleFundstellenKandidaten(freigegeben);
        const query = req.query as { ids?: string };
        let ids: string[] | undefined;
        if (query.ids !== undefined && query.ids.trim() !== '') {
          ids = query.ids.split(',').map((s) => s.trim()).filter((s) => s !== '');
          const bekannt = new Set(kandidaten.map((k) => k.id));
          if (!ids.every((wert) => bekannt.has(wert))) {
            throw new ExportFehler(
              'unbekannte-fundstelle',
              'Mindestens eine ausgewählte Fundstelle ist nicht verfügbar.'
            );
          }
        }
        const auswahl = ids !== undefined ? kandidaten.filter((k) => ids!.includes(k.id)) : kandidaten;
        if (auswahl.length === 0) {
          throw new ExportFehler('keine-fundstellen', 'Keine freigegebenen Fundstellen auf diesem Schreibtisch.');
        }

        const bytes = await erzeugeFundstellenPdf(
          freigegeben,
          { ladeDocBytes: macheLadeDocBytes(db, dataDir, freigegeben) },
          `Fundstellen — ${row.name}`,
          ids
        );
        // HIST-04 (P-06/P-07): die `ids`-Auswahl gehört NICHT in den Payload.
        const actor = actorFromRequest(db, req);
        appendJournal(db, { deskId: id, rev: result.rev, type: 'exported', payload: { format: 'fundstellen' }, actorId: actor.id, actorName: actor.name });
        reply.header('content-type', 'application/pdf');
        reply.header('content-disposition', contentDisposition(dateiname(`${row.name}-fundstellen`, '.pdf')));
        return Buffer.from(bytes);
      } catch (e) {
        if (e instanceof ExportFehler) {
          return reply.code(422).send({ error: e.message, reason: e.reason });
        }
        throw e;
      }
    }
  );
}

/** Ein einzelnes Objekt aus der Sicht der Statistik: nur die beiden Felder, die effektiveFreigabe
 *  braucht. Kein Objekt-Detail, kein Name — die Statistik zählt, sie beschreibt nicht (D-08). */
type StatistikObjekt = { freigabe?: Freigabe; layerId?: string };

/** Aus dem Übergabe-Dialog abrufbare Formate (D-12) — jeder andere Wert ⇒ 422 (unbekanntes Format). */
const STATISTIK_FORMATE = new Set([
  'aufgaben', 'dokument', 'snapshot', 'argumentation', 'beweismittel', 'fundstellen',
]);

/** Alle Objekte über sämtliche VERSIONIERTE_ARTEN (Statistik-Umfang „Gesamter Schreibtisch"). */
function alleVersioniertenObjekte(state: DesktopState): StatistikObjekt[] {
  const ergebnis: StatistikObjekt[] = [];
  for (const art of VERSIONIERTE_ARTEN) {
    const liste = (state as unknown as Record<string, StatistikObjekt[] | undefined>)[art];
    if (liste) ergebnis.push(...liste);
  }
  return ergebnis;
}

/**
 * Kandidatenmenge für die Statistik (D-12): format-bewusst eingeschränkt auf das, was das
 * jeweilige Artefakt tatsächlich enthielte — sonst zeigte z. B. „Aufgabenliste" die Zahl ALLER
 * Tisch-Objekte statt nur der offenen Zettel/Fähnchen, die erzeugeAufgabenlistePdf tatsächlich
 * druckt. Ohne format (Erststart des Dialogs, noch kein Format gewählt) zählt der ganze Tisch;
 * die vier Übersichtsformate (Snapshot/Argumentation/Beweismittel) haben laut Planner-Annahme
 * ohnehin den festen Umfang „Gesamter Schreibtisch" — dieselbe Kandidatenmenge wie ohne Format.
 */
function statistikKandidaten(state: DesktopState, filter?: { format?: string; docId?: string }): StatistikObjekt[] {
  const format = filter?.format;
  if (format === undefined || format === '') return alleVersioniertenObjekte(state);
  if (!STATISTIK_FORMATE.has(format)) {
    throw new ExportFehler('unbekanntes-format', `Unbekanntes Format für die Statistik: ${format}`);
  }
  if (format === 'aufgaben') {
    // Deckungsgleich mit erzeugeAufgabenlistePdf (uebersichten.ts): offene Zettel (todo/notiz,
    // done !== true) plus Fähnchen — keine zweite, driftende Definition von "Aufgabe".
    const eintraege: StatistikObjekt[] = [];
    for (const n of state.notes ?? []) {
      if ((n.kind === 'todo' || n.kind === 'notiz') && n.done !== true) eintraege.push(n);
    }
    eintraege.push(...(state.flags ?? []));
    return eintraege;
  }
  if (format === 'dokument') {
    if (filter?.docId === undefined || filter.docId === '') {
      throw new ExportFehler('unbekanntes-format', 'docId fehlt für Format „dokument"');
    }
    const docId = filter.docId;
    const doc = state.docs.find((d) => d.id === docId);
    // Doc-Sichtbarkeits-Gate (WR-03, D-08): `state` ist hier projiziert, aber NICHT
    // freigabe-gefiltert (Docstring oben) — Annotationen werden unabhängig von ihrem
    // Parent-Doc nach eigenem layerId gefiltert (projectStateForActor filtert jede
    // VERSIONIERTE_ARTEN-Liste separat). Ohne dieses Gate könnte ein berechtigter
    // 'export'-Nutzer über einen erratenen/bekannten docId eines für ihn NICHT sichtbaren
    // Docs (z. B. private Ebene eines anderen Nutzers) einen Existenz-Leck-Zähler abgreifen
    // ("dieses docId hat N Annotationen"). Ein nicht (mehr) sichtbares/unbekanntes Doc liefert
    // deshalb eine leere Kandidatenmenge statt Annotations-Zählungen — dasselbe uninformative
    // Verhalten wie für ein völlig unbekanntes docId.
    if (!doc) return [];
    const eintraege: StatistikObjekt[] = [doc];
    for (const m of state.marks ?? []) if (m.docId === docId) eintraege.push(m);
    for (const s of state.strokes ?? []) if (s.docId === docId) eintraege.push(s);
    for (const s of state.stamps ?? []) if (s.docId === docId) eintraege.push(s);
    for (const f of state.flags ?? []) if (f.docId === docId) eintraege.push(f);
    return eintraege;
  }
  if (format === 'fundstellen') return state.cutouts ?? []; // sammleFundstellenKandidaten-Kandidatenmenge (03-08)
  return alleVersioniertenObjekte(state); // snapshot/argumentation/beweismittel: „Gesamter Schreibtisch"
}

/**
 * Zählt Objekte nach effektiver Freigabe-Stufe für die Statistik-Vorschau im Übergabe-Dialog
 * (D-12): auf dem PROJIZIERTEN, aber bewusst NICHT freigabe-gefilterten State — der Dialog
 * braucht alle drei Stufen, um "Nicht enthalten: N intern · N mandantensichtbar" zu erklären.
 * Nur requireDeskAktion('export')-berechtigte Nutzer sehen diese Zahlen (D-08); sie verlassen
 * den Server NIE Richtung Artefakt (dort zählt weiterhin ausschließlich freigabeFilter).
 */
function zaehleFreigabeStufen(
  state: DesktopState,
  filter?: { format?: string; docId?: string },
): { export: number; mandant: number; intern: number } {
  const ergebnis = { export: 0, mandant: 0, intern: 0 };
  for (const obj of statistikKandidaten(state, filter)) {
    ergebnis[effektiveFreigabe(obj, state.layers)]++;
  }
  return ergebnis;
}

/**
 * Statistik-Endpunkt (D-12, 03-10): derselbe Guard wie alle Übergabe-Routen, aber OHNE
 * freigabeFilter — die Statistik braucht das Mengengerüst über alle drei Stufen, damit der
 * Dialog vor der Erzeugung ehrlich zeigt, was fehlen wird. Die Antwort ist ausschließlich das
 * Zahlenobjekt (kein Objekt-Detail, kein Name) — das Existenz-Leck-Verbot gilt für das
 * ARTEFAKT, nicht für den bereits berechtigten Dialog-Nutzer.
 */
function registriereStatistikRoute(app: FastifyInstance, db: Db): void {
  app.get('/api/v1/desks/:id/export/statistik', { preHandler: requireDeskAktion(db, 'export') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    const userId = (req as FastifyRequest & { userId?: string }).userId;
    const projiziert = projectStateForActor(result.state, { userId, rolle: req.rolle! });
    const query = req.query as { format?: string; docId?: string };
    try {
      return zaehleFreigabeStufen(projiziert, { format: query.format, docId: query.docId });
    } catch (e) {
      if (e instanceof ExportFehler) return reply.code(422).send({ error: e.message, reason: e.reason });
      throw e;
    }
  });
}

export function registerPdfExportRoutes(app: FastifyInstance, db: Db, dataDir: string): void {
  registriereUebersichtRoute(app, db, 'aufgaben', 'Aufgabenliste', 'aufgaben', erzeugeAufgabenlistePdf);
  registriereUebersichtRoute(app, db, 'snapshot', 'Schreibtisch-Snapshot', 'snapshot', erzeugeSnapshotPdf);
  registriereUebersichtRoute(app, db, 'argumentation', 'Argumentationsübersicht', 'argumentation', erzeugeArgumentationPdf);
  registriereUebersichtRoute(app, db, 'beweismittel', 'Beweismittelübersicht', 'beweismittel', erzeugeBeweismittelPdf);
  registriereDokumentRoute(app, db, dataDir);
  registriereFundstellenRoute(app, db, dataDir);
  registriereStatistikRoute(app, db);
}
