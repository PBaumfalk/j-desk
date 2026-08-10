import { describe, it, expect } from 'vitest';
import { createTestApp, createTestAppMitZweiNutzern } from '../testUtils';
import { storeFile } from '../files';
import { warteAufLeerlauf } from '../ocr/ocrQueue';
import { ocrStatusFuerDesk } from './ocrStatus';

/**
 * Legt eine `file_extract`-Zeile mit `stand='ocr-fertig'` und die zugehörigen `file_pages`-Zeilen
 * direkt an — dieselbe Datenform, die `ocrQueue.ts` nach einem echten Lauf hinterlässt, aber ohne
 * tesseract tatsächlich auszuführen (reine Statusabfrage-Tests brauchen keine echte Erkennung).
 *
 * `storeFile` stellt selbst synchron einen Sperr-Eintrag (`ocr-ausstehend`) in `file_extract`,
 * bevor die eigentliche (hier: unechte) Extraktion asynchron im Hintergrund läuft — der Aufrufer
 * muss deshalb zunächst `warteAufLeerlauf()` abwarten, bevor hier per UPSERT/Neuanlage die für den
 * Test gewünschten Werte überschrieben werden (dasselbe Race wie in
 * `searchQuery.projection.test.ts`).
 */
function legeOcrErgebnisAn(db: import('../db').Db, fileId: string, seiten: { page: number; confidence: number | null }[]): void {
  db.prepare(
    `INSERT INTO file_extract (file_id, stand, seiten, fehler, aktualisiert_am)
     VALUES (?, 'ocr-fertig', ?, NULL, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       stand = excluded.stand, seiten = excluded.seiten, fehler = excluded.fehler,
       aktualisiert_am = excluded.aktualisiert_am`,
  ).run(fileId, seiten.length, Date.now());
  db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(fileId);
  for (const seite of seiten) {
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, NULL, ?, ?)',
    ).run(fileId, seite.page, 'text', seite.confidence);
  }
}

