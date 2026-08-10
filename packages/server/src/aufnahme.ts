import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CommandError, projectStateForActor, type Vec2 } from '@j-desk/core';
import type { Db } from './db';
import { ensureDesk, ensureBearbeiterRolle, applyDeskCommand, getDeskState, getRolleForNutzer } from './deskStore';
import { createDocument } from './jlawyer';
import { classify } from './files';
import { broadcast } from './broadcast';
import { actorFromRequest } from './actor';
import { winansiSanitize, wrapText } from './export/layout';

/**
 * EXT-01 (13-06 Task 1): die Text-Ablage („Urteil"/„Norm"/„Textfragment" mit Ablage-Wahl
 * „In j-lawyer ablegen") ist die einzige neue Server-Sequenz der Erfassung — PDF-Synthese
 * (pdf-lib, Bestands-Dependency seit Phase 3) → createDocument (jlawyer.ts) → addDoc-Karte,
 * exakt entlang des Upload-Routen-Musters (app.ts POST /cases/:id/documents): ERST j-lawyer
 * bestätigen lassen, DANN die Karte anlegen (kein Optimismus). Die Route ist für Datei-Arten
 * (E-Mail/Foto/Medien: Bestands-Uploadpfad) und Weblinks (nie j-lawyer, UI-SPEC-Sonderregel)
 * strukturell NICHT zuständig — eine unbekannte/falsche art fällt auf denselben 400 wie eine
 * fehlende Pflichtangabe.
 */

const SEITE_W = 595; // A4 in PDF-Punkten (Muster export/layout.ts)
const SEITE_H = 842;
const RAND = 50;
const ZEILEN_H = 16;

type TextAblageArt = 'urteil' | 'norm' | 'textfragment';
const TEXT_ABLAGE_ARTEN: readonly TextAblageArt[] = ['urteil', 'norm', 'textfragment'];

const ART_LABEL: Record<TextAblageArt, string> = {
  urteil: 'Urteil',
  norm: 'Norm',
  textfragment: 'Textfragment',
};

/** WR-01: Längenbegrenzung für Freitextfelder vor der PDF-Synthese — analog
 *  TEXT_SNAPSHOT_MAX (cutouts.ts) / QUELLEN_MAX (proposals.ts), die dieselbe Klasse von
 *  unbegrenztem Nutzertext deckeln, der in generierte Artefakte einfließt. */
const FELD_MAX = 5000;

/** Pflichtfeld-Leser: leerer/fehlender Text wirft CommandError mit deutschem Feldnamen — VOR
 *  jedem Außenstellen-Aufruf (T-13-06-01: 400 ohne Seiteneffekt). Zu lange Werte werden
 *  ebenso VOR jeder PDF-Synthese/j-lawyer-Aufruf abgelehnt (WR-01), statt sie stillschweigend
 *  zu kappen — Pflichtfelder bestimmen Titel/Metazeilen, ein gekappter Wert wäre irreführend. */
function pflichtfeld(v: unknown, feld: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new CommandError(`Feld "${feld}" fehlt`);
  if (v.length > FELD_MAX) throw new CommandError(`Feld "${feld}" ist zu lang (max. ${FELD_MAX} Zeichen)`);
  return v;
}

/** Optionale Felder werden gekappt statt abgelehnt (Fließtext/Metazeilen, keine harte
 *  Pflichtangabe) — konsistent mit TEXT_SNAPSHOT_MAX-Muster (stilles Kürzen statt 400). */
function optionalesFeld(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return v.length > FELD_MAX ? v.slice(0, FELD_MAX) : v;
}

/** Bewusst schlichte, deterministische Synthese (kein Layout-Cursor mit Kopf-/Fußzeile wie
 *  export/layout.ts — der Text-Ablage-PDF ist ein einzelnes, kurzes Dokument, keine
 *  mehrseitige Übersicht): Titelzeile (fett), Metazeilen (Gericht/Aktenzeichen/… je art),
 *  optional Fließtext mit Zeilenumbruch an Wortgrenzen (wrapText, Bestandsmuster). Keine
 *  externe Font-Datei, keine Bilder — WinAnsi-Sanitize deckt Deutsch inkl. äöüß§€ ab. */
