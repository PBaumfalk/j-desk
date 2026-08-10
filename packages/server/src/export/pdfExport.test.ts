import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createTestAppMitZweiNutzern, type EinNutzer } from '../testUtils';
import { storeFile } from '../files';
import { previewCachePath } from '../convert';
import { putDeskState } from '../deskStore';
import { erzeugeRotiertesPdf, erzeugeTextPdf, erzeugeXObjectTextPdf } from './pdfTestFixtures';
import { extrahiereText } from './verify';

/**
 * Tracer-Test (EXP-03/EXP-05, D-02/D-08/D-11): die Aufgabenliste läuft end-to-end durch
 * die Sicherheitskette requireDeskAktion → Projektion → freigabeFilter → pdf-lib →
 * Download. Die pdfjs-Extraktion der Antwort-Bytes ist der Beweis, dass interne Inhalte
 * restlos fehlen (kein Platzhalter, kein Zählhinweis — Marker-String-Muster aus dem
 * Phase-2-Trace-Test projection.test.ts).
 */

const MARKER_AUFGABE = 'MARKERAUFGABEEXPORT7F3E';
const MARKER_INTERN = 'MARKERINTERNGEHEIM9C1B';

async function deskMitAufgabeUndInternemMarker() {
  const ctx = await createTestAppMitZweiNutzern();
  const { app, a } = ctx;
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Tracer' } })
  ).json() as { id: string };
  // Offene Aufgabe (todo, nicht abgehakt) — wird anschließend auf die exportierbare Ebene gehängt.
  const aufgabe = await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
    payload: { type: 'addNote', payload: { id: 'n-aufgabe', kind: 'todo', text: MARKER_AUFGABE, position: { x: 0, y: 0 } } },
  });
  expect(aufgabe.statusCode).toBe(200);
  const ebene = await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
    payload: { type: 'changeLayerId', payload: { objectId: 'n-aufgabe', layerId: 'exportierbar' } },
  });
  expect(ebene.statusCode).toBe(200);
  // Interne Notiz (Kanzlei-Ebene, kein Override) — darf im Artefakt nirgends auftauchen.
  const intern = await app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
    payload: { type: 'addNote', payload: { id: 'n-intern', kind: 'notiz', text: MARKER_INTERN, position: { x: 1, y: 1 } } },
  });
  expect(intern.statusCode).toBe(200);
  return { ...ctx, deskId: desk.id };
}

describe('GET /api/v1/desks/:id/export/pdf/aufgaben (Tracer)', () => {
  it('liefert ein serverseitig erzeugtes PDF: Aufgabe drin, interner Marker nachweislich nicht', async () => {
    const { app, a, deskId } = await deskMitAufgabeUndInternemMarker();

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/aufgaben`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(MARKER_AUFGABE);
    expect(text).not.toContain(MARKER_INTERN);
  });

  it('Rolle ohne Export-Recht (Nur-Lesen) ⇒ 403', async () => {
    const { app, db, b, deskId } = await deskMitAufgabeUndInternemMarker();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'Nur-Lesen');

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/aufgaben`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });

  it('unbekannter Schreibtisch ⇒ 404 (Bestandsverhalten)', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/export/pdf/aufgaben', headers: a.authHeaders });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * Annotierte PDF-Kopie (EXP-01, D-01/D-03/D-04/D-05/D-06/D-08): volle Pipeline
 * Quelle → Redaktion → Overlays → Scrub → Verifikationsgate hinter dem Doc-Gate.
 * Normatives Orakel bleibt die pdfjs-Extraktion; Fehlerfälle sind 422 mit deutscher
 * Meldung — niemals ein ungeprüftes Artefakt und niemals ein 500/Stacktrace.
 */

const DOK_TEXT = 'DOKTEXT-03-07-ORIGINAL';
const GEHEIM = 'GEHEIMTOKEN-03-07-XXXX';
const OFFEN = 'OFFENTEXT-03-07-BLEIBT';
const STEMPEL_EXPORT = 'STEMPELEXPORT-03-07';
const STEMPEL_INTERN = 'STEMPELINTERN-03-07';

type PdfCtx = Awaited<ReturnType<typeof deskMitPdfDoc>>;

async function befehl(ctx: { app: FastifyInstance; a: EinNutzer }, deskId: string, type: string, payload: unknown): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
    payload: { type, payload },
  });
  expect(res.statusCode).toBe(200);
}

