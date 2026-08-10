import { describe, it, expect } from 'vitest';
import { koppleSeite, koppleRollposition } from './vergleichSync';

describe('koppleSeite (COMP-01: Seitenkopplung im Vergleichsviewer)', () => {
  it('bei eingeschalteter Kopplung übernimmt die andere Spalte die Seitenzahl der bewegten Spalte', () => {
    expect(koppleSeite({ gekoppelt: true, quelle: 'links', seite: 5, seitenAndereSpalte: 10 })).toBe(5);
  });

  it('eine so ausgelöste Angleichung löst keine zweite Angleichung in die Gegenrichtung aus — die Kaskade endet nach einem Schritt', () => {
    const angeglicheneSeite = koppleSeite({ gekoppelt: true, quelle: 'links', seite: 5, seitenAndereSpalte: 10 });
    expect(angeglicheneSeite).toBe(5);
    // Das Ergebnis wird als neue Eingabe mit der Quelle 'programm' wieder eingespeist — genau
    // diese Quelle darf keine weitere Angleichung liefern.
    const zweiteRunde = koppleSeite({ gekoppelt: true, quelle: 'programm', seite: angeglicheneSeite!, seitenAndereSpalte: 5 });
    expect(zweiteRunde).toBeNull();
  });

  it('bei ausgeschalteter Kopplung bleibt die andere Spalte unverändert (null — kein Angleichungsergebnis)', () => {
    expect(koppleSeite({ gekoppelt: false, quelle: 'links', seite: 5, seitenAndereSpalte: 10 })).toBeNull();
  });

  it('hat die andere Fassung weniger Seiten, wird auf die letzte vorhandene Seite geklemmt; eine Seitenzahl kleiner als eins wird auf eins geklemmt', () => {
    expect(koppleSeite({ gekoppelt: true, quelle: 'links', seite: 8, seitenAndereSpalte: 3 })).toBe(3);
    expect(koppleSeite({ gekoppelt: true, quelle: 'rechts', seite: 0, seitenAndereSpalte: 5 })).toBe(1);
    expect(koppleSeite({ gekoppelt: true, quelle: 'rechts', seite: -4, seitenAndereSpalte: 5 })).toBe(1);
  });

  it('hat die andere Fassung mehr Seiten, bleibt die Seitenzahl unverändert übernommen', () => {
    expect(koppleSeite({ gekoppelt: true, quelle: 'links', seite: 2, seitenAndereSpalte: 10 })).toBe(2);
  });

  it('eine Fassung mit null Seiten führt zu keiner Angleichung und zu keinem Fehler', () => {
    expect(() => koppleSeite({ gekoppelt: true, quelle: 'links', seite: 3, seitenAndereSpalte: 0 })).not.toThrow();
    expect(koppleSeite({ gekoppelt: true, quelle: 'links', seite: 3, seitenAndereSpalte: 0 })).toBeNull();
  });

  it('zwei unmittelbar aufeinanderfolgende Bewegungen derselben Spalte führen zu genau zwei Angleichungen, nicht zu einer Kaskade', () => {
    const erste = koppleSeite({ gekoppelt: true, quelle: 'links', seite: 3, seitenAndereSpalte: 10 });
    const zweite = koppleSeite({ gekoppelt: true, quelle: 'links', seite: 4, seitenAndereSpalte: 10 });
    expect(erste).toBe(3);
    expect(zweite).toBe(4);
  });
});

describe('koppleRollposition (COMP-01: Rollpositions-Kopplung im Vergleichsviewer)', () => {
  it('eine Rollposition wird als Bruchteil zwischen null und eins übertragen und außerhalb dieses Bereichs geklemmt', () => {
    expect(koppleRollposition({ gekoppelt: true, quelle: 'links', bruchteil: 0.42 })).toBe(0.42);
    expect(koppleRollposition({ gekoppelt: true, quelle: 'links', bruchteil: -0.5 })).toBe(0);
    expect(koppleRollposition({ gekoppelt: true, quelle: 'rechts', bruchteil: 1.7 })).toBe(1);
  });

  it('eine programmgesteuerte Angleichung löst keine weitere Angleichung aus', () => {
    expect(koppleRollposition({ gekoppelt: true, quelle: 'programm', bruchteil: 0.3 })).toBeNull();
  });

  it('bei ausgeschalteter Kopplung bleibt die andere Spalte unverändert', () => {
    expect(koppleRollposition({ gekoppelt: false, quelle: 'links', bruchteil: 0.3 })).toBeNull();
  });
});
