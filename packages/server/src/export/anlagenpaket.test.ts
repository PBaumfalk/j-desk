import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from 'pdf-lib';
import { createTestAppMitZweiNutzern, type EinNutzer } from '../testUtils';
import { storeFile, getFilePath } from '../files';
import { warteAufLeerlauf } from '../ocr/ocrQueue';
import { getDeskState } from '../deskStore';
import { previewCachePath } from '../convert';
import type { Db } from '../db';
import { erzeugeTextPdf } from './pdfTestFixtures';
import { extrahiereSeiten, extrahiereText } from './verify';
import { ANLAGENPAKET_AUSGESCHLOSSENE_SEITEN_LIMIT, ANLAGENPAKET_DOKUMENT_LIMIT } from './anlagenpaket';

/**
 * Anlagenpaket-Tracer (KONV-01, 10-01) + Deckblatt/Verzeichnis/Lesezeichen (KONV-02, 10-02) +
 * Dubletten-/Leerseiten-Prüfroute (KONV-03, 10-04): das Paket entsteht ausschließlich aus den
 * Ergebnissen von erzeugeAnnotierteDokumentKopie() — die Tests belegen Reihenfolge, Freigabe,
 * pageOnly, Schwärzung, unbekannte/nicht sichtbare Dokumente, den Dokumentdeckel, das Exportrecht,
 * den Journaleintrag, die Übereinstimmung von Verzeichnis-Startseiten mit den gedruckten
 * Seitenzahlen, den Lesezeichenbaum in den ausgelieferten Bytes sowie — für die Prüfroute — die
 * Dubletten-/Leerseiten-/Unbeurteilbar-Erkennung ohne jede Erzeugung eines Artefakts.
 */

/** Lädt die ausgelieferten Bytes und löst den Lesezeichenbaum auf, falls vorhanden. */
async function ladeLesezeichenwurzel(bytes: Uint8Array): Promise<{ doc: PDFDocument; wurzel: PDFDict } | null> {
  const doc = await PDFDocument.load(bytes);
  const outlinesRef = doc.catalog.get(PDFName.of('Outlines'));
  if (!outlinesRef) return null;
  const wurzel = doc.context.lookup(outlinesRef, PDFDict);
  return { doc, wurzel };
}

/** Läuft die Next-Kette der Lesezeicheneinträge ab der ersten Referenz ab. */
function lesezeichenKette(doc: PDFDocument, ersteRef: unknown): PDFDict[] {
  const kette: PDFDict[] = [];
  let aktuell = ersteRef;
  while (aktuell !== undefined) {
    const dict = doc.context.lookup(aktuell as never, PDFDict);
    kette.push(dict);
    aktuell = dict.get(PDFName.of('Next'));
  }
  return kette;
}

async function befehl(ctx: { app: FastifyInstance; a: EinNutzer }, deskId: string, type: string, payload: unknown): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${deskId}/commands`, headers: ctx.a.authHeaders,
    payload: { type, payload },
  });
  expect(res.statusCode).toBe(200);
}

async function neuerDesk(name = 'Akte Anlagenpaket') {
  const ctx = await createTestAppMitZweiNutzern();
  const { app, a } = ctx;
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name } })
  ).json() as { id: string };
  return { ...ctx, deskId: desk.id };
}

/** Legt ein Text-PDF als freigegebenes Doc an; gibt docId/fileId zurück. */
async function legeDokAn(
  ctx: Awaited<ReturnType<typeof neuerDesk>>,
  opts: { id: string; text: string; x?: number; y?: number; aufExportEbene?: boolean; pageOnly?: number }
) {
  const fixture = await erzeugeTextPdf(opts.text, opts.x ?? 100, opts.y ?? 700);
  const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(fixture.bytes), `${opts.id}.pdf`);
  await befehl(ctx, ctx.deskId, 'addDoc', {
    fileId: meta.id, name: `${opts.id}.pdf`, position: { x: 0, y: 0 }, id: opts.id,
    ...(opts.pageOnly !== undefined ? { pageOnly: opts.pageOnly } : {}),
  });
  if (opts.aufExportEbene) {
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: opts.id, layerId: 'exportierbar' });
  }
  return { docId: opts.id, fileId: meta.id, fixture };
}

function anlagenpaketErzeugen(
  ctx: { app: FastifyInstance; a: EinNutzer; deskId: string },
  wunsch: { deckblattTitel: string; eintraege: { docId: string; bezeichnung: string }[]; ausgeschlosseneSeiten?: { docId: string; seite: number }[] }
) {
  return ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${ctx.deskId}/export/pdf/anlagenpaket`, headers: ctx.a.authHeaders,
    payload: wunsch,
  });
}

