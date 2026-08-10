import { describe, expect, it, vi } from 'vitest';
import type { Quelle } from '@j-desk/core';
import { createTestApp, createTestAppMitZweiNutzern } from './testUtils';
import { storeFile } from './files';
import { warteAufLeerlauf } from './ocr/ocrQueue';
import { pruefeQuelle, pruefeQuellen } from './quelleServer';

/**
 * Legt `file_pages`-Zeilen direkt an — dieselbe Datenform wie im echten Lauf, ohne die
 * Extraktion tatsächlich auszuführen (Muster aus fileText.test.ts `legeTextErgebnisAn`).
 * `storeFile` stellt selbst synchron einen Sperr-Eintrag in `file_extract`, bevor die
 * eigentliche Extraktion asynchron läuft — der Aufrufer muss deshalb zunächst
 * `warteAufLeerlauf()` abwarten, bevor hier die für den Test gewünschten Zeilen geschrieben
 * werden.
 */
function legeSeitenAn(
  db: import('./db').Db,
  fileId: string,
  seiten: { page: number; pdfText?: string | null; ocrText?: string | null }[],
): void {
  db.prepare('DELETE FROM file_pages WHERE file_id = ?').run(fileId);
  for (const seite of seiten) {
    db.prepare(
      'INSERT INTO file_pages (file_id, page, pdf_text, ocr_text, ocr_confidence) VALUES (?, ?, ?, ?, NULL)',
    ).run(fileId, seite.page, seite.pdfText ?? null, seite.ocrText ?? null);
  }
}

const EIGENTUEMER_TEST = { userId: 'test', rolle: 'Eigentümer' as const };