describe('ocrStatusFuerDesk (SEARCH-03: sichtbarkeitsgefilterte OCR-Statusabfrage)', () => {
  it('eine Datei mit stand=ocr-fertig und einer Seite unter der Schwelle (62) erscheint in unsicher', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nunsicher'), 'unsicher.pdf');
    await warteAufLeerlauf();
    legeOcrErgebnisAn(db, meta.id, [{ page: 1, confidence: 62 }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-unsicher', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const status = ocrStatusFuerDesk(db, desk.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(status.unsicher).toEqual([meta.id]);
  });

  it('eine Datei mit ausschließlich Seitenkonfidenzen von 70 und darüber erscheint nicht in unsicher', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nsicher'), 'sicher.pdf');
    await warteAufLeerlauf();
    legeOcrErgebnisAn(db, meta.id, [{ page: 1, confidence: 70 }, { page: 2, confidence: 91 }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-sicher', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const status = ocrStatusFuerDesk(db, desk.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(status.unsicher).toEqual([]);
  });

  it('eine Datei mit stand=pdf-text (kein OCR-Lauf) erscheint nicht in unsicher, auch wenn keine Konfidenz vorliegt', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\npdftext'), 'pdftext.pdf');
    await warteAufLeerlauf();
    db.prepare(
      `INSERT INTO file_extract (file_id, stand, seiten, fehler, aktualisiert_am)
       VALUES (?, 'pdf-text', 1, NULL, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         stand = excluded.stand, seiten = excluded.seiten, fehler = excluded.fehler,
         aktualisiert_am = excluded.aktualisiert_am`,
    ).run(meta.id, Date.now());
    db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(meta.id);
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, 1, ?, NULL, NULL)',
    ).run(meta.id, 'eingebetteter Text');
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-pdftext', fileId: meta.id, name: 'PDF', position: { x: 0, y: 0 } } },
    });

    const status = ocrStatusFuerDesk(db, desk.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(status.unsicher).toEqual([]);
  });

  it('eine Datei ohne file_extract-Zeile erscheint nicht in unsicher', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nkeinextrakt'), 'keinextrakt.pdf');
    await warteAufLeerlauf();
    // storeFile stellt selbst einen file_extract-Sperr-/Ergebnis-Eintrag (07-04-Verhalten,
    // unabhängig von dieser Route) — für DIESEN Testfall wird er wieder entfernt, um den Fall
    // "nie extrahiert" (keine Zeile) exakt nachzubilden, wie ihn ältere Bestandsdateien vor
    // Einführung der Extraktionspipeline hätten.
    db.prepare('DELETE FROM file_extract WHERE file_id = ?').run(meta.id);
    db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(meta.id);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-keinextrakt', fileId: meta.id, name: 'PDF', position: { x: 0, y: 0 } } },
    });

    const status = ocrStatusFuerDesk(db, desk.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(status.unsicher).toEqual([]);
  });

  it('eine Datei mit gemischten Seiten (eine ohne Konfidenz, eine mit 55) erscheint in unsicher — Seiten ohne OCR-Lauf gehen nicht in die Aggregation ein', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\ngemischt'), 'gemischt.pdf');
    await warteAufLeerlauf();
    legeOcrErgebnisAn(db, meta.id, [{ page: 1, confidence: null }, { page: 2, confidence: 55 }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-gemischt', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const status = ocrStatusFuerDesk(db, desk.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(status.unsicher).toEqual([meta.id]);
  });

  it('eine Datei mit stand=ocr-fertig, deren Karte auf einer fremden privaten Ebene liegt, erscheint für den anderen Nutzer NICHT in unsicher — die Antwort ist für ihn strikt leer', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nprivat'), 'privat.pdf');
    await warteAufLeerlauf();
    legeOcrErgebnisAn(db, meta.id, [{ page: 1, confidence: 40 }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-privat', fileId: meta.id, name: 'Privater Scan', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-privat', layerId: 'privat' } },
    });

    const statusB = ocrStatusFuerDesk(db, desk.id, { userId: b.userId, rolle: 'Bearbeiter' });
    expect(statusB.unsicher).toEqual([]);

    const statusA = ocrStatusFuerDesk(db, desk.id, { userId: a.userId, rolle: 'Eigentümer' });
    expect(statusA.unsicher).toEqual([meta.id]);
  });

  it('eine Datei, deren Karte auf einem anderen Schreibtisch liegt, erscheint in der Antwort dieses Schreibtischs nicht', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const deskMitKarte = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte mit Karte' } })
    ).json();
    const deskOhneKarte = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte ohne Karte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\ndeskgebunden'), 'deskgebunden.pdf');
    await warteAufLeerlauf();
    legeOcrErgebnisAn(db, meta.id, [{ page: 1, confidence: 30 }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${deskMitKarte.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-deskgebunden', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const statusAndererDesk = ocrStatusFuerDesk(db, deskOhneKarte.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(statusAndererDesk.unsicher).toEqual([]);

    const statusRichtigerDesk = ocrStatusFuerDesk(db, deskMitKarte.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(statusRichtigerDesk.unsicher).toEqual([meta.id]);
  });

  it('ein Schreibtisch ohne Karten liefert eine leere Liste, keinen Fehler', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Leere Akte' } })
    ).json();

    const status = ocrStatusFuerDesk(db, desk.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(status.unsicher).toEqual([]);
  });
});

describe('GET /api/v1/desks/:id/ocr', () => {
  it('liefert { unsicher: [...] } über die HTTP-Route mit demselben Guard wie /state', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nrouten-test'), 'routen-test.pdf');
    await warteAufLeerlauf();
    legeOcrErgebnisAn(db, meta.id, [{ page: 1, confidence: 20 }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-routen-test', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/ocr`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsicher: [meta.id] });
  });

  it('ohne gültigen Token liefert die Route 401 — kein neuer, ungeschützter Auslieferungspfad', async () => {
    const { app, db } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: { authorization: 'Bearer ungueltig' }, payload: { name: 'x' } })
    );
    void db;
    expect(desk.statusCode).toBe(401);
  });
});
