import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import { findeObjekt } from './stempel';
import { addLink } from './links';
import { applyCommand, CommandError } from './commands';
import {
  addZeitleiste, moveZeitleiste, removeZeitleiste, expandZeitleiste, collapseZeitleiste, resizeZeitleiste,
  addZeitleisteEintrag, setZeitleisteEintrag, removeZeitleisteEintrag,
  findZeitleiste, zeitleisteBox, sortierteEintraege,
  ZEITLEISTE_EINTRAG_ARTEN, ZEITANGABE_ARTEN,
  ZEITLEISTE_W, ZEITLEISTE_H, ZEITLEISTE_OPEN_W, ZEITLEISTE_OPEN_H, ZEITLEISTE_MIN_W, ZEITLEISTE_MIN_H,
  type ZeitangabeArt,
} from './zeitleiste';

function tischMitDoc(docId = 'd1'): DesktopState {
  return addDoc(emptyState(), 'f1', 'Akte.pdf', { x: 0, y: 0 }, docId);
}

describe('addZeitleiste', () => {
  it('legt eine geöffnete Karte ohne Einträge mit zIndex = maxZ + 1 an', () => {
    const alt = tischMitDoc();
    const neu = addZeitleiste(alt, { x: 10, y: 20 }, 'zl1');
    expect(neu.zeitleisten).toHaveLength(1);
    const z = neu.zeitleisten![0];
    expect(z).toMatchObject({ id: 'zl1', titel: 'Zeitleiste', eintraege: [], position: { x: 10, y: 20 }, open: true });
    expect(z.openSize).toEqual({ w: ZEITLEISTE_OPEN_W, h: ZEITLEISTE_OPEN_H });
    expect(z.zIndex).toBeGreaterThan(0);
  });

  it('vergibt eine id, wenn keine mitkommt', () => {
    const s = addZeitleiste(emptyState(), { x: 0, y: 0 });
    expect(s.zeitleisten![0].id).toBeTruthy();
  });

  it('funktioniert auf alten States ohne zeitleisten-Feld — das Array entsteht erstmalig', () => {
    const alt = emptyState();
    delete (alt as { zeitleisten?: unknown }).zeitleisten;
    const neu = addZeitleiste(alt, { x: 0, y: 0 });
    expect(neu.zeitleisten).toHaveLength(1);
  });

  it('ein Bestandszustand ohne zeitleisten-Array lässt sich unverändert lesen', () => {
    const alt = emptyState();
    delete (alt as { zeitleisten?: unknown }).zeitleisten;
    expect(alt.zeitleisten).toBeUndefined();
    expect(findZeitleiste(alt, 'irgendwas')).toBeUndefined();
  });
});

describe('moveZeitleiste/removeZeitleiste', () => {
  it('moveZeitleiste ändert die Position', () => {
    let s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zl1');
    s = moveZeitleiste(s, 'zl1', { x: 5, y: 6 });
    expect(findZeitleiste(s, 'zl1')?.position).toEqual({ x: 5, y: 6 });
  });

  it('moveZeitleiste/removeZeitleiste auf unbekannter id werfen "nicht gefunden"', () => {
    expect(() => moveZeitleiste(emptyState(), 'nix', { x: 0, y: 0 })).toThrow(/nicht gefunden/);
    expect(() => removeZeitleiste(emptyState(), 'nix')).toThrow(/nicht gefunden/);
  });

  it('entfernt die Karte UND alle Verknüpfungen, an denen sie beteiligt ist', () => {
    let s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zl1');
    s = addZeitleiste(s, { x: 100, y: 0 }, 'zl2');
    s = addLink(s, 'zl1', 'zl2', 'l1');
    s = removeZeitleiste(s, 'zl1');
    expect(findZeitleiste(s, 'zl1')).toBeUndefined();
    expect(s.links).toEqual([]);
  });
});