describe('pruefeQuelle (AI-03: serverseitige Zitat-Verifikation gegen file_pages)', () => {
  it('ein gültiges Zitat auf der genannten Seite eines sichtbaren Dokuments löst auf', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nfund'), 'fund.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [
      { page: 1, pdfText: 'Die Klage ist unbegründet. Der Anspruch ist verjährt.' },
    ]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Schriftsatz', position: { x: 0, y: 0 } } },
    });

    const ergebnis = pruefeQuelle(
      db, desk.id,
      { dokumentId: 'doc-1', seite: 1, zitat: 'Der Anspruch ist verjährt.' },
      EIGENTUEMER_TEST,
    );
    expect(ergebnis).toEqual({ ok: true, dokumentId: 'doc-1', seite: 1 });
  });

  it('ein Zitat, das im Dokument steht, aber nicht auf der genannten Seite, wird abgelehnt (Seitenbindung)', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nseiten'), 'seiten.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [
      { page: 1, pdfText: 'Der Anspruch ist verjährt.' },
      { page: 2, pdfText: 'Völlig anderer Inhalt der zweiten Seite.' },
    ]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Schriftsatz', position: { x: 0, y: 0 } } },
    });

    const quelle: Quelle = { dokumentId: 'doc-1', seite: 2, zitat: 'Der Anspruch ist verjährt.' };
    const ergebnis = pruefeQuelle(db, desk.id, quelle, EIGENTUEMER_TEST);
    expect(ergebnis).toEqual({ ok: false, grund: 'zitat_nicht_auflösbar', betroffeneQuelle: quelle });
  });

  it('beantwortet „unsichtbar" und „nicht existent" byte-identisch generisch mit mandat_fremd (keine Existenz-Auskunft)', async () => {
    const { app, db, dataDir, a, b } = await createTestAppMitZweiNutzern();
    const desk1 = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte eins' } })
    ).json();
    const desk2 = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte zwei' } })
    ).json();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk1.id, b.userId, 'Bearbeiter');
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(desk2.id, b.userId, 'Bearbeiter');

    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nprivat'), 'privat.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [{ page: 1, pdfText: 'Geheimer Inhalt' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk1.id}/commands`, headers: a.authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-privat', fileId: meta.id, name: 'Privates Schreiben', position: { x: 0, y: 0 } } },
    });
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk1.id}/commands`, headers: a.authHeaders,
      payload: { type: 'changeLayerId', payload: { objectId: 'doc-privat', layerId: 'privat' } },
    });

    // Dieselbe Quelle in zwei Lagen: desk1 hat das Dokument (für B unsichtbar), desk2 kennt die id nicht.
    const quelle: Quelle = { dokumentId: 'doc-privat', seite: 1, zitat: 'Geheimer Inhalt' };
    const ctxB = { userId: b.userId, rolle: 'Bearbeiter' as const };
    const unsichtbar = pruefeQuelle(db, desk1.id, quelle, ctxB);
    const nichtExistent = pruefeQuelle(db, desk2.id, quelle, ctxB);

    expect(unsichtbar).toEqual({ ok: false, grund: 'mandat_fremd', betroffeneQuelle: quelle });
    expect(JSON.stringify(unsichtbar)).toBe(JSON.stringify(nichtExistent));

    // Gegenprobe: A (sichtbar) löst dieselbe Quelle erfolgreich auf — die Ablehnung kam aus
    // der Projektion, nicht aus dem Dokumentbestand.
    const sichtbar = pruefeQuelle(db, desk1.id, quelle, { userId: a.userId, rolle: 'Eigentümer' });
    expect(sichtbar).toEqual({ ok: true, dokumentId: 'doc-privat', seite: 1 });
  });

  it('ein fehlender Schreibtisch wird generisch mit mandat_fremd beantwortet', async () => {
    const { db } = await createTestApp();
    const quelle: Quelle = { dokumentId: 'doc-egal', seite: 1, zitat: 'Egal' };
    expect(pruefeQuelle(db, 'desk-gibt-es-nicht', quelle, EIGENTUEMER_TEST)).toEqual({
      ok: false, grund: 'mandat_fremd', betroffeneQuelle: quelle,
    });
  });

  it('bei unsichtbarer docId wird die Datenbank NICHT nach Seitentext befragt (T-09-31/32-Muster)', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Leere Akte' } })
    ).json();

    const prepareSpy = vi.spyOn(db, 'prepare');
    const ergebnis = pruefeQuelle(
      db, desk.id,
      { dokumentId: 'doc-gibt-es-nicht', seite: 1, zitat: 'Egal' },
      EIGENTUEMER_TEST,
    );
    expect(ergebnis.ok).toBe(false);
    // getDeskState() selbst braucht eine Abfrage (SELECT ... FROM desks) — erwartet und
    // unvermeidbar. Die Behauptung ist, dass KEINE Abfrage gegen file_pages erfolgt, sobald
    // die Erlaubnisliste aus der Projektion die docId nicht enthält (T-12-02-01).
    const abgefragteSql = prepareSpy.mock.calls.map((c) => String(c[0]));
    expect(abgefragteSql.some((sql) => sql.includes('file_pages'))).toBe(false);
    prepareSpy.mockRestore();
  });

  it('eine Seite ohne file_pages-Zeile wird ehrlich mit text_nicht_extrahiert abgelehnt', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nteil'), 'teil.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [{ page: 1, pdfText: 'Nur Seite eins hat Text.' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const quelle: Quelle = { dokumentId: 'doc-1', seite: 5, zitat: 'Nur Seite eins hat Text.' };
    expect(pruefeQuelle(db, desk.id, quelle, EIGENTUEMER_TEST)).toEqual({
      ok: false, grund: 'text_nicht_extrahiert', betroffeneQuelle: quelle,
    });
  });

  it('eine file_pages-Zeile ohne pdf_text UND ohne ocr_text ist ebenfalls text_nicht_extrahiert', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nleer'), 'leer.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [{ page: 1, pdfText: null, ocrText: null }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Leere Seite', position: { x: 0, y: 0 } } },
    });

    const quelle: Quelle = { dokumentId: 'doc-1', seite: 1, zitat: 'Irgendetwas' };
    expect(pruefeQuelle(db, desk.id, quelle, EIGENTUEMER_TEST)).toEqual({
      ok: false, grund: 'text_nicht_extrahiert', betroffeneQuelle: quelle,
    });
  });

  it('der OCR-Fallback löst auf, wenn pdf_text fehlt, aber ocr_text das Zitat enthält', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nocr'), 'ocr.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [{ page: 1, pdfText: null, ocrText: 'Erkannter Text mit der Fundstelle.' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Scan', position: { x: 0, y: 0 } } },
    });

    const ergebnis = pruefeQuelle(
      db, desk.id,
      { dokumentId: 'doc-1', seite: 1, zitat: 'Text mit der Fundstelle.' },
      EIGENTUEMER_TEST,
    );
    expect(ergebnis).toEqual({ ok: true, dokumentId: 'doc-1', seite: 1 });
  });

  it('die Normalisierung greift: Zitat findet den Seitentext trotz Umbruch und Silbentrennung im Original', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\numbruch'), 'umbruch.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [{ page: 1, pdfText: 'Die Infor-\nmation liegt im Schreiben vor.' }]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Schriftsatz', position: { x: 0, y: 0 } } },
    });

    const ergebnis = pruefeQuelle(
      db, desk.id,
      { dokumentId: 'doc-1', seite: 1, zitat: 'Die Information liegt' },
      EIGENTUEMER_TEST,
    );
    expect(ergebnis).toEqual({ ok: true, dokumentId: 'doc-1', seite: 1 });
  });
});

