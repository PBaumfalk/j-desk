import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anderePersonen, bearbeitetJetzt, deutePraesenzNachricht, personFuerObjekt, praesenz, RENEW_INTERVAL_MS,
  ruhtJetzt, setzePraesenzZurueck, setzeSender, uebernimmPraesenz,
} from './presence.svelte';

beforeEach(() => setzePraesenzZurueck());
afterEach(() => setzeSender(null));

describe('deutePraesenzNachricht', () => {
  it('liefert ein Array mit einem Eintrag für eine gültige Präsenzmeldung', () => {
    const result = deutePraesenzNachricht({ typ: 'praesenz', personen: [{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }] });
    expect(result).toEqual([{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }]);
  });

  it('liefert null, wenn personen kein Array ist (kaputte Form)', () => {
    expect(deutePraesenzNachricht({ typ: 'praesenz', personen: 'kaputt' })).toBeNull();
  });

  it('liefert null für eine {rev, state}-Nachricht (Bestandsformat)', () => {
    expect(deutePraesenzNachricht({ rev: 5, state: {} })).toBeNull();
  });

  it('liefert null für null', () => {
    expect(deutePraesenzNachricht(null)).toBeNull();
  });

  it('liefert null für einen reinen Textwert', () => {
    expect(deutePraesenzNachricht('text')).toBeNull();
  });

  it('überspringt ungültige Einzeleinträge statt die ganze Nachricht zu verwerfen', () => {
    const result = deutePraesenzNachricht({
      typ: 'praesenz',
      personen: [{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }, { userId: 42 }, 'kaputt'],
    });
    expect(result).toEqual([{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }]);
  });
});

describe('uebernimmPraesenz', () => {
  it('liefert true und aktualisiert praesenz.personen bei gültiger Präsenzmeldung', () => {
    const ok = uebernimmPraesenz({ typ: 'praesenz', personen: [{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }] });
    expect(ok).toBe(true);
    expect(praesenz.personen).toEqual([{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }]);
  });

  it('liefert false und lässt praesenz.personen unverändert bei einer {rev, state}-Nachricht', () => {
    uebernimmPraesenz({ typ: 'praesenz', personen: [{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }] });
    const ok = uebernimmPraesenz({ rev: 5, state: {} });
    expect(ok).toBe(false);
    expect(praesenz.personen).toEqual([{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }]);
  });
});

describe('anderePersonen', () => {
  it('schließt den Eintrag mit userId === eigeneUserId aus', () => {
    uebernimmPraesenz({
      typ: 'praesenz',
      personen: [
        { userId: 'u1', name: 'Ich', rolle: 'Bearbeiter' },
        { userId: 'u2', name: 'Andere', rolle: 'Kommentator' },
      ],
    });
    expect(anderePersonen('u1')).toEqual([{ userId: 'u2', name: 'Andere', rolle: 'Kommentator' }]);
  });
});

describe('personFuerObjekt', () => {
  it('liefert die fremde Person, die dieses Objekt bearbeitet', () => {
    uebernimmPraesenz({
      typ: 'praesenz',
      personen: [{ userId: 'u2', name: 'Andere', rolle: 'Bearbeiter', objektId: 'note-1' }],
    });
    expect(personFuerObjekt('note-1', 'u1')).toEqual({ userId: 'u2', name: 'Andere', rolle: 'Bearbeiter', objektId: 'note-1' });
  });

  it('liefert undefined, wenn nur die eigene Person das Objekt bearbeitet', () => {
    uebernimmPraesenz({
      typ: 'praesenz',
      personen: [{ userId: 'u1', name: 'Ich', rolle: 'Bearbeiter', objektId: 'note-1' }],
    });
    expect(personFuerObjekt('note-1', 'u1')).toBeUndefined();
  });
});

describe('setzePraesenzZurueck', () => {
  it('leert praesenz.personen', () => {
    uebernimmPraesenz({ typ: 'praesenz', personen: [{ userId: 'u1', name: 'A', rolle: 'Bearbeiter' }] });
    setzePraesenzZurueck();
    expect(praesenz.personen).toEqual([]);
  });

  it('stoppt eine laufende Erneuerung', () => {
    vi.useFakeTimers();
    const sende = vi.fn();
    setzeSender(sende);
    bearbeitetJetzt('note-1');
    sende.mockClear();
    setzePraesenzZurueck();
    vi.advanceTimersByTime(RENEW_INTERVAL_MS * 2);
    expect(sende).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('bearbeitetJetzt/ruhtJetzt (Senden und Erneuern)', () => {
  it('sendet über den injizierten Sender genau einmal {typ:"bearbeitet", objektId}', () => {
    const sende = vi.fn();
    setzeSender(sende);
    bearbeitetJetzt('note-1');
    expect(sende).toHaveBeenCalledTimes(1);
    expect(sende).toHaveBeenCalledWith({ typ: 'bearbeitet', objektId: 'note-1' });
  });

  it('erneuert dieselbe Nachricht nach RENEW_INTERVAL_MS, ohne dass bearbeitetJetzt erneut aufgerufen wurde', () => {
    vi.useFakeTimers();
    const sende = vi.fn();
    setzeSender(sende);
    bearbeitetJetzt('note-1');
    sende.mockClear();
    vi.advanceTimersByTime(RENEW_INTERVAL_MS);
    expect(sende).toHaveBeenCalledTimes(1);
    expect(sende).toHaveBeenCalledWith({ typ: 'bearbeitet', objektId: 'note-1' });
    vi.useRealTimers();
  });

  it('erneuert nach einem Objektwechsel nur noch das neue Objekt — nie zwei parallele Erneuerungen', () => {
    vi.useFakeTimers();
    const sende = vi.fn();
    setzeSender(sende);
    bearbeitetJetzt('note-1');
    bearbeitetJetzt('note-2');
    sende.mockClear();
    vi.advanceTimersByTime(RENEW_INTERVAL_MS);
    expect(sende).toHaveBeenCalledTimes(1);
    expect(sende).toHaveBeenCalledWith({ typ: 'bearbeitet', objektId: 'note-2' });
    vi.useRealTimers();
  });

  it('ruhtJetzt sendet {typ:"ruht"} und stoppt die Erneuerung', () => {
    vi.useFakeTimers();
    const sende = vi.fn();
    setzeSender(sende);
    bearbeitetJetzt('note-1');
    sende.mockClear();
    ruhtJetzt();
    expect(sende).toHaveBeenCalledTimes(1);
    expect(sende).toHaveBeenCalledWith({ typ: 'ruht' });
    sende.mockClear();
    vi.advanceTimersByTime(RENEW_INTERVAL_MS * 2);
    expect(sende).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('löst ohne gesetzten Sender keine Ausnahme aus und sendet nichts', () => {
    setzeSender(null);
    expect(() => bearbeitetJetzt('note-1')).not.toThrow();
    expect(() => ruhtJetzt()).not.toThrow();
  });
});
