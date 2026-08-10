import { describe, expect, it } from 'vitest';
import { applyCommand, commandTypen, CommandError } from './commands';
import { emptyState } from './model';
import { addDoc } from './documents';
import {
  erzeugendeCommandTypen, INHALT_OBJEKT_ID, OHNE_OBJEKT_BEZUG, ZIEL_OBJEKT_IDS,
  objektIdFuerCommand, zielObjektIdsFuerCommand,
} from './objektbezug';

/**
 * Wächtertest (Muster: stempel.test.ts): jeder Command-Typ muss MINDESTENS EINER Objekt-
 * Bezugs-Klasse zugeordnet sein — Inhalts-Objekt (Journal-Projektion), Ziel-Objekt
 * (Ebenen-Bearbeitungsprüfung) oder bewusst ohne Objekt-Bezug. Ein neu hinzugefügter
 * Command-Typ, der hier nicht einsortiert wird, würde sonst ungeprüft an Journal-Filter
 * (CR-03) und Ebenen-Guard (CR-04) vorbeilaufen. Inhalt und Ziel überschneiden sich
 * absichtlich (ein mutierender Command trägt Inhalt UND berührt ein Zielobjekt) —
 * disjunkt ist nur OHNE_OBJEKT_BEZUG.
 */
describe('objektbezug: Vollständigkeit gegen commandTypen()', () => {
  const inhalt = new Set(Object.keys(INHALT_OBJEKT_ID));
  const ziel = new Set(Object.keys(ZIEL_OBJEKT_IDS));
  const ohne = new Set(OHNE_OBJEKT_BEZUG);

  it('jeder Command-Typ ist mindestens einer Klasse zugeordnet (Inhalt, Ziel oder ohne Bezug)', () => {
    for (const typ of commandTypen()) {
      const zugeordnet = inhalt.has(typ) || ziel.has(typ) || ohne.has(typ);
      expect(zugeordnet, `Command-Typ "${typ}" ist keiner Objekt-Bezugs-Klasse zugeordnet`).toBe(true);
    }
  });

  it('OHNE_OBJEKT_BEZUG ist disjunkt zu Inhalts- und Ziel-Klasse', () => {
    for (const typ of ohne) {
      expect(inhalt.has(typ), `"${typ}" steht in OHNE_OBJEKT_BEZUG und INHALT_OBJEKT_ID`).toBe(false);
      expect(ziel.has(typ), `"${typ}" steht in OHNE_OBJEKT_BEZUG und ZIEL_OBJEKT_IDS`).toBe(false);
    }
  });

  it('keine Klassifizierung ohne zugehörigen Command-Typ (keine toten Einträge)', () => {
    const bekannte = new Set(commandTypen());
    for (const typ of [...inhalt, ...ziel, ...ohne]) {
      expect(bekannte.has(typ), `"${typ}" ist klassifiziert, aber kein bekannter Command-Typ`).toBe(true);
    }
  });

  it('WR-02: jeder erzeugende Command-Typ (ID-Injektion) hat eine Auflösung in INHALT_OBJEKT_ID — Schreib- und Leseseite bleiben konsistent', () => {
    const bekannte = new Set(commandTypen());
    for (const typ of erzeugendeCommandTypen()) {
      expect(inhalt.has(typ), `Erzeugender Typ "${typ}" fehlt in INHALT_OBJEKT_ID (Journal-Projektion kann die injizierte ID nicht lesen)`).toBe(true);
      expect(bekannte.has(typ), `Erzeugender Typ "${typ}" ist kein bekannter Command-Typ`).toBe(true);
    }
  });

  it('erzeugendeCommandTypen() enthält addVersionLink', () => {
    expect(erzeugendeCommandTypen()).toContain('addVersionLink');
  });
});

describe('13-02: Zonen-Kommandos (Klassifikation gegen die drei Pflicht-Registries)', () => {
  it('addZone ist in erzeugendeCommandTypen() UND über INHALT_OBJEKT_ID als Top-Level-id auflösbar', () => {
    // Offline-Queue-Dedupe (istBereitsAngewendet) und Journal-Auflösung laufen beide über
    // diese beiden Registries — fehlt eine Seite, erzeugt das Offline-Nachspielen Doppelzonen.
    expect(erzeugendeCommandTypen()).toContain('addZone');
    expect(objektIdFuerCommand({
      type: 'addZone',
      payload: { id: 'z1', name: 'Zone', rect: { x: 0, y: 0, w: 10, h: 10 } },
    })).toBe('z1');
  });

  it('renameZone/removeZone stehen in OHNE_OBJEKT_BEZUG (Zonen referenzieren kein geschütztes Fremdobjekt)', () => {
    expect(OHNE_OBJEKT_BEZUG).toContain('renameZone');
    expect(OHNE_OBJEKT_BEZUG).toContain('removeZone');
    // Disjunktions-Wächter oben (Zeile 31-36) deckt ab: weder INHALT_ noch ZIEL_-Eintrag.
    expect(zielObjektIdsFuerCommand({ type: 'removeZone', payload: { id: 'z1' } })).toEqual([]);
  });
});

describe('addVersionLink: Ebenen-Bearbeitungsprüfung und Pflichtfelder (COMP-03, T-09-18)', () => {
  it('zielObjektIdsFuerCommand liefert für addVersionLink genau die beiden Dokument-ids', () => {
    const ids = zielObjektIdsFuerCommand({
      type: 'addVersionLink',
      payload: { olderId: 'doc-alt', newerId: 'doc-neu' },
    });
    expect(ids.sort()).toEqual(['doc-alt', 'doc-neu']);
  });

  it('ein addVersionLink-Command ohne newerId wird mit CommandError abgelehnt', () => {
    let s = emptyState();
    s = addDoc(s, 'f1', 'a.pdf', { x: 0, y: 0 }, 'doc-alt');
    expect(() =>
      applyCommand(s, { type: 'addVersionLink', payload: { olderId: 'doc-alt' } }),
    ).toThrow(CommandError);
  });

  it('ein addVersionLink-Command ohne olderId wird mit CommandError abgelehnt', () => {
    let s = emptyState();
    s = addDoc(s, 'f1', 'b.pdf', { x: 0, y: 0 }, 'doc-neu');
    expect(() =>
      applyCommand(s, { type: 'addVersionLink', payload: { newerId: 'doc-neu' } }),
    ).toThrow(CommandError);
  });
});