describe('POST /api/v1/desks/:id/export/pdf/anlagenpaket', () => {
  it('Reihenfolge: die Seiten stehen in der angefragten Abfolge, auch nach Umsortieren', async () => {
    const ctx = await neuerDesk();
    const eins = await legeDokAn(ctx, { id: 'd-1', text: 'MARKERANLAGEEINS7A3F', aufExportEbene: true });
    const zwei = await legeDokAn(ctx, { id: 'd-2', text: 'MARKERANLAGEZWEI9C1D', aufExportEbene: true });
    const drei = await legeDokAn(ctx, { id: 'd-3', text: 'MARKERANLAGEDREI2E8B', aufExportEbene: true });

    const wunsch = (order: string[]) => ({
      deckblattTitel: 'Anlagen zur Akte',
      eintraege: order.map((id) => ({ docId: id, bezeichnung: id })),
    });

    const res1 = await anlagenpaketErzeugen(ctx, wunsch([eins.docId, zwei.docId, drei.docId]));
    expect(res1.statusCode).toBe(200);
    const text1 = await extrahiereText(new Uint8Array(res1.rawPayload));
    expect(text1.indexOf('MARKERANLAGEEINS7A3F')).toBeLessThan(text1.indexOf('MARKERANLAGEZWEI9C1D'));
    expect(text1.indexOf('MARKERANLAGEZWEI9C1D')).toBeLessThan(text1.indexOf('MARKERANLAGEDREI2E8B'));

    const res2 = await anlagenpaketErzeugen(ctx, wunsch([drei.docId, eins.docId, zwei.docId]));
    expect(res2.statusCode).toBe(200);
    const text2 = await extrahiereText(new Uint8Array(res2.rawPayload));
    expect(text2.indexOf('MARKERANLAGEDREI2E8B')).toBeLessThan(text2.indexOf('MARKERANLAGEEINS7A3F'));
    expect(text2.indexOf('MARKERANLAGEEINS7A3F')).toBeLessThan(text2.indexOf('MARKERANLAGEZWEI9C1D'));
  });

  it('Freigabe: ein nicht exportierbares Dokument fehlt restlos, x-anlagenpaket-ausgelassen steht auf 1', async () => {
    const ctx = await neuerDesk();
    const export1 = await legeDokAn(ctx, { id: 'd-export', text: 'MARKEREXPORTIERBARB1C4', aufExportEbene: true });
    const intern1 = await legeDokAn(ctx, { id: 'd-intern', text: 'MARKERINTERNPAKET5D2A' }); // keine Export-Ebene

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: export1.docId, bezeichnung: 'Export' },
        { docId: intern1.docId, bezeichnung: 'Intern' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-anlagenpaket-ausgelassen']).toBe('1');
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain('MARKEREXPORTIERBARB1C4');
    expect(text).not.toContain('MARKERINTERNPAKET5D2A');

    const nurIntern = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [{ docId: intern1.docId, bezeichnung: 'Intern' }],
    });
    expect(nurIntern.statusCode).toBe(422);
    const body = nurIntern.json() as { error: string; reason?: string };
    expect(body.reason).toBe('keine-dokumente');
  });

  it('pageOnly: eine Seitenkarte steuert genau eine Seite bei', async () => {
    const ctx = await neuerDesk();
    // Drei-seitiges Dokument über ein separates PDF mit drei Seiten und je eigenem Marker.
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const marker = ['SEITEEINS4F7B', 'SEITEZWEI8A2C', 'SEITEDREI1D9E'];
    for (const m of marker) {
      const seite = doc.addPage([595, 842]);
      seite.drawText(m, { x: 100, y: 700, size: 12, font });
    }
    const bytes = await doc.save();
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytes), 'dreiseitig.pdf');
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: meta.id, name: 'dreiseitig.pdf', position: { x: 0, y: 0 }, id: 'd-quelle' });
    // Enthefterzange (extractPage): löst Seite 2 als eigene Karte mit pageOnly=2 heraus —
    // `pageOnly` ist kein addDoc-Feld, sondern entsteht ausschließlich über diesen Command.
    await befehl(ctx, ctx.deskId, 'extractPage', { docId: 'd-quelle', page: 2, position: { x: 100, y: 100 }, id: 'd-seite' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-seite', layerId: 'exportierbar' });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [{ docId: 'd-seite', bezeichnung: 'Seite 2' }],
    });
    expect(res.statusCode).toBe(200);
    // Seit 10-02 trägt jedes Paket einen Vorspann (Deckblatt+Verzeichnis) vor den
    // Anlagenseiten — die Gesamtseitenzahl ist deshalb keine verlässliche Zusicherung mehr für
    // "genau eine Anlagenseite"; stattdessen zählt, wie viele Seiten Anlageninhalt tragen.
    const seiten = await extrahiereSeiten(new Uint8Array(res.rawPayload));
    const seitenMitInhalt = seiten.filter((t) => t.includes('SEITE'));
    expect(seitenMitInhalt.length).toBe(1);
    expect(seitenMitInhalt[0]).toContain('SEITEZWEI8A2C');
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain('SEITEZWEI8A2C');
    expect(text).not.toContain('SEITEEINS4F7B');
    expect(text).not.toContain('SEITEDREI1D9E');
  });

  it('Schwärzung: eine redact-Markierung im Paket ist echt gelöscht (Verifikationsgate)', async () => {
    const ctx = await neuerDesk();
    const geheim = 'GEHEIMPAKET9F3C1A';
    const fixture = await erzeugeTextPdf(geheim, 100, 700);
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(fixture.bytes), 'geheim.pdf');
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: meta.id, name: 'geheim.pdf', position: { x: 0, y: 0 }, id: 'd-geheim' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-geheim', layerId: 'exportierbar' });
    await befehl(ctx, ctx.deskId, 'addMark', {
      mark: { id: 'm-1', docId: 'd-geheim', page: 1, rect: fixture.basis, kind: 'redact', textSnapshot: geheim },
    });
    await befehl(ctx, ctx.deskId, 'setFreigabe', { objectId: 'm-1', freigabe: 'export' });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [{ docId: 'd-geheim', bezeichnung: 'Geheim' }],
    });
    expect(res.statusCode).toBe(200);
    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).not.toContain(geheim);
  });

  it('unbekannt: eine erfundene und eine für den anfragenden Nutzer unsichtbare docId verhalten sich identisch', async () => {
    const ctx = await neuerDesk();
    // Doc auf der Privat-Ebene von Nutzer a — für Nutzer a selbst sichtbar, für b nicht
    // (istObjektSichtbarFuer, PERM-05-Kern): changeLayerId('privat') materialisiert die
    // Pro-Nutzer-Instanz aus meta.createdById, den die Server-Session von a stellt.
    const privatDoc = await legeDokAn(ctx, { id: 'd-privat', text: 'MARKERPRIVATSICHT6E2D', aufExportEbene: true });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: privatDoc.docId, layerId: 'privat' });
    // Nutzer b bekommt Exportrecht, sieht die private Ebene von a aber nicht.
    ctx.db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(ctx.deskId, ctx.b.userId, 'Bearbeiter');

    const alsB = (eintraege: { docId: string; bezeichnung: string }[]) =>
      ctx.app.inject({
        method: 'POST', url: `/api/v1/desks/${ctx.deskId}/export/pdf/anlagenpaket`, headers: ctx.b.authHeaders,
        payload: { deckblattTitel: 'Anlagen', eintraege },
      });

    const resErfunden = await alsB([{ docId: 'gibtsnicht', bezeichnung: 'X' }]);
    expect(resErfunden.statusCode).toBe(422);
    const bodyErfunden = resErfunden.json() as { error: string; reason?: string };
    expect(bodyErfunden.reason).toBe('keine-dokumente');
    expect(resErfunden.headers['x-anlagenpaket-ausgelassen']).toBeUndefined();

    const resUnsichtbar = await alsB([{ docId: privatDoc.docId, bezeichnung: 'X' }]);
    expect(resUnsichtbar.statusCode).toBe(resErfunden.statusCode);
    const bodyUnsichtbar = resUnsichtbar.json() as { error: string; reason?: string };
    expect(bodyUnsichtbar.reason).toBe(bodyErfunden.reason);
    expect(bodyUnsichtbar.error).toBe(bodyErfunden.error);
  });

  it('Deckel: mehr Einträge als ANLAGENPAKET_DOKUMENT_LIMIT ⇒ 422 limit ohne Dokumentnamen', async () => {
    const ctx = await neuerDesk();
    const eintraege = Array.from({ length: ANLAGENPAKET_DOKUMENT_LIMIT + 1 }, (_, i) => ({ docId: `d-${i}`, bezeichnung: `Doc ${i}` }));

    const res = await anlagenpaketErzeugen(ctx, { deckblattTitel: 'Anlagen', eintraege });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('limit');
    expect(body.error).not.toMatch(/d-\d+/);
  });

  it('Deckel (WR-01): mehr Ausschlusszeilen als ANLAGENPAKET_AUSGESCHLOSSENE_SEITEN_LIMIT ⇒ 422 ungueltige-anfrage', async () => {
    const ctx = await neuerDesk();
    const doc = await legeDokAn(ctx, { id: 'd-ausschluss-deckel', text: 'MARKERAUSSCHLUSSDECKEL7B1A', aufExportEbene: true });
    const ausgeschlosseneSeiten = Array.from(
      { length: ANLAGENPAKET_AUSGESCHLOSSENE_SEITEN_LIMIT + 1 },
      (_, i) => ({ docId: doc.docId, seite: i + 1 })
    );

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [{ docId: doc.docId, bezeichnung: 'Doc' }],
      ausgeschlosseneSeiten,
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('ungueltige-anfrage');
  });

  it('Recht: ein Nutzer ohne Export-Recht erhält 403 und es entsteht kein Journaleintrag', async () => {
    const ctx = await neuerDesk();
    const doc = await legeDokAn(ctx, { id: 'd-recht', text: 'MARKERRECHTPAKET3B7F', aufExportEbene: true });
    ctx.db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(ctx.deskId, ctx.b.userId, 'Nur-Lesen');

    const vorJournal = ctx.db.prepare('SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ?').get(ctx.deskId) as { n: number };
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${ctx.deskId}/export/pdf/anlagenpaket`, headers: ctx.b.authHeaders,
      payload: { deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'Doc' }] },
    });
    expect(res.statusCode).toBe(403);
    const nachJournal = ctx.db.prepare('SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ?').get(ctx.deskId) as { n: number };
    expect(nachJournal.n).toBe(vorJournal.n);
  });

  it('Journal: nach erfolgreicher Erzeugung existiert genau ein Journaleintrag ohne Dokumentnamen', async () => {
    const ctx = await neuerDesk();
    const doc = await legeDokAn(ctx, { id: 'd-journal', text: 'MARKERJOURNALPAKET8C4E', aufExportEbene: true });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [{ docId: doc.docId, bezeichnung: 'Doc' }],
    });
    expect(res.statusCode).toBe(200);

    const zeilen = ctx.db
      .prepare("SELECT payload FROM command_journal WHERE desk_id = ? AND type = 'exported'")
      .all(ctx.deskId) as { payload: string }[];
    expect(zeilen.length).toBe(1);
    const payload = JSON.parse(zeilen[0].payload) as { format: string };
    expect(payload.format).toBe('anlagenpaket');
    expect(zeilen[0].payload).not.toContain('d-journal');
    expect(zeilen[0].payload).not.toContain('.pdf');
  });

  it('Ergebnis-Seitenzahl entspricht der Summe der übernommenen Seiten (Landkarte seiten hat dieselbe Länge)', async () => {
    const ctx = await neuerDesk();
    const eins = await legeDokAn(ctx, { id: 'd-a', text: 'MARKERSUMMEEINSA2F4', aufExportEbene: true });
    const zwei = await legeDokAn(ctx, { id: 'd-b', text: 'MARKERSUMMEZWEIB9E1', aufExportEbene: true });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: eins.docId, bezeichnung: 'A' },
        { docId: zwei.docId, bezeichnung: 'B' },
      ],
    });
    expect(res.statusCode).toBe(200);
    // Seit 10-02 trägt jedes Paket einen Vorspann vor den Anlagenseiten (siehe Kommentar im
    // pageOnly-Test oben) — gezählt werden deshalb die Seiten mit Anlageninhalt, nicht die
    // Gesamtseitenzahl.
    const seiten = await extrahiereSeiten(new Uint8Array(res.rawPayload));
    const seitenMitInhalt = seiten.filter((t) => t.includes('MARKERSUMME'));
    expect(seitenMitInhalt.length).toBe(2);
  });

  it('Startseite stimmt: die im Verzeichnis genannte Startseite ist genau die gedruckte Seitenzahl', async () => {
    const ctx = await neuerDesk();
    const { PDFDocument, StandardFonts } = await import('pdf-lib');

    async function mehrseitigesPdf(praefix: string, seitenzahl: number): Promise<Uint8Array> {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= seitenzahl; i++) {
        const seite = doc.addPage([595, 842]);
        seite.drawText(`${praefix}SEITE${i}`, { x: 100, y: 700, size: 12, font });
      }
      return doc.save();
    }

    // Drei Unterlagen unterschiedlichen Umfangs (2, 3, 1 Seiten) — Verzeichnis muss die
    // Startseiten 1, 3 und 6 nennen, und genau diese Zahlen müssen als "Seite n von 6" auf den
    // entsprechenden Anlagenseiten stehen.
    const bytesA = await mehrseitigesPdf('MARKERA', 2);
    const bytesB = await mehrseitigesPdf('MARKERB', 3);
    const bytesC = await mehrseitigesPdf('MARKERC', 1);
    const metaA = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytesA), 'a.pdf');
    const metaB = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytesB), 'b.pdf');
    const metaC = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytesC), 'c.pdf');
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: metaA.id, name: 'a.pdf', position: { x: 0, y: 0 }, id: 'd-a' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-a', layerId: 'exportierbar' });
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: metaB.id, name: 'b.pdf', position: { x: 0, y: 0 }, id: 'd-b' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-b', layerId: 'exportierbar' });
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: metaC.id, name: 'c.pdf', position: { x: 0, y: 0 }, id: 'd-c' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-c', layerId: 'exportierbar' });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: 'd-a', bezeichnung: 'A' },
        { docId: 'd-b', bezeichnung: 'B' },
        { docId: 'd-c', bezeichnung: 'C' },
      ],
    });
    expect(res.statusCode).toBe(200);

    const seiten = await extrahiereSeiten(new Uint8Array(res.rawPayload));
    const seiteVon = (n: number) => seiten.find((t) => t.includes(`Seite ${n} von 6`));

    const seite1 = seiteVon(1);
    expect(seite1).toBeDefined();
    expect(seite1).toContain('MARKERASEITE1');

    const seite3 = seiteVon(3);
    expect(seite3).toBeDefined();
    expect(seite3).toContain('MARKERBSEITE1');

    const seite6 = seiteVon(6);
    expect(seite6).toBeDefined();
    expect(seite6).toContain('MARKERCSEITE1');
  });

  it('Lesezeichen: die ausgelieferten Bytes enthalten nach erneutem Einlesen einen Baum mit 1 + Zahl der Anlagen Einträgen', async () => {
    const ctx = await neuerDesk();
    const eins = await legeDokAn(ctx, { id: 'd-lz-1', text: 'MARKERLESEZEICHENEINS', aufExportEbene: true });
    const zwei = await legeDokAn(ctx, { id: 'd-lz-2', text: 'MARKERLESEZEICHENZWEI', aufExportEbene: true });
    const drei = await legeDokAn(ctx, { id: 'd-lz-3', text: 'MARKERLESEZEICHENDREI', aufExportEbene: true });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: eins.docId, bezeichnung: 'Eins' },
        { docId: zwei.docId, bezeichnung: 'Zwei' },
        { docId: drei.docId, bezeichnung: 'Drei' },
      ],
    });
    expect(res.statusCode).toBe(200);

    const geladen = await ladeLesezeichenwurzel(new Uint8Array(res.rawPayload));
    expect(geladen).not.toBeNull();
    const { doc, wurzel } = geladen!;
    const anzahl = wurzel.lookup(PDFName.of('Count'));
    expect((anzahl as PDFNumber).asNumber()).toBe(4); // Anlagenverzeichnis + 3 Anlagen

    const kette = lesezeichenKette(doc, wurzel.get(PDFName.of('First')));
    expect(kette.length).toBe(4);
    const titel = kette.map((d) => (d.lookup(PDFName.of('Title')) as PDFHexString).decodeText());
    expect(titel[0]).toBe('Anlagenverzeichnis');
    expect(titel[1]).toBe('K1 — Eins');
    expect(titel[2]).toBe('K2 — Zwei');
    expect(titel[3]).toBe('K3 — Drei');
  });

  it('Lesezeichen bleiben: Regressionswächter gegen einen Bereinigungslauf nach den Lesezeichen', async () => {
    // Diese Zusicherung fällt in dem Moment, in dem irgendwer einen Bereinigungslauf hinter die
    // Lesezeichen setzt — scrubbePdf() entfernt den Katalogeintrag Outlines bedingungslos.
    const ctx = await neuerDesk();
    const doc = await legeDokAn(ctx, { id: 'd-lz-bleiben', text: 'MARKERLESEZEICHENBLEIBEN', aufExportEbene: true });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [{ docId: doc.docId, bezeichnung: 'Doc' }],
    });
    expect(res.statusCode).toBe(200);

    const geladen = await ladeLesezeichenwurzel(new Uint8Array(res.rawPayload));
    expect(geladen).not.toBeNull();
    const anzahl = geladen!.wurzel.lookup(PDFName.of('Count'));
    expect((anzahl as PDFNumber).asNumber()).toBe(2); // Anlagenverzeichnis + 1 Anlage
  });

  it('Lesezeichen zeigen richtig: das Ziel des Eintrags einer Anlage ist die Seite, deren Fußtext die im Verzeichnis genannte Startseite trägt', async () => {
    const ctx = await neuerDesk();
    const { PDFDocument: PDFErzeugen, StandardFonts } = await import('pdf-lib');

    async function mehrseitigesPdf(praefix: string, seitenzahl: number): Promise<Uint8Array> {
      const erzeuger = await PDFErzeugen.create();
      const font = await erzeuger.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= seitenzahl; i++) {
        const seite = erzeuger.addPage([595, 842]);
        seite.drawText(`${praefix}SEITE${i}`, { x: 100, y: 700, size: 12, font });
      }
      return erzeuger.save();
    }

    const bytesA = await mehrseitigesPdf('MARKERLZA', 2);
    const bytesB = await mehrseitigesPdf('MARKERLZB', 1);
    const metaA = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytesA), 'lz-a.pdf');
    const metaB = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytesB), 'lz-b.pdf');
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: metaA.id, name: 'lz-a.pdf', position: { x: 0, y: 0 }, id: 'd-lz-a' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-lz-a', layerId: 'exportierbar' });
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: metaB.id, name: 'lz-b.pdf', position: { x: 0, y: 0 }, id: 'd-lz-b' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-lz-b', layerId: 'exportierbar' });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: 'd-lz-a', bezeichnung: 'A' },
        { docId: 'd-lz-b', bezeichnung: 'B' },
      ],
    });
    expect(res.statusCode).toBe(200);

    const geladen = await ladeLesezeichenwurzel(new Uint8Array(res.rawPayload));
    expect(geladen).not.toBeNull();
    const { doc, wurzel } = geladen!;
    const kette = lesezeichenKette(doc, wurzel.get(PDFName.of('First')));
    // Eintrag 1 = Anlagenverzeichnis, Eintrag 2 = K1 (A, Startseite 1), Eintrag 3 = K2 (B, Startseite 3)
    const seiten = await extrahiereSeiten(new Uint8Array(res.rawPayload));

    const zielSeite = (eintrag: PDFDict): number => {
      const dest = doc.context.lookup(eintrag.get(PDFName.of('Dest')) as never) as unknown as {
        get: (i: number) => unknown;
      };
      const zielRef = dest.get(0) as { toString: () => string };
      return doc.getPages().findIndex((p) => p.ref.toString() === zielRef.toString());
    };

    const seiteK1 = zielSeite(kette[1]);
    expect(seiten[seiteK1]).toContain('Seite 1 von 3');
    expect(seiten[seiteK1]).toContain('MARKERLZASEITE1');

    const seiteK2 = zielSeite(kette[2]);
    expect(seiten[seiteK2]).toContain('Seite 3 von 3');
    expect(seiten[seiteK2]).toContain('MARKERLZBSEITE1');
  });
});

/** Antwortform der Prüfroute — nur Positionen und Zahlen, kein Seitentext. */
interface AnlagenpaketPruefungAntwort {
  dubletten: { docId: string; lokaleSeite: number; gleichWieDocId: string; gleichWieLokaleSeite: number }[];
  leerseiten: { docId: string; lokaleSeite: number }[];
  unbeurteilbar: { docId: string; lokaleSeite: number }[];
  seitenGesamt: number;
  ausgelassen: number;
}

/** Ersetzt die `file_pages`-Zeile einer Seite durch feste Werte — überschreibt das, was die
 *  reale (asynchrone) Extraktion beim Hochladen bereits geschrieben hat (`legeTextErgebnisAn`-
 *  Muster aus `search/fileText.test.ts`); der Aufrufer muss vorher `warteAufLeerlauf()`
 *  abwarten, damit der automatische Lauf nicht die manuelle Zeile überschreibt. */
function legeFilePagesZeileAn(db: Db, fileId: string, page: number, spalten: { pdfText?: string | null; ocrText?: string | null }): void {
  db.prepare('DELETE FROM file_pages WHERE file_id = ? AND page = ?').run(fileId, page);
  db.prepare(
    'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, ?, ?, NULL)',
  ).run(fileId, page, spalten.pdfText ?? null, spalten.ocrText ?? null);
}

/** Baut ein zweiseitiges PDF: erste Seite mit `praefix`-Marker, zweite Seite mit `zweiteSeite`. */
async function zweiseitigesPdf(praefix: string, zweiteSeite: string): Promise<Uint8Array> {
  const { PDFDocument: PDFErzeugen, StandardFonts } = await import('pdf-lib');
  const doc = await PDFErzeugen.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const seite1 = doc.addPage([595, 842]);
  seite1.drawText(`${praefix}SEITEEINS`, { x: 100, y: 700, size: 12, font });
  const seite2 = doc.addPage([595, 842]);
  seite2.drawText(zweiteSeite, { x: 100, y: 700, size: 12, font });
  return doc.save();
}

/** Baut ein einseitiges PDF ohne jeden Seiteninhalt (textlos). */
async function leeresEinseitigesPdf(): Promise<Uint8Array> {
  const { PDFDocument: PDFErzeugen } = await import('pdf-lib');
  const doc = await PDFErzeugen.create();
  doc.addPage([595, 842]);
  return doc.save();
}

function anlagenpaketPruefung(
  ctx: { app: FastifyInstance; a: EinNutzer; deskId: string },
  wunsch: { deckblattTitel: string; eintraege: { docId: string; bezeichnung: string }[] },
  nutzer: EinNutzer = ctx.a,
) {
  return ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${ctx.deskId}/export/anlagenpaket/pruefung`, headers: nutzer.authHeaders,
    payload: wunsch,
  });
}

