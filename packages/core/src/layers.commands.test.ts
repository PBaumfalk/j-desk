import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { applyCommand, CommandError } from './commands';
import { addDoc } from './documents';

const base = () => addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'id-a');

describe('changeLayerId', () => {
  it('setzt layerId am adressierten Objekt (ueber die passende Objektart hinweg gefunden)', () => {
    const s = applyCommand(base(), { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'privat' } });
    expect(s.docs[0].layerId).toBe('privat');
  });

  it('Zielebene muss existieren (SYSTEM_EBENEN oder state.layers) — sonst CommandError', () => {
    expect(() =>
      applyCommand(base(), { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'nirgendwo' } }),
    ).toThrow(CommandError);
  });

  it('unbekannte objectId wirft CommandError (kein stiller No-Op)', () => {
    expect(() =>
      applyCommand(base(), { type: 'changeLayerId', payload: { objectId: 'unbekannt', layerId: 'privat' } }),
    ).toThrow(CommandError);
  });

  it('gibt neuen State zurueck, Eingabe bleibt unveraendert (Immutabilitaet)', () => {
    const vorher = base();
    const nachher = applyCommand(vorher, { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'privat' } });
    expect(nachher).not.toBe(vorher);
    expect(vorher.docs[0].layerId).toBeUndefined();
  });
});

describe('changeLayerId mit Platzhalter-Aufloesung (02-09: Ziel "privat" + meta.createdById)', () => {
  const meta = { createdBy: 'Nutzer A', createdAt: '2026-07-23T10:00:00.000Z', createdById: 'nutzer-a' };

  it('materialisiert die eigene Privat-Instanz atomar im selben Command (Objekt traegt die Instanz-id, state.layers waechst um genau eine Instanz)', () => {
    const s = applyCommand(base(), { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'privat' } }, meta);
    expect(s.docs[0].layerId).toBe('privat-nutzer-a');
    expect(s.layers).toHaveLength(1);
    expect(s.layers![0]).toEqual({ id: 'privat-nutzer-a', typ: 'privat', name: 'Privat', ownerUserId: 'nutzer-a' });
  });

  it('ist idempotent: das zweite changeLayerId auf "privat" legt KEINE zweite Instanz an', () => {
    const hin = applyCommand(base(), { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'privat' } }, meta);
    const zurueck = applyCommand(hin, { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'kanzlei' } }, meta);
    const wieder = applyCommand(zurueck, { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'privat' } }, meta);
    expect(wieder.docs[0].layerId).toBe('privat-nutzer-a');
    expect(wieder.layers!.filter((e) => e.typ === 'privat' && e.ownerUserId === 'nutzer-a')).toHaveLength(1);
  });

  it('ohne meta.createdById bleibt das dokumentierte Platzhalter-Verhalten (meta-loser Legacy/Test-Pfad)', () => {
    const s = applyCommand(base(), { type: 'changeLayerId', payload: { objectId: 'id-a', layerId: 'privat' } });
    expect(s.docs[0].layerId).toBe('privat');
    expect(s.layers ?? []).toHaveLength(0);
  });
});

describe('addCustomLayer', () => {
  it('fuegt state.layers eine Ebene typ=custom mit Name und generierter id hinzu', () => {
    const s = applyCommand(emptyState(), { type: 'addCustomLayer', payload: { name: 'Notizen von Yvonne' } });
    expect(s.layers).toHaveLength(1);
    expect(s.layers?.[0].typ).toBe('custom');
    expect(s.layers?.[0].name).toBe('Notizen von Yvonne');
    expect(s.layers?.[0].id).toBeTruthy();
  });

  it('setzt createdBy/createdAt aus CommandMeta, NICHT aus dem Payload (Server-Feldhoheit)', () => {
    const meta = { createdBy: 'Anwalt A', createdAt: '2026-07-21T10:00:00.000Z' };
    const s = applyCommand(
      emptyState(),
      { type: 'addCustomLayer', payload: { name: 'Notizen', createdBy: 'Angreifer' } },
      meta,
    );
    expect(s.layers?.[0].createdBy).toBe('Anwalt A');
    expect(s.layers?.[0].createdAt).toBe('2026-07-21T10:00:00.000Z');
  });

  it('Name > 40 Zeichen oder leer wirft CommandError', () => {
    const zuLang = 'x'.repeat(41);
    expect(() =>
      applyCommand(emptyState(), { type: 'addCustomLayer', payload: { name: zuLang } }),
    ).toThrow(CommandError);
    expect(() =>
      applyCommand(emptyState(), { type: 'addCustomLayer', payload: { name: '' } }),
    ).toThrow(CommandError);
  });

  it('exportierbar-Flag der neuen Ebene ist per Payload setzbar (default false)', () => {
    const sDefault = applyCommand(emptyState(), { type: 'addCustomLayer', payload: { name: 'Notizen' } });
    expect(sDefault.layers?.[0].exportierbar).toBe(false);

    const sExport = applyCommand(emptyState(), {
      type: 'addCustomLayer', payload: { name: 'Notizen', exportierbar: true },
    });
    expect(sExport.layers?.[0].exportierbar).toBe(true);
  });
});