async function synthetisierePdf(titel: string, meta: string[], fliesstext?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fett = await doc.embedFont(StandardFonts.HelveticaBold);
  let seite = doc.addPage([SEITE_W, SEITE_H]);
  let y = SEITE_H - RAND;

  const neueSeiteFallsNoetig = (): void => {
    if (y - ZEILEN_H < RAND) {
      seite = doc.addPage([SEITE_W, SEITE_H]);
      y = SEITE_H - RAND;
    }
  };
  // WR-02: dieselbe Wortumbruch-Logik wie fliesstext (statt separatem, ungeprüftem
  // Codepfad) — sonst laufen lange (aber FELD_MAX-konforme) Titel-/Metazeilen unsichtbar
  // über den A4-Seitenrand hinaus, obwohl der Text im PDF-Textlayer erhalten bleibt.
  const zeile = (text: string, f = font, groesse = 11): void => {
    for (const teil of wrapText(text, f, groesse, SEITE_W - 2 * RAND)) {
      neueSeiteFallsNoetig();
      seite.drawText(winansiSanitize(teil), { x: RAND, y: y - 12, size: groesse, font: f });
      y -= ZEILEN_H;
    }
  };

  zeile(titel, fett, 14);
  y -= ZEILEN_H / 2;
  for (const m of meta) zeile(m);

  if (fliesstext !== undefined) {
    y -= ZEILEN_H / 2;
    for (const zeileText of fliesstext.split('\n')) {
      for (const teil of wrapText(zeileText, font, 11, SEITE_W - 2 * RAND)) zeile(teil);
    }
  }

  return doc.save();
}

/** Baut Titel/Metazeilen/Fließtext je art — wirft CommandError bei fehlenden Pflichtfeldern,
 *  VOR jeder PDF-Synthese und jedem Außenstellen-Aufruf. */
function inhaltFuerArt(
  art: TextAblageArt,
  felder: Record<string, unknown>,
): { titel: string; meta: string[]; fliesstext?: string } {
  if (art === 'urteil') {
    const gericht = pflichtfeld(felder.gericht, 'felder.gericht');
    const aktenzeichen = pflichtfeld(felder.aktenzeichen, 'felder.aktenzeichen');
    const meta = [`Gericht: ${gericht}`, `Aktenzeichen: ${aktenzeichen}`];
    const datum = optionalesFeld(felder.datum);
    if (datum !== undefined) meta.push(`Datum: ${datum}`);
    const fundstelle = optionalesFeld(felder.fundstelle);
    if (fundstelle !== undefined) meta.push(`Fundstelle: ${fundstelle}`);
    return { titel: `${ART_LABEL.urteil} — ${gericht}, ${aktenzeichen}`, meta };
  }
  if (art === 'norm') {
    const gesetz = pflichtfeld(felder.gesetz, 'felder.gesetz');
    const paragraf = pflichtfeld(felder.paragraf, 'felder.paragraf');
    const meta = [`Gesetz: ${gesetz}`, `Paragraf: ${paragraf}`];
    const absatz = optionalesFeld(felder.absatz);
    if (absatz !== undefined) meta.push(`Absatz: ${absatz}`);
    return { titel: `${ART_LABEL.norm} — ${gesetz}, ${paragraf}`, meta };
  }
  const text = pflichtfeld(felder.text, 'felder.text');
  const meta: string[] = [];
  const quelle = optionalesFeld(felder.quelle);
  if (quelle !== undefined) meta.push(`Quelle: ${quelle}`);
  return { titel: ART_LABEL.textfragment, meta, fliesstext: text };
}

/** Dateiname aus name (falls gesetzt) oder aus den Pflichtfeldern abgeleitet — immer mit
 *  .pdf-Endung (die Route erzeugt ausschließlich PDFs). */
function dateiname(name: unknown, titel: string): string {
  const basis = typeof name === 'string' && name.trim() !== '' ? name.trim() : titel;
  return basis.toLowerCase().endsWith('.pdf') ? basis : `${basis}.pdf`;
}

