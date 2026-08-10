import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createTestApp, createTestAppMitZweiNutzern } from '../testUtils';
import { storeFile } from '../files';
import { warteAufLeerlauf } from '../ocr/ocrQueue';
import { SUCHE_MAX_TREFFER } from './searchQuery';

/** Mehrseitiges PDF mit definiertem Text pro Seite — dasselbe Muster wie ocr/extract.test.ts
 *  (`pdfTestFixtures.ts` hat keinen Mehrseiten-Helfer). Realer, per pdfjs parsebarer Inhalt ist
 *  hier Pflicht: die Extraktion (07-04, ocrQueue.ts) läuft echt, kein gemocktes `extract`-Modul. */
async function pdfMitSeiten(texte: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of texte) {
    const seite = doc.addPage([595, 842]);
    if (text) seite.drawText(text, { x: 50, y: 700, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

/**
 * SEARCH-04 (T-07-01/T-07-02): dieselbe Zwei-Stufen-Sichtbarkeitsprüfung, die Phase 2 bereits
 * über `app.projection.test.ts` für die zehn übrigen Auslieferungspfade absichert — hier für den
 * elften Pfad (POST /desks/:id/search). Ein gefilterter Treffer muss vollständig fehlen (strikte
 * Gleichheit mit einer leeren Liste), nicht nur „nicht enthalten sein" — ein Resttreffer mit
 * geleertem Label wäre ebenfalls ein Leck (aec4f58, fcda808).
 */
describe('POST /desks/:id/search — Sichtbarkeits-Gegenprobe (SEARCH-04)', () => {
  it('Objekt auf privater Ebene von A: für B leer, für A selbst auffindbar (Positivfall im selben Setup)', async () => {
    const { app, db, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const anlegen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addNote', payload: { id: 'note-geheim', kind: 'notiz', text: 'Geheimsache', position: { x: 0, y: 0 } } },
    });
    expect(anlegen.statusCode).toBe(200);
    // A stellt die Notiz auf ihre eigene private Ebene (Muster wie app.projection.test.ts:
    // changeLayerId materialisiert die Pro-Nutzer-Instanz lazy über meta.createdById).
    const umhaengen = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'note-geheim', layerId: 'privat' } },
    });
    expect(umhaengen.statusCode).toBe(200);

    const resB = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: b.authHeaders, payload: { q: 'Geheimsache' },
    });
    expect(resB.statusCode).toBe(200);
    // Strikte Gleichheit mit [] — kein gefilterter Resttreffer mit geleertem Label.
    expect(resB.json()).toEqual({ treffer: [] });

    const resA = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: a.authHeaders, payload: { q: 'Geheimsache' },
    });
    expect(resA.statusCode).toBe(200);
    const trefferA = resA.json().treffer as { objId: string }[];
    expect(trefferA.some((t) => t.objId === 'note-geheim')).toBe(true);
  });

  it('Objekt mit Freigabestufe „intern" (Default): für „externer Gast" nicht auffindbar, für Bearbeiter schon', async () => {
    const MARKER = 'INTERNER-VERMERK-Bearbeiterfall';
    const { app, b: bBearbeiter, desk: deskBearbeiter } = await deskMitInternemVermerk(MARKER, 'Bearbeiter');
    const resBearbeiter = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskBearbeiter.id}/search`, headers: bBearbeiter.authHeaders, payload: { q: MARKER },
    });
    expect(resBearbeiter.statusCode).toBe(200);
    expect((resBearbeiter.json().treffer as { objId: string }[]).some((t) => t.objId === 'note-intern')).toBe(true);

    const { app: appGast, b: bGast, desk: deskGast } = await deskMitInternemVermerk(MARKER, 'externer Gast');
    const resGast = await appGast.inject({
      method: 'POST', url: `/api/v1/desks/${deskGast.id}/search`, headers: bGast.authHeaders, payload: { q: MARKER },
    });
    expect(resGast.statusCode).toBe(200);
    expect(resGast.json()).toEqual({ treffer: [] });
  });

  it(`Kappung auf ${SUCHE_MAX_TREFFER} erfolgt NACH der Sichtbarkeits-Gegenprobe: ein relevanterer, aber unsichtbarer Treffer verdrängt keinen sichtbaren`, async () => {
    const { app, b, desk } = await deskMitVielenTreffern();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: b.authHeaders, payload: { q: 'Vertrag' },
    });
    expect(res.statusCode).toBe(200);
    const treffer = res.json().treffer as { objId: string }[];
    // Genau SUCHE_MAX_TREFFER Treffer — der unsichtbare, relevantere Kandidat (private Ebene
    // von A) darf keinen der sichtbaren 31 Kandidaten aus der gekappten Liste verdrängen.
    expect(treffer).toHaveLength(SUCHE_MAX_TREFFER);
    expect(treffer.some((t) => t.objId === 'doc-unsichtbar')).toBe(false);
  });
});

/**
 * T-07-09/T-07-11 (Vorschau-Leck-Gegenprobe): eine Markierung ist auffindbar (der Treffer
 * ERSCHEINT), aber der geschwärzte Ursprungstext darf über KEIN Feld der Antwort nach außen
 * gelangen. Die stärkere, eigentlich gemeinte Behauptung ist nicht nur „kein `snippet`-Feld",
 * sondern „der markante Text kommt in der GESAMTEN serialisierten Antwortzeichenkette nicht
 * vor" — ein Leck über ein anderes Feld (z. B. ein künftig hinzugefügtes `title` o. Ä.) würde
 * sonst unbemerkt durchrutschen.
 */
describe('POST /desks/:id/search — Vorschau-Leck-Gegenprobe für Schwärzungen (T-07-09/T-07-11)', () => {
  it('ein Treffer in einer Schwärzung erscheint, aber der geschwärzte Text taucht NIRGENDS in der Antwort auf', async () => {
    const MARKER = 'GEHEIMER-URSPRUNGSTEXT-Unterlassungserklaerung';
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Schwärzung' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\ninhalt-schwaerzung'), 'schwaerzung.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-schwaerzung', fileId: meta.id, name: 'Schreiben', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addMark',
        payload: { mark: { id: 'mark-1', docId: 'doc-schwaerzung', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact', textSnapshot: MARKER } },
      },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: MARKER },
    });
    expect(res.statusCode).toBe(200);
    const { treffer } = res.json() as { treffer: { objId: string; art: string; label: string; snippet?: string }[] };
    const eintrag = treffer.find((t) => t.objId === 'mark-1');
    // Der Treffer ERSCHEINT (der Text ist auffindbar, obwohl geschwärzt) …
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('Markierung');
    expect(eintrag?.snippet).toBeUndefined();
    // … aber der markante Text kommt NIRGENDS in der vollständigen Antwortzeichenkette vor —
    // die stärkere Behauptung als nur „kein snippet-Feld".
    expect(JSON.stringify(res.json())).not.toContain(MARKER);
    expect(res.body).not.toContain(MARKER);
  });

  it('dieselbe Unterdrückung gilt für Tipp-Ex-Markierungen (`kind: "tippex"`) — der Export behandelt beide Arten identisch als echte Schwärzung (D-01)', async () => {
    const MARKER = 'GEHEIMER-TIPPEX-URSPRUNGSTEXT';
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Tipp-Ex' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\ninhalt-tippex'), 'tippex.pdf');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-tippex', fileId: meta.id, name: 'Schreiben', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: {
        type: 'addMark',
        payload: { mark: { id: 'mark-2', docId: 'doc-tippex', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'tippex', textSnapshot: MARKER } },
      },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: MARKER },
    });
    const { treffer } = res.json() as { treffer: { objId: string; snippet?: string }[] };
    expect(treffer.some((t) => t.objId === 'mark-2')).toBe(true);
    expect(treffer.find((t) => t.objId === 'mark-2')?.snippet).toBeUndefined();
    expect(res.body).not.toContain(MARKER);
  });
});

/**
 * 07-04: Datei-Text-Treffer (SEARCH-01 "PDF-Inhalt") mit derselben Sichtbarkeits-Gegenprobe wie
 * oben (T-07-19) — hier über die fileId → Doc-Zuordnung aus dem projizierten State statt über
 * `obj_id`/`layer_id`. Echte PDF-Bytes (`pdfMitSeiten`), echte Extraktion über `enqueueExtraction`
 * (kein gemocktes `extract`-Modul) — abgewartet über `warteAufLeerlauf()`.
 */
describe('POST /desks/:id/search — Datei-Text-Treffer (SEARCH-01 "PDF-Inhalt", T-07-19)', () => {
  it('ein Begriff, der nur im PDF-Text einer Datei steht, deren Karte sichtbar ist, liefert einen Treffer mit art=PDF-Text, korrekter page, fileId und docId', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Dateitext' } })
    ).json();
    const bytes = await pdfMitSeiten(['Einleitungstext ohne den Suchbegriff.', 'EINZIGARTIGERPDFINHALTKUENDIGUNGSSCHUTZKLAGE steht nur hier.']);
    const meta = storeFile(db, dataDir, bytes, 'schriftsatz.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-dateitext', fileId: meta.id, name: 'Schriftsatz', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'EINZIGARTIGERPDFINHALTKUENDIGUNGSSCHUTZKLAGE' },
    });
    expect(res.statusCode).toBe(200);
    const { treffer } = res.json() as { treffer: { art: string; fileId?: string; docId?: string; page?: number }[] };
    const eintrag = treffer.find((t) => t.fileId === meta.id);
    expect(eintrag).toBeDefined();
    expect(eintrag?.art).toBe('PDF-Text');
    expect(eintrag?.page).toBe(2);
    expect(eintrag?.docId).toBe('doc-dateitext');
  });

  it('steht derselbe Begriff auf mehreren Seiten derselben Datei, entstehen mehrere Treffer mit unterschiedlicher id und unterschiedlicher page', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte Mehrseiten' } })
    ).json();
    const bytes = await pdfMitSeiten(['ZWEISEITENMARKERBEGRIFF auf Seite eins.', 'ZWEISEITENMARKERBEGRIFF auch auf Seite zwei.']);
    const meta = storeFile(db, dataDir, bytes, 'mehrseiten.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-mehrseiten', fileId: meta.id, name: 'Mehrseiten', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'ZWEISEITENMARKERBEGRIFF' },
    });
    const { treffer } = res.json() as { treffer: { id: string; fileId?: string; page?: number }[] };
    const treffserDieserDatei = treffer.filter((t) => t.fileId === meta.id);
    expect(treffserDieserDatei).toHaveLength(2);
    expect(new Set(treffserDieserDatei.map((t) => t.id)).size).toBe(2);
    expect(new Set(treffserDieserDatei.map((t) => t.page)).size).toBe(2);
    expect(treffserDieserDatei.map((t) => t.page).sort()).toEqual([1, 2]);
  });

  it('liegt die Karte der Datei auf einer fremden privaten Ebene, liefert die Suche für den anderen Nutzer null Treffer — obwohl der Text in file_pages_fts steht', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const bytes = await pdfMitSeiten(['PRIVATERDATEITEXTMARKERGEHEIM steht hier drin.']);
    const meta = storeFile(db, dataDir, bytes, 'privat.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-privat', fileId: meta.id, name: 'Privates Schreiben', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-privat', layerId: 'privat' } },
    });

    // Gegenprobe: der Text steht tatsächlich in file_pages_fts (kein Testartefakt).
    const roheZeile = db.prepare('SELECT 1 FROM file_pages_fts WHERE file_pages_fts MATCH ?').get('PRIVATERDATEITEXTMARKERGEHEIM');
    expect(roheZeile).toBeDefined();

    const resB = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: b.authHeaders, payload: { q: 'PRIVATERDATEITEXTMARKERGEHEIM' },
    });
    expect(resB.statusCode).toBe(200);
    expect(resB.json()).toEqual({ treffer: [] });

    const resA = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: a.authHeaders, payload: { q: 'PRIVATERDATEITEXTMARKERGEHEIM' },
    });
    expect((resA.json().treffer as { fileId?: string }[]).some((t) => t.fileId === meta.id)).toBe(true);
  });

  it('existiert für eine Datei Text in file_pages_fts, aber KEINE Karte im projizierten State (nie hinzugefügt), entsteht kein Treffer', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte ohne Karte' } })
    ).json();
    const bytes = await pdfMitSeiten(['VERWAISTERDATEITEXTOHNEKARTE steht hier drin.']);
    const meta = storeFile(db, dataDir, bytes, 'verwaist.pdf');
    await warteAufLeerlauf();
    // Bewusst KEIN addDoc — die Datei existiert (und ist extrahiert), hat aber keine Karte auf diesem Desk.

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'VERWAISTERDATEITEXTOHNEKARTE' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().treffer as { fileId?: string }[]).some((t) => t.fileId === meta.id)).toBe(false);
  });

  it('ein Treffer wird nur für dasjenige Desk geliefert, auf dem die Karte liegt: dieselbe Datei auf einem anderen Desk erzeugt in dieser Suche keinen Treffer', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const deskMitKarte = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte mit Karte' } })
    ).json();
    const deskOhneKarte = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte ohne Karte' } })
    ).json();
    const bytes = await pdfMitSeiten(['DESKGEBUNDENERDATEITEXTMARKER steht hier drin.']);
    const meta = storeFile(db, dataDir, bytes, 'deskgebunden.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskMitKarte.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-deskgebunden', fileId: meta.id, name: 'Schreiben', position: { x: 0, y: 0 } } },
    });

    const resAndererDesk = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskOhneKarte.id}/search`, headers: authHeaders, payload: { q: 'DESKGEBUNDENERDATEITEXTMARKER' },
    });
    expect(resAndererDesk.statusCode).toBe(200);
    expect((resAndererDesk.json().treffer as { fileId?: string }[]).some((t) => t.fileId === meta.id)).toBe(false);

    const resRichtigerDesk = await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskMitKarte.id}/search`, headers: authHeaders, payload: { q: 'DESKGEBUNDENERDATEITEXTMARKER' },
    });
    expect((resRichtigerDesk.json().treffer as { fileId?: string }[]).some((t) => t.fileId === meta.id)).toBe(true);
  });

  it('Objekt-Treffer und Datei-Text-Treffer stehen in einer gemeinsamen, nach Relevanz sortierten Liste', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte gemischt' } })
    ).json();
    const bytes = await pdfMitSeiten(['GEMISCHTERSUCHBEGRIFF steht im Dateitext.']);
    const meta = storeFile(db, dataDir, bytes, 'gemischt.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-gemischt', fileId: meta.id, name: 'Schreiben', position: { x: 0, y: 0 } } },
    });
    // Ein zweiter Kandidat aus search_fts (Kandidat A) mit demselben Suchbegriff im Notiztext.
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addNote', payload: { id: 'note-gemischt', kind: 'notiz', text: 'GEMISCHTERSUCHBEGRIFF steht auch im Notiztext.', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: authHeaders, payload: { q: 'GEMISCHTERSUCHBEGRIFF' },
    });
    expect(res.statusCode).toBe(200);
    const { treffer } = res.json() as { treffer: { art: string; fileId?: string; objId?: string; rang: number }[] };
    // Beide Kandidatenquellen in EINER Liste — kein separates Feld/Array je Quelle.
    expect(treffer.some((t) => t.art === 'PDF-Text' && t.fileId === meta.id)).toBe(true);
    expect(treffer.some((t) => t.art === 'Zettel' && t.objId === 'note-gemischt')).toBe(true);
    // Gemeinsam nach Relevanz (rang) sortiert, keine getrennte Reihenfolge je Quelle.
    const raenge = treffer.map((t) => t.rang);
    expect(raenge).toEqual([...raenge].sort((x, y) => x - y));
  });

  it(`die Kappung auf ${SUCHE_MAX_TREFFER} greift auf die gemeinsame Liste NACH beiden Sichtbarkeitsfiltern: ein relevanterer, aber unsichtbarer Datei-Text-Treffer verdrängt keinen sichtbaren`, async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    // SUCHE_MAX_TREFFER + 1 sichtbare Datei-Text-Treffer, alle mit demselben Begriff, aber
    // umfangreicherem (unspezifischerem) Text als der eine unsichtbare Kandidat unten.
    for (let i = 0; i < SUCHE_MAX_TREFFER + 1; i += 1) {
      const bytes = await pdfMitSeiten([
        `KAPPUNGSTESTBEGRIFF eingebettet in einen längeren, weniger dichten Fließtext Nummer ${i} zur Verringerung der bm25-Relevanz.`,
      ]);
      const meta = storeFile(db, dataDir, bytes, `sichtbar-${i}.pdf`);
      await warteAufLeerlauf();
      await app.inject({
        method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
        payload: { type: 'addDoc', payload: { id: `doc-sichtbar-${i}`, fileId: meta.id, name: `Sichtbar ${i}`, position: { x: i, y: 0 } } },
      });
    }

    // Unsichtbarer Kandidat: dichterer, kürzerer Text (bessere bm25-Relevanz) — läge er in der
    // gekappten Liste, würde er einen sichtbaren Treffer verdrängen, wenn die Kappung VOR der
    // Sichtbarkeitsprüfung stattfände.
    const unsichtbarBytes = await pdfMitSeiten(['KAPPUNGSTESTBEGRIFF.']);
    const unsichtbarMeta = storeFile(db, dataDir, unsichtbarBytes, 'unsichtbar.pdf');
    await warteAufLeerlauf();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-unsichtbar', fileId: unsichtbarMeta.id, name: 'Unsichtbar', position: { x: -1, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-unsichtbar', layerId: 'privat' } },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/search`, headers: b.authHeaders, payload: { q: 'KAPPUNGSTESTBEGRIFF' },
    });
    expect(res.statusCode).toBe(200);
    const treffer = res.json().treffer as { fileId?: string }[];
    expect(treffer).toHaveLength(SUCHE_MAX_TREFFER);
    expect(treffer.some((t) => t.fileId === unsichtbarMeta.id)).toBe(false);
  });
});

