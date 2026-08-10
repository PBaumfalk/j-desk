import { describe, it, expect } from 'vitest';
import { ui } from './ui.svelte';
import {
  bewegungGesperrt, sitzungBeendenBeiVollbildwechsel, starteSitzungsmodus, beendeSitzungsmodus,
  kartenBewegungGesperrt, schalteVerschiebeSperre,
} from './sitzungsmodus';

describe('bewegungGesperrt', () => {
  it('ist nur wahr, wenn beide Flags wahr sind', () => {
    expect(bewegungGesperrt(true, true)).toBe(true);
    expect(bewegungGesperrt(true, false)).toBe(false);
    expect(bewegungGesperrt(false, true)).toBe(false);
    expect(bewegungGesperrt(false, false)).toBe(false);
  });
});

describe('sitzungBeendenBeiVollbildwechsel', () => {
  it('ist nur wahr, wenn die Sitzung zuvor im Vollbild lief und es jetzt verlassen wurde', () => {
    expect(sitzungBeendenBeiVollbildwechsel(true, false)).toBe(true);
    expect(sitzungBeendenBeiVollbildwechsel(false, false)).toBe(false);
    expect(sitzungBeendenBeiVollbildwechsel(true, true)).toBe(false);
    expect(sitzungBeendenBeiVollbildwechsel(false, true)).toBe(false);
  });
});

describe('starteSitzungsmodus/beendeSitzungsmodus', () => {
  it('setzt ui.sitzungsmodusAktiv/ui.aktiveSitzungsmappeId, ohne document zu werfen (Fail-open-Pfad, Vitest node)', async () => {
    beendeSitzungsmodus();
    const ergebnis = await starteSitzungsmodus('sm1');
    expect(ergebnis).toBe(true);
    expect(ui.sitzungsmodusAktiv).toBe(true);
    expect(ui.aktiveSitzungsmappeId).toBe('sm1');
  });

  it('ein zweiter Aufruf bei bereits aktiver Sitzung lässt aktiveSitzungsmappeId stehen und liefert false', async () => {
    beendeSitzungsmodus();
    await starteSitzungsmodus('sm1');
    const ergebnis = await starteSitzungsmodus('sm2');
    expect(ergebnis).toBe(false);
    expect(ui.aktiveSitzungsmappeId).toBe('sm1');
  });

  it('beendeSitzungsmodus setzt sitzungsmodusAktiv auf false und aktiveSitzungsmappeId auf null', async () => {
    await starteSitzungsmodus('sm1');
    beendeSitzungsmodus();
    expect(ui.sitzungsmodusAktiv).toBe(false);
    expect(ui.aktiveSitzungsmappeId).toBeNull();
  });
});

describe('kartenBewegungGesperrt/schalteVerschiebeSperre (11-01 Task 2)', () => {
  it('kartenBewegungGesperrt liest ui.sitzungsmodusAktiv/ui.verschiebeSperreAktiv und liefert dasselbe Ergebnis wie bewegungGesperrt', () => {
    for (const sitzungsmodusAktiv of [true, false]) {
      for (const verschiebeSperreAktiv of [true, false]) {
        ui.sitzungsmodusAktiv = sitzungsmodusAktiv;
        ui.verschiebeSperreAktiv = verschiebeSperreAktiv;
        expect(kartenBewegungGesperrt()).toBe(bewegungGesperrt(sitzungsmodusAktiv, verschiebeSperreAktiv));
      }
    }
  });

  it('schalteVerschiebeSperre zweimal aufgerufen stellt den Ausgangswert exakt wieder her (Idempotenz-Paar)', () => {
    ui.verschiebeSperreAktiv = false;
    schalteVerschiebeSperre();
    expect(ui.verschiebeSperreAktiv).toBe(true);
    schalteVerschiebeSperre();
    expect(ui.verschiebeSperreAktiv).toBe(false);
  });

  it('beendeSitzungsmodus setzt ui.verschiebeSperreAktiv zurück, damit eine neue Sitzung nicht mit der Sperre der vorherigen startet', async () => {
    await starteSitzungsmodus('sm1');
    ui.verschiebeSperreAktiv = true;
    beendeSitzungsmodus();
    expect(ui.verschiebeSperreAktiv).toBe(false);
  });
});