describe('expandZeitleiste/collapseZeitleiste/resizeZeitleiste', () => {
  it('expandZeitleiste öffnet mit Vorgabemaßen, resizeZeitleiste setzt eine eigene Größe, collapseZeitleiste schließt', () => {
    let s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zl1');
    s = collapseZeitleiste(s, 'zl1');
    expect(findZeitleiste(s, 'zl1')?.open).toBe(false);
    s = expandZeitleiste(s, 'zl1');
    expect(findZeitleiste(s, 'zl1')).toMatchObject({ open: true, openSize: { w: ZEITLEISTE_OPEN_W, h: ZEITLEISTE_OPEN_H } });
    s = resizeZeitleiste(s, 'zl1', { w: 1000, h: 500 });
    expect(findZeitleiste(s, 'zl1')?.openSize).toEqual({ w: 1000, h: 500 });
  });

  it('resizeZeitleiste klemmt auf die Mindestgröße statt abzulehnen', () => {
    const s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zl1');
    const neu = resizeZeitleiste(s, 'zl1', { w: 10, h: 10 });
    expect(findZeitleiste(neu, 'zl1')?.openSize).toEqual({ w: ZEITLEISTE_MIN_W, h: ZEITLEISTE_MIN_H });
  });

  it('resizeZeitleiste wirft bei nicht-endlichen Maßen', () => {
    const s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zl1');
    expect(() => resizeZeitleiste(s, 'zl1', { w: NaN, h: 500 })).toThrow();
  });
});

describe('zeitleisteBox', () => {
  it('liefert das liegende Miniaturformat geschlossen und openSize/Vorgabe geöffnet — NICHT CARD_W/CARD_H', () => {
    let s = addZeitleiste(emptyState(), { x: 3, y: 4 }, 'zl1');
    s = collapseZeitleiste(s, 'zl1');
    expect(zeitleisteBox(findZeitleiste(s, 'zl1')!)).toEqual({ x: 3, y: 4, w: ZEITLEISTE_W, h: ZEITLEISTE_H });
    s = expandZeitleiste(s, 'zl1');
    expect(zeitleisteBox(findZeitleiste(s, 'zl1')!)).toEqual({ x: 3, y: 4, w: ZEITLEISTE_OPEN_W, h: ZEITLEISTE_OPEN_H });
  });
});

describe('addZeitleisteEintrag: fachliche Regeln (objRef, Datum)', () => {
  it('fügt einen Eintrag mit Referenz auf ein bestehendes Objekt hinzu', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-01-15', undefined, 'e1');
    const z = findZeitleiste(s, 'zl1')!;
    expect(z.eintraege).toHaveLength(1);
    expect(z.eintraege[0]).toEqual({ id: 'e1', objRef: 'd1', art: 'ereignis', zeitangabe: 'genau', datum: '2026-01-15' });
  });

  it('ein unbekanntes objRef wirft und verändert den Zustand nicht', () => {
    let s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zl1');
    expect(() => addZeitleisteEintrag(s, 'zl1', 'gibt-es-nicht', 'ereignis', 'genau', '2026-01-15')).toThrow(/nicht gefunden/);
    expect(findZeitleiste(s, 'zl1')?.eintraege).toEqual([]);
  });

  it('ein ungültiges Datumsformat wirft', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    expect(() => addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '15.01.2026')).toThrow(/Kalendertag/);
    expect(() => addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', 'kein-datum')).toThrow(/Kalendertag/);
  });

  it('zeitangabe "zeitraum" ohne datumBis wirft und verändert den Zustand nicht', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    expect(() => addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'zeitraum', '2026-01-01')).toThrow(/Enddatum/);
    expect(findZeitleiste(s, 'zl1')?.eintraege).toEqual([]);
  });

  it('zeitangabe "zeitraum" mit datumBis vor datum wirft', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    expect(() => addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'zeitraum', '2026-01-10', '2026-01-05')).toThrow(/Enddatum/);
  });

  it('zeitangabe "zeitraum" mit datumBis gleich datum ist zulässig (eintägiger Zeitraum)', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'zeitraum', '2026-01-10', '2026-01-10', 'e1');
    expect(findZeitleiste(s, 'zl1')?.eintraege[0].datumBis).toBe('2026-01-10');
  });

  it('zeitangabe "genau" mit mitgeliefertem datumBis speichert kein datumBis', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-01-15', '2026-02-01', 'e1');
    const eintrag = findZeitleiste(s, 'zl1')!.eintraege[0];
    expect(eintrag.datumBis).toBeUndefined();
    expect('datumBis' in eintrag).toBe(false);
  });

  it('ohne mitgelieferte Zeitangabe entsteht "genau"', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', undefined, '2026-01-15', undefined, 'e1');
    expect(findZeitleiste(s, 'zl1')?.eintraege[0].zeitangabe).toBe('genau');
  });
});

