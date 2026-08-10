import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseHours } from './envConfig';

describe('parseHours (WR-02)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('nicht gesetzter Wert liefert den Standardwert, ohne jede Meldung', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseHours('BACKUP_INTERVAL_HOURS', undefined, 6)).toBe(6);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('ein gültiger numerischer String wird als Zahl übernommen', () => {
    expect(parseHours('BACKUP_INTERVAL_HOURS', '12', 6)).toBe(12);
  });

  it('"0" schaltet ab (0 bleibt 0, kein Fallback)', () => {
    expect(parseHours('JDESK_ARCHIVE_INTERVAL_HOURS', '0', 24)).toBe(0);
  });

  it('ein nicht-numerischer Wert (Tippfehler) fällt auf den Standardwert zurück UND wird laut protokolliert', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseHours('BACKUP_INTERVAL_HOURS', '6h', 6)).toBe(6);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('BACKUP_INTERVAL_HOURS');
  });

  it('ein leerer String ist ebenfalls kein gültiger Zahlenwert und fällt mit Meldung zurück', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseHours('JDESK_ARCHIVE_INTERVAL_HOURS', '', 24)).toBe(24);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});
