import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DIFF_MAX_WOERTER, normalisiereWort, wortDiff } from './diff';

describe('wortDiff — Grundfälle', () => {
  it('liefert für zwei leere Wortlisten ein leeres Ergebnis, keinen Fehler und keinen undefinierten Wert', () => {
    expect(wortDiff([], [])).toEqual({ art: 'verglichen', schritte: [] });
  });

  it('weist bei leerer alter Fassung alle Wörter der neuen Fassung als hinzugefügt aus', () => {
    expect(wortDiff([], ['a', 'b'])).toEqual({
      art: 'verglichen',
      schritte: [
        { art: 'hinzugefuegt', wort: 'a', neuIndex: 0 },
        { art: 'hinzugefuegt', wort: 'b', neuIndex: 1 },
      ],
    });
  });

  it('weist bei leerer neuer Fassung alle Wörter der alten Fassung als entfernt aus', () => {
    expect(wortDiff(['a', 'b'], [])).toEqual({
      art: 'verglichen',
      schritte: [
        { art: 'entfernt', wort: 'a', altIndex: 0 },
        { art: 'entfernt', wort: 'b', altIndex: 1 },
      ],
    });
  });

  it('liefert drei gleiche Schritte für identische Wortlisten, keinen Unterschied', () => {
    expect(wortDiff(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({
      art: 'verglichen',
      schritte: [
        { art: 'gleich', wort: 'a', altIndex: 0, neuIndex: 0 },
        { art: 'gleich', wort: 'b', altIndex: 1, neuIndex: 1 },
        { art: 'gleich', wort: 'c', altIndex: 2, neuIndex: 2 },
      ],
    });
  });
});

describe('wortDiff — Einfügen, Entfernen, Ersetzen', () => {
  it('erzeugt für ein eingefügtes Wort in der Mitte genau einen hinzugefügt-Schritt an der richtigen Stelle; die umgebenden Wörter bleiben gleich', () => {
    const ergebnis = wortDiff(['a', 'b', 'd'], ['a', 'b', 'c', 'd']);
    expect(ergebnis.art).toBe('verglichen');
    if (ergebnis.art !== 'verglichen') throw new Error('unreachable');
    expect(ergebnis.schritte.filter((s) => s.art === 'hinzugefuegt')).toEqual([
      { art: 'hinzugefuegt', wort: 'c', neuIndex: 2 },
    ]);
    expect(ergebnis.schritte.filter((s) => s.art === 'gleich')).toHaveLength(3);
    expect(ergebnis.schritte.filter((s) => s.art === 'entfernt')).toHaveLength(0);
  });

  it('erzeugt für ein entferntes Wort in der Mitte genau einen entfernt-Schritt', () => {
    const ergebnis = wortDiff(['a', 'b', 'c', 'd'], ['a', 'b', 'd']);
    expect(ergebnis.art).toBe('verglichen');
    if (ergebnis.art !== 'verglichen') throw new Error('unreachable');
    expect(ergebnis.schritte.filter((s) => s.art === 'entfernt')).toEqual([
      { art: 'entfernt', wort: 'c', altIndex: 2 },
    ]);
    expect(ergebnis.schritte.filter((s) => s.art === 'gleich')).toHaveLength(3);
    expect(ergebnis.schritte.filter((s) => s.art === 'hinzugefuegt')).toHaveLength(0);
  });

  it('erzeugt für ein ersetztes Wort genau einen entfernt- und einen hinzugefügt-Schritt', () => {
    const ergebnis = wortDiff(['a', 'X', 'c'], ['a', 'Y', 'c']);
    expect(ergebnis.art).toBe('verglichen');
    if (ergebnis.art !== 'verglichen') throw new Error('unreachable');
    expect(ergebnis.schritte.filter((s) => s.art === 'entfernt')).toEqual([
      { art: 'entfernt', wort: 'X', altIndex: 1 },
    ]);
    expect(ergebnis.schritte.filter((s) => s.art === 'hinzugefuegt')).toEqual([
      { art: 'hinzugefuegt', wort: 'Y', neuIndex: 1 },
    ]);
    expect(ergebnis.schritte.filter((s) => s.art === 'gleich')).toHaveLength(2);
  });
});

describe('wortDiff — Index-Vollständigkeit (Rückwärtsverfolgung)', () => {
  it('trägt für jedes Wort der alten Fassung genau einen Schritt mit altIndex und für jedes Wort der neuen Fassung genau einen Schritt mit neuIndex; die Schritte setzen sich zu beiden Ursprungslisten zusammen', () => {
    const alt = ['a', 'b', 'X', 'd', 'e'];
    const neu = ['a', 'Y', 'b', 'd', 'f'];
    const ergebnis = wortDiff(alt, neu);
    expect(ergebnis.art).toBe('verglichen');
    if (ergebnis.art !== 'verglichen') throw new Error('unreachable');

    const altSchritte = ergebnis.schritte.filter((s) => s.altIndex !== undefined);
    const neuSchritte = ergebnis.schritte.filter((s) => s.neuIndex !== undefined);

    // Rekonstruktion: aus den Schritten lässt sich exakt die Eingabeliste zurückgewinnen —
    // deckt einen Off-by-one in der Rückwärtsverfolgung sofort auf.
    const rekonstruiertAlt = [...altSchritte].sort((a, b) => a.altIndex! - b.altIndex!).map((s) => s.wort);
    const rekonstruiertNeu = [...neuSchritte].sort((a, b) => a.neuIndex! - b.neuIndex!).map((s) => s.wort);
    expect(rekonstruiertAlt).toEqual(alt);
    expect(rekonstruiertNeu).toEqual(neu);

    // Jeder Index kommt genau einmal vor — keine Lücke, keine Dopplung.
    expect(
      altSchritte.map((s) => s.altIndex).sort((a, b) => (a as number) - (b as number)),
    ).toEqual(alt.map((_, i) => i));
    expect(
      neuSchritte.map((s) => s.neuIndex).sort((a, b) => (a as number) - (b as number)),
    ).toEqual(neu.map((_, i) => i));
  });
});

describe('normalisiereWort', () => {
  it('zieht Leerraum jeder Art (geschütztes Leerzeichen, Zeilenumbruch, mehrfache Leerzeichen) zu einem einfachen Leerzeichen zusammen und schneidet außen ab', () => {
    expect(normalisiereWort('  Wort mit\n\tLeerraum  ')).toBe('Wort mit Leerraum');
  });

  it('verändert die Groß-/Kleinschreibung nicht', () => {
    expect(normalisiereWort('GROSS klein Gemischt')).toBe('GROSS klein Gemischt');
  });
});

describe('wortDiff — Leerraum-Schreibweise und Groß-/Kleinschreibung', () => {
  it('erzeugt für Wortlisten, die sich nur in Leerraum-Schreibweise unterscheiden, ausschließlich gleiche Schritte', () => {
    const ergebnis = wortDiff(['Vertrag Nr.', ' 123\n'], ['Vertrag Nr.', '123']);
    expect(ergebnis.art).toBe('verglichen');
    if (ergebnis.art !== 'verglichen') throw new Error('unreachable');
    expect(ergebnis.schritte.every((s) => s.art === 'gleich')).toBe(true);
    expect(ergebnis.schritte).toHaveLength(2);
  });

  it('erzeugt für Wortlisten, die sich nur in der Groß-/Kleinschreibung unterscheiden, einen Unterschied', () => {
    const ergebnis = wortDiff(['Kläger'], ['kläger']);
    expect(ergebnis.art).toBe('verglichen');
    if (ergebnis.art !== 'verglichen') throw new Error('unreachable');
    expect(ergebnis.schritte.some((s) => s.art !== 'gleich')).toBe(true);
  });
});

describe('wortDiff — Überlänge', () => {
  it('liefert bei Überschreiten von DIFF_MAX_WOERTER durch die alte Fassung die Variante "zu-lang" mit beiden Wortzahlen, ohne die Tabelle aufzubauen', () => {
    const alt = Array.from({ length: DIFF_MAX_WOERTER + 1 }, (_, i) => `wort${i}`);
    const neu = ['kurz'];
    expect(wortDiff(alt, neu)).toEqual({ art: 'zu-lang', woerterAlt: alt.length, woerterNeu: neu.length });
  });

  it('liefert bei Überschreiten von DIFF_MAX_WOERTER durch die neue Fassung ebenfalls die Variante "zu-lang"', () => {
    const alt = ['kurz'];
    const neu = Array.from({ length: DIFF_MAX_WOERTER + 1 }, (_, i) => `wort${i}`);
    expect(wortDiff(alt, neu)).toEqual({ art: 'zu-lang', woerterAlt: alt.length, woerterNeu: neu.length });
  });
});

describe('wortDiff — nach Normalisierung leeres Wort', () => {
  it('nimmt ein Wort, das nach der Normalisierung leer ist, nicht in den Vergleich auf — es gilt nie als gleich, auch nicht gegenüber einem anderen leeren Wort', () => {
    const alt = ['a', '   ', 'b'];
    const neu = ['a', ' ', 'b'];
    const ergebnis = wortDiff(alt, neu);
    expect(ergebnis.art).toBe('verglichen');
    if (ergebnis.art !== 'verglichen') throw new Error('unreachable');
    const leerraumSchritte = ergebnis.schritte.filter((s) => normalisiereWort(s.wort) === '');
    expect(leerraumSchritte.length).toBeGreaterThan(0);
    expect(leerraumSchritte.every((s) => s.art !== 'gleich')).toBe(true);
    // Index-Vollständigkeit gilt auch hier: jedes Wort behält genau einen Schritt.
    const altSchritte = ergebnis.schritte.filter((s) => s.altIndex !== undefined);
    const neuSchritte = ergebnis.schritte.filter((s) => s.neuIndex !== undefined);
    expect(altSchritte.map((s) => s.altIndex).sort((a, b) => (a as number) - (b as number))).toEqual([0, 1, 2]);
    expect(neuSchritte.map((s) => s.neuIndex).sort((a, b) => (a as number) - (b as number))).toEqual([0, 1, 2]);
  });
});

describe('Quellprüfung: diff.ts ist ein reines Modul', () => {
  const quelle = readFileSync(fileURLToPath(new URL('./diff.ts', import.meta.url)), 'utf-8');

  it('enthält keine import-Zeile außer reinen Typimporten', () => {
    const importZeilen = quelle.split('\n').filter((zeile) => /^\s*import\s/.test(zeile));
    for (const zeile of importZeilen) {
      expect(zeile).toMatch(/^\s*import type\s/);
    }
  });

  it('liest DIFF_MAX_WOERTER als benannte Konstante — die Zahl steht nicht zusätzlich als Literal im Funktionsrumpf von wortDiff', () => {
    const funktionsrumpf = quelle.slice(quelle.indexOf('export function wortDiff'));
    expect(funktionsrumpf).not.toMatch(/\b4000\b/);
    expect(funktionsrumpf).toMatch(/DIFF_MAX_WOERTER/);
  });
});
