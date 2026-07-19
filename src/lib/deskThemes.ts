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

/** Materialschicht(en) über dem Farbverlauf; dezent, damit die Lesbarkeit gewahrt bleibt. */
const MATERIAL_LAYERS: Record<DeskMaterial, string[]> = {
  smooth: [],
  felt: [noise('0.9', 2, 0.28)],           // feines, gleichmäßiges Korn
  leather: [noise('0.28', 4, 0.34)],       // gröbere Narbung
  wood: [noise('0.012 0.16', 4, 0.3)],     // anisotrop: längs gezogene Maserung
  parchment: [noise('0.016', 5, 0.3)],     // großflächige Wolkigkeit
};

/** Vollständiger Hintergrund-Stil (Verlauf + Materialtextur) für Tischfläche und Lupe. */
export function deskCss(bg: DeskBackground): string {
  const [hell, mittel, dunkel] = TONES[bg.themeId];
  const verlauf = `radial-gradient(1200px 800px at 40% 30%, ${hell}, ${mittel} 70%, ${dunkel})`;
  const layers = MATERIAL_LAYERS[bg.material];
  if (layers.length === 0) return `background: ${verlauf};`;
  return (
    `background-image: ${[...layers, verlauf].join(', ')}; ` +
    `background-blend-mode: ${[...layers.map(() => 'soft-light'), 'normal'].join(', ')};`
  );
}

/** Kleine Farbvorschau für die Auswahl im Menü. */
export function themeSwatch(id: DeskThemeId): string {
  const [hell, mittel, dunkel] = TONES[id];
  return `radial-gradient(circle at 35% 30%, ${hell}, ${mittel} 65%, ${dunkel})`;
}
