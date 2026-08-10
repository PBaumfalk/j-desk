import { describe, it, expect, vi } from 'vitest';
import { createTestApp, createTestAppMitZweiNutzern } from '../testUtils';
import { storeFile } from '../files';
import { warteAufLeerlauf } from '../ocr/ocrQueue';
import { fileTextFuerDesk } from './fileText';

/**
 * Legt `file_extract`/`file_pages`-Zeilen direkt an — dieselbe Datenform wie im echten Lauf,
 * ohne tesseract tatsächlich auszuführen (Muster aus ocrStatus.test.ts `legeOcrErgebnisAn`).
 * `storeFile` stellt selbst synchron einen Sperr-Eintrag (`ocr-ausstehend`) in `file_extract`,
 * bevor die eigentliche Extraktion asynchron läuft — der Aufrufer muss deshalb zunächst
 * `warteAufLeerlauf()` abwarten, bevor hier per UPSERT/Neuanlage die für den Test gewünschten
 * Werte überschrieben werden.
 */
function legeTextErgebnisAn(
  db: import('../db').Db,
  fileId: string,
  stand: string,
  seiten: { page: number; pdfText?: string | null; ocrText?: string | null }[],
): void {
  db.prepare(
    `INSERT INTO file_extract (file_id, stand, seiten, fehler, aktualisiert_am)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       stand = excluded.stand, seiten = excluded.seiten, fehler = excluded.fehler,
       aktualisiert_am = excluded.aktualisiert_am`,
  ).run(fileId, stand, seiten.length, Date.now());
  db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(fileId);
  for (const seite of seiten) {
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, ?, ?, NULL)',
    ).run(fileId, seite.page, seite.pdfText ?? null, seite.ocrText ?? null);
  }
}

