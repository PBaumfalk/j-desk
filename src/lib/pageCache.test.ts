import { describe, it, expect } from 'vitest';
import { pageCacheKey, PageBitmapCache } from './pageCache';

describe('pageCacheKey', () => {
  it('unterscheidet fileId, Seite und Zielbreite', () => {
    expect(pageCacheKey('f', 1, 560)).toBe('f:1:560');
    expect(pageCacheKey('f', 1, 560)).not.toBe(pageCacheKey('f', 2, 560));
    expect(pageCacheKey('f', 1, 560)).not.toBe(pageCacheKey('f', 1, 800));
  });
});

describe('PageBitmapCache', () => {
  it('verdrängt den zuerst eingefügten Eintrag über der Obergrenze', () => {
    const c = new PageBitmapCache(2);
    const a = {} as ImageBitmap, b = {} as ImageBitmap, d = {} as ImageBitmap;
    c.set('a', a); c.set('b', b); c.set('d', d); // Obergrenze 2 → 'a' fliegt raus
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(b);
    expect(c.get('d')).toBe(d);
  });
});
