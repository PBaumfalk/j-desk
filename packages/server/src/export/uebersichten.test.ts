import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import type { DesktopState, Doc } from '@j-desk/core';
import { createTestAppMitZweiNutzern } from '../testUtils';
import { storeFile } from '../files';
import { putDeskState } from '../deskStore';
import { extrahiereSeiten, extrahiereText } from './verify';
import { basisNachUserSpace, seitenGeometrieVon } from './coordinates';
import { erzeugeRotiertesPdf, erzeugeTextPdf } from './pdfTestFixtures';
import {
  berechneMiniaturen,
  erzeugeArgumentationPdf,
  erzeugeAufgabenlistePdf,
  erzeugeBeweismittelPdf,
  erzeugeFundstellenPdf,
  LEGAL_OBJECT_KIND_LABELS,
  LINK_MEANING_LABELS,
  sammleFundstellenKandidaten,
} from './uebersichten';

/**
 * Übersichts-Integrationstests (EXP-05, D-08/D-09/D-10): Snapshot, Argumentation und
 * Beweismittel laufen durch dieselbe Guard-Projektion-Filter-Kette wie die Aufgabenliste.
 * Die pdfjs-Extraktion ist das Orakel: freigegebene Inhalte sind drin, interne fehlen
 * restlos — und kein Artefakt verrät ihre Existenz durch Zähl- oder Lückenhinweise
 * (Pitfall 8: feste Phrasen-Muster, Statistik bleibt Dialog-only).
 */

const MARKER_DOC = 'MARKERDOCFREI7Q';
const MARKER_DOC_INTERN = 'MARKERDOCINTERN3Z';
const MARKER_NOTIZ = 'MARKERNOTIZBEHAUPTUNG4W';
const MARKER_URSPRUNG = 'MARKERURSPRUNGSTEXT8R';
const MARKER_INTERN = 'MARKERINTERNGEHEIM9C1B';

/** Bestandstext für fehlende Provenienz-/Datumsangaben (uebersichten.ts HERKUNFT_UNBEKANNT, intern). */
const HERKUNFT_UNBEKANNT_TEXT = 'Herkunft unbekannt';

/** Existenz-Leck-Muster (D-08): kein Zähl-/Lückenhinweis in irgendeinem Artefakt. */
function expectKeinZaehlhinweis(text: string): void {
  expect(text).not.toMatch(/\d+\s+interne/i);
  expect(text).not.toContain('interne Einträge');
  expect(text).not.toContain('ausgelassen');
  expect(text).not.toContain('gefiltert');
}

async function deskMitUebersichtsInhalten() {
  const ctx = await createTestAppMitZweiNutzern();
  const { app, db, dataDir, a } = ctx;
  const desk = (
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Übersicht' } })
  ).json() as { id: string };
  const cmd = (type: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders, payload: { type, payload } });

  const metaFrei = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nfrei'), `${MARKER_DOC}.pdf`);
  const metaIntern = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nintern'), `${MARKER_DOC_INTERN}.pdf`);
  expect((await cmd('addDoc', { fileId: metaFrei.id, name: `${MARKER_DOC}.pdf`, position: { x: 100, y: 100 }, id: 'doc-frei' })).statusCode).toBe(200);
  expect((await cmd('changeLayerId', { objectId: 'doc-frei', layerId: 'exportierbar' })).statusCode).toBe(200);
  expect((await cmd('addDoc', { fileId: metaIntern.id, name: `${MARKER_DOC_INTERN}.pdf`, position: { x: 2000, y: 100 }, id: 'doc-intern' })).statusCode).toBe(200);

  expect((await cmd('addNote', { id: 'n-frei', kind: 'behauptung', text: MARKER_NOTIZ, position: { x: 500, y: 500 } })).statusCode).toBe(200);
  expect((await cmd('changeLayerId', { objectId: 'n-frei', layerId: 'exportierbar' })).statusCode).toBe(200);

  expect((await cmd('addCutout', { docId: 'doc-frei', page: 1, rect: { x: 0, y: 0, w: 50, h: 20 }, position: { x: 900, y: 500 }, id: 'cut-frei', textSnapshot: MARKER_URSPRUNG })).statusCode).toBe(200);
  expect((await cmd('changeLayerId', { objectId: 'cut-frei', layerId: 'exportierbar' })).statusCode).toBe(200);
  expect((await cmd('addCutout', { docId: 'doc-intern', page: 1, rect: { x: 0, y: 0, w: 50, h: 20 }, position: { x: 2200, y: 500 }, id: 'cut-intern', textSnapshot: MARKER_INTERN })).statusCode).toBe(200);

  // Freigegebener Bezug Notiz ↔ Ausschnitt …
  expect((await cmd('addLink', { fromId: 'n-frei', toId: 'cut-frei', id: 'l-1' })).statusCode).toBe(200);
  expect((await cmd('changeLayerId', { objectId: 'l-1', layerId: 'exportierbar' })).statusCode).toBe(200);
  // … und ein freigegebener Link auf ein INTERNES Ziel: der Bezug muss lautlos entfallen
  // (das Ziel ist nicht im gefilterten State — seine Benennung wäre ein Existenz-Leck).
  expect((await cmd('addLink', { fromId: 'n-frei', toId: 'doc-intern', id: 'l-2' })).statusCode).toBe(200);
  expect((await cmd('changeLayerId', { objectId: 'l-2', layerId: 'exportierbar' })).statusCode).toBe(200);

  return { ...ctx, deskId: desk.id };
}