describe('POST /api/v1/desks/:id/export/anlagenpaket/pruefung', () => {
  it('Dublette: zwei Unterlagen, deren jeweils zweite Seite denselben Text trägt; die Antwort nennt genau einen Dubletteneintrag mit beiden Fundstellen', async () => {
    const ctx = await neuerDesk();
    const gemeinsam = 'GEMEINSAMERTEXTPRUEFUNG7F3A9C';
    const bytesA = await zweiseitigesPdf('PRUEFA', gemeinsam);
    const bytesB = await zweiseitigesPdf('PRUEFB', gemeinsam);
    const metaA = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytesA), 'pruef-a.pdf');
    const metaB = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytesB), 'pruef-b.pdf');
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: metaA.id, name: 'pruef-a.pdf', position: { x: 0, y: 0 }, id: 'd-pruef-a' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-pruef-a', layerId: 'exportierbar' });
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: metaB.id, name: 'pruef-b.pdf', position: { x: 0, y: 0 }, id: 'd-pruef-b' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-pruef-b', layerId: 'exportierbar' });

    const res = await anlagenpaketPruefung(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: 'd-pruef-a', bezeichnung: 'A' },
        { docId: 'd-pruef-b', bezeichnung: 'B' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnlagenpaketPruefungAntwort;
    expect(body.dubletten).toEqual([{ docId: 'd-pruef-b', lokaleSeite: 2, gleichWieDocId: 'd-pruef-a', gleichWieLokaleSeite: 2 }]);
    expect(body.seitenGesamt).toBe(4);
    expect(body.ausgelassen).toBe(0);
  });

  it('keine Dubletten: eine Auswahl ohne Wiederholungen liefert leere Listen und Status 200', async () => {
    const ctx = await neuerDesk();
    const eins = await legeDokAn(ctx, { id: 'd-keinedup-1', text: 'MARKERKEINEDUPEINS4B7A', aufExportEbene: true });
    const zwei = await legeDokAn(ctx, { id: 'd-keinedup-2', text: 'MARKERKEINEDUPZWEI9E2C', aufExportEbene: true });

    const res = await anlagenpaketPruefung(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: eins.docId, bezeichnung: 'Eins' },
        { docId: zwei.docId, bezeichnung: 'Zwei' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnlagenpaketPruefungAntwort;
    expect(body.dubletten).toEqual([]);
    expect(body.leerseiten).toEqual([]);
    expect(body.unbeurteilbar).toEqual([]);
  });

  it('Leerseite: eine Unterlage mit einer textlosen Seite und vorhandener Indexzeile erscheint in leerseiten', async () => {
    const ctx = await neuerDesk();
    const bytes = await leeresEinseitigesPdf();
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytes), 'leer.pdf');
    await warteAufLeerlauf();
    legeFilePagesZeileAn(ctx.db, meta.id, 1, { pdfText: '' });
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: meta.id, name: 'leer.pdf', position: { x: 0, y: 0 }, id: 'd-leer' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-leer', layerId: 'exportierbar' });

    const res = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: 'd-leer', bezeichnung: 'Leer' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnlagenpaketPruefungAntwort;
    expect(body.leerseiten).toEqual([{ docId: 'd-leer', lokaleSeite: 1 }]);
    expect(body.unbeurteilbar).toEqual([]);
  });

  it('OCR nicht leer: eine Unterlage, deren Seite nur über die Indexzeile Text hat, erscheint weder in leerseiten noch in unbeurteilbar', async () => {
    const ctx = await neuerDesk();
    const bytes = await leeresEinseitigesPdf();
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytes), 'ocr.pdf');
    await warteAufLeerlauf();
    legeFilePagesZeileAn(ctx.db, meta.id, 1, { ocrText: 'MARKERPRUEFUNGOCRTEXT2D6F' });
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: meta.id, name: 'ocr.pdf', position: { x: 0, y: 0 }, id: 'd-ocr' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-ocr', layerId: 'exportierbar' });

    const res = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: 'd-ocr', bezeichnung: 'OCR' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnlagenpaketPruefungAntwort;
    expect(body.leerseiten).toEqual([]);
    expect(body.unbeurteilbar).toEqual([]);
  });

  it('unbeurteilbar: eine Unterlage ohne Indexzeile und ohne extrahierbaren Text erscheint in unbeurteilbar und nicht in leerseiten', async () => {
    const ctx = await neuerDesk();
    const bytes = await leeresEinseitigesPdf();
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytes), 'unbeurteilbar.pdf');
    await warteAufLeerlauf();
    // Simuliert eine noch nicht (oder nicht mehr) indizierte Datei — die reale Extraktion legt
    // für kind='pdf' normalerweise immer eine Zeile an; hier wird sie bewusst entfernt, um den
    // Zustand "keine Aussage möglich" zu prüfen.
    ctx.db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(meta.id);
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: meta.id, name: 'unbeurteilbar.pdf', position: { x: 0, y: 0 }, id: 'd-unb' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-unb', layerId: 'exportierbar' });

    const res = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: 'd-unb', bezeichnung: 'Unb' }] });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AnlagenpaketPruefungAntwort;
    expect(body.leerseiten).toEqual([]);
    expect(body.unbeurteilbar).toEqual([{ docId: 'd-unb', lokaleSeite: 1 }]);
  });

  it('Recht: ein Nutzer ohne Export-Recht erhält 403', async () => {
    const ctx = await neuerDesk();
    const doc = await legeDokAn(ctx, { id: 'd-pruef-recht', text: 'MARKERPRUEFUNGRECHT8A1D', aufExportEbene: true });
    ctx.db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(ctx.deskId, ctx.b.userId, 'Nur-Lesen');

    const res = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'Doc' }] }, ctx.b);
    expect(res.statusCode).toBe(403);
  });

  it('kein Journal: nach einem erfolgreichen Prüfaufruf ist die Zahl der Journaleinträge unverändert', async () => {
    const ctx = await neuerDesk();
    const doc = await legeDokAn(ctx, { id: 'd-pruef-journal', text: 'MARKERPRUEFUNGJOURNAL6C3E', aufExportEbene: true });

    const vorJournal = ctx.db.prepare('SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ?').get(ctx.deskId) as { n: number };
    const res = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'Doc' }] });
    expect(res.statusCode).toBe(200);
    const nachJournal = ctx.db.prepare('SELECT COUNT(*) AS n FROM command_journal WHERE desk_id = ?').get(ctx.deskId) as { n: number };
    expect(nachJournal.n).toBe(vorJournal.n);
  });

  it('kein Text in der Antwort: der serialisierte Antwortkörper enthält keine der im Testdokument verwendeten Markerzeichenketten', async () => {
    const ctx = await neuerDesk();
    const marker = 'MARKERPRUEFUNGGEHEIMTEXT4F9B';
    const doc = await legeDokAn(ctx, { id: 'd-pruef-text', text: marker, aufExportEbene: true });

    const res = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'Doc' }] });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(marker);
  });

  it('Deckel: eine Prüfanfrage über dem Dokumentdeckel antwortet 422 mit dem Grund limit', async () => {
    const ctx = await neuerDesk();
    const eintraege = Array.from({ length: ANLAGENPAKET_DOKUMENT_LIMIT + 1 }, (_, i) => ({ docId: `d-${i}`, bezeichnung: `Doc ${i}` }));

    const res = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('limit');
  });
});

