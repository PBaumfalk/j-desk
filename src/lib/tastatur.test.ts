import { describe, it, expect } from 'vitest';
import { pfeilAktion } from './tastatur';

describe('pfeilAktion (P4, 13-05 Task 1: Modifier-Guard-Pflicht-Korrektur)', () => {
  it('liefert die vier Pan-Aktionen für unmodifizierte Pfeile', () => {
    expect(pfeilAktion({ code: 'ArrowLeft', altKey: false, metaKey: false, ctrlKey: false })).toBe('pan-links');
    expect(pfeilAktion({ code: 'ArrowRight', altKey: false, metaKey: false, ctrlKey: false })).toBe('pan-rechts');
    expect(pfeilAktion({ code: 'ArrowUp', altKey: false, metaKey: false, ctrlKey: false })).toBe('pan-oben');
    expect(pfeilAktion({ code: 'ArrowDown', altKey: false, metaKey: false, ctrlKey: false })).toBe('pan-unten');
  });

  it('⌥← / ⌥→ liefern Verlaufs-Navigation statt Pan', () => {
    expect(pfeilAktion({ code: 'ArrowLeft', altKey: true, metaKey: false, ctrlKey: false })).toBe('verlauf-zurueck');
    expect(pfeilAktion({ code: 'ArrowRight', altKey: true, metaKey: false, ctrlKey: false })).toBe('verlauf-vor');
  });

  it('⌥↑ / ⌥↓ bleiben neutral (kein Bestandsverhalten belegen)', () => {
    expect(pfeilAktion({ code: 'ArrowUp', altKey: true, metaKey: false, ctrlKey: false })).toBeNull();
    expect(pfeilAktion({ code: 'ArrowDown', altKey: true, metaKey: false, ctrlKey: false })).toBeNull();
  });

  it('⌘/Strg+Pfeil sperrt den Guard (weder Pan noch Verlauf) — Doppelfeuer-Kollision geschlossen', () => {
    expect(pfeilAktion({ code: 'ArrowLeft', altKey: false, metaKey: true, ctrlKey: false })).toBeNull();
    expect(pfeilAktion({ code: 'ArrowLeft', altKey: false, metaKey: false, ctrlKey: true })).toBeNull();
    expect(pfeilAktion({ code: 'ArrowRight', altKey: true, metaKey: true, ctrlKey: false })).toBeNull();
    expect(pfeilAktion({ code: 'ArrowUp', altKey: false, metaKey: true, ctrlKey: true })).toBeNull();
  });

  it('liefert null für Nicht-Pfeil-Codes', () => {
    expect(pfeilAktion({ code: 'KeyA', altKey: false, metaKey: false, ctrlKey: false })).toBeNull();
    expect(pfeilAktion({ code: 'Space', altKey: true, metaKey: false, ctrlKey: false })).toBeNull();
  });
});
