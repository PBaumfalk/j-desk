import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FORMEL_ARTEN,
  ZINS_TAGE_BASIS,
  sumColumnCents,
  parseEuroToCents,
  formatCentsDe,
  dateDiffDays,
  simpleInterestCents,
  recurringPaymentTotalCents,
} from './tableFormulas';

describe('FORMEL_ARTEN', () => {
  it('kennt genau die vier Formelarten aus CALC-01', () => {
    expect(FORMEL_ARTEN).toEqual(['summe', 'datumsdifferenz', 'zinsen', 'wiederkehrende-zahlung']);
  });
});

describe('sumColumnCents', () => {
  it('liefert 0 für eine leere Liste', () => {
    expect(sumColumnCents([])).toBe(0);
  });

  it('summiert eine Liste von Cent-Werten ganzzahlig', () => {
    expect(sumColumnCents([10, 20, 30])).toBe(60);
  });

  it('liefert bei Werten, die als Dezimalzahlen addiert Fließkomma-Drift erzeugen würden, exakt den handgerechneten Cent-Wert', () => {
    // 0.1 + 0.2 in Dezimal-Euro ergäbe in Fließkomma 0.30000000000000004 — als Cent-Ganzzahlen ist die Summe exakt.
    expect(sumColumnCents([10, 20])).toBe(30);
    // Realistischere Forderungsaufstellung mit Werten, die klassisch Fließkomma-Drift erzeugen.
    expect(sumColumnCents([111, 222, 333, 10, 20, 30])).toBe(726);
  });
});

describe('parseEuroToCents', () => {
  it('akzeptiert deutsche Schreibweise mit Tausenderpunkt und Komma', () => {
    expect(parseEuroToCents('1.234,56')).toBe(123456);
  });

  it('akzeptiert punktbasierte Schreibweise', () => {
    expect(parseEuroToCents('1234.56')).toBe(123456);
  });

  it('akzeptiert einen ganzzahligen Euro-Betrag ohne Nachkommastellen', () => {
    expect(parseEuroToCents('12')).toBe(1200);
  });

  it('liefert undefined für leere Eingabe', () => {
    expect(parseEuroToCents('')).toBeUndefined();
  });

  it('liefert undefined für nicht interpretierbare Eingabe', () => {
    expect(parseEuroToCents('abc')).toBeUndefined();
  });

  it('akzeptiert negative Beträge (Gutschriften)', () => {
    expect(parseEuroToCents('-5,00')).toBe(-500);
  });
});

describe('formatCentsDe', () => {
  it('formatiert mit zwei Nachkommastellen, deutschem Komma und Tausendertrennzeichen', () => {
    expect(formatCentsDe(123456)).toBe('1.234,56');
  });

  it('formatiert negative Beträge mit führendem Minus', () => {
    expect(formatCentsDe(-500)).toBe('-5,00');
  });

  it('formatiert 0 als "0,00"', () => {
    expect(formatCentsDe(0)).toBe('0,00');
  });
});

describe('dateDiffDays', () => {
  it('liefert die volle Tageszahl über den mitteleuropäischen Sommerzeitwechsel hinweg', () => {
    // Sommerzeit-Beginn in Deutschland: letzter Sonntag im März — liegt zwischen den beiden Daten.
    expect(dateDiffDays('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('liefert einen negativen Wert, wenn das zweite Datum früher liegt', () => {
    expect(dateDiffDays('2026-04-01', '2026-03-01')).toBe(-31);
  });

  it('liefert 0 für dasselbe Datum', () => {
    expect(dateDiffDays('2026-03-01', '2026-03-01')).toBe(0);
  });

  it('liefert undefined für ein nicht parsbares Datum', () => {
    expect(dateDiffDays('nicht-parsbar', '2026-03-01')).toBeUndefined();
    expect(dateDiffDays('2026-03-01', 'nicht-parsbar')).toBeUndefined();
  });
});

describe('simpleInterestCents', () => {
  it('berechnet 5 Prozent Zinsen auf 1000 Euro für ein volles Jahr (365 Tage)', () => {
    expect(simpleInterestCents(100_000, 5, 365)).toBe(5000);
  });

  it('liefert 0 für null Tage', () => {
    expect(simpleInterestCents(100_000, 5, 0)).toBe(0);
  });

  it('rundet das Endergebnis kaufmännisch (halber Cent rundet von der Null weg)', () => {
    // 100 Cent Kapital * 100% Zinssatz * 1 Tag / 365 Tage = 100/365 = 0,2739... Cent → rundet auf 0.
    expect(simpleInterestCents(100, 100, 1)).toBe(0);
    // 100 Cent Kapital * 182,5% Zinssatz * 1 Tag / 365 Tage = 18250/36500 = exakt 0,5 Cent
    // → rundet von der Null weg auf 1, das negative Pendant auf -1.
    expect(simpleInterestCents(100, 182.5, 1)).toBe(1);
    expect(simpleInterestCents(-100, 182.5, 1)).toBe(-1);
  });

  it('liefert undefined für negative Tage', () => {
    expect(simpleInterestCents(100_000, 5, -1)).toBeUndefined();
  });

  it('liefert undefined für einen nicht endlichen Eingabewert', () => {
    expect(simpleInterestCents(Number.NaN, 5, 365)).toBeUndefined();
  });
});

describe('recurringPaymentTotalCents', () => {
  it('multipliziert Betrag und Anzahl', () => {
    expect(recurringPaymentTotalCents(50_000, 12)).toBe(600_000);
  });

  it('liefert 0 für Anzahl 0', () => {
    expect(recurringPaymentTotalCents(50_000, 0)).toBe(0);
  });

  it('liefert undefined für eine negative Anzahl', () => {
    expect(recurringPaymentTotalCents(50_000, -1)).toBeUndefined();
  });

  it('liefert undefined für eine nicht ganzzahlige Anzahl', () => {
    expect(recurringPaymentTotalCents(50_000, 1.5)).toBeUndefined();
  });
});

describe('ZINS_TAGE_BASIS', () => {
  it('ist als benannte Konstante 365 (taggenau/365, Planner-Festlegung)', () => {
    expect(ZINS_TAGE_BASIS).toBe(365);
  });
});

describe('Quellprüfung: tableFormulas.ts ist ein reines Rechenmodul', () => {
  it('enthält keine import-Zeile außer reinen Typimporten', () => {
    const pfad = fileURLToPath(new URL('./tableFormulas.ts', import.meta.url));
    const quelle = readFileSync(pfad, 'utf-8');
    const importZeilen = quelle.split('\n').filter((zeile) => /^\s*import\s/.test(zeile));
    for (const zeile of importZeilen) {
      expect(zeile).toMatch(/^\s*import type\s/);
    }
  });
});
