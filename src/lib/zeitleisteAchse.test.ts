import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ZeitleistenEintrag } from '@j-desk/core';
import { achsenSpanne, achsenTicks, markerPositionen } from './zeitleisteAchse';

function eintrag(id: string, datum: string, extra: Partial<ZeitleistenEintrag> = {}): ZeitleistenEintrag {
  return { id, objRef: 'obj', art: 'ereignis', zeitangabe: 'genau', datum, ...extra };
}

function tage(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 86_400_000);
}

describe('achsenSpanne (09-05-PLAN.md Task 1)', () => {
  it('liefert bei einer leeren Liste eine Standardspanne um heute statt einer Spanne der Länge null', () => {
    const spanne = achsenSpanne([]);
    expect(tage(spanne.bis)).toBeGreaterThan(tage(spanne.von));
    const heute = Math.floor(Date.now() / 86_400_000);
    expect(tage(spanne.von)).toBeLessThanOrEqual(heute);
    expect(tage(spanne.bis)).toBeGreaterThanOrEqual(heute);
  });

  it('liefert bei einem einzelnen Eintrag eine Spanne mit sichtbarer Breite um dieses Datum', () => {
    const spanne = achsenSpanne([eintrag('e1', '2024-06-15')]);
    expect(tage(spanne.von)).toBeLessThan(tage('2024-06-15'));
    expect(tage(spanne.bis)).toBeGreaterThan(tage('2024-06-15'));
    expect(tage(spanne.bis) - tage(spanne.von)).toBeGreaterThan(7);
  });

  it('berücksichtigt bei Zeitraum-Einträgen auch das Enddatum', () => {
    const spanne = achsenSpanne([
      eintrag('e1', '2024-01-01'),
      eintrag('e2', '2024-01-05', { zeitangabe: 'zeitraum', datumBis: '2024-06-01' }),
    ]);
    expect(tage(spanne.bis)).toBeGreaterThanOrEqual(tage('2024-06-01'));
  });

  it('fügt links und rechts einen Rand hinzu, sodass ein Marker am Rand nicht abgeschnitten wird', () => {
    const spanne = achsenSpanne([eintrag('e1', '2024-06-01'), eintrag('e2', '2024-06-30')]);
    expect(tage(spanne.von)).toBeLessThan(tage('2024-06-01'));
    expect(tage(spanne.bis)).toBeGreaterThan(tage('2024-06-30'));
  });
});

describe('achsenTicks (09-05-PLAN.md Task 1)', () => {
  it('liefert bei einer Spanne von wenigen Monaten Monatsmarken', () => {
    const spanne = { von: '2024-01-01', bis: '2024-04-01' };
    const ticks = achsenTicks(spanne, 2000);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.art === 'monat')).toBe(true);
  });

  it('liefert bei einer Spanne von vielen Jahren Jahresmarken', () => {
    const spanne = { von: '2000-01-01', bis: '2024-01-01' };
    const ticks = achsenTicks(spanne, 2000);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.art === 'jahr')).toBe(true);
  });

  it('liefert nie mehr Marken, als bei der übergebenen Breite lesbar sind', () => {
    const spanne = { von: '1900-01-01', bis: '2024-01-01' };
    const breitePx = 120;
    const ticks = achsenTicks(spanne, breitePx);
    const maxMarken = Math.floor(breitePx / 48);
    expect(ticks.length).toBeLessThanOrEqual(Math.max(1, maxMarken));
  });
});

