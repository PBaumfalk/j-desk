import { describe, it, expect } from 'vitest';
import {
  emptyState, addDoc, addCutout, addMark, addStamp, addFlag, expandDoc, setDocPage, trashObject, removeDoc, stackDocs, renameStack,
} from '@j-desk/core';
import {
  planeSprung, fundstelleAusCutout, fundstelleAusMark, fundstelleAusStamp, fundstelleAusFlag, STEMPEL_SPRUNG_RECT,
  fundstelleAusPdfTreffer, fundstelleAusOcrTreffer,
} from './jump';

/** Karte "doc-a" (file-a) mit einem Ausschnitt von Seite 2 daneben. */
function mitQuelleUndAusschnitt() {
  let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
  s = addCutout(s, 'doc-a', 2, { x: 0, y: 0, w: 50, h: 50 }, { x: 300, y: 0 }, 'cut-1');
  return s;
}

describe('planeSprung', () => {
  it('Karte liegt zu auf dem Tisch -> springen, braucht Aufschlagen + Seitenwahl', () => {
    const s = mitQuelleUndAusschnitt();
    const plan = planeSprung(s, fundstelleAusCutout(s.cutouts![0]));
    expect(plan).toMatchObject({ art: 'springen', brauchtExpand: true, brauchtPage: true });
    if (plan.art === 'springen') expect(plan.doc.id).toBe('doc-a');
  });

  it('Karte ist offen, aber auf der falschen Seite -> springen, kein Aufschlagen, braucht Seitenwahl', () => {
    let s = mitQuelleUndAusschnitt();
    s = expandDoc(s, 'doc-a'); // öffnet auf Seite 1, der Ausschnitt stammt von Seite 2
    const plan = planeSprung(s, fundstelleAusCutout(s.cutouts![0]));
    expect(plan).toMatchObject({ art: 'springen', brauchtExpand: false, brauchtPage: true });
  });

  it('Karte ist offen und schon auf der richtigen Seite -> kein Command nötig (kein Spam)', () => {
    let s = mitQuelleUndAusschnitt();
    s = expandDoc(s, 'doc-a');
    s = setDocPage(s, 'doc-a', 2);
    const plan = planeSprung(s, fundstelleAusCutout(s.cutouts![0]));
    expect(plan).toMatchObject({ art: 'springen', brauchtExpand: false, brauchtPage: false });
  });

  it('Quelle liegt im Papierkorb -> papierkorb', () => {
    let s = mitQuelleUndAusschnitt();
    s = trashObject(s, 'doc-a', '2026-07-20T00:00:00.000Z', 'trash-1');
    const plan = planeSprung(s, fundstelleAusCutout(s.cutouts![0]));
    expect(plan).toEqual({ art: 'papierkorb' });
  });

  it('Quelle weder auf dem Tisch noch im Korb -> anlegen', () => {
    let s = mitQuelleUndAusschnitt();
    s = removeDoc(s, 'doc-a'); // Karte verschwindet, ohne im Korb zu landen (Testsimulation "unbekannt")
    const plan = planeSprung(s, fundstelleAusCutout(s.cutouts![0]));
    expect(plan).toEqual({ art: 'anlegen' });
  });

  it('Quelle steckt in einem (unbenannten) Stapel -> stapel mit Fallback-Namen "Stapel (n)"', () => {
    let s = mitQuelleUndAusschnitt();
    s = addDoc(s, 'file-b', 'b.pdf', { x: 100, y: 0 }, 'doc-b');
    s = stackDocs(s, 'doc-a', 'doc-b', 'stack-1');
    const plan = planeSprung(s, fundstelleAusCutout(s.cutouts![0]));
    expect(plan).toEqual({ art: 'stapel', stackName: 'Stapel (2)' });
  });

  it('Quelle steckt in einem benannten Stapel -> stapel mit dem Stapel-Namen', () => {
    let s = mitQuelleUndAusschnitt();
    s = addDoc(s, 'file-b', 'b.pdf', { x: 100, y: 0 }, 'doc-b');
    s = stackDocs(s, 'doc-a', 'doc-b', 'stack-1');
    s = renameStack(s, 'stack-1', 'Schriftsätze');
    const plan = planeSprung(s, fundstelleAusCutout(s.cutouts![0]));
    expect(plan).toEqual({ art: 'stapel', stackName: 'Schriftsätze' });
  });
});

