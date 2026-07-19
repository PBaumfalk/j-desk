# Gestaltungsrunde Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schreibtisch-Erscheinungsbild voll nach Vision Block 2 — der begonnene Stand (Farbe + Material) wird committet und um Helligkeit, Strukturintensität und Vignette samt Regler-UI ergänzt.

**Architecture:** Die Gestaltung liegt als `background`-Feld im `DesktopState` (pro Schreibtisch, geteilt, live gesynct wie jedes Command). Der Core validiert (`setBackground`), der Client rechnet daraus reine CSS-Strings (`deskCss` in `src/lib/deskThemes.ts`). Regler zeigen beim Ziehen eine lokale Vorschau über `ui.backgroundPreview`; das Command geht erst beim Loslassen raus.

**Tech Stack:** Svelte 5 (Runes), TypeScript, Vitest (`environment: node`), npm workspaces. Keine neuen Dependencies.

**Spec:** `docs/superpowers/specs/2026-07-19-gestaltung-design.md`

## Global Constraints

- Alle UI-Texte, Bezeichner-Kommentare und Commit-Messages auf Deutsch (Muster der bestehenden Codebasis; Variablennamen im Client teils deutsch — beibehalten).
- Wertebereiche exakt wie Spec: `brightness` 0,75–1,25 (Standard 1), `textureIntensity` 0–1 (Standard 0,25), `vignette` boolean (Standard `true`).
- Alt-States und Teil-States (nur `themeId`/`material`) bleiben ohne Migration gültig — `deskBackground()` füllt Standards auf.
- Kein CSS-`filter` auf der Tischfläche (würde Papiere mitfärben — Vision-Regel).
- Tests: `npx vitest run <datei>`; kompletter Lauf `npx vitest run`; Build-Check `npm run build`.
- Jeder Commit endet mit:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QdeYjTVNGfLh9ciFfgeXZt
  ```

---

### Task 1: Zwischenstand committen (Farbe + Material)

Der uncommittete Stand ist funktionsfähig und getestet — er wird als eigener Commit gesichert, bevor darauf aufgebaut wird. **Nicht** committen: `.claude/` und `packages/core/.svelte-kit/` (Build-Artefakt, wird ignoriert).

**Files:**
- Modify: `.gitignore`
- Commit (bereits vorhanden, uncommitted): `packages/core/src/background.ts`, `packages/core/src/background.test.ts`, `packages/core/src/commands.ts`, `packages/core/src/index.ts`, `packages/core/src/model.ts`, `src/lib/deskThemes.ts`, `src/lib/components/DeskSwitcher.svelte`, `src/lib/components/Desktop.svelte`

**Interfaces:**
- Produces: `DeskBackground { themeId, material }`, `deskBackground(state)`, `setBackground(state, bg)`, Command `setBackground`, `deskCss(bg)`, `themeSwatch(id)`, `isLight(id)` — Stand wie im Repo-Diff; Task 2/3 bauen darauf auf.

- [ ] **Step 1: Tests laufen lassen**

Run: `npx vitest run`
Expected: alle Suiten PASS (inkl. `background.test.ts` mit 5 Tests).

- [ ] **Step 2: .gitignore ergänzen**

In `.gitignore` unter der Zeile `/.svelte-kit` ergänzen:

```
packages/core/.svelte-kit/
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore packages/core/src/background.ts packages/core/src/background.test.ts \
  packages/core/src/commands.ts packages/core/src/index.ts packages/core/src/model.ts \
  src/lib/deskThemes.ts src/lib/components/DeskSwitcher.svelte src/lib/components/Desktop.svelte
