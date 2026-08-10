import { describe, expect, it } from 'vitest';
import { createTestAppMitZweiNutzern } from '../testUtils';
import { storeFile } from '../files';
import { readPackage } from '../jdesk';
import { erzeugeTextPdf } from './pdfTestFixtures';
import { extrahiereText } from './verify';

/**
 * EXP-03-Beweisplan (D-07): der Drei-Stufen-Trace aus Phase 2 (projection.test.ts) über ALLE
 * SECHS `/export/pdf/*`-Routen — dasselbe Marker-Sonden-Muster, dasselbe normative Orakel
 * (pdfjs-Extraktion via verify.ts), diesmal für die Freigabe-Stufen intern/mandant/export statt
 * für Rollen-Sichtbarkeit. Der Aufbau läuft AUSSCHLIESSLICH über echte Commands via app.inject
 * (kein State-Hacking, key_links des Plans) — exakt das Muster aus projection.test.ts.
 *
 * Format-Matrix (welches Objekt trägt MARKER_EXPORT in welchem Artefakt — Kommentar-Pflicht
 * bei neuer Route, T-03-09-02):
 *   aufgaben/argumentation/snapshot  ← Notiz-Text        (n-export, kind 'todo')
 *   beweismittel/fundstellen        ← Cutout-Ursprungstext (cut-export.textSnapshot)
 *   dokument/:docId                 ← Stempeltext        (st-export) — der PDF-Seiteninhalt
 *                                      selbst trägt bewusst KEINEN Marker; Notiz-Marker sind in
 *                                      diesem Format naturgemäß nicht relevant (nur Overlays
 *                                      werden eingebrannt).
 * MARKER_INTERN/MARKER_MANDANT dürfen in KEINEM der sechs Artefakte auftauchen — unabhängig
 * davon, ob das jeweilige Format ihre Objektart überhaupt rendert (Existenz-Leck-Verbot gilt
 * universell, D-08).
 */

const MARKER_INTERN = 'MARKERTRACEINTERN2P8W9';
const MARKER_MANDANT = 'MARKERTRACEMANDANT4K9L';
const MARKER_EXPORT = 'MARKERTRACEEXPORT7X2Q5';

/** Existenz-Leck-Muster (D-08, Pitfall 8): kein Zähl-/Lückenhinweis in irgendeinem Artefakt. */
function expectKeinZaehlhinweis(text: string): void {
  expect(text).not.toMatch(/\d+\s+interne/i);
  expect(text).not.toContain('interne Einträge');
  expect(text).not.toContain('nicht enthalten');
  expect(text).not.toContain('ausgelassen');
  expect(text).not.toContain('gefiltert');
}

/** Die sechs Übergabe-Routen (Trace-Test-Muster: Routen-Matrix als Liste, T-03-09-02). */
function sechsRouten(docId: string): { pfad: string; label: string }[] {
  return [
    { pfad: 'aufgaben', label: 'Aufgabenliste' },
    { pfad: 'snapshot', label: 'Schreibtisch-Snapshot' },
    { pfad: 'argumentation', label: 'Argumentationsübersicht' },
    { pfad: 'beweismittel', label: 'Beweismittelübersicht' },
    { pfad: `dokument/${docId}`, label: 'Annotierte Kopie (Dokument)' },
    { pfad: 'fundstellen', label: 'Fundstellen-PDF' },
  ];
}

/**
 * Baut den Trace-Grundzustand auf: EIN freigegebenes Doc (Doc-Gate, T-03-07-02) mit einer
 * freigegebenen Fundstelle (cutout) UND einer offenen Aufgabe (todo-Notiz) — beide tragen
 * MARKER_EXPORT. Daneben je eine mandantensichtbare (Override 'mandant') und eine interne
 * (Kanzlei-Default, kein Override, fail-closed D-14) Notiz. Drei Stempel auf demselben Doc
 * spiegeln dieselben drei Stufen für das dokument-Format (Format-Matrix oben).
 */