describe('GET …/export/pdf/snapshot (D-10)', () => {
  it('200 application/pdf; Objekt-Index mit freigegebenen Karten, interner Marker fehlt, kein Zählhinweis', async () => {
    const { app, a, deskId } = await deskMitUebersichtsInhalten();

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/snapshot`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(`${MARKER_DOC}.pdf`);
    expect(text).toContain(MARKER_NOTIZ);
    expect(text).not.toContain(MARKER_DOC_INTERN);
    expect(text).not.toContain(MARKER_INTERN);
    expectKeinZaehlhinweis(text);
  });

  it('Miniaturen erhalten die relative Tisch-Anordnung (reine Funktion, x- und y-Ordnung)', () => {
    const karten = [
      { id: 'a', name: 'A', box: { x: 0, y: 0, w: 180, h: 240 } },
      { id: 'b', name: 'B', box: { x: 2000, y: 500, w: 180, h: 240 } },
      { id: 'c', name: 'C', box: { x: 500, y: 3000, w: 180, h: 240 } },
    ];
    const flaeche = { x: 50, y: 150, w: 495, h: 400 };
    const minis = berechneMiniaturen(karten, flaeche);
    const nach = Object.fromEntries(minis.map((m) => [m.id, m.box]));

    expect(nach.a.x).toBeLessThan(nach.c.x);
    expect(nach.c.x).toBeLessThan(nach.b.x);
    expect(nach.a.y).toBeLessThan(nach.b.y);
    expect(nach.b.y).toBeLessThan(nach.c.y);
    // Proportionalität: Abstandsverhältnis x wie auf dem Tisch (2000:500 = 4:1).
    expect((nach.b.x - nach.a.x) / (nach.c.x - nach.a.x)).toBeCloseTo(4, 5);
    // Alles bleibt innerhalb der vorgegebenen Fläche.
    for (const m of minis) {
      expect(m.box.x).toBeGreaterThanOrEqual(flaeche.x - 0.001);
      expect(m.box.y).toBeGreaterThanOrEqual(flaeche.y - 0.001);
      expect(m.box.x + m.box.w).toBeLessThanOrEqual(flaeche.x + flaeche.w + 0.001);
      expect(m.box.y + m.box.h).toBeLessThanOrEqual(flaeche.y + flaeche.h + 0.001);
    }
  });
});

/**
 * Aufgabenliste aus echten Aufgaben-Objekten (08-04 Task 1, LEGAL-01/TASK-01): direkte
 * State-Fixturen statt HTTP-Layer — dieselbe Textextraktion (extrahiereText) wie überall
 * in dieser Datei, keine zweite Prüftechnik (Plan-Vorgabe).
 */
describe('erzeugeAufgabenlistePdf (08-04 Task 1): führend echte Aufgaben-Objekte, Zettel/Fähnchen als Ergänzung', () => {
  function stateMitAufgaben(legalObjects: DesktopState['legalObjects']): DesktopState {
    return { docs: [], links: [], stacks: [], legalObjects };
  }

  it('offene Aufgabe erscheint; Status erledigt und übergeben erscheinen nicht', async () => {
    const MARKER_OFFEN = 'AUFGABEOFFEN8H3K';
    const MARKER_ERLEDIGT = 'AUFGABEERLEDIGT2P9L';
    const MARKER_UEBERGEBEN = 'AUFGABEUEBERGEBEN6Q1M';
    const state = stateMitAufgaben([
      { id: 'a-offen', kind: 'aufgabe', text: MARKER_OFFEN, position: { x: 0, y: 0 }, zIndex: 1, status: 'offen' },
      { id: 'a-erledigt', kind: 'aufgabe', text: MARKER_ERLEDIGT, position: { x: 0, y: 0 }, zIndex: 2, status: 'erledigt' },
      { id: 'a-uebergeben', kind: 'aufgabe', text: MARKER_UEBERGEBEN, position: { x: 0, y: 0 }, zIndex: 3, status: 'uebergeben' },
    ]);

    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expect(text).toContain(MARKER_OFFEN);
    expect(text).not.toContain(MARKER_ERLEDIGT);
    expect(text).not.toContain(MARKER_UEBERGEBEN);
  });

  it('fehlender Status gilt als offen (Bestandsobjekte aus 08-01 vor 08-02)', async () => {
    const MARKER = 'AUFGABEOHNESTATUS3D7F';
    const state = stateMitAufgaben([
      { id: 'a-1', kind: 'aufgabe', text: MARKER, position: { x: 0, y: 0 }, zIndex: 1 },
    ]);
    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expect(text).toContain(MARKER);
  });

  it('Verantwortlicher und Fälligkeit gesetzt: beide erscheinen in der Detailzeile', async () => {
    const MARKER_NAME = 'VERANTWORTLICHXY2K5N';
    const state = stateMitAufgaben([
      {
        id: 'a-1', kind: 'aufgabe', text: 'Frist prüfen', position: { x: 0, y: 0 }, zIndex: 1,
        status: 'offen', assignee: MARKER_NAME, dueDate: '2026-09-01', priority: 'hoch',
      },
    ]);
    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expect(text).toContain(MARKER_NAME);
    expect(text).not.toContain(HERKUNFT_UNBEKANNT_TEXT);
    expect(text).toContain('Hoch');
  });

  it('kein Verantwortlicher gesetzt: kein erfundener Platzhalter, Segment entfällt ersatzlos', async () => {
    const state = stateMitAufgaben([
      {
        id: 'a-1', kind: 'aufgabe', text: 'Aufgabentext ohne Zuweisung', position: { x: 0, y: 0 }, zIndex: 1,
        status: 'offen', dueDate: '2026-09-01',
      },
    ]);
    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expect(text).not.toContain('Verantwortlich');
  });

  it('keine Fälligkeit gesetzt: etablierter Unbekannt-Text statt erfundenem Datum', async () => {
    const state = stateMitAufgaben([
      { id: 'a-1', kind: 'aufgabe', text: 'Ohne Fälligkeit', position: { x: 0, y: 0 }, zIndex: 1, status: 'offen' },
    ]);
    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expect(text).toContain(HERKUNFT_UNBEKANNT_TEXT);
  });

  it('Zustand ganz ohne Aufgaben-Objekte und ohne Zettel/Fähnchen: gültiges PDF mit bestehendem Leerhinweis', async () => {
    const state: DesktopState = { docs: [], links: [], stacks: [] };
    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expect(text).toContain('Keine offenen Aufgaben.');
  });

  it('Zustand ohne legalObjects-Schlüssel (Bestandsschreibtisch): Zettel-/Fähnchen-Ableitung liefert weiterhin Einträge', async () => {
    const MARKER_TODO = 'BESTANDSTODOZETTEL9K1Q';
    const state: DesktopState = {
      docs: [], links: [], stacks: [],
      notes: [{ id: 'n-1', kind: 'todo', text: MARKER_TODO, position: { x: 0, y: 0 }, zIndex: 1 }],
    };
    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expect(text).toContain(MARKER_TODO);
  });

  it('kein Zähl- oder Statistikhinweis über herausgefilterte Objekte', async () => {
    const state = stateMitAufgaben([
      { id: 'a-offen', kind: 'aufgabe', text: 'Sichtbar', position: { x: 0, y: 0 }, zIndex: 1, status: 'offen' },
      { id: 'a-erledigt', kind: 'aufgabe', text: 'Verborgen', position: { x: 0, y: 0 }, zIndex: 2, status: 'erledigt' },
    ]);
    const text = await extrahiereText(await erzeugeAufgabenlistePdf(state, 'Aufgabenliste'));
    expectKeinZaehlhinweis(text);
  });
});

/**
 * Typbewusste Argumentations- und Beweismittelübersicht (08-04 Task 2, LEGAL-01/LEGAL-02):
 * juristische Objekttypen und die Bedeutung der sie verbindenden Verknüpfungen. Direkte
 * State-Fixturen (kein HTTP-Layer nötig, gleiche Begründung wie beim Aufgabenliste-Block).
 */
describe('erzeugeArgumentationPdf (08-04 Task 2): eigene-behauptung/behauptung-gegenseite/tatsache mit Bezugs-Bedeutung', () => {
  it('listet alle drei Argumentations-Typen mit dem Anzeigenamen der Bezugs-Bedeutung', async () => {
    const MARKER_BEHAUPTUNG = 'BEHAUPTUNGEIGEN3F8K';
    const MARKER_GEGENSEITE = 'BEHAUPTUNGGEGEN7H2M';
    const MARKER_TATSACHE = 'TATSACHEMARKER9L4P';
    const MARKER_BEWEIS = 'BEWEISZIELMARKER2Q6R';
    const state: DesktopState = {
      docs: [], stacks: [],
      links: [{ id: 'l-1', fromId: 'beh-1', toId: 'bew-1', note: '', kind: 'belegt' } as DesktopState['links'][number]],
      legalObjects: [
        { id: 'beh-1', kind: 'eigene-behauptung', text: MARKER_BEHAUPTUNG, position: { x: 0, y: 0 }, zIndex: 1 },
        { id: 'geg-1', kind: 'behauptung-gegenseite', text: MARKER_GEGENSEITE, position: { x: 0, y: 0 }, zIndex: 2 },
        { id: 'tat-1', kind: 'tatsache', text: MARKER_TATSACHE, position: { x: 0, y: 0 }, zIndex: 3 },
        { id: 'bew-1', kind: 'beweismittel', text: MARKER_BEWEIS, position: { x: 0, y: 0 }, zIndex: 4 },
      ],
    };
    const text = await extrahiereText(await erzeugeArgumentationPdf(state, 'Argumentation'));
    expect(text).toContain(MARKER_BEHAUPTUNG);
    expect(text).toContain(MARKER_GEGENSEITE);
    expect(text).toContain(MARKER_TATSACHE);
    expect(text).toContain('belegt');
    expect(text).toContain(MARKER_BEWEIS);
  });

  it('Bezug ohne gesetzte Bedeutung wird als offene Zuordnung benannt statt als Behauptung einer Beziehung', async () => {
    const MARKER = 'OHNEBEDEUTUNG4T8V';
    const state: DesktopState = {
      docs: [], stacks: [],
      links: [{ id: 'l-1', fromId: 'beh-1', toId: 'tat-1', note: '' }],
      legalObjects: [
        { id: 'beh-1', kind: 'eigene-behauptung', text: MARKER, position: { x: 0, y: 0 }, zIndex: 1 },
        { id: 'tat-1', kind: 'tatsache', text: 'Ziel', position: { x: 0, y: 0 }, zIndex: 2 },
      ],
    };
    const text = await extrahiereText(await erzeugeArgumentationPdf(state, 'Argumentation'));
    expect(text).toContain('offene Zuordnung');
  });

  it('Bezug auf ein Zielobjekt, das NICHT im übergebenen Zustand liegt, entfällt lautlos — kein Platzhalter, kein Zählhinweis', async () => {
    const MARKER = 'MITEXTERNEMZIEL1A9B';
    const state: DesktopState = {
      docs: [], stacks: [],
      links: [{ id: 'l-1', fromId: 'beh-1', toId: 'nicht-vorhanden', note: '', kind: 'belegt' } as DesktopState['links'][number]],
      legalObjects: [{ id: 'beh-1', kind: 'eigene-behauptung', text: MARKER, position: { x: 0, y: 0 }, zIndex: 1 }],
    };
    const text = await extrahiereText(await erzeugeArgumentationPdf(state, 'Argumentation'));
    expect(text).toContain(MARKER);
    expect(text).not.toContain('nicht-vorhanden');
    expectKeinZaehlhinweis(text);
  });

  it('Zustand ohne passende Objekte: gültiges PDF mit Leerhinweis', async () => {
    const state: DesktopState = { docs: [], links: [], stacks: [] };
    const text = await extrahiereText(await erzeugeArgumentationPdf(state, 'Argumentation'));
    expect(text).toContain('Keine Einträge.');
  });

  it('Bestandsquelle (Notizen mit Verknüpfung) bleibt als Ergänzung erhalten', async () => {
    const MARKER = 'BESTANDSNOTIZARGUMENTATION5C7D';
    const state: DesktopState = {
      docs: [], links: [], stacks: [],
      notes: [{ id: 'n-1', kind: 'behauptung', text: MARKER, position: { x: 0, y: 0 }, zIndex: 1 }],
    };
    const text = await extrahiereText(await erzeugeArgumentationPdf(state, 'Argumentation'));
    expect(text).toContain(MARKER);
  });
});

describe('erzeugeBeweismittelPdf (08-04 Task 2): beweismittel/gegenbeweis mit belegt-gestützten Objekten', () => {
  it('listet beweismittel und gegenbeweis, je mit den über belegt gestützten Objekten', async () => {
    const MARKER_BEWEIS = 'BEWEISMITTELMARKER3E5F';
    const MARKER_GEGENBEWEIS = 'GEGENBEWEISMARKER8G2H';
    const MARKER_TATSACHE = 'GESTUETZTETATSACHE1J4K';
    const state: DesktopState = {
      docs: [], stacks: [],
      links: [{ id: 'l-1', fromId: 'bew-1', toId: 'tat-1', note: '', kind: 'belegt' } as DesktopState['links'][number]],
      legalObjects: [
        { id: 'bew-1', kind: 'beweismittel', text: MARKER_BEWEIS, position: { x: 0, y: 0 }, zIndex: 1 },
        { id: 'geg-1', kind: 'gegenbeweis', text: MARKER_GEGENBEWEIS, position: { x: 0, y: 0 }, zIndex: 2 },
        { id: 'tat-1', kind: 'tatsache', text: MARKER_TATSACHE, position: { x: 0, y: 0 }, zIndex: 3 },
      ],
    };
    const text = await extrahiereText(await erzeugeBeweismittelPdf(state, 'Beweismittel'));
    expect(text).toContain(MARKER_BEWEIS);
    expect(text).toContain(MARKER_GEGENBEWEIS);
    expect(text).toContain(MARKER_TATSACHE);
  });

  it('Bezug auf ein nicht im Zustand enthaltenes Zielobjekt entfällt lautlos — kein Platzhalter, kein Zählhinweis', async () => {
    const MARKER = 'BEWEISOHNEZIEL6L8M';
    const state: DesktopState = {
      docs: [], stacks: [],
      links: [{ id: 'l-1', fromId: 'bew-1', toId: 'nicht-vorhanden', note: '', kind: 'belegt' } as DesktopState['links'][number]],
      legalObjects: [{ id: 'bew-1', kind: 'beweismittel', text: MARKER, position: { x: 0, y: 0 }, zIndex: 1 }],
    };
    const text = await extrahiereText(await erzeugeBeweismittelPdf(state, 'Beweismittel'));
    expect(text).toContain(MARKER);
    expect(text).not.toContain('nicht-vorhanden');
    expectKeinZaehlhinweis(text);
  });

  it('Zustand ohne passende Objekte: gültiges PDF mit Leerhinweis', async () => {
    const state: DesktopState = { docs: [], links: [], stacks: [] };
    const text = await extrahiereText(await erzeugeBeweismittelPdf(state, 'Beweismittel'));
    expect(text).toContain('Keine Einträge.');
  });

  it('Bestandsquelle (Ausschnitte) bleibt als Ergänzung erhalten', async () => {
    const MARKER = 'BESTANDSAUSSCHNITTBEWEISMITTEL2N4P';
    const doc: Doc = { id: 'd-1', fileId: 'f-1', name: 'Quelle.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, kind: 'pdf' };
    const state: DesktopState = {
      docs: [doc], links: [], stacks: [],
      cutouts: [{ id: 'c-1', fileId: 'f-1', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, zIndex: 1, textSnapshot: MARKER }],
    };
    const text = await extrahiereText(await erzeugeBeweismittelPdf(state, 'Beweismittel'));
    expect(text).toContain(MARKER);
  });
});

/** T-08-17: die serverseitige Anzeigenamen-Zuordnung darf nie von REQUIREMENTS.md abweichen. */
describe('Anzeigenamen-Zuordnung (T-08-17): server-seitig, wortgleich mit REQUIREMENTS.md', () => {
  it('LEGAL_OBJECT_KIND_LABELS deckt alle 13 gesperrten Anzeigenamen aus REQUIREMENTS.md Zeile 77 ab', () => {
    expect(Object.values(LEGAL_OBJECT_KIND_LABELS)).toEqual([
      'Tatsache', 'eigene Behauptung', 'Behauptung der Gegenseite', 'Beweismittel', 'Gegenbeweis',
      'Rechtsfrage', 'Tatbestandsmerkmal', 'Einwendung', 'Risiko', 'Frist', 'Aufgabe',
      'zitierfähige Fundstelle', 'Ergebnis',
    ]);
  });

  it('LINK_MEANING_LABELS deckt alle 11 gesperrten Anzeigenamen aus REQUIREMENTS.md Zeile 78 ab', () => {
    expect(Object.values(LINK_MEANING_LABELS)).toEqual([
      'belegt', 'widerspricht', 'bestätigt', 'widerlegt', 'gehört zu', 'entkräftet',
      'Folge von', 'Voraussetzung für', 'offene Frage', 'streitig', 'unstreitig',
    ]);
  });
});

describe('GET …/export/pdf/argumentation (D-09)', () => {
  it('enthält freigegebene Notiz mit Verknüpfungs-Bezug; interner Marker und internes Linkziel fehlen', async () => {
    const { app, a, deskId } = await deskMitUebersichtsInhalten();

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/argumentation`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(MARKER_NOTIZ);
    // Bezug auf den freigegebenen Ausschnitt (Kurztext aus dem Ursprungstext).
    expect(text).toContain(MARKER_URSPRUNG);
    expect(text).not.toContain(MARKER_INTERN);
    // l-2 ist freigegeben, sein Ziel aber intern — der Dokumentname darf trotzdem nicht auftauchen.
    expect(text).not.toContain(MARKER_DOC_INTERN);
    expectKeinZaehlhinweis(text);
  });

  it('paginiert lange Inhalte: jede Seite trägt „Seite n"', async () => {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Pagination' } })
    ).json() as { id: string };
    for (let i = 0; i < 90; i++) {
      const id = `n-pag-${i}`;
      await app.inject({
        method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
        payload: { type: 'addNote', payload: { id, kind: 'argument', text: `PAGINIERUNGSNOTIZ ${i}: Erwägung mit etwas ausführlicherem Begründungstext.`, position: { x: i, y: i } } },
      });
      await app.inject({
        method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders,
        payload: { type: 'changeLayerId', payload: { objectId: id, layerId: 'exportierbar' } },
      });
    }

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export/pdf/argumentation`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    const seiten = await extrahiereSeiten(new Uint8Array(res.rawPayload));
    expect(seiten.length).toBeGreaterThan(1);
    seiten.forEach((text, i) => expect(text).toContain(`Seite ${i + 1}`));
  });
});

describe('GET …/export/pdf/beweismittel (D-09)', () => {
  it('enthält freigegebenen Ausschnitt mit Ursprungstext und Provenienz (Dokumentname, Seite); interner Marker fehlt', async () => {
    const { app, a, deskId } = await deskMitUebersichtsInhalten();

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/beweismittel`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(MARKER_URSPRUNG);
    expect(text).toContain(`${MARKER_DOC}.pdf`);
    expect(text).toContain('Seite 1');
    expect(text).not.toContain(MARKER_INTERN);
    expect(text).not.toContain(MARKER_DOC_INTERN);
    expectKeinZaehlhinweis(text);
  });
});