/** Desk + echtes PDF als Karte; optional auf die Exportierbar-Ebene gehängt (Doc-Freigabe 'export'). */
async function deskMitPdfDoc(opts: { bytes: Uint8Array; kind?: string; aufExportEbene?: boolean; dateiName?: string }) {
  const ctx = await createTestAppMitZweiNutzern();
  const { app, a } = ctx;
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Kopie' } })
  ).json() as { id: string };
  const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(opts.bytes), opts.dateiName ?? 'dokument.pdf');
  await befehl(ctx, desk.id, 'addDoc', {
    fileId: meta.id, name: opts.dateiName ?? 'dokument.pdf', position: { x: 0, y: 0 }, id: 'doc-1',
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
  });
  if (opts.aufExportEbene) {
    await befehl(ctx, desk.id, 'changeLayerId', { objectId: 'doc-1', layerId: 'exportierbar' });
  }
  return { ...ctx, deskId: desk.id, docId: 'doc-1', fileId: meta.id };
}

function exportiere(ctx: PdfCtx) {
  return ctx.app.inject({
    method: 'GET', url: `/api/v1/desks/${ctx.deskId}/export/pdf/dokument/${ctx.docId}`, headers: ctx.a.authHeaders,
  });
}

describe('GET /api/v1/desks/:id/export/pdf/dokument/:docId (annotierte Kopie)', () => {
  it('liefert 200 application/pdf: Stempeltext UND Dokumenttext im Ergebnis', async () => {
    const fixture = await erzeugeTextPdf(DOK_TEXT, 100, 700);
    const ctx = await deskMitPdfDoc({ bytes: fixture.bytes, aufExportEbene: true });
    await befehl(ctx, ctx.deskId, 'addStamp', {
      stamp: { id: 'st-1', docId: ctx.docId, page: 1, x: 200, y: 300, angle: 0, text: STEMPEL_EXPORT, color: 'red', baseW: 595, baseH: 842 },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'st-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('annotiert');
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(STEMPEL_EXPORT);
    expect(text).toContain(DOK_TEXT);
  });

  it('Doc-Gate: Doc effektiv intern ⇒ 422 doc-nicht-freigegeben — auch bei freigegebener Mark (Open Question 2)', async () => {
    const fixture = await erzeugeTextPdf(DOK_TEXT, 100, 700);
    const ctx = await deskMitPdfDoc({ bytes: fixture.bytes }); // Kanzlei-Ebene = intern (fail-closed)
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: ctx.docId, page: 1, rect: fixture.basis, kind: 'redact', textSnapshot: DOK_TEXT },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('doc-nicht-freigegeben');
    expect(body.error).toContain('freigegeben');
  });

  it('interner Stempel fehlt restlos im Artefakt; freigegebener erscheint (D-05/D-06/D-08)', async () => {
    const fixture = await erzeugeTextPdf(DOK_TEXT, 100, 700);
    const ctx = await deskMitPdfDoc({ bytes: fixture.bytes, aufExportEbene: true });
    await befehl(ctx, ctx.deskId, 'addStamp', {
      stamp: { id: 'st-intern', docId: ctx.docId, page: 1, x: 150, y: 200, angle: 0, text: STEMPEL_INTERN, color: 'blue', baseW: 595, baseH: 842 },
    });
    await befehl(ctx, ctx.deskId, 'addStamp', {
      stamp: { id: 'st-export', docId: ctx.docId, page: 1, x: 350, y: 500, angle: 0, text: STEMPEL_EXPORT, color: 'red', baseW: 595, baseH: 842 },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'st-export', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(STEMPEL_EXPORT);
    expect(text).not.toContain(STEMPEL_INTERN);
  });

  it('freigegebene redact-Mark löscht den textSnapshot echt; der Rest der Seite bleibt lesbar (D-01/D-03)', async () => {
    const fixture = await erzeugeTextPdf(GEHEIM, 100, 700);
    // Zweiter Text außerhalb des Rects — muss im Ergebnis lesbar bleiben:
    const doc = await PDFDocument.load(fixture.bytes);
    const seite = doc.getPage(0);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    seite.drawText(OFFEN, { x: 100, y: 500, size: 12, font });
    const bytes = await doc.save();

    const ctx = await deskMitPdfDoc({ bytes, aufExportEbene: true });
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: ctx.docId, page: 1, rect: fixture.basis, kind: 'redact', textSnapshot: GEHEIM },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).not.toContain(GEHEIM); // Verifikationsgate-Nachweis: echt gelöscht
    expect(text).toContain(OFFEN);
  });

  /**
   * Der Fehlerfall aus dem Feld, end-to-end über die Route: eine Schwärzung, die MITTEN in
   * einer Zeile ansetzt und (wie jede frisch gezogene Fläche) KEIN freigabe-Attribut trägt.
   * Beide Eigenschaften zusammen ergaben früher entweder ein Artefakt mit Klartext (Mark
   * intern ⇒ lautlos weggefiltert) oder 422 „Die Schwärzung konnte nicht verifiziert werden"
   * (Mark freigegeben ⇒ Trefferregel verfehlte den am Zeilenanfang startenden Tj).
   */
  it('Schwärzung mitten in der Zeile und ohne Freigabe-Override ⇒ 200, Text echt weg, Rest der Zeile bleibt', async () => {
    const doc = await PDFDocument.create();
    const seite = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const zeile = `Die Zeugin wohnt ${GEHEIM} und wurde gehoert.`;
    seite.drawText(zeile, { x: 60, y: 760, size: 12, font }); // eine Zeile = EIN Tj ab x = 60
    seite.drawText(OFFEN, { x: 60, y: 700, size: 12, font });
    const bytes = await doc.save();

    const ctx = await deskMitPdfDoc({ bytes, aufExportEbene: true });
    const vorlauf = font.widthOfTextAtSize('Die Zeugin wohnt ', 12);
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: {
        id: 'm-1', docId: ctx.docId, page: 1, kind: 'redact', textSnapshot: GEHEIM,
        rect: { x: 60 + vorlauf, y: 842 - 760 - 12, w: font.widthOfTextAtSize(GEHEIM, 12), h: 12 },
      },
    });
    // KEIN setFreigabe — genau der Normalfall.

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).not.toContain(GEHEIM);
    expect(text).toContain(OFFEN); // andere Zeilen bleiben unangetastet
  });

  it("convertible ohne Vorschau-Cache ⇒ 422 mit Cache-Hinweis (Pitfall 5, keine falsche Quelle)", async () => {
    const ctx = await deskMitPdfDoc({
      bytes: new TextEncoder().encode('kein echtes Office-Paket'),
      kind: 'convertible', dateiName: 'schriftsatz.docx', aufExportEbene: true,
    });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('cache-fehlt');
    expect(body.error).toContain('Vorschau');
  });

  it('convertible mit vorhandener Cache-PDF ⇒ Export aus dem Cache', async () => {
    const fixture = await erzeugeTextPdf(DOK_TEXT, 100, 700);
    const ctx = await deskMitPdfDoc({
      bytes: new TextEncoder().encode('kein echtes Office-Paket'),
      kind: 'convertible', dateiName: 'schriftsatz.docx', aufExportEbene: true,
    });
    const cachePfad = previewCachePath(ctx.dataDir, ctx.fileId);
    mkdirSync(dirname(cachePfad), { recursive: true });
    writeFileSync(cachePfad, fixture.bytes);

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(200);
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(DOK_TEXT);
  });

  it('korrupte PDF-Bytes ⇒ 422 mit deutscher Meldung, kein 500 und kein Stacktrace (DoS-Schutz)', async () => {
    const korrupt = new Uint8Array([...Buffer.from('%PDF-1.7\n'), ...Buffer.from('datenmuell ohne xref und trailer')]);
    const ctx = await deskMitPdfDoc({ bytes: korrupt, aufExportEbene: true });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error?: string };
    expect(typeof body.error).toBe('string');
    expect(body.error!.length).toBeGreaterThan(0);
    expect(body.error).not.toContain('at '); // kein Stacktrace im Body
  });

  it('rotierte Seite mit Schwärzung ⇒ Fallback-Pfad ohne Rasterer: 422 verifikation-fehlgeschlagen (kein ungeprüftes Artefakt)', async () => {
    const rot = await erzeugeRotiertesPdf();
    const ctx = await deskMitPdfDoc({ bytes: rot.bytes, aufExportEbene: true });
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: ctx.docId, page: 1, rect: { x: 50, y: 100, w: 300, h: 200 }, kind: 'redact', textSnapshot: rot.text },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('verifikation-fehlgeschlagen');
    expect(body.error).toContain('abgebrochen');
  });

  it('Form-XObject-Text unter der Schwärzung ⇒ Fallback-Signal greift: 422 verifikation-fehlgeschlagen', async () => {
    const xob = await erzeugeXObjectTextPdf(GEHEIM);
    const ctx = await deskMitPdfDoc({ bytes: xob, aufExportEbene: true });
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: ctx.docId, page: 1, rect: { x: 50, y: 100, w: 300, h: 50 }, kind: 'redact', textSnapshot: GEHEIM },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('verifikation-fehlgeschlagen');
  });

  it('rotierte Seite mit Stempel OHNE Schwärzung ⇒ Rotations-Gate greift trotzdem: 422 statt falsch positioniertem Overlay (WR-01)', async () => {
    // Vor dem Fix (WR-01): der Rotations-Check lief nur INNERHALB des schwaerzungen>0-Zweigs —
    // eine rotierte Seite mit Stempel/Strokes, aber ohne redact/tippex-Mark, überging das Gate
    // komplett und brannte den Stempel mit den unrotierten coordinates.ts-Transforms ein.
    const rot = await erzeugeRotiertesPdf();
    const ctx = await deskMitPdfDoc({ bytes: rot.bytes, aufExportEbene: true });
    await befehl(ctx, ctx.deskId, 'addStamp', {
      stamp: { id: 'st-1', docId: ctx.docId, page: 1, x: 200, y: 300, angle: 0, text: STEMPEL_EXPORT, color: 'red', baseW: 595, baseH: 842 },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'st-1', freigabe: 'export' });

    const res = await exportiere(ctx);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('verifikation-fehlgeschlagen');
  });
});

