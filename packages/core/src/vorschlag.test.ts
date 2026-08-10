import { describe, expect, it } from 'vitest';
import {
  erstelleVorschlag, uebergang, VorschlagStatusError, ZUSAMMENFASSUNG_MAX, type Vorschlag,
} from './vorschlag';

/** Ausstehender Basis-Vorschlag; Felder je Testfall überschreibbar. */
function basisVorschlag(ueberschreibungen: Partial<Vorschlag> = {}): Vorschlag {
  return {
    id: 'v1',
    deskId: 'desk1',
    art: 'addNote',
    payload: { kind: 'notiz', text: 'Fundstelle prüfen', position: { x: 1, y: 2 } },
    quellen: [],
    zusammenfassung: 'Notiz anlegen',
    status: 'ausstehend',
    createdBy: 'ki-agent',
    createdById: 'u-ki',
    createdAt: 1000,
    ...ueberschreibungen,
  };
}

describe('erstelleVorschlag', () => {
  it('setzt status ausstehend, createdAt und den Ersteller-Stempel', () => {
    const v = erstelleVorschlag({
      id: 'v1', deskId: 'd1', art: 'addNote', payload: { text: 't' }, quellen: [],
      zusammenfassung: 'Notiz anlegen', createdBy: 'ki-agent', createdById: 'u-ki',
    }, 1234);

    expect(v.status).toBe('ausstehend');
    expect(v.createdAt).toBe(1234);
    expect(v.createdBy).toBe('ki-agent');
    expect(v.createdById).toBe('u-ki');
    expect(v.id).toBe('v1');
    expect(v.deskId).toBe('d1');
    expect(v.zusammenfassung).toBe('Notiz anlegen');
    expect(v.inverse).toBeUndefined();
    expect(v.genehmigteObjekte).toBeUndefined();
    expect(v.decidedAt).toBeUndefined();
  });

  it('kappt die Zusammenfassung auf 280 Zeichen (längere Eingabe wird nicht gespeichert, kein Wurf)', () => {
    const v = erstelleVorschlag({
      id: 'v1', deskId: 'd1', art: 'addNote', payload: {}, quellen: [],
      zusammenfassung: 'x'.repeat(ZUSAMMENFASSUNG_MAX + 42), createdBy: 'ki-agent',
    }, 1000);

    expect(v.zusammenfassung).toHaveLength(ZUSAMMENFASSUNG_MAX);
  });

  it('übernimmt den idempotenzKey und lässt leere quellen zu', () => {
    const v = erstelleVorschlag({
      id: 'v1', deskId: 'd1', art: 'addNote', payload: {}, zusammenfassung: 's',
      idempotenzKey: 'retry-1', createdBy: 'ki-agent',
    }, 1000);

    expect(v.idempotenzKey).toBe('retry-1');
    expect(v.quellen).toEqual([]);
  });
});

describe('uebergang', () => {
  const genehmiger = { id: 'u-anwalt', name: 'anwalt-a' };

  it('genehmigen auf einen ausstehenden Vorschlag liefert genehmigt samt decidedAt/decidedBy', () => {
    const v = uebergang(basisVorschlag(), 'genehmigen', genehmiger, 2000);

    expect(v.status).toBe('genehmigt');
    expect(v.decidedBy).toBe('anwalt-a');
    expect(v.decidedById).toBe('u-anwalt');
    expect(v.decidedAt).toBe(2000);
  });

  it('ablehnen auf einen ausstehenden Vorschlag liefert abgelehnt samt decidedAt/decidedBy', () => {
    const v = uebergang(basisVorschlag(), 'ablehnen', genehmiger, 2000);

    expect(v.status).toBe('abgelehnt');
    expect(v.decidedBy).toBe('anwalt-a');
    expect(v.decidedById).toBe('u-anwalt');
    expect(v.decidedAt).toBe(2000);
  });

  it('zuruecknehmen auf einen genehmigten Vorschlag liefert zurückgenommen und stempelt den Rücknehmenden neu', () => {
    const genehmigt = uebergang(basisVorschlag(), 'genehmigen', genehmiger, 2000);
    const v = uebergang(genehmigt, 'zuruecknehmen', { id: 'u-b', name: 'anwalt-b' }, 3000);

    expect(v.status).toBe('zurückgenommen');
    expect(v.decidedBy).toBe('anwalt-b');
    expect(v.decidedById).toBe('u-b');
    expect(v.decidedAt).toBe(3000);
  });

  it('wirft VorschlagStatusError bei jedem Übergang aus genehmigt außer zuruecknehmen', () => {
    const genehmigt = basisVorschlag({ status: 'genehmigt', decidedAt: 2000, decidedBy: 'anwalt-a' });

    expect(() => uebergang(genehmigt, 'genehmigen', genehmiger, 3000)).toThrow(VorschlagStatusError);
    expect(() => uebergang(genehmigt, 'ablehnen', genehmiger, 3000)).toThrow(VorschlagStatusError);
  });

  it('wirft VorschlagStatusError bei jedem Übergang aus abgelehnt oder zurückgenommen', () => {
    for (const status of ['abgelehnt', 'zurückgenommen'] as const) {
      const v = basisVorschlag({ status });
      expect(() => uebergang(v, 'genehmigen', genehmiger, 3000)).toThrow(VorschlagStatusError);
      expect(() => uebergang(v, 'ablehnen', genehmiger, 3000)).toThrow(VorschlagStatusError);
      expect(() => uebergang(v, 'zuruecknehmen', genehmiger, 3000)).toThrow(VorschlagStatusError);
    }
  });

  it('nennt Ist-Status und verlangte Aktion in der deutschen Fehlermeldung', () => {
    const genehmigt = basisVorschlag({ status: 'genehmigt' });

    expect(() => uebergang(genehmigt, 'ablehnen', genehmiger, 3000))
      .toThrow(/genehmigt.*ablehnen|ablehnen.*genehmigt/);
  });

  it('ist immutable — der Eingangs-Vorschlag bleibt unverändert', () => {
    const ausgang = basisVorschlag();
    const kopie = { ...ausgang };
    uebergang(ausgang, 'genehmigen', genehmiger, 2000);

    expect(ausgang).toEqual(kopie);
  });
});