git commit -m "feat: Schreibtisch-Gestaltung — Farbthema und Material pro Desk"
```

---

### Task 2: Core — DeskBackground um Helligkeit/Struktur/Vignette erweitern

**Files:**
- Modify: `packages/core/src/background.ts`
- Modify: `packages/core/src/commands.ts` (Funktion `backgroundPayload`, ca. Zeile 121)
- Modify: `packages/core/src/model.ts` (isValidState, ca. Zeile 106)
- Test: `packages/core/src/background.test.ts`

**Interfaces:**
- Consumes: `text(v, field)`, `num(v, field)`, `CommandError` aus `commands.ts`; `DesktopState` aus `model.ts`.
- Produces: `DeskBackground { themeId: DeskThemeId; material: DeskMaterial; brightness: number; textureIntensity: number; vignette: boolean }`; `DEFAULT_BACKGROUND` (dark_green/felt/1/0.25/true); `deskBackground(s): DeskBackground` (füllt fehlende Felder auf); `setBackground(s, bg)` (validiert Bereiche). Task 3/4 verlassen sich auf genau diese Feldnamen.

- [ ] **Step 1: Tests erweitern/anpassen (failing)**

`packages/core/src/background.test.ts` — die bestehenden Tests an das vollständige Objekt anpassen und neue Fälle ergänzen. Kompletter neuer Dateiinhalt:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState, isValidState } from './model';
import {
  deskBackground, setBackground, DEFAULT_BACKGROUND, DESK_THEME_IDS, DESK_MATERIALS,
  type DeskBackground,
} from './background';
import { applyCommand } from './commands';

describe('background', () => {
  it('liefert den Standard, wenn kein Erscheinungsbild gespeichert ist (Alt-States)', () => {
    expect(deskBackground(emptyState())).toEqual(DEFAULT_BACKGROUND);
    expect(DEFAULT_BACKGROUND).toEqual({
      themeId: 'dark_green', material: 'felt', brightness: 1, textureIntensity: 0.25, vignette: true,
    });
  });

  it('füllt Teil-Zustände (nur Farbe/Material) mit den Standards auf', () => {
    const s = {
      ...emptyState(),
      background: { themeId: 'bordeaux', material: 'leather' } as DeskBackground,
    };
    expect(deskBackground(s)).toEqual({
      themeId: 'bordeaux', material: 'leather', brightness: 1, textureIntensity: 0.25, vignette: true,
    });
  });

  it('setzt Erscheinungsbild; alle Thema/Material-Kombinationen sind gültig', () => {
    for (const themeId of DESK_THEME_IDS) {
      for (const material of DESK_MATERIALS) {
        const bg = { ...DEFAULT_BACKGROUND, themeId, material, brightness: 1.1, textureIntensity: 0.5, vignette: false };
        const s = setBackground(emptyState(), bg);
        expect(deskBackground(s)).toEqual(bg);
        expect(isValidState(s)).toBe(true);
      }
    }
  });

  it('lehnt unbekannte Themen und Materialien ab', () => {
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, themeId: 'neon_pink' as never })).toThrow('Farbthema');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, material: 'beton' as never })).toThrow('Material');
  });

  it('lehnt Werte außerhalb der Bereiche ab', () => {
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, brightness: 0.5 })).toThrow('Helligkeit');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, brightness: 1.3 })).toThrow('Helligkeit');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, brightness: Number.NaN })).toThrow('Helligkeit');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, textureIntensity: -0.1 })).toThrow('Struktur');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, textureIntensity: 1.1 })).toThrow('Struktur');
    expect(() => setBackground(emptyState(), { ...DEFAULT_BACKGROUND, vignette: 'ja' as never })).toThrow('vignette');
  });

  it('Command setBackground über applyCommand; fehlende Felder werden abgewiesen', () => {
    const bg = { themeId: 'bordeaux', material: 'leather', brightness: 0.9, textureIntensity: 0.4, vignette: false };
    const s = applyCommand(emptyState(), { type: 'setBackground', payload: { background: bg } });
    expect(s.background).toEqual(bg);
    expect(() => applyCommand(emptyState(), { type: 'setBackground', payload: {} })).toThrow('background');
    expect(() => applyCommand(emptyState(), { type: 'setBackground', payload: { background: { themeId: 'ivory' } } })).toThrow('material');
    expect(() => applyCommand(emptyState(), {
      type: 'setBackground',
      payload: { background: { themeId: 'ivory', material: 'felt' } },
    })).toThrow('brightness');
    expect(() => applyCommand(emptyState(), {
      type: 'setBackground',
      payload: { background: { themeId: 'ivory', material: 'felt', brightness: 1, textureIntensity: 0.25 } },
    })).toThrow('vignette');
  });

  it('isValidState toleriert fehlendes/teilweises background, weist kaputte Werte ab', () => {
    expect(isValidState({ docs: [], links: [], stacks: [] })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], background: { themeId: 'navy_blue', material: 'wood' } })).toBe(true);
    expect(isValidState({
      docs: [], links: [], stacks: [],
      background: { themeId: 'navy_blue', material: 'wood', brightness: 1.2, textureIntensity: 0.8, vignette: false },
    })).toBe(true);
    expect(isValidState({ docs: [], links: [], stacks: [], background: 'grün' })).toBe(false);
    expect(isValidState({ docs: [], links: [], stacks: [], background: { themeId: 7 } })).toBe(false);
    expect(isValidState({
      docs: [], links: [], stacks: [],
      background: { themeId: 'navy_blue', material: 'wood', brightness: 'hell' },
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npx vitest run packages/core/src/background.test.ts`
Expected: FAIL (u. a. Typ-/Laufzeitfehler: `brightness` unbekannt, Teil-Zustand wird nicht aufgefüllt).

