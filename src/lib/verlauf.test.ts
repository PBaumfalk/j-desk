import { describe, it, expect } from 'vitest';
import { aufzeichnen, zurueck, vor, labelFuer, VERLAUF_MAX, type VerlaufEintrag, type VerlaufState } from './verlauf';
import type { Viewport } from '@j-desk/core';

function vp(n: number): Viewport {
  return { x: n, y: n, scale: 1 };
}

function eintrag(n: number): VerlaufEintrag {
  return { vp: vp(n), ausloeser: 'minikarte', label: 'Minikarte-Sprung' };
}

const leer: VerlaufState = { eintraege: [], zeiger: 0 };

describe('aufzeichnen (P4, 13-05 Task 1: Positions-Verlauf-Ringpuffer)', () => {
  it('hängt einen Eintrag an und rückt den Zeiger auf die neue Position', () => {
    const v1 = aufzeichnen(leer, eintrag(1));
    expect(v1.eintraege).toEqual([eintrag(1)]);
    expect(v1.zeiger).toBe(0);

    const v2 = aufzeichnen(v1, eintrag(2));
    expect(v2.eintraege).toEqual([eintrag(1), eintrag(2)]);
    expect(v2.zeiger).toBe(1);
  });

  it('kappt den Ringpuffer bei 20 Einträgen — der 21. verdrängt den ältesten', () => {
    let v: VerlaufState = leer;
    for (let i = 0; i < VERLAUF_MAX; i++) v = aufzeichnen(v, eintrag(i));
    expect(v.eintraege).toHaveLength(VERLAUF_MAX);
    expect(v.eintraege[0]).toEqual(eintrag(0));

    v = aufzeichnen(v, eintrag(VERLAUF_MAX)); // 21. Eintrag
    expect(v.eintraege).toHaveLength(VERLAUF_MAX);
    expect(v.eintraege[0]).toEqual(eintrag(1)); // der älteste (0) ist verdrängt
    expect(v.eintraege[v.eintraege.length - 1]).toEqual(eintrag(VERLAUF_MAX));
    expect(v.zeiger).toBe(VERLAUF_MAX - 1);
  });

  it('ist immutable — die Eingabe bleibt unverändert', () => {
    const v1 = aufzeichnen(leer, eintrag(1));
    expect(leer.eintraege).toEqual([]);
    aufzeichnen(v1, eintrag(2));
    expect(v1.eintraege).toEqual([eintrag(1)]);
  });
});

describe('zurueck/vor (P4, 13-05 Task 1: Zeiger-Navigation)', () => {
  it('bewegen den Zeiger innerhalb der Grenzen', () => {
    let v = aufzeichnen(leer, eintrag(1));
    v = aufzeichnen(v, eintrag(2));
    v = aufzeichnen(v, eintrag(3)); // zeiger=2, eintraege=[1,2,3]

    const b1 = zurueck(v);
    expect(b1.zeiger).toBe(1);
    const b2 = zurueck(b1);
    expect(b2.zeiger).toBe(0);

    const f1 = vor(b2);
    expect(f1.zeiger).toBe(1);
    const f2 = vor(f1);
    expect(f2.zeiger).toBe(2);
  });

  it('sind am Anfang/Ende No-Op statt außerhalb der Grenzen zu laufen', () => {
    let v = aufzeichnen(leer, eintrag(1));
    v = aufzeichnen(v, eintrag(2)); // zeiger=1

    const amEnde = vor(v); // schon am letzten Eintrag
    expect(amEnde).toEqual(v);

    const amAnfang = zurueck(zurueck(v)); // zweimal zurück von zeiger=1 -> 0 -> No-Op
    expect(amAnfang.zeiger).toBe(0);
    expect(zurueck(amAnfang)).toEqual(amAnfang);
  });

  it('leerer Verlauf: zurueck/vor sind No-Op (keine Absturz-Gefahr)', () => {
    expect(zurueck(leer)).toEqual(leer);
    expect(vor(leer)).toEqual(leer);
  });

  it('ein neuer Eintrag nach einem Zurück-Schritt verwirft die Vorwärts-Zukunft (Standard-Verlaufssemantik)', () => {
    let v = aufzeichnen(leer, eintrag(1));
    v = aufzeichnen(v, eintrag(2));
    v = aufzeichnen(v, eintrag(3)); // eintraege=[1,2,3], zeiger=2

    const zurueckgegangen = zurueck(v); // zeiger=1 (bei eintrag 2)
    const neu = aufzeichnen(zurueckgegangen, eintrag(9));

    expect(neu.eintraege).toEqual([eintrag(1), eintrag(2), eintrag(9)]);
    expect(neu.zeiger).toBe(2);
  });
});

describe('labelFuer (P4, 13-05 Task 1: Copywriting Contract, vier Auslöser-Formen)', () => {
  it('formt die Fundstellen-Form', () => {
    expect(labelFuer({ ausloeser: 'fundstelle', dokument: 'Klageschrift.pdf', seite: 3 })).toBe('Fundstelle: Klageschrift.pdf, Seite 3');
  });

  it('formt die Ansicht-Form', () => {
    expect(labelFuer({ ausloeser: 'ansicht', name: 'Beweismittel-Übersicht' })).toBe('Ansicht: Beweismittel-Übersicht');
  });

  it('formt die Zone-Form', () => {
    expect(labelFuer({ ausloeser: 'zone', name: 'Anlagenkonvolut' })).toBe('Zone: Anlagenkonvolut');
  });

  it('formt die Minikarte-Sprung-Form (keine Parameter)', () => {
    expect(labelFuer({ ausloeser: 'minikarte' })).toBe('Minikarte-Sprung');
  });
});
