import type { DesktopState } from './model';

/** Farbthemen: dunkle, gedeckte Standardtöne plus zwei helle Oberflächen (Vision Block 2). */
export type DeskThemeId =
  | 'dark_green' | 'bordeaux' | 'navy_blue' | 'anthracite'
  | 'dark_brown' | 'deep_purple' | 'dark_white' | 'ivory';
export const DESK_THEME_IDS: readonly DeskThemeId[] = [
  'dark_green', 'bordeaux', 'navy_blue', 'anthracite',
  'dark_brown', 'deep_purple', 'dark_white', 'ivory',
];

export type DeskMaterial = 'smooth' | 'felt' | 'leather' | 'wood' | 'parchment';
export const DESK_MATERIALS: readonly DeskMaterial[] = ['smooth', 'felt', 'leather', 'wood', 'parchment'];

/** Erscheinungsbild eines Schreibtischs; gehört zum Workspace-Zustand. */
export interface DeskBackground {
  themeId: DeskThemeId;
  material: DeskMaterial;
  /** Helligkeit der Tischfläche, 0.75–1.25 (1 = neutral). */
  brightness: number;
  /** Intensität der Materialstruktur, 0–1 (0.25 = Standard-Look). */
  textureIntensity: number;
  /** Randabdunklung mit Lichtzentrum; aus = gleichmäßige Fläche. */
  vignette: boolean;
}

export const BRIGHTNESS_MIN = 0.75;
export const BRIGHTNESS_MAX = 1.25;

export const DEFAULT_BACKGROUND: DeskBackground = {
  themeId: 'dark_green', material: 'felt', brightness: 1, textureIntensity: 0.25, vignette: true,
};

/** Erscheinungsbild mit Rückfall auf den Standard (Alt-/Teil-States haben nicht alle Felder). */
export function deskBackground(s: DesktopState): DeskBackground {
  return { ...DEFAULT_BACKGROUND, ...s.background };
}

export function setBackground(s: DesktopState, bg: DeskBackground): DesktopState {
  if (!DESK_THEME_IDS.includes(bg.themeId)) throw new Error(`Unbekanntes Farbthema: ${String(bg.themeId)}`);
  if (!DESK_MATERIALS.includes(bg.material)) throw new Error(`Unbekanntes Material: ${String(bg.material)}`);
  if (!Number.isFinite(bg.brightness) || bg.brightness < BRIGHTNESS_MIN || bg.brightness > BRIGHTNESS_MAX) {
    throw new Error(`Helligkeit außerhalb ${BRIGHTNESS_MIN}–${BRIGHTNESS_MAX}: ${String(bg.brightness)}`);
  }
  if (!Number.isFinite(bg.textureIntensity) || bg.textureIntensity < 0 || bg.textureIntensity > 1) {
    throw new Error(`Strukturintensität außerhalb 0–1: ${String(bg.textureIntensity)}`);
  }
  if (typeof bg.vignette !== 'boolean') throw new Error('Feld "vignette" muss true oder false sein');
  return {
    ...s,
    background: {
      themeId: bg.themeId, material: bg.material,
      brightness: bg.brightness, textureIntensity: bg.textureIntensity, vignette: bg.vignette,
    },
  };
}
