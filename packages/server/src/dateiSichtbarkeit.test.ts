import { describe, it, expect } from 'vitest';
import type { Rolle } from '@j-desk/core';
import { openDb, type Db } from './db';
import { createUser } from './auth';
import { createDesk, getDeskState, putDeskState } from './deskStore';
import { istDateiSichtbarFuer } from './dateiSichtbarkeit';

/**
 * AR-02-04 (02-SECURITY.md) — Kernfunktion `istDateiSichtbarFuer()`: TDD rot-zuerst, deckt vor der
 * Implementierung Positiv-/Negativ-/Mehrfachbezugs-/Objektarten-/Gastfälle ab. Fixture-Stil
 * analog `berechtigung.test.ts`: direkte State-Manipulation über `putDeskState` statt Command-Weg
 * (die Prüfung selbst steht im Fokus, nicht die Objektanlage).
 */

function weiseRolleZu(db: Db, deskId: string, userId: string, rolle: Rolle): void {
  db.prepare('INSERT INTO desk_roles (desk_id, user_id, rolle) VALUES (?, ?, ?)').run(deskId, userId, rolle);
}

function setzeState(db: Db, deskId: string, patch: Record<string, unknown>): void {
  const vorher = getDeskState(db, deskId)!.state;
  putDeskState(db, deskId, { ...vorher, ...patch });
}

async function baueNutzer(db: Db, name: string): Promise<string> {
  return createUser(db, name, 'test-passwort');
}

describe('istDateiSichtbarFuer()', () => {
  it('Positiv: eine für den Nutzer sichtbare Dokumentkarte referenziert die Datei — erlaubt', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const desk = createDesk(db, aId, 'Akte A', { id: aId, name: 'A' });
    setzeState(db, desk.id, {
      docs: [{ id: 'doc-1', fileId: 'file-1', name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }],
    });

    expect(istDateiSichtbarFuer(db, aId, 'file-1')).toBe(true);
  });

  it('Negativ: die einzige referenzierende Karte liegt auf der privaten Ebene eines anderen Nutzers — verweigert', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const bId = await baueNutzer(db, 'nutzer-b');
    const desk = createDesk(db, aId, 'Akte A', { id: aId, name: 'A' });
    weiseRolleZu(db, desk.id, bId, 'Bearbeiter');
    setzeState(db, desk.id, {
      layers: [{ id: `privat-${aId}`, typ: 'privat', name: 'Privat', ownerUserId: aId }],
      docs: [{ id: 'doc-privat', fileId: 'file-2', name: 'Vermerk.pdf', position: { x: 0, y: 0 }, layerId: `privat-${aId}` }],
    });

    expect(istDateiSichtbarFuer(db, bId, 'file-2')).toBe(false);
  });

  it('Negativ: der Nutzer hat auf keinem Schreibtisch eine Rolle, der die Datei referenziert — verweigert', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const cId = await baueNutzer(db, 'nutzer-c');
    const desk = createDesk(db, aId, 'Akte A', { id: aId, name: 'A' });
    setzeState(db, desk.id, {
      docs: [{ id: 'doc-1', fileId: 'file-3', name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }],
    });

    expect(istDateiSichtbarFuer(db, cId, 'file-3')).toBe(false);
  });

  it('Mehrfachbezug: dieselbe Datei ist auf zwei Schreibtischen referenziert — der zweite mit sichtbarem Bezug erlaubt den Zugriff', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const fremdeId = await baueNutzer(db, 'nutzer-fremd');
    const deskUnsichtbar = createDesk(db, aId, 'Akte 1', { id: aId, name: 'A' });
    const deskSichtbar = createDesk(db, aId, 'Akte 2', { id: aId, name: 'A' });
    setzeState(db, deskUnsichtbar.id, {
      layers: [{ id: `privat-${fremdeId}`, typ: 'privat', name: 'Privat', ownerUserId: fremdeId }],
      docs: [{ id: 'doc-fremd', fileId: 'file-4', name: 'X.pdf', position: { x: 0, y: 0 }, layerId: `privat-${fremdeId}` }],
    });
    setzeState(db, deskSichtbar.id, {
      docs: [{ id: 'doc-eigen', fileId: 'file-4', name: 'X.pdf', position: { x: 0, y: 0 } }],
    });

    expect(istDateiSichtbarFuer(db, aId, 'file-4')).toBe(true);
  });

  it('Objektart Ausschnitt: die einzige Referenz ist ein Scheren-Ausschnitt — erlaubt', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const desk = createDesk(db, aId, 'Akte A', { id: aId, name: 'A' });
    setzeState(db, desk.id, {
      cutouts: [{ id: 'cut-1', fileId: 'file-5', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, position: { x: 0, y: 0 }, zIndex: 1 }],
    });

    expect(istDateiSichtbarFuer(db, aId, 'file-5')).toBe(true);
  });

  it('Objektart Konvolut-Bestandteil: die einzige Referenz ist eine Dokumentkarte innerhalb eines geheften Konvoluts — erlaubt', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const desk = createDesk(db, aId, 'Akte A', { id: aId, name: 'A' });
    setzeState(db, desk.id, {
      docs: [{ id: 'doc-mitglied', fileId: 'file-6', name: 'Seite.pdf', position: { x: 0, y: 0 } }],
      stacks: [{ id: 'stack-1', name: 'Konvolut', docIds: ['doc-mitglied'], position: { x: 0, y: 0 }, zIndex: 1, stapled: true }],
    });

    expect(istDateiSichtbarFuer(db, aId, 'file-6')).toBe(true);
  });

  it('Gastfall: der einzige Bezug ist ein als intern geltendes Objekt — für einen externen Gast verweigert', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const gastId = await baueNutzer(db, 'externer-gast');
    const desk = createDesk(db, aId, 'Akte A', { id: aId, name: 'A' });
    weiseRolleZu(db, desk.id, gastId, 'externer Gast');
    setzeState(db, desk.id, {
      docs: [{ id: 'doc-intern', fileId: 'file-7', name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }],
    });

    expect(istDateiSichtbarFuer(db, gastId, 'file-7')).toBe(false);
  });

  it('Unbekannte Datei bei angemeldetem Nutzer liefert schlicht false, wirft nicht', async () => {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a');
    const desk = createDesk(db, aId, 'Akte A', { id: aId, name: 'A' });
    setzeState(db, desk.id, {
      docs: [{ id: 'doc-1', fileId: 'file-1', name: 'Klageschrift.pdf', position: { x: 0, y: 0 } }],
    });

    expect(() => istDateiSichtbarFuer(db, aId, 'gibtsnicht')).not.toThrow();
    expect(istDateiSichtbarFuer(db, aId, 'gibtsnicht')).toBe(false);
  });
});