describe('Guard-Dreischritt und DoS-Limit (T-03-04-02/03)', () => {
  it('Rolle ohne Export-Recht (Nur-Lesen) ⇒ 403 auf den neuen Routen', async () => {
    const { app, db, b, deskId } = await deskMitUebersichtsInhalten();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'Nur-Lesen');

    for (const format of ['snapshot', 'argumentation', 'beweismittel']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/${format}`, headers: b.authHeaders });
      expect(res.statusCode).toBe(403);
    }
  });

  it('Objekt-Limit: mehr als 2000 freigegebene Objekte ⇒ 422 (ExportFehler reason limit)', async () => {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, db, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Riesig' } })
    ).json() as { id: string };
    const notes = Array.from({ length: 2001 }, (_, i) => ({
      id: `n-${i}`, kind: 'notiz', text: 'x', position: { x: 0, y: 0 }, zIndex: 1, freigabe: 'export',
    }));
    putDeskState(db, desk.id, { docs: [], links: [], stacks: [], notes });

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export/pdf/argumentation`, headers: a.authHeaders });
    expect(res.statusCode).toBe(422);
  });
});

/**
 * Fundstellen-PDF (EXP-02, D-04, 03-08): erzeugeFundstellenPdf wird HIER direkt gegen
 * handgebaute DesktopState-Fixturen getestet (kein HTTP-Layer — die Route folgt in Task 2).
 * Der übergebene State simuliert bewusst den bereits freigabe-gefilterten Zustand (Route
 * ruft freigabeFilter VOR dem Aufruf auf, 03-PATTERNS „Export-Route: Guard + Projektion +
 * freigabeFilter"): Fixturen, die keine Sichtbarkeit mehr haben sollen, fehlen im State
 * (Doc-Schnitt) statt über ein freigabe-Feld ausgefiltert zu werden.
 */
