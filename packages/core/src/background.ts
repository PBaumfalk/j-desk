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
}

export const DEFAULT_BACKGROUND: DeskBackground = { themeId: 'dark_green', material: 'felt' };

/** Erscheinungsbild mit Rückfall auf den Standard (Alt-States haben kein background-Feld). */
export function deskBackground(s: DesktopState): DeskBackground {
  return s.background ?? DEFAULT_BACKGROUND;
}

export function setBackground(s: DesktopState, bg: DeskBackground): DesktopState {
  if (!DESK_THEME_IDS.includes(bg.themeId)) throw new Error(`Unbekanntes Farbthema: ${String(bg.themeId)}`);
  if (!DESK_MATERIALS.includes(bg.material)) throw new Error(`Unbekanntes Material: ${String(bg.material)}`);
  return { ...s, background: { themeId: bg.themeId, material: bg.material } };
}