describe('markerPositionen (09-05-PLAN.md Task 1)', () => {
  const spanne = { von: '2024-01-01', bis: '2024-01-31' }; // 30 Tage, 10px/Tag bei 300px
  const breitePx = 300;
  const markerBreitePx = 20;

  it('bildet ein Datum am Spannenanfang auf x gleich null ab und ein Datum am Spannenende auf die volle Breite', () => {
    const positionen = markerPositionen(
      [eintrag('e1', '2024-01-01'), eintrag('e2', '2024-01-31')],
      spanne,
      breitePx,
      markerBreitePx,
    );
    expect(positionen.find((p) => p.eintragId === 'e1')?.x).toBe(0);
    expect(positionen.find((p) => p.eintragId === 'e2')?.x).toBe(breitePx);
  });

  it('liefert für einen Zeitraum-Eintrag Start- und Endposition', () => {
    const positionen = markerPositionen(
      [eintrag('e1', '2024-01-10', { zeitangabe: 'zeitraum', datumBis: '2024-01-20' })],
      spanne,
      breitePx,
      markerBreitePx,
    );
    const p = positionen.find((x) => x.eintragId === 'e1');
    expect(p?.xBis).toBeDefined();
    expect(p!.xBis!).toBeGreaterThan(p!.x);
  });

  it('gibt zwei Einträgen, deren Marker sich bei der gegebenen Breite überlappen würden, unterschiedliche Reihen', () => {
    const positionen = markerPositionen(
      [eintrag('e1', '2024-01-05'), eintrag('e2', '2024-01-05')],
      spanne,
      breitePx,
      markerBreitePx,
    );
    const r1 = positionen.find((p) => p.eintragId === 'e1')?.reihe;
    const r2 = positionen.find((p) => p.eintragId === 'e2')?.reihe;
    expect(r1).not.toBe(r2);
  });

  it('belegt mit drei überlappenden Einträgen drei Reihen; ein vierter, weit entfernter Eintrag steht wieder in Reihe null (Quellprüfung aller vier Reihennummern einzeln)', () => {
    const positionen = markerPositionen(
      [
        eintrag('e1', '2024-01-05'),
        eintrag('e2', '2024-01-05'),
        eintrag('e3', '2024-01-06'),
        eintrag('e4', '2024-01-25'),
      ],
      spanne,
      breitePx,
      markerBreitePx,
    );
    expect(positionen.find((p) => p.eintragId === 'e1')?.reihe).toBe(0);
    expect(positionen.find((p) => p.eintragId === 'e2')?.reihe).toBe(1);
    expect(positionen.find((p) => p.eintragId === 'e3')?.reihe).toBe(2);
    expect(positionen.find((p) => p.eintragId === 'e4')?.reihe).toBe(0);
  });

  it('ist deterministisch: dieselbe Eingabe liefert dieselbe Ausgabe (feldweiser Vergleich zweier Aufrufe)', () => {
    const eintraege = [eintrag('e1', '2024-01-05'), eintrag('e2', '2024-01-05'), eintrag('e3', '2024-01-20')];
    const erster = markerPositionen(eintraege, spanne, breitePx, markerBreitePx);
    const zweiter = markerPositionen(eintraege, spanne, breitePx, markerBreitePx);
    expect(zweiter).toEqual(erster);
    for (let i = 0; i < erster.length; i++) {
      expect(zweiter[i].eintragId).toBe(erster[i].eintragId);
      expect(zweiter[i].x).toBe(erster[i].x);
      expect(zweiter[i].xBis).toBe(erster[i].xBis);
      expect(zweiter[i].reihe).toBe(erster[i].reihe);
    }
  });

  it('überspringt einen Eintrag mit ungültigem Datum statt eine Ausnahme auszulösen', () => {
    expect(() => {
      const positionen = markerPositionen(
        [eintrag('e1', '2024-01-05'), eintrag('e2', 'kein-datum')],
        spanne,
        breitePx,
        markerBreitePx,
      );
      expect(positionen.find((p) => p.eintragId === 'e1')).toBeDefined();
      expect(positionen.find((p) => p.eintragId === 'e2')).toBeUndefined();
    }).not.toThrow();
  });
});

describe('Quellprüfung: zeitleisteAchse.ts bleibt ein reines Modul (09-05-PLAN.md Task 1)', () => {
  it('importiert ausschließlich Typen aus @j-desk/core und nichts aus svelte', () => {
    const hier = fileURLToPath(new URL('./zeitleisteAchse.ts', import.meta.url));
    const quelltext = readFileSync(hier, 'utf-8');
    expect(quelltext).not.toMatch(/from ['"]svelte/);
    expect(quelltext).toMatch(/import type \{[^}]*\} from '@j-desk\/core';/);
  });
});