describe('erzeugeFundstellenPdf (EXP-02, D-04): TOC, Crop, Provenienz, Redaktion, Lautlosigkeit, jl-Stand', () => {
  const FS_URSPRUNG_1 = 'FUNDSTELLENURSPRUNG-EINS-4K9Q';
  const FS_URSPRUNG_2 = 'FUNDSTELLENURSPRUNG-ZWEI-5L2R';
  const FS_DOC_NAME = 'FUNDSTELLENDOKUMENT-7X3P.pdf';
  const FS_DOC_NAME_2 = 'ZWEITESDOKUMENT-9Y2S.pdf';
  const FS_ERSTELLER = 'nutzer-fundstelle';

  function macheDoc(id: string, fileId: string, extra: Partial<Doc> = {}): Doc {
    return { id, fileId, name: `${id}.pdf`, position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, kind: 'pdf', ...extra };
  }

  /**
   * Zwei Fundstellen = zwei Ausschnitte (cutouts) auf zwei verschiedenen Dokumenten. KEIN
   * Mark hier: marks (redact/tippex) sind bewusst keine eigenständigen Fundstellen (siehe
   * sammleFundstellenKandidaten-Kommentar) — ihr textSnapshot ist der zu verbergende Text,
   * nicht ein anzeigbarer Fund.
   */
  async function zweiFundstellenFixtures() {
    const f1 = await erzeugeTextPdf(FS_URSPRUNG_1, 80, 700);
    const f2 = await erzeugeTextPdf(FS_URSPRUNG_2, 80, 500);
    const doc1 = macheDoc('doc-1', 'file-1', { name: FS_DOC_NAME });
    const doc2 = macheDoc('doc-2', 'file-2', { name: FS_DOC_NAME_2 });
    const state: DesktopState = {
      docs: [doc1, doc2], links: [], stacks: [],
      cutouts: [
        {
          id: 'cut-1', fileId: 'file-1', page: 1, rect: f1.basis, position: { x: 0, y: 0 }, zIndex: 1,
          textSnapshot: FS_URSPRUNG_1, createdBy: FS_ERSTELLER, createdAt: '2026-01-15T09:00:00.000Z',
        },
        {
          id: 'cut-2', fileId: 'file-2', page: 1, rect: f2.basis, position: { x: 0, y: 0 }, zIndex: 2,
          textSnapshot: FS_URSPRUNG_2, createdBy: FS_ERSTELLER, createdAt: '2026-01-16T09:00:00.000Z',
        },
      ],
    };
    const bytesMap: Record<string, Uint8Array> = { 'doc-1': f1.bytes, 'doc-2': f2.bytes };
    const quellen = { ladeDocBytes: async (docId: string) => bytesMap[docId] };
    return { state, quellen, f1, f2, doc1, doc2 };
  }

  it('zwei freigegebene Fundstellen ⇒ TOC-Seite mit Link-Annots auf beide Fundstellen-Seiten', async () => {
    const { state, quellen } = await zweiFundstellenFixtures();
    const bytes = await erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte');
    const out = await PDFDocument.load(bytes);
    const seiten = out.getPages();
    expect(seiten.length).toBe(3); // 1 TOC-Seite + 2 Fundstellen-Seiten

    const annots = seiten[0].node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(2);
    const ziele = new Set<string>();
    for (let i = 0; i < annots.size(); i++) {
      const annot = out.context.lookup(annots.get(i), PDFDict);
      expect(annot.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe('/Link');
      const dest = annot.lookup(PDFName.of('Dest'), PDFArray);
      ziele.add(dest.get(0).toString());
    }
    expect(ziele).toEqual(new Set([seiten[1].ref.toString(), seiten[2].ref.toString()]));
  });

  it('Crop-Region: die Fundstellen-Seite hat eine CropBox, die exakt die umgerechnete Fundstellen-Region (mit Rand) deckt', async () => {
    const { state, quellen, f1 } = await zweiFundstellenFixtures();
    const bytes = await erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte');
    const out = await PDFDocument.load(bytes);
    const seiten = out.getPages();

    const quellGeo = seitenGeometrieVon((await PDFDocument.load(f1.bytes)).getPage(0));
    const rectUser = basisNachUserSpace(f1.basis, quellGeo);

    const crop = seiten[1].getCropBox();
    // Echtes Cropping hat stattgefunden — die CropBox ist deutlich kleiner als die MediaBox.
    expect(crop.width).toBeLessThan(595);
    expect(crop.height).toBeLessThan(842);
    // Der Ausschnitt-Bereich liegt vollständig innerhalb der gesetzten CropBox (Display-Crop, Pattern 5).
    expect(crop.x).toBeLessThanOrEqual(rectUser.x + 0.01);
    expect(crop.y).toBeLessThanOrEqual(rectUser.y + 0.01);
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(rectUser.x + rectUser.w - 0.01);
    expect(crop.y + crop.height).toBeGreaterThanOrEqual(rectUser.y + rectUser.h - 0.01);
  });

  it('Provenienz-Block: Dokumentname, Seite, Ersteller, Zeitpunkt und Ursprungstext im extrahierten Text', async () => {
    const { state, quellen } = await zweiFundstellenFixtures();
    const bytes = await erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte');
    const seiten = await extrahiereSeiten(bytes);
    const fundstellenSeite1 = seiten[1];
    expect(fundstellenSeite1).toContain(FS_DOC_NAME);
    expect(fundstellenSeite1).toContain('Seite: 1');
    expect(fundstellenSeite1).toContain(FS_ERSTELLER);
    expect(fundstellenSeite1).toContain(FS_URSPRUNG_1);
  });

  it('Schwärzung auf derselben Quellseite ⇒ geschwärzter Ursprungstext trotz Crop nicht extrahierbar (Redaktion VOR Crop)', async () => {
    const GEHEIM = 'FUNDSTELLENGEHEIM-3Q8Z';
    const f1 = await erzeugeTextPdf(FS_URSPRUNG_1, 80, 700);
    // Geheimtext an ANDERER Stelle derselben Quellseite, außerhalb des Cutout-Bereichs (T-03-08-01):
    // reines Cropping würde ihn NICHT entfernen — nur redactiereSeite (Content-Stream-Rewrite) tut das.
    const geladen = await PDFDocument.load(f1.bytes);
    const seite0 = geladen.getPage(0);
    const font = await geladen.embedFont(StandardFonts.Helvetica);
    seite0.drawText(GEHEIM, { x: 80, y: 300, size: 12, font });
    const bytes0 = await geladen.save();
    const geheimBasis = { x: 80, y: 842 - 300 - 12, w: font.widthOfTextAtSize(GEHEIM, 12), h: 12 };

    const doc1 = macheDoc('doc-1', 'file-1', { name: FS_DOC_NAME });
    const state: DesktopState = {
      docs: [doc1], links: [], stacks: [],
      cutouts: [{
        id: 'cut-1', fileId: 'file-1', page: 1, rect: f1.basis, position: { x: 0, y: 0 }, zIndex: 1,
        textSnapshot: FS_URSPRUNG_1, createdBy: FS_ERSTELLER, createdAt: '2026-01-15T09:00:00.000Z',
      }],
      marks: [{ id: 'mark-redact', docId: 'doc-1', page: 1, rect: geheimBasis, kind: 'redact', textSnapshot: GEHEIM }],
    };
    const quellen = { ladeDocBytes: async () => bytes0 };

    const bytes = await erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte');
    const text = await extrahiereText(bytes);
    expect(text).not.toContain(GEHEIM);
    expect(text).toContain(FS_URSPRUNG_1); // der Rest der Fundstelle bleibt lesbar
  });

  it('Fundstelle auf internem Doc (Doc nicht im gefilterten State) ⇒ taucht lautlos nicht auf, kein Hinweis im Artefakt', async () => {
    const f1 = await erzeugeTextPdf(FS_URSPRUNG_1, 80, 700);
    // KEIN Doc im State — simuliert den bereits freigabe-gefilterten Zustand, in dem ein
    // effektiv internes Doc restlos entfernt wurde (D-08): die Fundstelle findet keinen Doc-Treffer.
    const state: DesktopState = {
      docs: [], links: [], stacks: [],
      cutouts: [{
        id: 'cut-1', fileId: 'file-1', page: 1, rect: f1.basis, position: { x: 0, y: 0 }, zIndex: 1,
        textSnapshot: FS_URSPRUNG_1, createdBy: FS_ERSTELLER, createdAt: '2026-01-15T09:00:00.000Z',
      }],
    };
    expect(sammleFundstellenKandidaten(state)).toHaveLength(0);

    const quellen = { ladeDocBytes: async () => f1.bytes };
    const bytes = await erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte');
    const text = await extrahiereText(bytes);
    expect(text).not.toContain(FS_URSPRUNG_1);
    expect(text).not.toMatch(/ausgelassen|gefiltert|intern/i);
  });

  it('rotierte Quellseite mit Schwärzung ⇒ fail-closed statt ungeprüft "geschwärzt" ausgeliefert (CR-01)', async () => {
    // Vor dem Fix (T-03-08-01 Lücke): redactiereSeite() meldet rotationsAbgelehnt, die
    // Fundstellen-Pipeline ignorierte das Ergebnis und lieferte die UNREDIGIERTE Seite aus.
    // Der Fix mirrort registriereDokumentRoute (pdfExport.ts): rotationsAbgelehnt/xobjectTextVerdacht
    // lösen den Raster-Fallback aus, der ohne installierten Rasterer fail-closed abbricht.
    const rot = await erzeugeRotiertesPdf();
    const doc1 = macheDoc('doc-1', 'file-1', { name: FS_DOC_NAME });
    const state: DesktopState = {
      docs: [doc1], links: [], stacks: [],
      cutouts: [{
        id: 'cut-1', fileId: 'file-1', page: 1, rect: { x: 50, y: 350, w: 250, h: 60 }, position: { x: 0, y: 0 }, zIndex: 1,
        textSnapshot: FS_URSPRUNG_1, createdBy: FS_ERSTELLER, createdAt: '2026-01-15T09:00:00.000Z',
      }],
      marks: [{ id: 'mark-redact', docId: 'doc-1', page: 1, rect: { x: 50, y: 350, w: 250, h: 60 }, kind: 'redact', textSnapshot: rot.text }],
    };
    const quellen = { ladeDocBytes: async () => rot.bytes };

    await expect(erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte')).rejects.toMatchObject({
      reason: 'verifikation-fehlgeschlagen',
    });
  });

  it('rotierte Quellseite: transienter zweiter ladeDocBytes-Fehler im Raster-Fallback ⇒ sauberer 422 statt unbehandelter 500 (WR-04)', async () => {
    // ladeQuelle() (erster Aufruf, gecacht) lädt erfolgreich; der Raster-Fallback-Zweig
    // (zweiter, ungecachter ladeDocBytes-Aufruf) simuliert einen transienten Lesefehler.
    // Ohne den WR-04-Guard würde dieser rohe Error ungefangen aus erzeugeFundstellenPdf
    // propagieren statt als ExportFehler('quelle-fehlt') abgefangen zu werden.
    const rot = await erzeugeRotiertesPdf();
    const doc1 = macheDoc('doc-1', 'file-1', { name: FS_DOC_NAME });
    const state: DesktopState = {
      docs: [doc1], links: [], stacks: [],
      cutouts: [{
        id: 'cut-1', fileId: 'file-1', page: 1, rect: { x: 50, y: 350, w: 250, h: 60 }, position: { x: 0, y: 0 }, zIndex: 1,
        textSnapshot: FS_URSPRUNG_1, createdBy: FS_ERSTELLER, createdAt: '2026-01-15T09:00:00.000Z',
      }],
      marks: [{ id: 'mark-redact', docId: 'doc-1', page: 1, rect: { x: 50, y: 350, w: 250, h: 60 }, kind: 'redact', textSnapshot: rot.text }],
    };
    let aufrufe = 0;
    const quellen = {
      ladeDocBytes: async () => {
        aufrufe += 1;
        if (aufrufe === 1) return rot.bytes; // ladeQuelle() — erfolgreich, wird gecacht
        throw new Error('ECONNRESET (simuliert)'); // Raster-Fallback-Zweig — transient fehlgeschlagen
      },
    };

    await expect(erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte')).rejects.toMatchObject({
      reason: 'quelle-fehlt',
    });
  });

  it("jl-Status 'ersetzt' am Quell-Doc ⇒ Stand-Hinweis im Provenienz-Block, Ursprungstext bleibt trotzdem (D-15)", async () => {
    const f1 = await erzeugeTextPdf(FS_URSPRUNG_1, 80, 700);
    const doc1 = macheDoc('doc-1', 'file-1', { name: FS_DOC_NAME, sourceReplacedAt: '2026-02-01T00:00:00.000Z' });
    const state: DesktopState = {
      docs: [doc1], links: [], stacks: [],
      cutouts: [{
        id: 'cut-1', fileId: 'file-1', page: 1, rect: f1.basis, position: { x: 0, y: 0 }, zIndex: 1,
        textSnapshot: FS_URSPRUNG_1, createdBy: FS_ERSTELLER, createdAt: '2026-01-15T09:00:00.000Z',
      }],
    };
    const quellen = { ladeDocBytes: async () => f1.bytes };

    const bytes = await erzeugeFundstellenPdf(state, quellen, 'Fundstellen — Testakte');
    const text = await extrahiereText(bytes);
    expect(text).toContain('Stand-Hinweis');
    expect(text).toContain(FS_URSPRUNG_1); // Ursprungstext bleibt trotz Stand-Hinweis erhalten (D-15)
  });
});