/**
 * Freigabe-Statistik (D-12, 03-10): der Übergabe-Dialog fragt vor jeder Erzeugung die
 * Mengengerüst-Zahlen ab — Server zählt, Antwort ist ausschließlich Zahlen (kein Objekt-
 * Detail, kein Name; Existenz-Leck-Verbot gilt für das ARTEFAKT, nicht für den berechtigten
 * Dialog-Nutzer, D-08). Gezählt wird auf dem projizierten, aber NICHT freigabe-gefilterten
 * State (alle drei Stufen), damit „Nicht enthalten: N intern · N mandantensichtbar" stimmt.
 */
describe('GET /api/v1/desks/:id/export/statistik (D-12)', () => {
  async function befehl(ctx: { app: FastifyInstance; a: EinNutzer }, deskId: string, type: string, payload: unknown): Promise<void> {
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
      payload: { type, payload },
    });
    expect(res.statusCode).toBe(200);
  }

  async function deskMitDreiStufen() {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Statistik' } })
    ).json() as { id: string };
    const notiz = (id: string, text: string) =>
      befehl(ctx, desk.id, 'addNote', { id, kind: 'notiz', text, position: { x: 0, y: 0 } });
    const freigabe = (id: string, stufe: string) => befehl(ctx, desk.id, 'setFreigabe', { objectId: id, freigabe: stufe });

    await notiz('n-export-1', 'A');
    await freigabe('n-export-1', 'export');
    await notiz('n-export-2', 'B');
    await freigabe('n-export-2', 'export');
    await notiz('n-mandant-1', 'C');
    await freigabe('n-mandant-1', 'mandant');
    await notiz('n-intern-1', 'D'); // kein Override, Kanzlei-Ebene ⇒ intern (fail-closed, D-14)
    await notiz('n-intern-2', 'E');
    await notiz('n-intern-3', 'F');
    return { ...ctx, deskId: desk.id };
  }

  it('zählt 2 export/1 mandant/3 intern über alle VERSIONIERTE_ARTEN (ohne Format)', async () => {
    const { app, a, deskId } = await deskMitDreiStufen();
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/statistik`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ export: 2, mandant: 1, intern: 3 });
  });

  it('Antwort enthält ausschließlich Zahlen (keine Objekt-Details, keine Namen)', async () => {
    const { app, a, deskId } = await deskMitDreiStufen();
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/statistik`, headers: a.authHeaders });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['export', 'intern', 'mandant']);
    for (const wert of Object.values(body)) expect(typeof wert).toBe('number');
    // Keine der Notiz-Kurztexte (A-F) darf im Antwortkörper auftauchen (nur Zahlen, kein Leck).
    expect(JSON.stringify(body)).not.toMatch(/[ABCDEF]/);
  });

  it('Rolle ohne Export-Recht (Nur-Lesen) ⇒ 403', async () => {
    const { app, db, b, deskId } = await deskMitDreiStufen();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'Nur-Lesen');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/statistik`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });

  it('unbekannter Schreibtisch ⇒ 404 (Bestandsverhalten)', async () => {
    const { app, a } = await createTestAppMitZweiNutzern();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/export/statistik', headers: a.authHeaders });
    expect(res.statusCode).toBe(404);
  });

  it('format=aufgaben zählt nur offene Zettel/Fähnchen je Stufe', async () => {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Aufgaben' } })
    ).json() as { id: string };

    // Offene Aufgabe (todo, nicht erledigt) ⇒ zählt, Stufe export.
    await befehl(ctx, desk.id, 'addNote', { id: 'n-todo-offen', kind: 'todo', text: 'offen', position: { x: 0, y: 0 } });
    await befehl(ctx, desk.id, 'setFreigabe', { objectId: 'n-todo-offen', freigabe: 'export' });
    // Erledigte Aufgabe (done: true) ⇒ zählt NICHT mit, obwohl freigegeben.
    await befehl(ctx, desk.id, 'addNote', { id: 'n-todo-erledigt', kind: 'todo', text: 'erledigt', position: { x: 0, y: 0 } });
    await befehl(ctx, desk.id, 'setFreigabe', { objectId: 'n-todo-erledigt', freigabe: 'export' });
    await befehl(ctx, desk.id, 'setNoteDone', { id: 'n-todo-erledigt', done: true });
    // Dokument (kein Zettel/Fähnchen) ⇒ zählt NICHT mit, obwohl export.
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from('x'), 'x.pdf');
    await befehl(ctx, desk.id, 'addDoc', { id: 'd-1', fileId: meta.id, name: 'x.pdf', position: { x: 0, y: 0 } });
    await befehl(ctx, desk.id, 'setFreigabe', { objectId: 'd-1', freigabe: 'export' });
    // Fähnchen (kein Override ⇒ intern).
    await befehl(ctx, desk.id, 'addFlag', { flag: { id: 'fl-1', docId: 'd-1', page: 1, offset: 0.5, color: '#f5c518' } });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/desks/${desk.id}/export/statistik?format=aufgaben`, headers: a.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ export: 1, mandant: 0, intern: 1 });
  });

  it('format=dokument&docId=… zählt nur Objekte mit Bezug zu diesem Doc', async () => {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Doc' } })
    ).json() as { id: string };

    const metaA = storeFile(ctx.db, ctx.dataDir, Buffer.from('a'), 'a.pdf');
    await befehl(ctx, desk.id, 'addDoc', { id: 'doc-a', fileId: metaA.id, name: 'a.pdf', position: { x: 0, y: 0 } });
    await befehl(ctx, desk.id, 'setFreigabe', { objectId: 'doc-a', freigabe: 'export' });
    const metaB = storeFile(ctx.db, ctx.dataDir, Buffer.from('b'), 'b.pdf');
    await befehl(ctx, desk.id, 'addDoc', { id: 'doc-b', fileId: metaB.id, name: 'b.pdf', position: { x: 0, y: 0 } });
    await befehl(ctx, desk.id, 'setFreigabe', { objectId: 'doc-b', freigabe: 'export' });
    // Mark auf doc-a ⇒ zählt mit (Stufe mandant).
    await befehl(ctx, desk.id, 'addMark', { mark: { id: 'm-a', docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact' } });
    await befehl(ctx, desk.id, 'setFreigabe', { objectId: 'm-a', freigabe: 'mandant' });
    // Stamp auf doc-b ⇒ zählt NICHT mit (falsches Doc), obwohl export.
    await befehl(ctx, desk.id, 'addStamp', {
      stamp: { id: 'st-b', docId: 'doc-b', page: 1, x: 0, y: 0, angle: 0, text: 'X', color: 'red', baseW: 100, baseH: 100 },
    });
    await befehl(ctx, desk.id, 'setFreigabe', { objectId: 'st-b', freigabe: 'export' });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/desks/${desk.id}/export/statistik?format=dokument&docId=doc-a`, headers: a.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ export: 1, mandant: 1, intern: 0 });
  });

  it("format=dokument&docId=… mit einem für den Anfragenden UNSICHTBAREN Doc (fremde Privat-Ebene) ⇒ leere Kandidatenmenge statt Existenz-Leck (WR-03)", async () => {
    // Vor dem Fix (WR-03): der 'dokument'-Zweig prüfte Doc-Sichtbarkeit NUR, um das Doc-Objekt
    // selbst mitzuzählen — Marks/Strokes/Stamps/Flags mit demselben docId wurden gezählt,
    // UNABHÄNGIG davon, ob der Anfragende das referenzierte Doc überhaupt sehen darf. Ein
    // 'export'-berechtigter Nutzer, der die id eines für ihn unsichtbaren Docs kennt/errät
    // (hier: Doc auf der privaten Ebene eines anderen Nutzers), erhielt einen Nicht-Null-Zähler
    // — ein schwaches Existenz-Leck ("dieses docId hat N Annotationen").
    const ctx = await createTestAppMitZweiNutzern();
    const { app, db, a, b } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Privat-Doc' } })
    ).json() as { id: string };

    putDeskState(db, desk.id, {
      docs: [{
        id: 'doc-privat-b', fileId: 'file-privat-b', name: 'geheim.pdf', position: { x: 0, y: 0 },
        rotation: 0, zIndex: 1, kind: 'pdf', layerId: 'privat-b',
      }],
      links: [], stacks: [],
      layers: [{ id: 'privat-b', typ: 'privat', name: 'Privat', ownerUserId: b.userId }],
      // KEIN layerId ⇒ Kanzlei-Ebene (für a sichtbar), referenziert aber das für a unsichtbare Doc.
      marks: [{ id: 'm-auf-privatem-doc', docId: 'doc-privat-b', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact' }],
    }, { type: 'stateReplaced', actor: { id: a.userId, name: 'a' } });

    const res = await app.inject({
      method: 'GET', url: `/api/v1/desks/${desk.id}/export/statistik?format=dokument&docId=doc-privat-b`, headers: a.authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ export: 0, mandant: 0, intern: 0 });
  });

  it('unbekanntes Format ⇒ 422', async () => {
    const { app, a, deskId } = await deskMitDreiStufen();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/desks/${deskId}/export/statistik?format=gibtsnicht`, headers: a.authHeaders,
    });
    expect(res.statusCode).toBe(422);
  });
});

