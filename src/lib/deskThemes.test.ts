import { describe, expect, it } from 'vitest';
import type { DeskBackground } from '@digital-desktop/core';
import { deskCss } from './deskThemes';

const basis: DeskBackground = {
  themeId: 'dark_green', material: 'felt', brightness: 1, textureIntensity: 0.25, vignette: true,
};

describe('deskCss', () => {
  it('Helligkeit 1 reproduziert die Originaltöne', () => {
    const css = deskCss(basis);
    expect(css).toContain('#3a5c4e');
    expect(css).toContain('radial-gradient');
  });

  it('Helligkeit skaliert die Töne (0.75 → dunkler, exakt gerechnet)', () => {
    const css = deskCss({ ...basis, brightness: 0.75 });
    expect(css).not.toContain('#3a5c4e');
    expect(css).toContain('#2c453b'); // 0x3a·0.75=44, 0x5c·0.75=69, 0x4e·0.75≈59
  });

  it('Struktur 0.25 nutzt das Basis-Alpha des Materials, 1 wird gedeckelt, 0 entfernt die Textur', () => {
    expect(deskCss(basis)).toContain("slope='0.28'");
    expect(deskCss({ ...basis, textureIntensity: 1 })).toContain("slope='0.85'");
    expect(deskCss({ ...basis, textureIntensity: 0 })).not.toContain('url(');
  });

  it('smooth bleibt in jeder Intensität texturlos', () => {
    expect(deskCss({ ...basis, material: 'smooth', textureIntensity: 1 })).not.toContain('url(');
  });

  it('Vignette aus ergibt eine gleichmäßige Fläche im Mittelton', () => {
    const css = deskCss({ ...basis, vignette: false });
    expect(css).not.toContain('radial-gradient');
    expect(css).toContain('linear-gradient(#27423a, #27423a)');
  });

  it('unbekanntes Thema fällt auf dark_green zurück statt zu werfen', () => {
    const css = deskCss({ ...basis, themeId: 'neon_pink' as never });
    expect(css).toContain('#3a5c4e');
  });
});