describe('planeSprung mit docId-Anker (Markierungen, Stempel)', () => {
  it('Dokument liegt zu auf dem Tisch -> springen mit Aufschlagen und Seitenwahl', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    const plan = planeSprung(s, { docId: 'doc-a', page: 3, rect: { x: 1, y: 2, w: 10, h: 4 } });
    expect(plan).toMatchObject({ art: 'springen', brauchtExpand: true, brauchtPage: true });
  });

  it('Dokument ist fort -> weg (kein Neuanlegen, docId trägt keine Datei)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = removeDoc(s, 'doc-a');
    expect(planeSprung(s, { docId: 'doc-a', page: 1 })).toEqual({ art: 'weg' });
  });

  it('Dokument liegt im Papierkorb -> papierkorb', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = trashObject(s, 'doc-a', '2026-07-20T00:00:00.000Z', 'trash-1');
    expect(planeSprung(s, { docId: 'doc-a', page: 1 })).toEqual({ art: 'papierkorb' });
  });

  it('Dokument steckt in einem Stapel -> stapel', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addDoc(s, 'file-b', 'b.pdf', { x: 100, y: 0 }, 'doc-b');
    s = stackDocs(s, 'doc-a', 'doc-b', 'stack-1');
    expect(planeSprung(s, { docId: 'doc-a', page: 1 })).toEqual({ art: 'stapel', stackName: 'Stapel (2)' });
  });

  it('Ziel ohne jeden Anker -> weg (defensiv, statt Absturz)', () => {
    expect(planeSprung(emptyState(), { page: 1 })).toEqual({ art: 'weg' });
  });
});

describe('fundstelleAusMark', () => {
  it('liefert docId-Anker mit Seite und Fläche der Markierung', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addMark(s, { docId: 'doc-a', page: 2, rect: { x: 10, y: 20, w: 30, h: 40 }, kind: 'redact', id: 'mark-1' });
    expect(fundstelleAusMark(s.marks![0])).toEqual({ docId: 'doc-a', page: 2, rect: { x: 10, y: 20, w: 30, h: 40 } });
  });

  it('Karte liegt auf dem Tisch -> springen', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addMark(s, { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'tippex', id: 'mark-1' });
    expect(planeSprung(s, fundstelleAusMark(s.marks![0]))).toMatchObject({ art: 'springen' });
  });

  it('Karte ist fort -> weg (docId trägt keine Datei)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addMark(s, { docId: 'doc-a', page: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, kind: 'redact', id: 'mark-1' });
    const fundstelle = fundstelleAusMark(s.marks![0]);
    s = removeDoc(s, 'doc-a');
    expect(planeSprung(s, fundstelle)).toEqual({ art: 'weg' });
  });
});

describe('fundstelleAusStamp', () => {
  it('liefert docId-Anker mit Seite und Rechteck um den Stempelmittelpunkt', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addStamp(s, {
      docId: 'doc-a', page: 3, x: 100, y: 200, angle: 0, text: 'GEPRÜFT', color: 'blue',
      baseW: 600, baseH: 800, id: 'stamp-1',
    });
    expect(fundstelleAusStamp(s.stamps![0])).toEqual({ docId: 'doc-a', page: 3, rect: STEMPEL_SPRUNG_RECT(100, 200) });
  });

  it('Karte liegt auf dem Tisch -> springen', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addStamp(s, {
      docId: 'doc-a', page: 1, x: 50, y: 50, angle: 0, text: 'ERLEDIGT', color: 'red',
      baseW: 600, baseH: 800, id: 'stamp-1',
    });
    expect(planeSprung(s, fundstelleAusStamp(s.stamps![0]))).toMatchObject({ art: 'springen' });
  });

  it('Karte ist fort -> weg (docId trägt keine Datei)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addStamp(s, {
      docId: 'doc-a', page: 1, x: 50, y: 50, angle: 0, text: 'ERLEDIGT', color: 'red',
      baseW: 600, baseH: 800, id: 'stamp-1',
    });
    const fundstelle = fundstelleAusStamp(s.stamps![0]);
    s = removeDoc(s, 'doc-a');
    expect(planeSprung(s, fundstelle)).toEqual({ art: 'weg' });
  });
});