- [ ] **Step 3: `background.ts` erweitern**

Kompletter neuer Inhalt von `packages/core/src/background.ts`:

```ts
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
```

- [ ] **Step 4: `commands.ts` — backgroundPayload erweitern**

Die bestehende Funktion `backgroundPayload` (nach dem `handlers`-Block) ersetzen durch:

```ts
function backgroundPayload(v: unknown): DeskBackground {
  const b = v as Partial<DeskBackground> | undefined;
  if (!b || typeof b !== 'object') throw new CommandError('Feld "background" fehlt');
  const themeId = text(b.themeId, 'background.themeId') as DeskBackground['themeId'];
  const material = text(b.material, 'background.material') as DeskBackground['material'];
  const brightness = num(b.brightness, 'background.brightness');
  const textureIntensity = num(b.textureIntensity, 'background.textureIntensity');
  if (typeof b.vignette !== 'boolean') throw new CommandError('Feld "background.vignette" muss true oder false sein');
  return { themeId, material, brightness, textureIntensity, vignette: b.vignette };
}
```

- [ ] **Step 5: `model.ts` — isValidState erweitern**

Den bestehenden `background`-Teil der Bedingung ersetzen durch:

```ts
    (s.background === undefined ||
      (!!s.background && typeof s.background === 'object' &&
        typeof s.background.themeId === 'string' && typeof s.background.material === 'string' &&
        (s.background.brightness === undefined || typeof s.background.brightness === 'number') &&
        (s.background.textureIntensity === undefined || typeof s.background.textureIntensity === 'number') &&
        (s.background.vignette === undefined || typeof s.background.vignette === 'boolean'))) &&
```

- [ ] **Step 6: Tests laufen lassen**

Run: `npx vitest run packages/core/src/background.test.ts`
Expected: PASS (7 Tests). Danach `npx vitest run` — alle Suiten PASS (falls andere Stellen `setBackground` mit 2-Feld-Objekt aufrufen, sind sie auf `{ ...DEFAULT_BACKGROUND, … }` umzustellen; laut Repo-Stand gibt es außer DeskSwitcher — Task 4 — keine).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/background.ts packages/core/src/background.test.ts \
  packages/core/src/commands.ts packages/core/src/model.ts
