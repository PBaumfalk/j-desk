import type { DeskBackground, DeskMaterial, DeskThemeId } from '@digital-desktop/core';

export const THEME_LABELS: Record<DeskThemeId, string> = {
  dark_green: 'Dunkelgrün',
  bordeaux: 'Bordeaux',
  navy_blue: 'Nachtblau',
  anthracite: 'Anthrazit',
  dark_brown: 'Dunkelbraun',
  deep_purple: 'Tiefviolett',
  dark_white: 'Altweiß',
  ivory: 'Elfenbein',
};

export const MATERIAL_LABELS: Record<DeskMaterial, string> = {
  smooth: 'Glatt',
  felt: 'Filz',
  leather: 'Leder',
  wood: 'Holz',
  parchment: 'Pergament',
};

/** Drei Töne je Thema: Lichtzentrum, Grundfläche, Randabdunklung (wie der bisherige Verlauf). */
const TONES: Record<DeskThemeId, [string, string, string]> = {
  dark_green: ['#3a5c4e', '#27423a', '#1d332d'],
  bordeaux: ['#6b3843', '#4a232c', '#361a21'],
  navy_blue: ['#35495f', '#233140', '#192431'],
  anthracite: ['#4b4e53', '#34373b', '#26282b'],
  dark_brown: ['#5b4636', '#3f2f24', '#2e211a'],
  deep_purple: ['#4c3a5e', '#352741', '#271c31'],
  dark_white: ['#f1ece1', '#e2dac8', '#cfc5ae'],
  ivory: ['#f6f0de', '#ebe2c9', '#dbd0b2'],
};

/** Helle Oberflächen brauchen stärkere Papier-Kontur (Vision: light_surface_rules). */
export function isLight(id: DeskThemeId): boolean {
  return id === 'dark_white' || id === 'ivory';
}

/** Nahtlos kachelnde SVG-Rausch-Textur als data-URI; alpha steuert die Strukturintensität. */
function noise(baseFrequency: string, octaves: number, alpha: number): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'>` +
    `<filter id='t'><feTurbulence type='fractalNoise' baseFrequency='${baseFrequency}' numOctaves='${octaves}' stitchTiles='stitch'/>` +
    `<feColorMatrix type='saturate' values='0'/>` +
    `<feComponentTransfer><feFuncA type='linear' slope='${alpha}' intercept='0'/></feComponentTransfer></filter>` +
    `<rect width='220' height='220' filter='url(%23t)'/></svg>`;
  return `url("data:image/svg+xml,${svg.replace(/#/g, '%23')}")`;
}

/** Material-Rezepte: Rauschform + Basis-Alpha; das Alpha, das bei Struktur 0.25 gilt. */
const MATERIAL_NOISE: Record<DeskMaterial, { baseFrequency: string; octaves: number; baseAlpha: number } | null> = {
  smooth: null,
  felt: { baseFrequency: '0.9', octaves: 2, baseAlpha: 0.28 },       // feines, gleichmäßiges Korn
  leather: { baseFrequency: '0.28', octaves: 4, baseAlpha: 0.34 },   // gröbere Narbung
  wood: { baseFrequency: '0.012 0.16', octaves: 4, baseAlpha: 0.3 }, // anisotrop: längs gezogene Maserung
  parchment: { baseFrequency: '0.016', octaves: 5, baseAlpha: 0.3 }, // großflächige Wolkigkeit
};

/** Texturschicht des Materials, skaliert mit der Strukturintensität; gedeckelt (Lesbarkeit). */
function materialLayer(material: DeskMaterial, intensity: number): string | null {
  const m = MATERIAL_NOISE[material];
  if (!m || intensity <= 0) return null;
  const alpha = Math.min(0.85, Math.round(m.baseAlpha * (intensity / 0.25) * 100) / 100);
  return noise(m.baseFrequency, m.octaves, alpha);
}

/** Farbton per Kanal skalieren — bewusst kein CSS-filter (würde die Papiere mitfärben). */
function skaliere(hex: string, faktor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const kanal = (v: number) => Math.min(255, Math.max(0, Math.round(v * faktor)));
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(kanal);
  return `#${(((r << 16) | (g << 8) | b) >>> 0).toString(16).padStart(6, '0')}`;
}

/** Vollständiger Hintergrund-Stil (Fläche + Materialtextur) für Tischfläche und Lupe. */
export function deskCss(bg: DeskBackground): string {
  const [hell, mittel, dunkel] = TONES[bg.themeId].map((t) => skaliere(t, bg.brightness));
  const flaeche = bg.vignette
    ? `radial-gradient(1200px 800px at 40% 30%, ${hell}, ${mittel} 70%, ${dunkel})`
    : `linear-gradient(${mittel}, ${mittel})`;
  const layer = materialLayer(bg.material, bg.textureIntensity);
  if (!layer) return `background-image: ${flaeche}; background-blend-mode: normal;`;
  return `background-image: ${layer}, ${flaeche}; background-blend-mode: soft-light, normal;`;
}

/** Kleine Farbvorschau für die Auswahl im Menü. */
export function themeSwatch(id: DeskThemeId): string {
  const [hell, mittel, dunkel] = TONES[id];
  return `radial-gradient(circle at 35% 30%, ${hell}, ${mittel} 65%, ${dunkel})`;
}