describe('fileTextFuerDesk (COMP-01/02: sichtbarkeitsgefilterte Textabfrage)', () => {
  it('eine sichtbare Datei liefert den Text je Seite in Seitenreihenfolge', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nsichtbar'), 'sichtbar.pdf');
    await warteAufLeerlauf();
    legeTextErgebnisAn(db, meta.id, 'pdf-text', [
      { page: 2, pdfText: 'Zweite Seite' },
      { page: 1, pdfText: 'Erste Seite' },
    ]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-sichtbar', fileId: meta.id, name: 'Schreiben', position: { x: 0, y: 0 } } },
    });

    const ergebnis = fileTextFuerDesk(db, desk.id, meta.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(ergebnis).toEqual({
      stand: 'pdf-text',
      seiten: [
        { seite: 1, text: 'Erste Seite', quelle: 'pdf-text' },
        { seite: 2, text: 'Zweite Seite', quelle: 'pdf-text' },
      ],
    });
  });

  it('die Antwort benennt je Seite, ob der Text eingebettet vorlag oder erkannt wurde', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\ngemischt'), 'gemischt.pdf');
    await warteAufLeerlauf();
    legeTextErgebnisAn(db, meta.id, 'ocr-fertig', [
      { page: 1, pdfText: 'Eingebetteter Text' },
      { page: 2, ocrText: 'Erkannter Text' },
    ]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-gemischt', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const ergebnis = fileTextFuerDesk(db, desk.id, meta.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(ergebnis?.seiten).toEqual([
      { seite: 1, text: 'Eingebetteter Text', quelle: 'pdf-text' },
      { seite: 2, text: 'Erkannter Text', quelle: 'ocr' },
    ]);
  });

  it('eine Datei, deren Erkennung noch läuft (ocr-ausstehend), liefert die bereits vorhandenen Seiten und benennt den Erkennungsstand', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nlaufend'), 'laufend.pdf');
    await warteAufLeerlauf();
    legeTextErgebnisAn(db, meta.id, 'ocr-ausstehend', [{ page: 1, ocrText: 'Bereits erkannter Teil' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-laufend', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const ergebnis = fileTextFuerDesk(db, desk.id, meta.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(ergebnis).toEqual({
      stand: 'ocr-ausstehend',
      seiten: [{ seite: 1, text: 'Bereits erkannter Teil', quelle: 'ocr' }],
    });
  });

  it('eine Datei ohne erkannten und ohne eingebetteten Text liefert eine leere Seitenliste, keine Ablehnung', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nleer'), 'leer.pdf');
    await warteAufLeerlauf();
    legeTextErgebnisAn(db, meta.id, 'ocr-fertig', [{ page: 1, pdfText: null, ocrText: null }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-leer', fileId: meta.id, name: 'Leere Seite', position: { x: 0, y: 0 } } },
    });

    const ergebnis = fileTextFuerDesk(db, desk.id, meta.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(ergebnis).toEqual({ stand: 'ocr-fertig', seiten: [] });
  });

  it('eine Datei, die auf dem Schreibtisch liegt, aber für diesen Betrachter nicht sichtbar ist, liefert dieselbe Ablehnung (null) wie eine Datei-id, die es gar nicht gibt', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte A' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk.id, b.userId, 'Bearbeiter');

    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nprivat'), 'privat.pdf');
    await warteAufLeerlauf();
    legeTextErgebnisAn(db, meta.id, 'pdf-text', [{ page: 1, pdfText: 'Geheimer Inhalt' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-privat', fileId: meta.id, name: 'Privates Schreiben', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-privat', layerId: 'privat' } },
    });

    const ergebnisUnsichtbar = fileTextFuerDesk(db, desk.id, meta.id, { userId: b.userId, rolle: 'Bearbeiter' });
    const ergebnisNichtExistent = fileTextFuerDesk(db, desk.id, 'datei-gibt-es-nicht', { userId: b.userId, rolle: 'Bearbeiter' });
    expect(ergebnisUnsichtbar).toBeNull();
    expect(ergebnisNichtExistent).toBeNull();
    expect(ergebnisUnsichtbar).toEqual(ergebnisNichtExistent);

    // Gegenprobe: für A selbst (der die Datei sehen darf) liefert dieselbe Datei-id echten Text.
    const ergebnisA = fileTextFuerDesk(db, desk.id, meta.id, { userId: a.userId, rolle: 'Eigentümer' });
    expect(ergebnisA?.seiten).toEqual([{ seite: 1, text: 'Geheimer Inhalt', quelle: 'pdf-text' }]);
  });

  it('eine Datei, die auf diesem Schreibtisch überhaupt nicht liegt, liefert dieselbe Ablehnung (null)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte ohne Karte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nverwaist'), 'verwaist.pdf');
    await warteAufLeerlauf();
    legeTextErgebnisAn(db, meta.id, 'pdf-text', [{ page: 1, pdfText: 'Verwaister Text' }]);
    // Bewusst KEIN addDoc.

    const ergebnis = fileTextFuerDesk(db, desk.id, meta.id, { userId: 'test', rolle: 'Eigentümer' });
    expect(ergebnis).toBeNull();
  });

  it('ein fehlender Schreibtisch liefert null', async () => {
    const { db } = await createTestApp();
    const ergebnis = fileTextFuerDesk(db, 'desk-gibt-es-nicht', 'datei-egal', { userId: 'test', rolle: 'Eigentümer' });
    expect(ergebnis).toBeNull();
  });

  it('ein Schreibtisch, auf dem der Betrachter kein einziges Dokument sehen darf, führt zu keiner Datenbankabfrage nach Datei-Text (nur der Zustandsabruf selbst zählt)', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Leere Akte' } })
    ).json();

    const prepareSpy = vi.spyOn(db, 'prepare');
    const ergebnis = fileTextFuerDesk(db, desk.id, 'irgendeine-datei', { userId: 'test', rolle: 'Eigentümer' });
    expect(ergebnis).toBeNull();
    // getDeskState() selbst braucht eine Abfrage (SELECT ... FROM desks) — das ist erwartet und
    // unvermeidbar. Die eigentliche Behauptung ist, dass KEINE Abfrage gegen file_pages/
    // file_extract erfolgt, sobald die Erlaubnisliste leer ist (T-09-31).
    const abgefragteSql = prepareSpy.mock.calls.map((c) => String(c[0]));
    expect(abgefragteSql.some((sql) => sql.includes('file_pages') || sql.includes('file_extract'))).toBe(false);
    prepareSpy.mockRestore();
  });
});