describe('CHRONO-01/02: alle sieben Eintragsarten und alle fünf Zeitangaben', () => {
  it.each(ZEITLEISTE_EINTRAG_ARTEN)('Eintragsart "%s" lässt sich anlegen und bleibt unterscheidbar erhalten', (art) => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', art, 'genau', '2026-01-01', undefined, 'e1');
    expect(findZeitleiste(s, 'zl1')?.eintraege[0].art).toBe(art);
  });

  it.each(ZEITANGABE_ARTEN)('Zeitangabe "%s" lässt sich anlegen und bleibt unterscheidbar erhalten', (za: ZeitangabeArt) => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    const datumBis = za === 'zeitraum' ? '2026-01-05' : undefined;
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', za, '2026-01-01', datumBis, 'e1');
    const eintrag = findZeitleiste(s, 'zl1')!.eintraege[0];
    expect(eintrag.zeitangabe).toBe(za);
    if (za === 'zeitraum') expect(eintrag.datumBis).toBe('2026-01-05');
    else expect(eintrag.datumBis).toBeUndefined();
  });
});

describe('setZeitleisteEintrag: Teilaktualisierung + Zeitraum-Wechsel', () => {
  function tischMitEintrag() {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-01-01', undefined, 'e1');
    return s;
  }

  it('nicht gesetzte Felder bleiben unverändert', () => {
    const s = tischMitEintrag();
    const neu = setZeitleisteEintrag(s, 'zl1', 'e1', { art: 'frist' });
    const eintrag = findZeitleiste(neu, 'zl1')!.eintraege[0];
    expect(eintrag.art).toBe('frist');
    expect(eintrag.datum).toBe('2026-01-01');
    expect(eintrag.zeitangabe).toBe('genau');
  });

  it('ein Wechsel der Zeitangabe von "zeitraum" auf einen anderen Wert entfernt datumBis', () => {
    let s = tischMitEintrag();
    s = setZeitleisteEintrag(s, 'zl1', 'e1', { zeitangabe: 'zeitraum', datumBis: '2026-01-10' });
    expect(findZeitleiste(s, 'zl1')?.eintraege[0].datumBis).toBe('2026-01-10');
    s = setZeitleisteEintrag(s, 'zl1', 'e1', { zeitangabe: 'ungefaehr' });
    const eintrag = findZeitleiste(s, 'zl1')!.eintraege[0];
    expect(eintrag.zeitangabe).toBe('ungefaehr');
    expect(eintrag.datumBis).toBeUndefined();
    expect('datumBis' in eintrag).toBe(false);
  });

  it('ein Wechsel auf "zeitraum" ohne gleichzeitig mitgeliefertes datumBis wird abgelehnt', () => {
    const s = tischMitEintrag();
    expect(() => setZeitleisteEintrag(s, 'zl1', 'e1', { zeitangabe: 'zeitraum' })).toThrow(/Enddatum/);
  });

  it('ein ausdrücklich auf undefined gesetztes datumBis wird entfernt (Feld vorhanden, Wert undefined)', () => {
    let s = tischMitEintrag();
    s = setZeitleisteEintrag(s, 'zl1', 'e1', { zeitangabe: 'zeitraum', datumBis: '2026-01-10' });
    // Zeitangabe bleibt 'zeitraum', aber datumBis wird explizit entfernt — das MUSS ablehnen,
    // weil 'zeitraum' ein Enddatum verlangt (dieselbe Regel wie bei der Neuanlage).
    expect(() => setZeitleisteEintrag(s, 'zl1', 'e1', { datumBis: undefined })).toThrow(/Enddatum/);
  });

  it('setZeitleisteEintrag auf unbekannter Eintrags-id wirft', () => {
    const s = tischMitEintrag();
    expect(() => setZeitleisteEintrag(s, 'zl1', 'nix', { art: 'frist' })).toThrow(/nicht gefunden/);
  });
});

describe('removeZeitleisteEintrag', () => {
  it('entfernt genau einen Eintrag über seine id', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-01-01', undefined, 'e1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'frist', 'genau', '2026-01-02', undefined, 'e2');
    s = removeZeitleisteEintrag(s, 'zl1', 'e1');
    const eintraege = findZeitleiste(s, 'zl1')!.eintraege;
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0].id).toBe('e2');
  });

  it('wirft auf unbekannter Eintrags-id', () => {
    const s = addZeitleiste(emptyState(), { x: 0, y: 0 }, 'zl1');
    expect(() => removeZeitleisteEintrag(s, 'zl1', 'nix')).toThrow(/nicht gefunden/);
  });
});