describe('fundstelleAusFlag', () => {
  it('liefert docId-Anker mit Seite, ohne Fläche (Fahne hat keine Fläche)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addFlag(s, { docId: 'doc-a', page: 5, offset: 0.5, color: '#f5c518', id: 'flag-1' });
    expect(fundstelleAusFlag(s.flags![0])).toEqual({ docId: 'doc-a', page: 5 });
  });

  it('Karte liegt auf dem Tisch -> springen', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addFlag(s, { docId: 'doc-a', page: 1, offset: 0.2, color: '#e5484d', id: 'flag-1' });
    expect(planeSprung(s, fundstelleAusFlag(s.flags![0]))).toMatchObject({ art: 'springen' });
  });

  it('Karte ist fort -> weg (docId trägt keine Datei)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    s = addFlag(s, { docId: 'doc-a', page: 1, offset: 0.2, color: '#3b82f6', id: 'flag-1' });
    const fundstelle = fundstelleAusFlag(s.flags![0]);
    s = removeDoc(s, 'doc-a');
    expect(planeSprung(s, fundstelle)).toEqual({ art: 'weg' });
  });
});

describe('fundstelleAusPdfTreffer (07-03, SEARCH-02: Fundstelle ohne Wortkoordinaten)', () => {
  it('liefert docId-Anker mit ganzeSeite, kein rect', () => {
    expect(fundstelleAusPdfTreffer({ docId: 'd1', page: 4 })).toEqual({ docId: 'd1', page: 4, ganzeSeite: true });
  });

  it('liefert fileId-Anker, wenn kein docId vorliegt', () => {
    expect(fundstelleAusPdfTreffer({ fileId: 'f1', page: 2 })).toEqual({ fileId: 'f1', page: 2, ganzeSeite: true });
  });

  it('planeSprung behandelt das Ergebnis wie jede andere rechtecklose Fundstelle -> springen bleibt unverändert', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    const plan = planeSprung(s, fundstelleAusPdfTreffer({ docId: 'doc-a', page: 1 }));
    expect(plan).toMatchObject({ art: 'springen' });
  });
});

describe('fundstelleAusOcrTreffer (07-03, SEARCH-02: Fundstelle ohne Wortkoordinaten)', () => {
  it('liefert fileId-Anker mit ganzeSeite, kein rect', () => {
    expect(fundstelleAusOcrTreffer({ fileId: 'f1', page: 2 })).toEqual({ fileId: 'f1', page: 2, ganzeSeite: true });
  });

  it('liefert docId-Anker, wenn vorhanden', () => {
    expect(fundstelleAusOcrTreffer({ docId: 'd9', page: 7 })).toEqual({ docId: 'd9', page: 7, ganzeSeite: true });
  });

  it('planeSprung behandelt das Ergebnis wie jede andere rechtecklose Fundstelle -> weg bleibt unverändert, wenn die Karte fort ist', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'doc-a');
    const ziel = fundstelleAusOcrTreffer({ docId: 'doc-a', page: 1 });
    s = removeDoc(s, 'doc-a');
    expect(planeSprung(s, ziel)).toEqual({ art: 'weg' });
  });
});

describe('STEMPEL_SPRUNG_RECT', () => {
  it('zentriert ein Rechteck um den Stempelmittelpunkt', () => {
    const r = STEMPEL_SPRUNG_RECT(100, 200);
    expect(r.x + r.w / 2).toBe(100);
    expect(r.y + r.h / 2).toBe(200);
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });
});