git commit -m "feat: Erscheinungsbild voll — Helligkeit, Strukturintensität und Vignette im Core"
```

---

### Task 3: deskThemes — Helligkeit/Struktur/Vignette in deskCss (TDD)

**Files:**
- Modify: `src/lib/deskThemes.ts`
- Test: Create `src/lib/deskThemes.test.ts`

**Interfaces:**
- Consumes: `DeskBackground` (voll, 5 Felder) aus `@digital-desktop/core` — Aufrufer reichen immer das Ergebnis von `deskBackground()` oder die Regler-Vorschau herein.
- Produces: `deskCss(bg: DeskBackground): string` (jetzt immer `background-image` + `background-blend-mode`); `themeSwatch`, `isLight`, `THEME_LABELS`, `MATERIAL_LABELS` unverändert.

- [ ] **Step 1: Failing Test schreiben**

Create `src/lib/deskThemes.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/lib/deskThemes.test.ts`
Expected: FAIL (deskCss kennt brightness/vignette noch nicht; Typfehler bzw. falsche Strings).

- [ ] **Step 3: `deskThemes.ts` umbauen**

In `src/lib/deskThemes.ts` den Block ab `MATERIAL_LAYERS` bis einschließlich `deskCss` ersetzen durch (Rest der Datei — Labels, TONES, `isLight`, `noise`, `themeSwatch` — bleibt unverändert):

```ts
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
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npx vitest run src/lib/deskThemes.test.ts`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/deskThemes.ts src/lib/deskThemes.test.ts
git commit -m "feat: deskCss rechnet Helligkeit, Strukturintensität und Vignette ein"
```

---

### Task 4: UI — Regler, Vignette-Haken, Zurücksetzen, Vorschau beim Ziehen

**Files:**
- Modify: `src/lib/ui.svelte.ts`
- Modify: `src/lib/components/Desktop.svelte` (Zeile ~35, `hintergrund`-Derived)
- Modify: `src/lib/components/DeskSwitcher.svelte` (Gestaltungs-Untermenü)

**Interfaces:**
- Consumes: `DeskBackground`, `DEFAULT_BACKGROUND`, `deskBackground` aus `@digital-desktop/core`; `deskCss` aus Task 3; `desktop.command('setBackground', { background })`.
- Produces: `ui.backgroundPreview: DeskBackground | null` — Desktop.svelte rendert Vorschau vor gespeichertem Zustand.

- [ ] **Step 1: `ui.svelte.ts` — Vorschau-Feld ergänzen**

Import oben ergänzen und im `$state`-Objekt (nach `trashOpen`) das Feld anfügen:

```ts
import type { DeskBackground } from '@digital-desktop/core';
```

```ts
  /** Gestaltung: lokale Regler-Vorschau — wirkt nur auf die Darstellung, bis das Command beim Loslassen gesendet ist. */
  backgroundPreview: null as DeskBackground | null,
```

- [ ] **Step 2: `Desktop.svelte` — Vorschau rendern**

Das `hintergrund`-Derived ersetzen:

```ts
  // Erscheinungsbild des Schreibtischs (Farbe/Material/Regler) — Regler-Vorschau vor gespeichertem Zustand.
  const hintergrund = $derived(ui.backgroundPreview ?? deskBackground(desktop.state));
```

- [ ] **Step 3: `DeskSwitcher.svelte` — Script erweitern**

Imports ersetzen/ergänzen:

```ts
  import {
    deskBackground, DEFAULT_BACKGROUND, DESK_MATERIALS, DESK_THEME_IDS,
    type DeskBackground, type DeskMaterial, type DeskThemeId,
  } from '@digital-desktop/core';
  import { ui } from '../ui.svelte';
```

Nach dem `hintergrund`-Derived ergänzen und `waehleFarbe`/`waehleMaterial` ersetzen:

```ts
  /** Wirksames Erscheinungsbild: lokale Regler-Vorschau vor dem gespeicherten Zustand. */
  const wirksam = $derived(ui.backgroundPreview ?? hintergrund);

  /** Regler-Vorschau: Tisch folgt sofort, ohne Command (kein Sync-Spam beim Ziehen). */
  function vorschau(teil: Partial<DeskBackground>) {
    ui.backgroundPreview = { ...wirksam, ...teil };
  }

  /** Wert übernehmen: Vorschau beenden und als Command speichern (synct beim Loslassen). */
  async function uebernehmen(teil: Partial<DeskBackground>) {
    const ziel = { ...wirksam, ...teil };
    ui.backgroundPreview = null;
    await desktop.command('setBackground', { background: ziel });
  }
```

In `toggle()` und im Backdrop-`onpointerdown` zusätzlich die Vorschau verwerfen — beide um `ui.backgroundPreview = null;` ergänzen:

```ts
  function toggle() {
    open = !open;
    mode = 'liste';
    ui.backgroundPreview = null;
  }
```

```svelte
    <div class="backdrop" role="presentation"
         onpointerdown={(e) => { e.stopPropagation(); open = false; ui.backgroundPreview = null; }}></div>
```

- [ ] **Step 4: Gestaltungs-Markup erweitern**

Im `{:else if mode === 'gestaltung'}`-Zweig: bei Farb-Swatches und Materialliste jedes `hintergrund` durch `wirksam` ersetzen und die Klick-Handler auf `uebernehmen` umstellen (`onclick={() => void uebernehmen({ themeId })}` bzw. `{ material }`). Zwischen der Materialliste und dem „Zurück"-`.row`-Block einfügen:

```svelte
        <div class="abschnitt">Helligkeit</div>
        <input class="regler" type="range" min="0.75" max="1.25" step="0.01" aria-label="Helligkeit"
               value={wirksam.brightness}
               oninput={(e) => vorschau({ brightness: Number(e.currentTarget.value) })}
               onchange={(e) => void uebernehmen({ brightness: Number(e.currentTarget.value) })} />
        <div class="abschnitt">Struktur</div>
        <input class="regler" type="range" min="0" max="1" step="0.01" aria-label="Strukturintensität"
               value={wirksam.textureIntensity}
               oninput={(e) => vorschau({ textureIntensity: Number(e.currentTarget.value) })}
               onchange={(e) => void uebernehmen({ textureIntensity: Number(e.currentTarget.value) })} />
        <label class="haken">
          <input type="checkbox" checked={wirksam.vignette}
                 onchange={(e) => void uebernehmen({ vignette: e.currentTarget.checked })} />
          Randabdunklung
        </label>
        <hr />
        <button class="item" onclick={() => void uebernehmen({ ...DEFAULT_BACKGROUND })}>Zurücksetzen</button>
```

Die Funktionen `waehleFarbe` und `waehleMaterial` ersatzlos streichen (durch `uebernehmen` abgelöst).

- [ ] **Step 5: CSS ergänzen**

Im `<style>`-Block: `.menu` um Scrollbarkeit erweitern und neue Klassen anfügen:

```css
  .menu { position: absolute; top: 36px; left: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; gap: 2px;
          max-height: calc(100vh - 56px); overflow-y: auto; }
  /* Regler: volle Menübreite, touch-freundlich; touch-action verhindert Scrollen beim Ziehen. */
  .regler { width: calc(100% - 20px); margin: 2px 10px 8px; accent-color: #2b5bd7; touch-action: none; }
  .haken { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
```

- [ ] **Step 6: Tests + Build**

Run: `npx vitest run && npm run build`
Expected: alle Tests PASS, Build ohne Fehler (insbesondere keine Svelte-/TS-Fehler in DeskSwitcher/Desktop).

- [ ] **Step 7: Commit**