/** Desk von A mit EINER Notiz ohne Freigabe-Override (Default-Freigabe „intern") — B bekommt
 *  die übergebene Rolle. Getrennte App-Instanz pro Aufruf (kein geteilter Zustand zwischen den
 *  beiden Rollen-Fällen). */
async function deskMitInternemVermerk(marker: string, rolleB: 'Bearbeiter' | 'externer Gast') {
  const ctx = await createTestAppMitZweiNutzern();
  const desk = (
    await ctx.app.inject({ method: 'POST', url: '/api/v1/desks', headers: ctx.a.authHeaders, payload: { name: 'Akte A' } })
  ).json();
  ctx.db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, ctx.b.userId, rolleB);
  await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: ctx.a.authHeaders,
    payload: { type: 'addNote', payload: { id: 'note-intern', kind: 'notiz', text: marker, position: { x: 0, y: 0 } } },
  });
  return { ...ctx, desk };
}

/** 31 sichtbare, gleichnamige Karten (Kanzlei-Ebene) PLUS eine unsichtbare (private Ebene von A)
 *  mit demselben Suchbegriff, aber deutlich kürzerem/dichterem Text (bessere bm25-Relevanz) —
 *  der Kandidat, der bei einer Kappung VOR dem Sichtbarkeitsfilter einen sichtbaren Treffer
 *  verdrängen würde. */