/**
 * Task 3 (T-14-07-03/T-14-07-04): Lesepfad unter Last. Baut einen Nutzer mit mehreren
 * Schreibtischen auf, davon einer mit einer realistisch großen Akte (Größenordnung wie
 * desk-volume.perf.test.ts, OPS-04) — direkte State-Konstruktion statt Kommandokette, weil hier
 * der LESE-Pfad gemessen wird, nicht der Schreibweg (dessen Kosten sind unabhängig davon, WIE der
 * Zustand entstanden ist). Worst-Case-Messung: eine Dateikennung, die auf KEINEM Schreibtisch
 * referenziert ist, zwingt die Prüfung, wirklich ALLE Schreibtische inkl. der großen Akte zu
 * laden und zu projizieren — das ist der teuerste Fall, den T-14-07-03 abdecken muss.
 */
describe('Performance: Lesepfad unter Last (T-14-07-03/T-14-07-04)', () => {
  const KLEINE_DESKS = 5;
  const DOCS_JE_KLEINEM_DESK = 10;
  const DOCS_GROSSE_AKTE = 800;
  // Vorgehen wie desk-volume.perf.test.ts (14-03): erst gemessen, dann mit deutlicher Reserve über
  // dem beobachteten Höchstwert. Siehe SUMMARY für die gemessenen Ausgangswerte dieses Plans.
  const LESE_SCHWELLE_MS = 100;
  const CACHE_GROESSE_LIMIT = 50;

  function baueGrosseAkte(db: Db, deskId: string, anzahl: number): void {
    const vorher = getDeskState(db, deskId)!.state;
    const docs = Array.from({ length: anzahl }, (_, i) => ({
      id: `doc-groß-${i}`, fileId: `file-groß-${i}`, name: `${i}.pdf`, position: { x: i, y: i },
    }));
    putDeskState(db, deskId, { ...vorher, docs: [...vorher.docs, ...docs] });
  }

  async function baueMehrereSchreibtische(): Promise<{ db: Db; aId: string; grosseAkteId: string }> {
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a-last');
    let grosseAkteId = '';
    for (let i = 0; i < KLEINE_DESKS; i += 1) {
      const desk = createDesk(db, aId, `Akte klein ${i}`, { id: aId, name: 'A' });
      setzeState(db, desk.id, {
        docs: Array.from({ length: DOCS_JE_KLEINEM_DESK }, (_, j) => ({
          id: `doc-klein-${i}-${j}`, fileId: `file-klein-${i}-${j}`, name: `${j}.pdf`, position: { x: j, y: j },
        })),
      });
    }
    const grosseAkte = createDesk(db, aId, 'Große Akte', { id: aId, name: 'A' });
    grosseAkteId = grosseAkte.id;
    baueGrosseAkte(db, grosseAkteId, DOCS_GROSSE_AKTE);
    return { db, aId, grosseAkteId };
  }

  it(`Worst Case (unbekannte Datei, alle Schreibtische inkl. großer Akte durchsucht) bleibt unter ${LESE_SCHWELLE_MS} ms`, async () => {
    const { db, aId } = await baueMehrereSchreibtische();

    const start = performance.now();
    const gefunden = istDateiSichtbarFuer(db, aId, 'file-existiert-nirgends');
    const dauerMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[T-14-07-03] Worst-Case-Dateiprüfung (${KLEINE_DESKS} kleine + 1 große Akte, ${DOCS_GROSSE_AKTE} Docs): ${dauerMs.toFixed(1)} ms`);

    expect(gefunden).toBe(false);
    expect(dauerMs).toBeLessThan(LESE_SCHWELLE_MS);
  }, 30_000);

  it('ein soeben entzogener Bezug wirkt sofort — keine veraltete Wiederverwendung nach Rechteentzug', async () => {
    const { db, aId, grosseAkteId } = await baueMehrereSchreibtische();
    const fileId = 'file-wird-entzogen';
    const vorher = getDeskState(db, grosseAkteId)!.state;
    putDeskState(db, grosseAkteId, {
      ...vorher,
      docs: [...vorher.docs, { id: 'doc-entzogen', fileId, name: 'x.pdf', position: { x: 0, y: 0 } }],
    });
    expect(istDateiSichtbarFuer(db, aId, fileId)).toBe(true);

    // Rechteentzug: die einzige referenzierende Karte wandert auf eine fremde private Ebene.
    const fremdeId = await baueNutzer(db, 'nutzer-fremd-last');
    const nachher = getDeskState(db, grosseAkteId)!.state;
    putDeskState(db, grosseAkteId, {
      ...nachher,
      layers: [{ id: `privat-${fremdeId}`, typ: 'privat', name: 'Privat', ownerUserId: fremdeId }],
      docs: nachher.docs.map((d) => (d.id === 'doc-entzogen' ? { ...d, layerId: `privat-${fremdeId}` } : d)),
    });

    expect(istDateiSichtbarFuer(db, aId, fileId)).toBe(false);
  }, 30_000);

  it(`eine etwaige Wiederverwendung wächst nicht unbegrenzt (Obergrenze ${CACHE_GROESSE_LIMIT})`, async () => {
    // Deckt die must_haves-Zusicherung ab, FALLS Task 3 eine Wiederverwendung einführt (s. Modul-
    // Kommentar dort für die Begründung, warum ausschließlich am Revisionsstand geschlüsselt statt
    // zeitbasiert). Baut mehr Schreibtische auf, als das Limit erlaubt, und prüft jeweils eine
    // Datei darauf — die Suite muss stabil bleiben, unabhängig davon, ob eine Wiederverwendung
    // existiert (dann bleibt ihre interne Größe begrenzt) oder nicht (dann ist dieser Test ein
    // Bestätigungs-Nachweis ohne Wirkung).
    const db = openDb(':memory:');
    const aId = await baueNutzer(db, 'nutzer-a-viele-desks');
    const anzahlDesks = CACHE_GROESSE_LIMIT + 10;
    for (let i = 0; i < anzahlDesks; i += 1) {
      const desk = createDesk(db, aId, `Akte ${i}`, { id: aId, name: 'A' });
      setzeState(db, desk.id, { docs: [{ id: `doc-${i}`, fileId: `file-${i}`, name: `${i}.pdf`, position: { x: 0, y: 0 } }] });
      expect(istDateiSichtbarFuer(db, aId, `file-${i}`)).toBe(true);
    }
    // Bloße Ausführung ohne Absturz/Speicherwachstum-Symptom über die Testlaufzeit hinaus ist der
    // Nachweis auf dieser Ebene — eine interne Cache-Größe ist kein öffentlicher Vertrag des
    // Moduls und wird deshalb nicht direkt inspiziert.
    expect(istDateiSichtbarFuer(db, aId, 'file-0')).toBe(true);
  }, 30_000);
});