```bash
git add src/lib/ui.svelte.ts src/lib/components/Desktop.svelte src/lib/components/DeskSwitcher.svelte
git commit -m "feat: Gestaltungs-Regler — Helligkeit/Struktur/Vignette mit Vorschau beim Ziehen"
```

---

### Task 5: UAT-Sammelliste — Block A11 Gestaltungsrunde

**Files:**
- Modify: `docs/uat/2026-07-18-uat-sammelliste.md`

**Interfaces:**
- Consumes: nichts (reine Doku).
- Produces: Block A11 (7 Punkte); Gesamtzählung 118, Block A 95.

- [ ] **Step 1: Zählung anpassen**

Kopfzeile (Zeile 3–4): `**111 Punkte in drei aktiven Blöcken** (A mit 88, …)` → `**118 Punkte in drei aktiven Blöcken** (A mit 95, …)`.
Block-A-Überschrift (Zeile 18): `88 Punkte` → `95 Punkte`.

- [ ] **Step 2: Block A11 einfügen**

Direkt nach dem A10-Abschnitt (vor `### C′ — …`) einfügen:

```markdown
### A11 — Gestaltungsrunde: Erscheinungsbild des Schreibtischs (NEU)

- [ ] A11.1 DeskSwitcher → „Gestaltung…": Farbe wechseln → Tisch färbt sofort um, Menü bleibt offen; Zweitfenster folgt live.
- [ ] A11.2 Materialien durchschalten (Glatt/Filz/Leder/Holz/Pergament) → Struktur sichtbar verschieden, Papiere bleiben klar lesbar.
- [ ] A11.3 Helligkeits-Regler ziehen → Tisch folgt flüssig schon beim Ziehen; erst beim Loslassen übernimmt das Zweitfenster den Wert.
- [ ] A11.4 Struktur-Regler: 0 = ganz glatt, hoch = deutlich kräftiger; Lesbarkeit bleibt in jeder Stellung.
- [ ] A11.5 „Randabdunklung" abhaken → gleichmäßige Fläche ohne Lichtzentrum; wieder anhaken → Verlauf zurück.
- [ ] A11.6 Helles Thema (Altweiß/Elfenbein): Papiere setzen sich per Kontur/Schatten ab; Reload erhält alle Einstellungen; „Zurücksetzen" stellt Dunkelgrün/Filz/Standardregler wieder her.
- [ ] A11.7 j-lawyer-Modus: Gestaltung einer Akte ändern → zweiter Nutzer sieht sie live (kanzlei-weit geteilt, gewollt); iPad: Regler und Haken per Finger bedienbar, Ziehen am Regler scrollt das Menü nicht.
```

- [ ] **Step 3: Commit**

```bash
git add docs/uat/2026-07-18-uat-sammelliste.md
git commit -m "docs: UAT-Block A11 Gestaltungsrunde (7 Punkte), Zählung 118 aktiv"
```

---

### Task 6: End-to-End-Sichtprüfung

**Files:** keine Änderungen (Verifikation).

- [ ] **Step 1: App anfahren und Gestaltung prüfen**

Die Projekt-Skill `verify` verwenden (eigene Serverinstanz mit frischen Daten, Playwright): Konto anlegen, PDF hinzufügen, DeskSwitcher → „Gestaltung…" öffnen, prüfen: Farbwechsel (Bordeaux) färbt den Tisch, Material „Holz" zeigt Maserung, Helligkeits-/Struktur-Regler wirken, „Randabdunklung" aus = flache Fläche, „Zurücksetzen" stellt Dunkelgrün/Filz her, Reload erhält die Einstellungen. Screenshot(s) als Beleg sichern.

Expected: alle Punkte sichtbar korrekt; keine Konsolen-Fehler.

- [ ] **Step 2: Befund festhalten**

Auffälligkeiten als `fix:`-Commits nachziehen (Muster der bisherigen Runden); ansonsten ist die Runde bereit für UAT-Block A11.
