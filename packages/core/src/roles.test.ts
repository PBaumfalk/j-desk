import { describe, expect, it } from 'vitest';
import { ALLE_ROLLEN, darfAktion, type GefahrlicheAktion, type Rolle } from './roles';

const GEFAHRLICHE_AKTIONEN: readonly GefahrlicheAktion[] = ['delete', 'shred', 'export', 'upload', 'manage'];

describe('ALLE_ROLLEN', () => {
  it('enthaelt exakt 5 Rollen', () => {
    expect(ALLE_ROLLEN).toHaveLength(5);
  });

  it('enthaelt genau die fünf festgelegten Rollen, keinen sechsten Wert', () => {
    expect(new Set(ALLE_ROLLEN)).toEqual(
      new Set(['Eigentümer', 'Bearbeiter', 'Kommentator', 'Nur-Lesen', 'externer Gast']),
    );
  });
});

describe('darfAktion', () => {
  it('Eigentümer darf jede gefährliche Aktion', () => {
    for (const aktion of GEFAHRLICHE_AKTIONEN) {
      expect(darfAktion('Eigentümer', aktion)).toBe(true);
    }
  });

  it('Bearbeiter darf export/upload/manage', () => {
    expect(darfAktion('Bearbeiter', 'export')).toBe(true);
    expect(darfAktion('Bearbeiter', 'upload')).toBe(true);
    expect(darfAktion('Bearbeiter', 'manage')).toBe(true);
  });

  it('Bearbeiter darf NICHT delete/shred', () => {
    expect(darfAktion('Bearbeiter', 'delete')).toBe(false);
    expect(darfAktion('Bearbeiter', 'shred')).toBe(false);
  });

  it('WR-04: die nicht durchgesetzte mcp-Aktion ist aus der Matrix entfernt (fail-closed false)', () => {
    // 'mcp' ist kein GefahrlicheAktion-Wert mehr — darfAktion muss ihn fail-closed ablehnen,
    // statt eine nicht existierende Schutzwirkung zu suggerieren (02-REVIEW WR-04).
    expect(darfAktion('Eigentümer', 'mcp' as GefahrlicheAktion)).toBe(false);
  });

  it('Kommentator/Nur-Lesen/externer Gast dürfen KEINE gefährliche Aktion', () => {
    const harmlos: readonly Rolle[] = ['Kommentator', 'Nur-Lesen', 'externer Gast'];
    for (const rolle of harmlos) {
      for (const aktion of GEFAHRLICHE_AKTIONEN) {
        expect(darfAktion(rolle, aktion)).toBe(false);
      }
    }
  });

  it('unbekannter Rollen-String liefert fail-closed false', () => {
    expect(darfAktion('Erfinder' as Rolle, 'export')).toBe(false);
  });
});
