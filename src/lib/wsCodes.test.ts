import { describe, it, expect } from 'vitest';
import { accessLossMessage } from './wsCodes';

describe('accessLossMessage', () => {
  it('4001 → Schreibtisch wurde gelöscht', () => {
    expect(accessLossMessage(4001)).toBe('Schreibtisch wurde gelöscht');
  });
  it('4003 → Zugriff wurde entzogen', () => {
    expect(accessLossMessage(4003)).toBe('Zugriff wurde entzogen');
  });
  it('normale Close-Codes → null (Reconnect-Pfad)', () => {
    expect(accessLossMessage(1000)).toBeNull();
    expect(accessLossMessage(1006)).toBeNull();
  });
});