async function deskMitFreigabeTrace() {
  const ctx = await createTestAppMitZweiNutzern();
  const { app, db, dataDir, a } = ctx;
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Freigabe-Trace' } })
  ).json() as { id: string };
  const cmd = (type: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders, payload: { type, payload } });
  const setFreigabe = async (objectId: string, freigabe: string): Promise<void> => {
    expect((await cmd('setFreigabe', { objectId, freigabe })).statusCode).toBe(200);
  };

  // Freigegebenes Doc (Doc-Gate): neutraler Seiteninhalt — der Marker-Beweis für das
  // dokument-Format läuft bewusst über den Stempeltext, nicht über den Dokumentinhalt.
  const fixture = await erzeugeTextPdf('Dokumentinhalt Trace-Desk', 50, 700);
  const meta = storeFile(db, dataDir, Buffer.from(fixture.bytes), 'trace.pdf');
  expect((await cmd('addDoc', { fileId: meta.id, name: 'trace.pdf', position: { x: 0, y: 0 }, id: 'doc-trace' })).statusCode).toBe(200);
  await setFreigabe('doc-trace', 'export');

  // Fundstelle (Ausschnitt) mit Ursprungstext MARKER_EXPORT — Beweismittel + Fundstellen.
  expect(
    (
      await cmd('addCutout', {
        docId: 'doc-trace', page: 1, rect: { x: 10, y: 10, w: 120, h: 20 }, position: { x: 900, y: 500 },
        id: 'cut-export', textSnapshot: MARKER_EXPORT,
      })
    ).statusCode
  ).toBe(200);
  await setFreigabe('cut-export', 'export');

  // Offene Aufgabe (todo, nicht abgehakt) mit MARKER_EXPORT — Aufgabenliste + Argumentation + Snapshot.
  expect((await cmd('addNote', { id: 'n-export', kind: 'todo', text: MARKER_EXPORT, position: { x: 1, y: 1 } })).statusCode).toBe(200);
  await setFreigabe('n-export', 'export');

  // Mandantensichtbare Notiz (Override 'mandant', D-06): sichtbar für externe Gäste in der
  // Projektion, aber NIE im Export — reine Negativ-Kontrolle in diesem Test.
  expect((await cmd('addNote', { id: 'n-mandant', kind: 'notiz', text: MARKER_MANDANT, position: { x: 2, y: 2 } })).statusCode).toBe(200);
  await setFreigabe('n-mandant', 'mandant');

  // Interne Notiz (Kanzlei-Default, KEIN Override) — effektiveFreigabe fail-closed 'intern' (D-14).
  expect((await cmd('addNote', { id: 'n-intern', kind: 'notiz', text: MARKER_INTERN, position: { x: 3, y: 3 } })).statusCode).toBe(200);

  // Drei Stempel auf demselben Doc — Format-Matrix: das dokument-Format zeigt seinen
  // Export-Beweis über den Stempeltext (Overlay-Freigabefilter greift genauso wie bei Notizen/Cutouts).
  expect(
    (
      await cmd('addStamp', {
        stamp: { id: 'st-export', docId: 'doc-trace', page: 1, x: 200, y: 300, angle: 0, text: MARKER_EXPORT, color: 'red', baseW: 595, baseH: 842 },
      })
    ).statusCode
  ).toBe(200);
  await setFreigabe('st-export', 'export');
  expect(
    (
      await cmd('addStamp', {
        stamp: { id: 'st-mandant', docId: 'doc-trace', page: 1, x: 250, y: 350, angle: 0, text: MARKER_MANDANT, color: 'blue', baseW: 595, baseH: 842 },
      })
    ).statusCode
  ).toBe(200);
  await setFreigabe('st-mandant', 'mandant');
  expect(
    (
      await cmd('addStamp', {
        stamp: { id: 'st-intern', docId: 'doc-trace', page: 1, x: 300, y: 400, angle: 0, text: MARKER_INTERN, color: 'blue', baseW: 595, baseH: 842 },
      })
    ).statusCode
  ).toBe(200);

  return { ...ctx, deskId: desk.id, docId: 'doc-trace' };
}

describe('EXP-03: Freigabe-Trace über alle sechs Export-Routen + .jdesk-Konstanz (D-07)', () => {
  it('alle sechs Routen: MARKER_EXPORT ist enthalten, MARKER_INTERN/MARKER_MANDANT fehlen restlos', async () => {
    const { app, a, deskId, docId } = await deskMitFreigabeTrace();

    for (const route of sechsRouten(docId)) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/${route.pfad}`, headers: a.authHeaders });
      expect(res.statusCode).toBe(200);
      const text = await extrahiereText(new Uint8Array(res.rawPayload));
      expect(text.includes(MARKER_EXPORT)).toBe(true);
      expect(text.includes(MARKER_INTERN)).toBe(false);
      expect(text.includes(MARKER_MANDANT)).toBe(false);
    }
  });

  it('kein Artefakt enthält Zähl- oder Auslassungs-Hinweise (Existenz-Leck-Verbot, D-08)', async () => {
    const { app, a, deskId, docId } = await deskMitFreigabeTrace();

    for (const route of sechsRouten(docId)) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/${route.pfad}`, headers: a.authHeaders });
      expect(res.statusCode).toBe(200);
      const text = await extrahiereText(new Uint8Array(res.rawPayload));
      expectKeinZaehlhinweis(text);
    }
  });

  it('.jdesk-Export als Bearbeiter enthält MARKER_MANDANT (und MARKER_INTERN) weiterhin — freigabeFilter wirkt nur auf /export/pdf* (D-13/D-14)', async () => {
    const { app, a, deskId } = await deskMitFreigabeTrace();

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    const { state } = readPackage(res.rawPayload);
    const rohtext = JSON.stringify(state);
    // Der .jdesk-Arbeitsstand bleibt unverändert (kein stiller Verhaltenswechsel, D-13/D-14):
    // mandant- UND intern-Objekte sind für den berechtigten Bearbeiter weiterhin im Paket.
    expect(rohtext).toContain(MARKER_MANDANT);
    expect(rohtext).toContain(MARKER_INTERN);
    expect(rohtext).toContain(MARKER_EXPORT);
  });

  it('externer Gast erhält auf allen sechs Routen 403 (kein Export-Recht, PERM-04)', async () => {
    const { app, db, b, deskId, docId } = await deskMitFreigabeTrace();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'externer Gast');

    for (const route of sechsRouten(docId)) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/${route.pfad}`, headers: b.authHeaders });
      expect(res.statusCode).toBe(403);
    }
  });
});