/**
 * Ausschlüsse beim Erzeugen und Unversehrtheit der Originale (KONV-03, 10-04): die
 * Ausschlussliste wirkt bereits in sammleAuswahl() (Task 2), dieser Block belegt, dass sie sich
 * vollständig durch Nummerierung/Verzeichnis zieht UND dass Prüfung sowie Erzeugung die
 * Originaldatei, ihre Datenbankzeile und den gespeicherten Schreibtischzustand nicht verändern.
 */
describe('Anlagenpaket — Ausschlüsse und Unversehrtheit der Originale', () => {
  it('Dublette ausgeschlossen: eine Erzeugung mit einer Ausschlusszeile liefert ein Paket mit einer Seite weniger; der Text der ausgeschlossenen Seite fehlt in der Extraktion, und die Gesamtseitenzahl in den Fußtexten ist entsprechend kleiner', async () => {
    const ctx = await neuerDesk();
    const marker2 = 'MARKERAUSSCHLUSSSEITE2F1B';
    const bytes = await zweiseitigesPdf('AUSSA', marker2);
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(bytes), 'ausschluss.pdf');
    await befehl(ctx, ctx.deskId, 'addDoc', { fileId: meta.id, name: 'ausschluss.pdf', position: { x: 0, y: 0 }, id: 'd-ausschluss' });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-ausschluss', layerId: 'exportierbar' });

    const ohneAusschluss = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen', eintraege: [{ docId: 'd-ausschluss', bezeichnung: 'A' }],
    });
    expect(ohneAusschluss.statusCode).toBe(200);
    const seitenOhne = await extrahiereSeiten(new Uint8Array(ohneAusschluss.rawPayload));
    const anlagenseitenOhne = seitenOhne.filter((t) => t.includes('AUSSASEITEEINS') || t.includes(marker2));
    expect(anlagenseitenOhne.length).toBe(2);

    const mitAusschluss = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen', eintraege: [{ docId: 'd-ausschluss', bezeichnung: 'A' }],
      ausgeschlosseneSeiten: [{ docId: 'd-ausschluss', seite: 2 }],
    });
    expect(mitAusschluss.statusCode).toBe(200);
    const textMit = await extrahiereText(new Uint8Array(mitAusschluss.rawPayload));
    expect(textMit).not.toContain(marker2);
    expect(textMit).toContain('AUSSASEITEEINS');

    const seitenMit = await extrahiereSeiten(new Uint8Array(mitAusschluss.rawPayload));
    const anlagenseiteMit = seitenMit.find((t) => t.includes('AUSSASEITEEINS'));
    expect(anlagenseiteMit).toBeDefined();
    // Nur noch eine Anlagenseite im Paket — der Fußtext benennt sie folgerichtig als "1 von 1".
    expect(anlagenseiteMit).toContain('Seite 1 von 1');
  });

  it('Nummern rücken auf: werden alle Seiten der mittleren von drei Unterlagen ausgeschlossen, trägt die dritte Unterlage die Anlagennummer K2, und das Verzeichnis hat zwei Zeilen', async () => {
    const ctx = await neuerDesk();
    const eins = await legeDokAn(ctx, { id: 'd-nr-1', text: 'MARKERNUMMERNEINS3A7C', aufExportEbene: true });
    const zwei = await legeDokAn(ctx, { id: 'd-nr-2', text: 'MARKERNUMMERNZWEI8D2E', aufExportEbene: true });
    const drei = await legeDokAn(ctx, { id: 'd-nr-3', text: 'MARKERNUMMERNDREI5F9B', aufExportEbene: true });

    const res = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen',
      eintraege: [
        { docId: eins.docId, bezeichnung: 'Eins' },
        { docId: zwei.docId, bezeichnung: 'Zwei' },
        { docId: drei.docId, bezeichnung: 'Drei' },
      ],
      ausgeschlosseneSeiten: [{ docId: zwei.docId, seite: 1 }],
    });
    expect(res.statusCode).toBe(200);

    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain('MARKERNUMMERNEINS3A7C');
    expect(text).not.toContain('MARKERNUMMERNZWEI8D2E'); // die ganz ausgeschlossene Unterlage fehlt restlos
    expect(text).toContain('MARKERNUMMERNDREI5F9B');
    expect(text).toContain('K1');
    expect(text).toContain('K2');
    expect(text).not.toContain('K3'); // kein Lücken-Sprung — "Drei" trägt K2, nicht K3

    const seiten = await extrahiereSeiten(new Uint8Array(res.rawPayload));
    const seiteDrei = seiten.find((t) => t.includes('MARKERNUMMERNDREI5F9B'));
    expect(seiteDrei).toBeDefined();
    expect(seiteDrei).toContain('K2'); // die dritte Unterlage rückt lückenlos auf Position K2 auf
  });

  it('unbekannte Ausschlusszeile: eine Ausschlusszeile mit unbekannter Seite oder unbekannter Dokument-id verändert das Ergebnis nicht und erzeugt keinen Fehler', async () => {
    const ctx = await neuerDesk();
    const marker = 'MARKERUNBEKANNTAUSSCHLUSS1E4A';
    const doc = await legeDokAn(ctx, { id: 'd-unbek-aus', text: marker, aufExportEbene: true });

    const ohne = await anlagenpaketErzeugen(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'A' }] });
    expect(ohne.statusCode).toBe(200);
    const seitenOhne = await extrahiereSeiten(new Uint8Array(ohne.rawPayload));

    const mitUnbekannterSeite = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'A' }],
      ausgeschlosseneSeiten: [{ docId: doc.docId, seite: 99 }], // Seite gibt es in der Unterlage nicht
    });
    expect(mitUnbekannterSeite.statusCode).toBe(200);
    const textMitUnbekannterSeite = await extrahiereText(new Uint8Array(mitUnbekannterSeite.rawPayload));
    expect(textMitUnbekannterSeite).toContain(marker);
    const seitenMitUnbekannterSeite = await extrahiereSeiten(new Uint8Array(mitUnbekannterSeite.rawPayload));
    expect(seitenMitUnbekannterSeite.length).toBe(seitenOhne.length);

    const mitUnbekannterDocId = await anlagenpaketErzeugen(ctx, {
      deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'A' }],
      ausgeschlosseneSeiten: [{ docId: 'gibtsnicht', seite: 1 }], // docId gehört nicht zur Auswahl
    });
    expect(mitUnbekannterDocId.statusCode).toBe(200);
    const textMitUnbekannterDocId = await extrahiereText(new Uint8Array(mitUnbekannterDocId.rawPayload));
    expect(textMitUnbekannterDocId).toContain(marker);
    const seitenMitUnbekannterDocId = await extrahiereSeiten(new Uint8Array(mitUnbekannterDocId.rawPayload));
    expect(seitenMitUnbekannterDocId.length).toBe(seitenOhne.length);
  });

  it('Original unangetastet: Dateibytes, Dateitabellenzeile und Schreibtischzustand sind vor und nach Prüfung und Erzeugung unverändert (Hashvergleich, nicht Längenvergleich)', async () => {
    const ctx = await neuerDesk();
    const doc = await legeDokAn(ctx, { id: 'd-original', text: 'MARKERORIGINALUNANGETASTET6B3F', aufExportEbene: true });

    const pfad = getFilePath(ctx.db, ctx.dataDir, doc.fileId);
    expect(pfad).not.toBeNull();
    const hashVorher = createHash('sha256').update(readFileSync(pfad!)).digest('hex');
    const zeileVorher = ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(doc.fileId);
    const stateVorher = getDeskState(ctx.db, ctx.deskId);

    const pruefungRes = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'A' }] });
    expect(pruefungRes.statusCode).toBe(200);
    const erzeugungRes = await anlagenpaketErzeugen(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: doc.docId, bezeichnung: 'A' }] });
    expect(erzeugungRes.statusCode).toBe(200);

    const hashNachher = createHash('sha256').update(readFileSync(pfad!)).digest('hex');
    expect(hashNachher).toBe(hashVorher); // Hashvergleich, nicht nur Längenvergleich
    const zeileNachher = ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(doc.fileId);
    expect(zeileNachher).toEqual(zeileVorher);
    const stateNachher = getDeskState(ctx.db, ctx.deskId);
    expect(JSON.stringify(stateNachher)).toBe(JSON.stringify(stateVorher));
  });

  it('Vorschau-Cache unangetastet: bei einer Unterlage der Dateiart Office-Umwandlung ist auch die Datei im Vorschau-Cache nach beiden Aufrufen unverändert', async () => {
    const ctx = await neuerDesk();
    const marker = 'MARKERCONVERTIBLECACHE2A8D';
    const fixture = await erzeugeTextPdf(marker, 100, 700);
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(new TextEncoder().encode('kein echtes Office-Paket')), 'schriftsatz.docx');
    await befehl(ctx, ctx.deskId, 'addDoc', {
      fileId: meta.id, name: 'schriftsatz.docx', position: { x: 0, y: 0 }, id: 'd-conv', kind: 'convertible',
    });
    await befehl(ctx, ctx.deskId, 'changeLayerId', { objectId: 'd-conv', layerId: 'exportierbar' });
    const cachePfad = previewCachePath(ctx.dataDir, meta.id);
    mkdirSync(dirname(cachePfad), { recursive: true });
    writeFileSync(cachePfad, fixture.bytes);
    const hashVorher = createHash('sha256').update(readFileSync(cachePfad)).digest('hex');

    const pruefungRes = await anlagenpaketPruefung(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: 'd-conv', bezeichnung: 'Conv' }] });
    expect(pruefungRes.statusCode).toBe(200);
    const erzeugungRes = await anlagenpaketErzeugen(ctx, { deckblattTitel: 'Anlagen', eintraege: [{ docId: 'd-conv', bezeichnung: 'Conv' }] });
    expect(erzeugungRes.statusCode).toBe(200);
    const text = await extrahiereText(new Uint8Array(erzeugungRes.rawPayload));
    expect(text).toContain(marker);

    const hashNachher = createHash('sha256').update(readFileSync(cachePfad)).digest('hex');
    expect(hashNachher).toBe(hashVorher);
  });
});