describe('pruefeQuellen (atomare Listen-Prüfung für den Erstellungspfad)', () => {
  async function fixtureMitZweiSeiten() {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Akte' } })
    ).json();
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nliste'), 'liste.pdf');
    await warteAufLeerlauf();
    legeSeitenAn(db, meta.id, [
      { page: 1, pdfText: 'Der Anspruch ist verjährt.' },
      { page: 2, pdfText: 'Die Klage ist unbegründet.' },
    ]);
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { id: 'doc-1', fileId: meta.id, name: 'Schriftsatz', position: { x: 0, y: 0 } } },
    });
    return { db, deskId: desk.id as string };
  }

  it('liefert bei lauter auflösbaren Quellen je ein Ergebnis in Eingabereihenfolge', async () => {
    const { db, deskId } = await fixtureMitZweiSeiten();
    const ergebnis = pruefeQuellen(
      db, deskId,
      [
        { dokumentId: 'doc-1', seite: 2, zitat: 'Die Klage ist unbegründet.' },
        { dokumentId: 'doc-1', seite: 1, zitat: 'Anspruch ist verjährt' },
      ],
      EIGENTUEMER_TEST,
    );
    expect(ergebnis).toEqual([
      { ok: true, dokumentId: 'doc-1', seite: 2 },
      { ok: true, dokumentId: 'doc-1', seite: 1 },
    ]);
  });

  it('liefert die erste nicht auflösbare Quelle als Fehler — kein Teilerfolg, keine Weiterprüfung', async () => {
    const { db, deskId } = await fixtureMitZweiSeiten();
    const q2: Quelle = { dokumentId: 'doc-1', seite: 2, zitat: 'Steht da nicht' };
    const ergebnis = pruefeQuellen(
      db, deskId,
      [
        { dokumentId: 'doc-1', seite: 1, zitat: 'Anspruch ist verjährt' },
        q2,
        { dokumentId: 'doc-1', seite: 1, zitat: 'Anspruch ist verjährt' },
      ],
      EIGENTUEMER_TEST,
    );
    expect(ergebnis).toEqual({ ok: false, grund: 'zitat_nicht_auflösbar', betroffeneQuelle: q2 });
  });

  it('die Reihenfolge bestimmt den Gesamt-grund: ein frühes mandat_fremd schlägt ein späteres zitat_nicht_auflösbar', async () => {
    const { db, deskId } = await fixtureMitZweiSeiten();
    const q1: Quelle = { dokumentId: 'doc-unbekannt', seite: 1, zitat: 'Egal' };
    const ergebnis = pruefeQuellen(
      db, deskId,
      [q1, { dokumentId: 'doc-1', seite: 2, zitat: 'Steht da nicht' }],
      EIGENTUEMER_TEST,
    );
    expect(ergebnis).toEqual({ ok: false, grund: 'mandat_fremd', betroffeneQuelle: q1 });
  });
});