/**
 * Fundstellen-Route (EXP-02, D-04, 03-08): dieselbe Guard-Projektion-Filter-Kette wie die
 * übrigen PDF-Übergabeformate (03-PATTERNS „Export-Route: Guard + Projektion + freigabeFilter"),
 * plus serverseitige ids-Validierung (untrusted Query-Parameter, 03-RESEARCH V5).
 */
describe('GET …/export/pdf/fundstellen (EXP-02, D-04, 03-08)', () => {
  const ROUTE_URSPRUNG_EXPORT_1 = 'ROUTEFUNDSTELLEEXPORT1-2H8M';
  const ROUTE_URSPRUNG_EXPORT_2 = 'ROUTEFUNDSTELLEEXPORT2-6P1D';
  const ROUTE_URSPRUNG_INTERN = 'ROUTEFUNDSTELLEINTERN-3J5N';

  async function deskMitFundstellenRoute() {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, db, dataDir, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Fundstellen' } })
    ).json() as { id: string };
    const cmd = (type: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: a.authHeaders, payload: { type, payload } });

    const fixture1 = await erzeugeTextPdf(ROUTE_URSPRUNG_EXPORT_1, 80, 700);
    const fixture2 = await erzeugeTextPdf(ROUTE_URSPRUNG_EXPORT_2, 80, 500);
    const fixtureIntern = await erzeugeTextPdf(ROUTE_URSPRUNG_INTERN, 80, 700);
    const metaExport = storeFile(db, dataDir, Buffer.from(fixture1.bytes), 'export-doc.pdf');
    const metaIntern = storeFile(db, dataDir, Buffer.from(fixtureIntern.bytes), 'intern-doc.pdf');

    expect((await cmd('addDoc', { fileId: metaExport.id, name: 'export-doc.pdf', position: { x: 0, y: 0 }, id: 'doc-export' })).statusCode).toBe(200);
    expect((await cmd('changeLayerId', { objectId: 'doc-export', layerId: 'exportierbar' })).statusCode).toBe(200);
    expect((await cmd('addDoc', { fileId: metaIntern.id, name: 'intern-doc.pdf', position: { x: 500, y: 0 }, id: 'doc-intern' })).statusCode).toBe(200);
    // doc-intern bleibt auf der Kanzlei-Ebene (intern) — kein changeLayerId.

    expect((await cmd('addCutout', {
      docId: 'doc-export', page: 1, rect: fixture1.basis, position: { x: 900, y: 0 }, id: 'cut-export-1', textSnapshot: ROUTE_URSPRUNG_EXPORT_1,
    })).statusCode).toBe(200);
    expect((await cmd('changeLayerId', { objectId: 'cut-export-1', layerId: 'exportierbar' })).statusCode).toBe(200);

    expect((await cmd('addCutout', {
      docId: 'doc-export', page: 1, rect: fixture2.basis, position: { x: 1200, y: 0 }, id: 'cut-export-2', textSnapshot: ROUTE_URSPRUNG_EXPORT_2,
    })).statusCode).toBe(200);
    expect((await cmd('changeLayerId', { objectId: 'cut-export-2', layerId: 'exportierbar' })).statusCode).toBe(200);

    expect((await cmd('addCutout', {
      docId: 'doc-intern', page: 1, rect: fixtureIntern.basis, position: { x: 1500, y: 0 }, id: 'cut-intern', textSnapshot: ROUTE_URSPRUNG_INTERN,
    })).statusCode).toBe(200);
    // cut-intern bleibt intern (weder Doc noch Cutout freigegeben).

    return { ...ctx, deskId: desk.id };
  }

  it('ohne Parameter ⇒ 200 application/pdf mit allen freigegebenen Fundstellen (interner Marker fehlt)', async () => {
    const { app, a, deskId } = await deskMitFundstellenRoute();
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/fundstellen`, headers: a.authHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const text = await extrahiereText(new Uint8Array(res.rawPayload));
    expect(text).toContain(ROUTE_URSPRUNG_EXPORT_1);
    expect(text).toContain(ROUTE_URSPRUNG_EXPORT_2);
    expect(text).not.toContain(ROUTE_URSPRUNG_INTERN);
  });

  it('?ids= schränkt auf die ausgewählten Fundstellen ein; unbekannte/nicht-freigegebene id ⇒ 422', async () => {
    const { app, a, deskId } = await deskMitFundstellenRoute();

    const eingeschraenkt = await app.inject({
      method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/fundstellen?ids=cut-export-1`, headers: a.authHeaders,
    });
    expect(eingeschraenkt.statusCode).toBe(200);
    const text = await extrahiereText(new Uint8Array(eingeschraenkt.rawPayload));
    expect(text).toContain(ROUTE_URSPRUNG_EXPORT_1);
    expect(text).not.toContain(ROUTE_URSPRUNG_EXPORT_2);

    const unbekannt = await app.inject({
      method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/fundstellen?ids=cut-export-1,nichtvorhanden`, headers: a.authHeaders,
    });
    expect(unbekannt.statusCode).toBe(422);
    const body = unbekannt.json() as { error: string; reason?: string };
    expect(body.reason).toBe('unbekannte-fundstelle');
    expect(body.error).toContain('verfügbar');

    // ids einer NICHT freigegebenen Fundstelle (existiert, ist aber intern) ⇒ ebenfalls 422.
    const internAlsId = await app.inject({
      method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/fundstellen?ids=cut-intern`, headers: a.authHeaders,
    });
    expect(internAlsId.statusCode).toBe(422);
    expect((internAlsId.json() as { reason?: string }).reason).toBe('unbekannte-fundstelle');
  });

  it('Desk ohne freigegebene Fundstellen ⇒ 422 mit ehrlicher Leermeldung (kein leeres PDF)', async () => {
    const ctx = await createTestAppMitZweiNutzern();
    const { app, a } = ctx;
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: a.authHeaders, payload: { name: 'Akte Leer' } })
    ).json() as { id: string };

    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/export/pdf/fundstellen`, headers: a.authHeaders });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; reason?: string };
    expect(body.reason).toBe('keine-fundstellen');
    expect(body.error).toContain('Keine freigegebenen Fundstellen');
  });

  it('Rolle ohne Export-Recht (Nur-Lesen) ⇒ 403', async () => {
    const { app, db, b, deskId } = await deskMitFundstellenRoute();
    db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, b.userId, 'Nur-Lesen');
    const res = await app.inject({ method: 'GET', url: `/api/v1/desks/${deskId}/export/pdf/fundstellen`, headers: b.authHeaders });
    expect(res.statusCode).toBe(403);
  });
});