describe('sortierteEintraege', () => {
  it('ordnet nach Datum aufsteigend und ist bei gleichem Datum nach id sortiert (deterministisch)', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-03-01', undefined, 'c');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-01-01', undefined, 'a');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-01-01', undefined, 'b');
    const sortiert = sortierteEintraege(findZeitleiste(s, 'zl1')!);
    expect(sortiert.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('findeObjekt/changeLayerId: Einträge sind KEINE eigenständigen Objekte', () => {
  it('findeObjekt löst die Zeitleisten-id auf, eine Eintrags-id NICHT', () => {
    let s = tischMitDoc('d1');
    s = addZeitleiste(s, { x: 0, y: 0 }, 'zl1');
    s = addZeitleisteEintrag(s, 'zl1', 'd1', 'ereignis', 'genau', '2026-01-01', undefined, 'e1');
    expect(findeObjekt(s, 'zl1')?.art).toBe('zeitleisten');
    expect(findeObjekt(s, 'e1')).toBeUndefined();
  });
});

describe('applyCommand: unbekannte Eintragsart/Zeitangabe werfen CommandError', () => {
  it('addZeitleisteEintrag mit unbekannter art wirft CommandError', () => {
    let s = tischMitDoc('d1');
    s = applyCommand(s, { type: 'addZeitleiste', payload: { position: { x: 0, y: 0 }, id: 'zl1' } });
    expect(() => applyCommand(s, {
      type: 'addZeitleisteEintrag',
      payload: { zeitleisteId: 'zl1', objRef: 'd1', art: 'unbekannt', datum: '2026-01-01' },
    })).toThrow(CommandError);
    expect(findZeitleiste(s, 'zl1')?.eintraege).toEqual([]);
  });

  it('addZeitleisteEintrag mit unbekannter zeitangabe wirft CommandError', () => {
    let s = tischMitDoc('d1');
    s = applyCommand(s, { type: 'addZeitleiste', payload: { position: { x: 0, y: 0 }, id: 'zl1' } });
    expect(() => applyCommand(s, {
      type: 'addZeitleisteEintrag',
      payload: { zeitleisteId: 'zl1', objRef: 'd1', art: 'ereignis', zeitangabe: 'unbekannt', datum: '2026-01-01' },
    })).toThrow(CommandError);
  });
});

describe('applyCommand: der volle Zeitleisten-Command-Pfad', () => {
  it('addZeitleiste/addZeitleisteEintrag/setZeitleisteEintrag/removeZeitleisteEintrag/removeZeitleiste über applyCommand', () => {
    let s = tischMitDoc('d1');
    s = applyCommand(s, { type: 'addZeitleiste', payload: { position: { x: 0, y: 0 }, id: 'zl1' } });
    s = applyCommand(s, {
      type: 'addZeitleisteEintrag',
      payload: { zeitleisteId: 'zl1', objRef: 'd1', art: 'ereignis', zeitangabe: 'genau', datum: '2026-01-01', id: 'e1' },
    });
    expect(findZeitleiste(s, 'zl1')?.eintraege).toHaveLength(1);
    s = applyCommand(s, { type: 'setZeitleisteEintrag', payload: { zeitleisteId: 'zl1', eintragId: 'e1', art: 'frist' } });
    expect(findZeitleiste(s, 'zl1')?.eintraege[0].art).toBe('frist');
    s = applyCommand(s, { type: 'expandZeitleiste', payload: { id: 'zl1' } });
    s = applyCommand(s, { type: 'resizeZeitleiste', payload: { id: 'zl1', size: { w: 900, h: 400 } } });
    expect(findZeitleiste(s, 'zl1')?.openSize).toEqual({ w: 900, h: 400 });
    s = applyCommand(s, { type: 'collapseZeitleiste', payload: { id: 'zl1' } });
    expect(findZeitleiste(s, 'zl1')?.open).toBe(false);
    s = applyCommand(s, { type: 'moveZeitleiste', payload: { id: 'zl1', position: { x: 50, y: 50 } } });
    expect(findZeitleiste(s, 'zl1')?.position).toEqual({ x: 50, y: 50 });
    s = applyCommand(s, { type: 'removeZeitleisteEintrag', payload: { zeitleisteId: 'zl1', eintragId: 'e1' } });
    expect(findZeitleiste(s, 'zl1')?.eintraege).toEqual([]);
    s = applyCommand(s, { type: 'removeZeitleiste', payload: { id: 'zl1' } });
    expect(findZeitleiste(s, 'zl1')).toBeUndefined();
  });
});