/**
 * Export-Historie (HIST-04, Task 3): macht P-06 (Vollständigkeit — kein Endpunkt darf
 * unjournaliert ausliefern) und P-07 (Inhaltsarmut — nur der Formatname, nie Akteninhalt)
 * ausführbar, plus die beiden Falschmeldungs-Verbote (Statistik, abgebrochener Export).
 */
describe('Export-Historie (HIST-04, P-06/P-07)', () => {
  const HIST_TEXT = 'HISTORIETEXT-04-03-9K2L';

  /** Ein Desk, der alle sieben Format-Kennungen bedienen kann: ein freigegebenes Doc
   *  (jdesk/aufgaben/snapshot/dokument), eine offene Aufgabe (aufgaben/argumentation)
   *  und ein freigegebener Ausschnitt (beweismittel/fundstellen). */
  async function deskMitAllenSiebenFormaten() {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, db, dataDir, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Historie' } })
    ).json() as { id: string };
    const cmd = (type: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders, payload: { type, payload } });

    const fixture = await erzeugeTextPdf(HIST_TEXT, 100, 700);
    const meta = storeFile(db, dataDir, Buffer.from(fixture.bytes), 'dokument.pdf');
    expect((await cmd('addDoc', { fileId: meta.id, name: 'dokument.pdf', position: { x: 0, y: 0 }, id: 'doc-1' })).statusCode).toBe(200);
    expect((await cmd('changeLayerId', { objectId: 'doc-1', layerId: 'exportierbar' })).statusCode).toBe(200);

    expect((await cmd('addNote', { id: 'n-1', kind: 'todo', text: 'Historie-Aufgabe', position: { x: 0, y: 0 } })).statusCode).toBe(200);
    expect((await cmd('changeLayerId', { objectId: 'n-1', layerId: 'exportierbar' })).statusCode).toBe(200);

    expect((await cmd('addCutout', {
      docId: 'doc-1', page: 1, rect: fixture.basis, position: { x: 900, y: 0 }, id: 'cut-1', textSnapshot: HIST_TEXT,
    })).statusCode).toBe(200);
    expect((await cmd('changeLayerId', { objectId: 'cut-1', layerId: 'exportierbar' })).statusCode).toBe(200);

    return { ...ctx, deskId: desk.id, docId: 'doc-1' };
  }

  function alleSiebenAufrufe(deskId: string, docId: string): string[] {
    return [
      `/api/v1/desks/${deskId}/export`,
      `/api/v1/desks/${deskId}/export/pdf/aufgaben`,
      `/api/v1/desks/${deskId}/export/pdf/snapshot`,
      `/api/v1/desks/${deskId}/export/pdf/argumentation`,
      `/api/v1/desks/${deskId}/export/pdf/beweismittel`,
      `/api/v1/desks/${deskId}/export/pdf/dokument/${docId}`,
      `/api/v1/desks/${deskId}/export/pdf/fundstellen`,
    ];
  }

  it('sieben Download-Endpunkte ⇒ genau sieben exported-Format-Kennungen (Mengenvergleich, P-06)', async () => {
    const { app, db, a, deskId, docId } = await deskMitAllenSiebenFormaten();

    for (const url of alleSiebenAufrufe(deskId, docId)) {
      const res = await app.inject({ method: 'GET', url, headers: a.authHeaders });
      expect(res.statusCode).toBe(200);
    }

    const zeilen = db.prepare(
      "SELECT payload FROM command_journal WHERE desk_id = ? AND type = 'exported'",
    ).all(deskId) as { payload: string }[];
    const formate = new Set(zeilen.map((z) => (JSON.parse(z.payload) as { format: string }).format));
    expect(formate).toEqual(new Set(['jdesk', 'aufgaben', 'snapshot', 'argumentation', 'beweismittel', 'dokument', 'fundstellen']));
  });

  it('exported-Payload trägt ausschließlich {format} — kein Dokument-/Fundstellenname im Journal (P-07)', async () => {
    const { app, db, a, deskId, docId } = await deskMitAllenSiebenFormaten();

    for (const url of alleSiebenAufrufe(deskId, docId)) {
      const res = await app.inject({ method: 'GET', url, headers: a.authHeaders });
      expect(res.statusCode).toBe(200);
    }

    const zeilen = db.prepare(
      "SELECT payload FROM command_journal WHERE desk_id = ? AND type = 'exported'",
    ).all(deskId) as { payload: string }[];
    expect(zeilen.length).toBe(7);
    for (const z of zeilen) {
      const payload = JSON.parse(z.payload) as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(['format']);
    }
    const gesamterPayloadText = zeilen.map((z) => z.payload).join(' ');
    expect(gesamterPayloadText).not.toContain('dokument.pdf');
    expect(gesamterPayloadText).not.toContain(HIST_TEXT);
    expect(gesamterPayloadText).not.toContain('Historie-Aufgabe');
  });

  it('GET …/export/statistik erzeugt keine zusätzliche exported-Zeile', async () => {
    const { app, db, a, deskId } = await deskMitAllenSiebenFormaten();
    const vorher = (
      db.prepare("SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ? AND type = 'exported'").get(deskId) as { n: number }
    ).n;

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/statistik`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);

    const nachher = (
      db.prepare("SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ? AND type = 'exported'").get(deskId) as { n: number }
    ).n;
    expect(nachher).toBe(vorher);
  });

  it('abgebrochener Export (422, Objekt-Limit) hinterlässt keine exported-Zeile', async () => {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, db, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Riesig Historie' } })
    ).json() as { id: string };
    const notes = Array.from({ length: 2001 }, (_, i) => ({
      id: `n-${i}`, kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, freigabe: 'export',
    }));
    putDeskState(db, desk.id, { docs: [], links: [], stacks: [], notes });

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export/pdf/argumentation`, headers: a.authHeaders });
    expect(res.statusCode).toBe(422);

    const zeilen = db.prepare(
      "SELECT id FROM command_journal WHERE desk_id = ? AND type = 'exported'",
    ).all(desk.id);
    expect(zeilen).toHaveLength(0);
  });
});