describe('setLayerExportierbar (02-07: Sichtbarkeits-Panel Exportfreigabe-Checkbox)', () => {
  it('setzt/loescht das exportierbar-Flag einer benutzerdefinierten Kanzlei-Ebene', () => {
    const angelegt = applyCommand(emptyState(), { type: 'addCustomLayer', payload: { name: 'Notizen' } });
    const layerId = angelegt.layers![0].id;

    const an = applyCommand(angelegt, { type: 'setLayerExportierbar', payload: { layerId, exportierbar: true } });
    expect(an.layers?.[0].exportierbar).toBe(true);

    const aus = applyCommand(an, { type: 'setLayerExportierbar', payload: { layerId, exportierbar: false } });
    expect(aus.layers?.[0].exportierbar).toBe(false);
  });

  it('Systemebenen (kanzlei/privat/ki-vorschlaege/exportierbar) leben nicht in state.layers und sind daher nicht änderbar — CommandError statt stillem No-Op', () => {
    expect(() =>
      applyCommand(emptyState(), { type: 'setLayerExportierbar', payload: { layerId: 'kanzlei', exportierbar: true } }),
    ).toThrow(CommandError);
  });

  it('unbekannte layerId wirft CommandError', () => {
    expect(() =>
      applyCommand(emptyState(), { type: 'setLayerExportierbar', payload: { layerId: 'nirgendwo', exportierbar: true } }),
    ).toThrow(CommandError);
  });

  it('gibt neuen State zurueck, Eingabe bleibt unveraendert (Immutabilitaet)', () => {
    const angelegt = applyCommand(emptyState(), { type: 'addCustomLayer', payload: { name: 'Notizen' } });
    const layerId = angelegt.layers![0].id;
    const nachher = applyCommand(angelegt, { type: 'setLayerExportierbar', payload: { layerId, exportierbar: true } });
    expect(nachher).not.toBe(angelegt);
    expect(angelegt.layers?.[0].exportierbar).toBe(false);
  });
});

describe('setLayerExportierbar mit Platzhalter-Aufloesung (WR-01: Ziel "privat" + meta.createdById)', () => {
  const meta = { createdBy: 'Nutzer A', createdAt: '2026-07-23T10:00:00.000Z', createdById: 'nutzer-a' };

  it('loest "privat" auf die eigene Instanz auf und materialisiert sie lazy — NIEMALS auf die SYSTEM-Platzhalter-Ebene', () => {
    const s = applyCommand(emptyState(), { type: 'setLayerExportierbar', payload: { layerId: 'privat', exportierbar: true } }, meta);
    expect(s.layers).toHaveLength(1);
    expect(s.layers![0]).toEqual({
      id: 'privat-nutzer-a', typ: 'privat', name: 'Privat', ownerUserId: 'nutzer-a', exportierbar: true,
    });
  });

  it('wirkt auf eine bereits vorhandene eigene Instanz (kein Duplikat, Flag wird umgesetzt)', () => {
    const an = applyCommand(emptyState(), { type: 'setLayerExportierbar', payload: { layerId: 'privat', exportierbar: true } }, meta);
    const aus = applyCommand(an, { type: 'setLayerExportierbar', payload: { layerId: 'privat', exportierbar: false } }, meta);
    expect(aus.layers!.filter((e) => e.typ === 'privat' && e.ownerUserId === 'nutzer-a')).toHaveLength(1);
    expect(aus.layers![0].exportierbar).toBe(false);
  });

  it('ohne meta.createdById bleibt der dokumentierte Legacy-Pfad: "privat" ist nicht aenderbar (CommandError)', () => {
    expect(() =>
      applyCommand(emptyState(), { type: 'setLayerExportierbar', payload: { layerId: 'privat', exportierbar: true } }),
    ).toThrow(CommandError);
  });
});
