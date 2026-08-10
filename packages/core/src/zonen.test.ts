import { describe, expect, it } from 'vitest';
import { applyCommand, CommandError } from './commands';
import { emptyState } from './model';
import { addNote } from './notes';
import { addZone, renameZone, removeZone, normalisiereZonenName, ZONEN_NAME_MAX } from './zonen';
import { findeObjekt } from './stempel';
import { erzeugendeCommandTypen, objektIdFuerCommand } from './objektbezug';

/**
 * Zonen-Kern (UX-03, 13-02 Task 1): Zone als referenzfreie, synchronisierte
 * Orientierungsstruktur (U4) — drei Kommandos mit serverseitiger Namens-Normalisierung
 * (Trim + NFC + 40), Provenienz-Stempel und Alt-States-Verträglichkeit.
 */

const META = { createdBy: 'Frau Meier', createdById: 'user-1', createdAt: '2026-08-08T12:00:00.000Z' };
const RECT = { x: 100, y: 50, w: 400, h: 300 };

describe('addZone', () => {
  it('legt eine Zone mit Provenienz-Stempel in state.zones an', () => {
    const s = applyCommand(emptyState(), {
      type: 'addZone',
      payload: { id: 'z1', name: 'Beweiswürdigung', rect: RECT },
    }, META);

    expect(s.zones).toHaveLength(1);
    expect(s.zones![0]).toMatchObject({
      id: 'z1',
      name: 'Beweiswürdigung',
      rect: RECT,
      createdBy: 'Frau Meier',
      createdById: 'user-1',
      createdAt: META.createdAt,
    });
  });

  it('materialisiert die zones-Liste bei einem Alt-State ohne zones-Feld', () => {
    const alt = emptyState();
    expect('zones' in alt).toBe(false); // gewählte Form: Feld weglassen (layers-Muster, s. model.ts)

    const s = addZone(alt, 'Orientierung', RECT, 'z1');
    expect(s.zones).toHaveLength(1);
    expect(s.zones![0].id).toBe('z1');
  });

  it('vergibt eine id, wenn das Payload keine clientvergebene id trägt', () => {
    const s = applyCommand(emptyState(), {
      type: 'addZone',
      payload: { name: 'Ohne Id', rect: RECT },
    }, META);
    expect(s.zones).toHaveLength(1);
    expect(typeof s.zones![0].id).toBe('string');
    expect(s.zones![0].id).not.toBe('');
  });
});

describe('normalisiereZonenName (serverseitig: Trim + NFC + 40)', () => {
  it('kappt auf ZONEN_NAME_MAX = 40 UTF-16-Codeeinheiten (45-Zeichen-Eingabe → 40)', () => {
    expect(ZONEN_NAME_MAX).toBe(40);
    expect(normalisiereZonenName('Z'.repeat(45))).toHaveLength(40);
  });

  it('trimmt führende und nachfolgende Leerzeichen', () => {
    expect(normalisiereZonenName('  Vorlage  ')).toBe('Vorlage');
  });

  it('normalisiert Unicode auf NFC (zerlegte Zeichen werden eins)', () => {
    expect(normalisiereZonenName('Köln')).toBe('Köln');
  });

  it('wird im Kommandopfad angewendet (addZone und renameZone)', () => {
    let s = applyCommand(emptyState(), {
      type: 'addZone',
      payload: { id: 'z1', name: `  ${'A'.repeat(45)}  `, rect: RECT },
    });
    expect(s.zones![0].name).toBe('A'.repeat(40));

    s = applyCommand(s, { type: 'renameZone', payload: { id: 'z1', name: '  Neu  ' } });
    expect(s.zones![0].name).toBe('Neu');
  });
});

describe('Validierung (CommandError mit deutschem Feldnamen)', () => {
  it('addZone mit leerem/normalisiert leerem Namen wirft CommandError („name“)', () => {
    expect(() =>
      applyCommand(emptyState(), { type: 'addZone', payload: { name: '   ', rect: RECT } }),
    ).toThrow(CommandError);
    expect(() =>
      applyCommand(emptyState(), { type: 'addZone', payload: { name: '   ', rect: RECT } }),
    ).toThrow(/Feld "name"/);
  });

  it('addZone mit fehlendem oder ungültigem rect wirft CommandError („rect“)', () => {
    expect(() =>
      applyCommand(emptyState(), { type: 'addZone', payload: { name: 'Zone' } }),
    ).toThrow(/Feld "rect"/);
    expect(() =>
      applyCommand(emptyState(), { type: 'addZone', payload: { name: 'Zone', rect: { x: 0, y: 0, w: 'breit', h: 10 } } }),
    ).toThrow(CommandError);
  });

  it('renameZone/removeZone bei unbekannter Zonen-id werfen CommandError mit deutschem Feldnamen', () => {
    const s = emptyState();
    expect(() => applyCommand(s, { type: 'renameZone', payload: { id: 'gibtsnicht', name: 'Neu' } }))
      .toThrow(CommandError);
    expect(() => applyCommand(s, { type: 'renameZone', payload: { id: 'gibtsnicht', name: 'Neu' } }))
      .toThrow(/Zone "gibtsnicht" nicht gefunden/);
    expect(() => applyCommand(s, { type: 'removeZone', payload: { id: 'gibtsnicht' } }))
      .toThrow(/Zone "gibtsnicht" nicht gefunden/);
  });
});