export interface AufnahmeContext {
  /** j-lawyer-Basis-URL (nur im j-lawyer-Modus registriert, wie die Upload-Route). */
  jlBase: string;
  /** Wortgleich zur Upload-Route: Sitzungs-Credentials oder 401 (Session abgelaufen). */
  credsOder401: (req: FastifyRequest, reply: FastifyReply) => { token: string; creds: { username: string; password: string } } | null;
  /** Wortgleich zur Upload-Route: JLawyerError → passender HTTP-Status + Logout bei 'auth'. */
  jlFehler: (e: unknown, token: string, reply: FastifyReply) => unknown;
  /** Position neuer Karten im „Eingang" — derselbe Helfer wie die Upload-Route (app.ts). */
  eingang: (n: number) => Vec2;
}

/** Registriert POST /api/v1/cases/:id/aufnahme — die Text-Ablage-Route der Erfassung
 *  (EXT-01, 13-06). Wird aus app.ts NEBEN der Upload-Route im j-lawyer-Zweig aufgerufen; die
 *  Kontext-Helfer (credsOder401/jlFehler/eingang) leben dort als geschlossene Closures über
 *  jlCreds/jlBase und werden hier durchgereicht statt dupliziert. */
export function registerAufnahme(app: FastifyInstance, db: Db, ctx: AufnahmeContext): void {
  app.post('/api/v1/cases/:id/aufnahme', async (req, reply) => {
    const c = ctx.credsOder401(req, reply);
    if (!c) return;
    const { id: caseId } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const art = body.art;
      if (typeof art !== 'string' || !(TEXT_ABLAGE_ARTEN as readonly string[]).includes(art)) {
        // Datei-Arten (email/foto/medien) und Weblinks laufen strukturell NICHT über diese
        // Route (Bestands-Uploadpfad bzw. nie-j-lawyer-Sonderregel) — derselbe 400 wie jede
        // andere unbekannte art.
        throw new CommandError('Feld "art" muss urteil, norm oder textfragment sein');
      }
      const felder = (body.felder ?? {}) as Record<string, unknown>;
      const { titel, meta, fliesstext } = inhaltFuerArt(art as TextAblageArt, felder);
      const fileName = dateiname(body.name, titel);

      const pdfBytes = await synthetisierePdf(titel, meta, fliesstext);
      const pdfBuffer = Buffer.from(pdfBytes);

      // Erst j-lawyer bestätigen lassen, dann die Karte anlegen (Spec: kein Optimismus —
      // wortgleiche Reihenfolge zur Upload-Route, app.ts POST /cases/:id/documents).
      const { id: docId } = await createDocument(ctx.jlBase, c.creds.username, c.creds.password, caseId, fileName, pdfBuffer);

      const userId = (req as FastifyRequest & { userId: string }).userId;
      const actor = actorFromRequest(db, req);
      ensureDesk(db, caseId, userId, caseId, actor);
      // WR-02: erfolgreicher createDocument-Abruf = jl-Berechtigung an der Akte (Upload-Route-Muster).
      ensureBearbeiterRolle(db, caseId, userId);
      const anzahl = getDeskState(db, caseId)!.state.docs.length;
      const kind = classify(pdfBuffer, fileName);
      const result = applyDeskCommand(db, caseId, {
        type: 'addDoc',
        payload: { fileId: docId, name: fileName, position: ctx.eingang(anzahl), kind },
      }, actor);
      broadcast(caseId, result);
      reply.code(201);
      // WR-07 (PERM-05): Antwort für den anfragenden Actor projizieren, Rolle mitliefern
      // (durch ensureBearbeiterRolle oben garantiert gesetzt) — Upload-Routen-Muster.
      const rolle = getRolleForNutzer(db, caseId, userId) ?? 'Eigentümer';
      return { ...result, state: projectStateForActor(result.state, { userId, rolle }), rolle };
    } catch (e) {
      if (e instanceof CommandError) return reply.code(400).send({ error: e.message });
      return ctx.jlFehler(e, c.token, reply);
    }
  });
}
