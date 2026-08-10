import { describe, expect, it } from 'vitest';
import {
  SYSTEM_EBENEN, darfEbeneBearbeiten, ensurePrivateLayer, findePrivateEbeneFuer, istObjektSichtbarFuer,
  type ActorContext, type Ebene,
} from './layers';
import { emptyState } from './model';

const eigentuemer: ActorContext = { userId: 'nutzer-a', rolle: 'Eigentümer' };
const bearbeiterFremd: ActorContext = { userId: 'nutzer-b', rolle: 'Bearbeiter' };
const kommentator: ActorContext = { userId: 'nutzer-c', rolle: 'Kommentator' };

describe('SYSTEM_EBENEN', () => {
  it('enthaelt die vier festen Ebenen mit stabilen ids', () => {
    expect(SYSTEM_EBENEN).toHaveLength(4);
    const ids = SYSTEM_EBENEN.map((e) => e.id);
    expect(new Set(ids)).toEqual(new Set(['privat', 'kanzlei', 'ki-vorschlaege', 'exportierbar']));
    const typen = SYSTEM_EBENEN.map((e) => e.typ);
    expect(new Set(typen)).toEqual(new Set(['privat', 'kanzlei', 'ki-vorschlaege', 'exportierbar']));
  });
});

describe('darfEbeneBearbeiten', () => {
  const privatVonA: Ebene = { id: 'privat-a', typ: 'privat', name: 'Privat (A)', ownerUserId: 'nutzer-a' };
  const kanzlei: Ebene = { id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' };
  const kiVorschlaege: Ebene = { id: 'ki-vorschlaege', typ: 'ki-vorschlaege', name: 'KI-Vorschläge' };
  const custom: Ebene = {
    id: 'notizen-yvonne', typ: 'custom', name: 'Notizen von Yvonne',
    createdBy: 'Yvonne', createdAt: '2026-07-21T00:00:00.000Z',
  };

  it('privat: nur der Eigentümer der Ebene darf bearbeiten', () => {
    expect(darfEbeneBearbeiten(privatVonA, eigentuemer)).toBe(true);
    expect(darfEbeneBearbeiten(privatVonA, bearbeiterFremd)).toBe(false);
  });

  it('kanzlei: jede Rolle Bearbeiter-aufwärts darf bearbeiten, andere nicht', () => {
    expect(darfEbeneBearbeiten(kanzlei, eigentuemer)).toBe(true);
    expect(darfEbeneBearbeiten(kanzlei, bearbeiterFremd)).toBe(true);
    expect(darfEbeneBearbeiten(kanzlei, kommentator)).toBe(false);
  });

  it('ki-vorschlaege: nie direkt bearbeitbar (nur via Uebernahme)', () => {
    expect(darfEbeneBearbeiten(kiVorschlaege, eigentuemer)).toBe(false);
    expect(darfEbeneBearbeiten(kiVorschlaege, bearbeiterFremd)).toBe(false);
  });

  it('custom: verhaelt sich wie kanzlei', () => {
    expect(darfEbeneBearbeiten(custom, eigentuemer)).toBe(true);
    expect(darfEbeneBearbeiten(custom, bearbeiterFremd)).toBe(true);
    expect(darfEbeneBearbeiten(custom, kommentator)).toBe(false);
  });
});

describe('istObjektSichtbarFuer', () => {
  const privatVonA: Ebene = { id: 'privat-a', typ: 'privat', name: 'Privat (A)', ownerUserId: 'nutzer-a' };
  const kanzlei: Ebene = { id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' };
  const custom: Ebene = { id: 'notizen-yvonne', typ: 'custom', name: 'Notizen von Yvonne' };
  const exportierbar: Ebene = { id: 'exportierbar', typ: 'exportierbar', name: 'Exportierbar' };

  it('privat-Ebene eines anderen Nutzers ist NICHT sichtbar', () => {
    expect(istObjektSichtbarFuer(privatVonA.id, bearbeiterFremd, [privatVonA])).toBe(false);
  });

  it('eigene privat-Ebene ist sichtbar', () => {
    expect(istObjektSichtbarFuer(privatVonA.id, eigentuemer, [privatVonA])).toBe(true);
  });

  it('kanzlei/custom/exportierbar sind fuer alle sichtbar', () => {
    expect(istObjektSichtbarFuer(kanzlei.id, bearbeiterFremd, [kanzlei])).toBe(true);
    expect(istObjektSichtbarFuer(custom.id, bearbeiterFremd, [custom])).toBe(true);
    expect(istObjektSichtbarFuer(exportierbar.id, bearbeiterFremd, [exportierbar])).toBe(true);
  });

  it('fehlende layerId (undefined) gilt wie kanzlei — sichtbar fuer alle', () => {
    expect(istObjektSichtbarFuer(undefined, bearbeiterFremd)).toBe(true);
    expect(istObjektSichtbarFuer(undefined, kommentator)).toBe(true);
  });
});

describe('benutzerdefinierte Ebene', () => {
  it('traegt createdBy/createdAt (Provenienz) und exportierbar-Flag', () => {
    const custom: Ebene = {
      id: 'notizen-yvonne', typ: 'custom', name: 'Notizen von Yvonne',
      createdBy: 'Yvonne', createdAt: '2026-07-21T00:00:00.000Z', exportierbar: false,
    };
    expect(custom.createdBy).toBe('Yvonne');
    expect(custom.createdAt).toBe('2026-07-21T00:00:00.000Z');
    expect(custom.exportierbar).toBe(false);
  });
});

describe('findePrivateEbeneFuer (02-09)', () => {
  const privatA: Ebene = { id: 'privat-nutzer-a', typ: 'privat', name: 'Privat', ownerUserId: 'nutzer-a' };
  const privatB: Ebene = { id: 'privat-nutzer-b', typ: 'privat', name: 'Privat', ownerUserId: 'nutzer-b' };
  const custom: Ebene = { id: 'custom-1', typ: 'custom', name: 'Notizen' };

  it('findet genau die Instanz mit typ privat und ownerUserId === userId', () => {
    const state = { ...emptyState(), layers: [privatB, custom, privatA] };
    expect(findePrivateEbeneFuer(state, 'nutzer-a')).toBe(privatA);
  });

  it('kein Treffer bei Fremd-Instanz, custom-Ebene oder leerem layers — der SYSTEM_EBENEN-Platzhalter ist nie ein Treffer', () => {
    const state = { ...emptyState(), layers: [privatB, custom] };
    expect(findePrivateEbeneFuer(state, 'nutzer-a')).toBeUndefined();
    expect(findePrivateEbeneFuer(emptyState(), 'nutzer-a')).toBeUndefined();
  });
});

describe('ensurePrivateLayer (02-09: lazy Materialisierung der Pro-Nutzer-Privat-Ebene)', () => {
  it('legt bei Fehlen die Instanz mit deterministischer id an und liefert state + layerId', () => {
    const { state, layerId } = ensurePrivateLayer(emptyState(), 'nutzer-a');
    expect(layerId).toBe('privat-nutzer-a');
    expect(state.layers).toHaveLength(1);
    expect(state.layers![0]).toEqual({ id: 'privat-nutzer-a', typ: 'privat', name: 'Privat', ownerUserId: 'nutzer-a' });
  });

  it('ist idempotent: vorhandene eigene Instanz -> unveraenderter State-Bezug, keine Dublette', () => {
    const erste = ensurePrivateLayer(emptyState(), 'nutzer-a');
    const zweite = ensurePrivateLayer(erste.state, 'nutzer-a');
    expect(zweite.state).toBe(erste.state);
    expect(zweite.layerId).toBe(erste.layerId);
    expect(zweite.state.layers).toHaveLength(1);
  });

  it('fremde Instanzen anderer Nutzer bleiben unangetastet', () => {
    const mitB = ensurePrivateLayer(emptyState(), 'nutzer-b').state;
    const { state, layerId } = ensurePrivateLayer(mitB, 'nutzer-a');
    expect(layerId).toBe('privat-nutzer-a');
    expect(state.layers).toHaveLength(2);
    expect(findePrivateEbeneFuer(state, 'nutzer-b')).toBeDefined();
  });
});
