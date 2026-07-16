import { describe, it, expect, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  it('ruft die Funktion erst nach Ablauf der Frist und nur einmal auf', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(400, fn);
    d(); d(); d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