describe('renameZone / removeZone', () => {
  it('renameZone ändert nur den Namen — rect und Provenienz bleiben unberührt', () => {
    let s = applyCommand(emptyState(), {
      type: 'addZone',
      payload: { id: 'z1', name: 'Alt', rect: RECT },
    }, META);
    s = applyCommand(s, { type: 'renameZone', payload: { id: 'z1', name: 'Neu' } });

    expect(s.zones![0]).toMatchObject({ id: 'z1', name: 'Neu', rect: RECT, createdBy: 'Frau Meier' });
  });

  it('removeZone entfernt die Zone ohne Kaskade — State außerhalb zones bleibt inhaltlich identisch (UX-03/edge)', () => {
    let s = emptyState();
    s = addNote(s, 'notiz', 'Unberührt', { x: 5, y: 5 }, 'n1');
    s = addZone(s, 'Zone A', RECT, 'z1');
    s = addZone(s, 'Zone B', { x: 0, y: 0, w: 10, h: 10 }, 'z2');
    const notizenVorher = s.notes;
    const zoneBVorher = s.zones![1];

    const entfernt = applyCommand(s, { type: 'removeZone', payload: { id: 'z1' } });

    expect(entfernt.zones!.map((z) => z.id)).toEqual(['z2']);
    // Keine Kaskade: die übrigen Listen tragen dieselben Objekte (Referenzidentität).
    expect(entfernt.notes).toBe(notizenVorher);
    expect(entfernt.zones![0]).toBe(zoneBVorher);
  });
});

describe('Alt-States-Verträglichkeit', () => {
  it('ein State ohne zones-Feld bleibt nach beliebigen Kommandos feldlos', () => {
    let s = emptyState();
    expect('zones' in s).toBe(false);

    s = applyCommand(s, {
      type: 'addNote',
      payload: { id: 'n1', kind: 'notiz', text: 'x', position: { x: 0, y: 0 } },
    });
    expect('zones' in s).toBe(false);
    expect(s.zones).toBeUndefined();
  });

  it('renameZone/removeZone wirken direkt (Domänenfunktionen, immutable)', () => {
    let s = addZone(emptyState(), 'Eins', RECT, 'z1');
    s = addZone(s, 'Zwei', RECT, 'z2');
    const vorher = s;

    s = renameZone(s, 'z1', 'Eins Neu');
    expect(vorher.zones![0].name).toBe('Eins'); // Eingabe unverändert (Immutabilität)
    expect(s.zones![0].name).toBe('Eins Neu');
    expect(s.zones![1].name).toBe('Zwei');

    s = removeZone(s, 'z1');
    expect(s.zones!.map((z) => z.id)).toEqual(['z2']);
  });
});

describe('Offline-Dedupe-Querschnitt (T-13-02-04, 13-02 Task 3)', () => {
  it('erzeugendeCommandTypen() enthält addZone — Grundlage der Queue-Dublettenerkennung', () => {
    expect(erzeugendeCommandTypen()).toContain('addZone');
  });

  it('ein zweites addZone mit derselben clientvergebenen id ist am frischen State als bereits angewendet erkennbar', () => {
    // Exakt die Prüfung, die offlineQueue.istBereitsAngewendet beim Nachspielen ausführt:
    // ERZEUGEND-Typ → objektIdFuerCommand → findeObjekt über den frisch geholten State.
    // Eine Offline-Wiederholung desselben addZone erzeugt so weder Fehler noch Doppelzone.
    const cmd = { type: 'addZone', payload: { id: 'z1', name: 'Zone', rect: RECT } };
    const frisch = applyCommand(emptyState(), cmd);

    expect(objektIdFuerCommand(cmd)).toBe('z1');
    const treffer = findeObjekt(frisch, objektIdFuerCommand(cmd)!);
    expect(treffer).toBeDefined();
    expect(treffer?.art).toBe('zones');
  });
});