async function deskMitVielenTreffern() {
  const ctx = await createTestAppMitZweiNutzern();
  const desk = (
    await ctx.app.inject({ method: 'POST', url: '/api/v1/desks', headers: ctx.a.authHeaders, payload: { name: 'Akte A' } })
  ).json();
  ctx.db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, ctx.b.userId, 'Bearbeiter');

  // addDoc verlangt eine echte files-Zeile (Guard in app.ts) UND lehnt eine bereits auf dem
  // Tisch liegende fileId ab (documents.ts addDoc) — jede Karte braucht daher ein eigenes,
  // per storeFile() abgelegtes Dateiobjekt (unterschiedliche Bytes → unterschiedlicher Hash).
  for (let i = 0; i < SUCHE_MAX_TREFFER + 1; i += 1) {
    const meta = storeFile(ctx.db, ctx.dataDir, Buffer.from(`%PDF-1.4\ninhalt-${i}`), `vertrag-${i}.pdf`);
    await ctx.app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: ctx.a.authHeaders,
      payload: {
        type: 'addDoc',
        payload: { id: `doc-sichtbar-${i}`, fileId: meta.id, name: `Vertrag über eine langwierige Zusatzvereinbarung Nummer ${i}`, position: { x: i, y: 0 } },
      },
    });
  }

  const unsichtbarMeta = storeFile(ctx.db, ctx.dataDir, Buffer.from('%PDF-1.4\ninhalt-unsichtbar'), 'unsichtbar.pdf');
  await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: ctx.a.authHeaders,
    payload: { type: 'addDoc', payload: { id: 'doc-unsichtbar', fileId: unsichtbarMeta.id, name: 'Vertrag', position: { x: -1, y: 0 } } },
  });
  await ctx.app.inject({
    method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: ctx.a.authHeaders,
    payload: { type: 'changeLayerId', payload: { objectId: 'doc-unsichtbar', layerId: 'privat' } },
  });

  return { ...ctx, desk };
}
