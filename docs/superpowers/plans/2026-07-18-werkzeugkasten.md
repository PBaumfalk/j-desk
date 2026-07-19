# Werkzeugkasten-Runde Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 11 Vision-Werkzeuge (Hefter, Büroklammer, Lineal, Kugelschreiber, Tipp-Ex, Schwärzung, Notizfahne, Klebeband, Stempel, Kopierer, Papierkorb) auf `feature/inline-viewer` bauen.

**Architecture:** Additiv im bestehenden Muster: je Objektart ein Core-Modul mit reinen Funktionen + Command-Registrierung in `commands.ts`, Server bleibt generisch (Command-Route), Client bekommt Overlay-/Karten-Komponenten in Svelte 5 (Runes). Seitenverankerte Objekte (Marks/Stempel/Fahnen) nutzen Basiskoordinaten wie Strokes; Tisch-Objekte erweitern den `DesktopState`.

**Tech Stack:** TypeScript strict, Vitest, SvelteKit + Svelte 5, pdfjs-dist, Fastify (unverändert), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-18-werkzeugkasten-design.md` — bei Widerspruch gilt der Spec.

## Global Constraints

- UI-Texte Deutsch, Bezeichner Englisch, Fehlermeldungen im Core Deutsch (Muster: `Dokument "x" nicht gefunden`).
- Alte States ohne neue Felder müssen unverändert laden (`?? []`-Semantik wie bei `cutouts`; `isValidState` akzeptiert `undefined`).
- Kein `Date.now()`/`Math.random()` im Core — Zeitstempel und Winkel liefert der Client im Payload.
- Radierer entfernt Marks/Stempel/Fahnen NICHT — nur Strokes.
- Verifikation pro Task: `npm test` (Wurzel, läuft alle Workspaces), `npm run check` (0 Errors), bei UI-Tasks zusätzlich `npm run build`.
- Commits: konventionelle Präfixe (`feat:`/`test:`/`fix:`), Nachricht Deutsch.
- Jeder Command validiert seine Payload über die Helfer in `commands.ts` (`id`, `num`, `text`, `vec`, `rect`, …); Modul-Fehler werfen `Error`, `commands.ts` wrappt via `wrap()` zu `CommandError`.

---

### Task 1: Core `marks.ts` — Tipp-Ex & Schwärzung

**Files:**
- Create: `packages/core/src/marks.ts`
- Test: `packages/core/src/marks.test.ts`
- Modify: `packages/core/src/model.ts` (Feld `marks`, `emptyState`, `isValidState`)
- Modify: `packages/core/src/removal.ts` (Marks bei removeDoc/removeStack abräumen)
- Modify: `packages/core/src/commands.ts` (Handler `addMark`, `removeMark`)
- Modify: `packages/core/src/index.ts` (Export)
- Modify: `packages/core/src/model.test.ts` (Leerzustand um `marks` ergänzen)

**Interfaces:**
- Consumes: `findDoc`, `uid`, `DesktopState`.
- Produces: `type MarkKind = 'redact' | 'tippex'`; `interface Mark { id: string; docId: string; page: number; rect: { x: number; y: number; w: number; h: number }; kind: MarkKind }`; `addMark(s, mark: Omit<Mark,'id'> & { id?: string }): DesktopState`; `removeMark(s, markId: string): DesktopState`; `marksFor(s, docId, page): Mark[]`; `removeMarksForDocs(s, docIds: string[]): DesktopState`. Commands: `addMark { mark }`, `removeMark { markId }`.

- [ ] **Step 1: Failing Tests schreiben** — `packages/core/src/marks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addMark, removeMark, marksFor, removeMarksForDocs } from './marks';
import { removeDoc } from './removal';
import { applyCommand } from './commands';

function mitDoc() {
  return addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
}

describe('marks', () => {
  it('fügt eine Schwärzung hinzu und findet sie über marksFor', () => {
    const s = addMark(mitDoc(), { docId: 'd1', page: 2, rect: { x: 10, y: 20, w: 100, h: 30 }, kind: 'redact', id: 'm1' });
    expect(marksFor(s, 'd1', 2)).toHaveLength(1);
    expect(marksFor(s, 'd1', 1)).toHaveLength(0);
    expect(s.marks?.[0]).toMatchObject({ id: 'm1', kind: 'redact' });
  });

  it('lehnt unbekanntes Dokument, ungültige Seite, ungültiges Rechteck und unbekannte Art ab', () => {
    expect(() => addMark(mitDoc(), { docId: 'nix', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'tippex' })).toThrow('nicht gefunden');
    expect(() => addMark(mitDoc(), { docId: 'd1', page: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'tippex' })).toThrow('Seite');
    expect(() => addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 0, h: 1 }, kind: 'tippex' })).toThrow('Fläche');
    expect(() => addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'x' as never })).toThrow('Art');
  });

  it('entfernt eine Fläche; unbekannte id wirft', () => {
    const s = addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'tippex', id: 'm1' });
    expect(removeMark(s, 'm1').marks).toHaveLength(0);
    expect(() => removeMark(s, 'nix')).toThrow('nicht gefunden');
  });

  it('alte States ohne marks-Feld: marksFor liefert leer, addMark legt das Feld an', () => {
    const alt = { ...mitDoc(), marks: undefined };
    expect(marksFor(alt, 'd1', 1)).toEqual([]);
    expect(addMark(alt, { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact' }).marks).toHaveLength(1);
  });

  it('removeDoc räumt Marks des Dokuments mit ab', () => {
    const s = addMark(mitDoc(), { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 5, h: 5 }, kind: 'redact' });
    expect(removeDoc(s, 'd1').marks).toHaveLength(0);
    expect(removeMarksForDocs(s, ['d1']).marks).toHaveLength(0);
  });

  it('Commands addMark/removeMark laufen durch applyCommand inkl. Validierung', () => {
    const s = applyCommand(mitDoc(), { type: 'addMark', payload: { mark: { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 9, h: 9 }, kind: 'tippex', id: 'm1' } } });
    expect(s.marks).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeMark', payload: { markId: 'm1' } }).marks).toHaveLength(0);
    expect(() => applyCommand(s, { type: 'addMark', payload: {} })).toThrow();
  });
});
```

- [ ] **Step 2: Tests laufen lassen, Scheitern verifizieren**

Run: `npm test -w packages/core -- marks`
Expected: FAIL (Modul `./marks` existiert nicht)

- [ ] **Step 3: `packages/core/src/marks.ts` anlegen**

```ts
import { findDoc, type DesktopState } from './model';
import { uid } from './uid';

/** Tipp-Ex und Schwärzung: deckende Flächen auf PDF-Seiten (rein visuell, nicht forensisch). */
export type MarkKind = 'redact' | 'tippex';

export interface Mark {
  id: string;
  docId: string;
  page: number;                                          // 1-basiert
  rect: { x: number; y: number; w: number; h: number };  // Basiskoordinaten der Seite (scale = 1)
  kind: MarkKind;
}

const KINDS: readonly MarkKind[] = ['redact', 'tippex'];

export function addMark(s: DesktopState, mark: Omit<Mark, 'id'> & { id?: string }): DesktopState {
  if (!findDoc(s, mark.docId)) throw new Error(`Dokument "${mark.docId}" nicht gefunden`);
  if (!Number.isInteger(mark.page) || mark.page < 1) throw new Error(`Ungültige Seite: ${mark.page}`);
  if (!KINDS.includes(mark.kind)) throw new Error(`Unbekannte Art: ${String(mark.kind)}`);
  const r = mark.rect;
  if (!(r.w > 0) || !(r.h > 0) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new Error('Ungültige Fläche');
  const entry: Mark = { id: mark.id ?? uid(), docId: mark.docId, page: mark.page, rect: { ...r }, kind: mark.kind };
  return { ...s, marks: [...(s.marks ?? []), entry] };
}

export function removeMark(s: DesktopState, markId: string): DesktopState {
  const marks = s.marks ?? [];
  if (!marks.some((m) => m.id === markId)) throw new Error(`Fläche "${markId}" nicht gefunden`);
  return { ...s, marks: marks.filter((m) => m.id !== markId) };
}

export function marksFor(s: DesktopState, docId: string, page: number): Mark[] {
  return (s.marks ?? []).filter((m) => m.docId === docId && m.page === page);
}

/** Entfernt alle Flächen der angegebenen Dokumente (Aufräumen bei removeDoc/removeStack). */
export function removeMarksForDocs(s: DesktopState, docIds: string[]): DesktopState {
  const marks = s.marks ?? [];
  if (marks.length === 0) return s;
  return { ...s, marks: marks.filter((m) => !docIds.includes(m.docId)) };
}
```

- [ ] **Step 4: `model.ts` erweitern**

In `DesktopState` nach `cutouts` ergänzen:

```ts
  /** Tipp-Ex-/Schwärzungs-Flächen auf PDF-Seiten; fehlt in älteren Staaten. */
  marks?: import('./marks').Mark[];
```

`emptyState()` → `return { docs: [], links: [], stacks: [], strokes: [], notes: [], cutouts: [], marks: [] };`

`isValidState` → Zeile `(s.marks === undefined || Array.isArray(s.marks)) &&` ergänzen.

In `model.test.ts` die Leerzustand-Erwartung um `marks: []` erweitern (bestehendes Muster der `cutouts`-Ergänzung, Commit 494d283).

- [ ] **Step 5: `removal.ts` erweitern**

`import { removeMarksForDocs } from './marks';` und in `removeDoc` sowie `removeStack` die Kette erweitern:

```ts
let next = removeMarksForDocs(removeStrokesForDocs(removeLinksFor(s, docId), [docId]), [docId]);
```

bzw. in `removeStack` analog mit `st.docIds`.

- [ ] **Step 6: `commands.ts` erweitern**

```ts
import { addMark, removeMark, type Mark, type MarkKind } from './marks';
```

Handler ergänzen:

```ts
  addMark: (s, p) => wrap(() => addMark(s, markPayload(p.mark))),
  removeMark: (s, p) => wrap(() => removeMark(s, id(p.markId, 'markId'))),
```

Payload-Helfer neben `strokePayload`:

```ts
function markPayload(v: unknown): Omit<Mark, 'id'> & { id?: string } {
  const m = v as Partial<Mark> | undefined;
  if (!m || typeof m !== 'object') throw new CommandError('Feld "mark" fehlt');
  return {
    ...(typeof m.id === 'string' && m.id !== '' ? { id: m.id } : {}),
    docId: id(m.docId, 'mark.docId'),
    page: num(m.page, 'mark.page'),
    rect: rect(m.rect),
    kind: m.kind as MarkKind,
  };
}
```

`index.ts`: `export * from './marks';`

- [ ] **Step 7: Tests grün verifizieren**

Run: `npm test -w packages/core`
Expected: PASS (alle bestehenden + 6 neue)

- [ ] **Step 8: Commit**

```bash
git add packages/core/src
git commit -m "feat: Tipp-Ex und Schwärzung im Core (marks) — deckende Seitenflächen"
```

---

### Task 2: Core `stamps.ts` — Stempel

**Files:**
- Create: `packages/core/src/stamps.ts`
- Test: `packages/core/src/stamps.test.ts`
- Modify: `packages/core/src/model.ts`, `packages/core/src/removal.ts`, `packages/core/src/commands.ts`, `packages/core/src/index.ts`, `packages/core/src/model.test.ts` (jeweils analog Task 1)

**Interfaces:**
- Produces: `interface Stamp { id: string; docId: string; page: number; x: number; y: number; angle: number; text: string; color: 'red' | 'blue'; date?: string; baseW: number; baseH: number }` (x/y = Stempelmitte in Basiskoordinaten; baseW/baseH = Seitengröße beim Stempeln, fürs Karten-Overlay); `STAMP_PRESETS: readonly { text: string; color: 'red' | 'blue'; withDate?: boolean }[]`; `addStamp(s, stamp: Omit<Stamp,'id'> & { id?: string })`; `removeStamp(s, stampId)`; `stampsFor(s, docId, page)`; `removeStampsForDocs(s, docIds)`. Commands: `addStamp { stamp }`, `removeStamp { stampId }`.

- [ ] **Step 1: Failing Tests** — `packages/core/src/stamps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addStamp, removeStamp, stampsFor, STAMP_PRESETS } from './stamps';
import { removeDoc } from './removal';
import { applyCommand } from './commands';

const basis = { angle: -3, baseW: 595, baseH: 842 };
function mitDoc() {
  return addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
}

describe('stamps', () => {
  it('setzt einen Stempel mit Datum und findet ihn seitenweise', () => {
    const s = addStamp(mitDoc(), { docId: 'd1', page: 1, x: 100, y: 50, text: 'EINGANG', color: 'blue', date: '2026-07-18', ...basis, id: 'st1' });
    expect(stampsFor(s, 'd1', 1)).toHaveLength(1);
    expect(stampsFor(s, 'd1', 2)).toHaveLength(0);
    expect(s.stamps?.[0]).toMatchObject({ text: 'EINGANG', date: '2026-07-18', baseW: 595 });
  });

  it('validiert Dokument, Seite, Text, Farbe und Winkel', () => {
    expect(() => addStamp(mitDoc(), { docId: 'nix', page: 1, x: 0, y: 0, text: 'X', color: 'red', ...basis })).toThrow('nicht gefunden');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: '', color: 'red', ...basis })).toThrow('Text');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'A'.repeat(41), color: 'red', ...basis })).toThrow('Text');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'X', color: 'green' as never, ...basis })).toThrow('Farbe');
    expect(() => addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'X', color: 'red', angle: Number.NaN, baseW: 595, baseH: 842 })).toThrow('Winkel');
  });

  it('entfernt Stempel; removeDoc räumt mit ab', () => {
    const s = addStamp(mitDoc(), { docId: 'd1', page: 1, x: 0, y: 0, text: 'ERLEDIGT', color: 'red', ...basis, id: 'st1' });
    expect(removeStamp(s, 'st1').stamps).toHaveLength(0);
    expect(() => removeStamp(s, 'nix')).toThrow('nicht gefunden');
    expect(removeDoc(s, 'd1').stamps).toHaveLength(0);
  });

  it('Preset-Liste enthält die sieben Kanzlei-Stempel', () => {
    expect(STAMP_PRESETS.map((p) => p.text)).toEqual(['ERLEDIGT', 'WICHTIG', 'FRIST!', 'GEPRÜFT', 'EINGANG', 'ENTWURF', 'KOPIE']);
    expect(STAMP_PRESETS.find((p) => p.text === 'EINGANG')?.withDate).toBe(true);
  });

  it('Commands addStamp/removeStamp laufen durch applyCommand', () => {
    const s = applyCommand(mitDoc(), { type: 'addStamp', payload: { stamp: { docId: 'd1', page: 1, x: 1, y: 2, text: 'KOPIE', color: 'blue', ...basis, id: 'st1' } } });
    expect(s.stamps).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeStamp', payload: { stampId: 'st1' } }).stamps).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Scheitern verifizieren**

Run: `npm test -w packages/core -- stamps`
Expected: FAIL (Modul fehlt)

- [ ] **Step 3: `packages/core/src/stamps.ts` anlegen**

```ts
import { findDoc, type DesktopState } from './model';
import { uid } from './uid';

/** Stempel: Kanzlei-Set + Freitext, seitenverankert, leicht gedreht aufgebracht. */
export interface Stamp {
  id: string;
  docId: string;
  page: number;          // 1-basiert
  x: number;             // Stempelmitte, Basiskoordinaten
  y: number;
  angle: number;         // Grad, leicht gedreht (vom Client gewürfelt)
  text: string;
  color: 'red' | 'blue';
  date?: string;         // ISO-Tag, nur EINGANG
  baseW: number;         // Seitengröße beim Stempeln — fürs Overlay auf der Miniatur
  baseH: number;
}

export const STAMP_PRESETS: readonly { text: string; color: 'red' | 'blue'; withDate?: boolean }[] = [
  { text: 'ERLEDIGT', color: 'red' },
  { text: 'WICHTIG', color: 'red' },
  { text: 'FRIST!', color: 'red' },
  { text: 'GEPRÜFT', color: 'blue' },
  { text: 'EINGANG', color: 'blue', withDate: true },
  { text: 'ENTWURF', color: 'blue' },
  { text: 'KOPIE', color: 'blue' },
];

export const STAMP_TEXT_MAX = 40;

export function addStamp(s: DesktopState, stamp: Omit<Stamp, 'id'> & { id?: string }): DesktopState {
  if (!findDoc(s, stamp.docId)) throw new Error(`Dokument "${stamp.docId}" nicht gefunden`);
  if (!Number.isInteger(stamp.page) || stamp.page < 1) throw new Error(`Ungültige Seite: ${stamp.page}`);
  if (typeof stamp.text !== 'string' || stamp.text.trim() === '' || stamp.text.length > STAMP_TEXT_MAX) {
    throw new Error(`Stempel-Text fehlt oder ist länger als ${STAMP_TEXT_MAX} Zeichen`);
  }
  if (stamp.color !== 'red' && stamp.color !== 'blue') throw new Error(`Unbekannte Farbe: ${String(stamp.color)}`);
  if (!Number.isFinite(stamp.angle)) throw new Error('Ungültiger Winkel');
  if (!Number.isFinite(stamp.x) || !Number.isFinite(stamp.y)) throw new Error('Ungültige Position');
  if (!(stamp.baseW > 0) || !(stamp.baseH > 0)) throw new Error('Ungültige Seitengröße');
  if (stamp.date !== undefined && typeof stamp.date !== 'string') throw new Error('Ungültiges Datum');
  const entry: Stamp = {
    id: stamp.id ?? uid(),
    docId: stamp.docId, page: stamp.page, x: stamp.x, y: stamp.y,
    angle: stamp.angle, text: stamp.text.trim(), color: stamp.color,
    ...(stamp.date !== undefined ? { date: stamp.date } : {}),
    baseW: stamp.baseW, baseH: stamp.baseH,
  };
  return { ...s, stamps: [...(s.stamps ?? []), entry] };
}

export function removeStamp(s: DesktopState, stampId: string): DesktopState {
  const stamps = s.stamps ?? [];
  if (!stamps.some((st) => st.id === stampId)) throw new Error(`Stempel "${stampId}" nicht gefunden`);
  return { ...s, stamps: stamps.filter((st) => st.id !== stampId) };
}

export function stampsFor(s: DesktopState, docId: string, page: number): Stamp[] {
  return (s.stamps ?? []).filter((st) => st.docId === docId && st.page === page);
}

/** Entfernt alle Stempel der angegebenen Dokumente (Aufräumen bei removeDoc/removeStack). */
export function removeStampsForDocs(s: DesktopState, docIds: string[]): DesktopState {
  const stamps = s.stamps ?? [];
  if (stamps.length === 0) return s;
  return { ...s, stamps: stamps.filter((st) => !docIds.includes(st.docId)) };
}
```

- [ ] **Step 4: `model.ts`, `removal.ts`, `commands.ts`, `index.ts` erweitern (Muster Task 1)**

`model.ts`: Feld `stamps?: import('./stamps').Stamp[];`, `emptyState` um `stamps: []`, `isValidState` um `(s.stamps === undefined || Array.isArray(s.stamps)) &&`; `model.test.ts` Leerzustand ergänzen.

`removal.ts`: `removeStampsForDocs` in beide Ketten einfügen.

`commands.ts`:

```ts
import { addStamp, removeStamp, type Stamp } from './stamps';
```

```ts
  addStamp: (s, p) => wrap(() => addStamp(s, stampPayload(p.stamp))),
  removeStamp: (s, p) => wrap(() => removeStamp(s, id(p.stampId, 'stampId'))),
```

```ts
function stampPayload(v: unknown): Omit<Stamp, 'id'> & { id?: string } {
  const st = v as Partial<Stamp> | undefined;
  if (!st || typeof st !== 'object') throw new CommandError('Feld "stamp" fehlt');
  return {
    ...(typeof st.id === 'string' && st.id !== '' ? { id: st.id } : {}),
    docId: id(st.docId, 'stamp.docId'),
    page: num(st.page, 'stamp.page'),
    x: num(st.x, 'stamp.x'),
    y: num(st.y, 'stamp.y'),
    angle: num(st.angle, 'stamp.angle'),
    text: text(st.text, 'stamp.text'),
    color: st.color as Stamp['color'],
    ...(st.date !== undefined ? { date: text(st.date, 'stamp.date') } : {}),
    baseW: num(st.baseW, 'stamp.baseW'),
    baseH: num(st.baseH, 'stamp.baseH'),
  };
}
```

`index.ts`: `export * from './stamps';`

- [ ] **Step 5: Grün verifizieren + Commit**

Run: `npm test -w packages/core` → PASS

```bash
git add packages/core/src
git commit -m "feat: Stempel im Core (Kanzlei-Set + Freitext, seitenverankert)"
```

---

### Task 3: Core `flags.ts` — Notizfahnen

**Files:**
- Create: `packages/core/src/flags.ts`
- Test: `packages/core/src/flags.test.ts`
- Modify: `model.ts`, `removal.ts`, `commands.ts`, `index.ts`, `model.test.ts` (Muster Task 1)

**Interfaces:**
- Produces: `FLAG_COLORS: readonly string[]` (`['#f5c518', '#e5484d', '#3b82f6', '#30a46c']` — gelb/rot/blau/grün); `interface Flag { id: string; docId: string; page: number; offset: number; color: string; label?: string }` (offset 0..1 vertikal am rechten Rand); `addFlag(s, flag)`; `removeFlag(s, flagId)`; `flagsFor(s, docId): Flag[]` (ALLE Seiten — der Viewer zeigt alle Laschen); `removeFlagsForDocs(s, docIds)`. Commands: `addFlag { flag }`, `removeFlag { flagId }`.

- [ ] **Step 1: Failing Tests** — `packages/core/src/flags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addFlag, removeFlag, flagsFor, FLAG_COLORS } from './flags';
import { removeDoc } from './removal';
import { applyCommand } from './commands';

function mitDoc() {
  return addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
}

describe('flags', () => {
  it('setzt eine Fahne; flagsFor liefert alle Fahnen des Dokuments über alle Seiten', () => {
    let s = addFlag(mitDoc(), { docId: 'd1', page: 3, offset: 0.25, color: FLAG_COLORS[0], id: 'fl1' });
    s = addFlag(s, { docId: 'd1', page: 7, offset: 0.5, color: FLAG_COLORS[1], id: 'fl2' });
    expect(flagsFor(s, 'd1')).toHaveLength(2);
    expect(flagsFor(s, 'anders')).toHaveLength(0);
  });

  it('validiert Dokument, Seite, Offset und Farbe', () => {
    expect(() => addFlag(mitDoc(), { docId: 'nix', page: 1, offset: 0.5, color: FLAG_COLORS[0] })).toThrow('nicht gefunden');
    expect(() => addFlag(mitDoc(), { docId: 'd1', page: 0, offset: 0.5, color: FLAG_COLORS[0] })).toThrow('Seite');
    expect(() => addFlag(mitDoc(), { docId: 'd1', page: 1, offset: 1.5, color: FLAG_COLORS[0] })).toThrow('Offset');
    expect(() => addFlag(mitDoc(), { docId: 'd1', page: 1, offset: 0.5, color: '#000000' })).toThrow('Farbe');
  });

  it('entfernt Fahnen; removeDoc räumt mit ab', () => {
    const s = addFlag(mitDoc(), { docId: 'd1', page: 1, offset: 0.1, color: FLAG_COLORS[2], id: 'fl1' });
    expect(removeFlag(s, 'fl1').flags).toHaveLength(0);
    expect(() => removeFlag(s, 'nix')).toThrow('nicht gefunden');
    expect(removeDoc(s, 'd1').flags).toHaveLength(0);
  });

  it('Commands addFlag/removeFlag über applyCommand', () => {
    const s = applyCommand(mitDoc(), { type: 'addFlag', payload: { flag: { docId: 'd1', page: 2, offset: 0.4, color: FLAG_COLORS[3], id: 'fl1' } } });
    expect(s.flags).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeFlag', payload: { flagId: 'fl1' } }).flags).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Scheitern verifizieren**

Run: `npm test -w packages/core -- flags` → FAIL (Modul fehlt)

- [ ] **Step 3: `packages/core/src/flags.ts` anlegen**

```ts
import { findDoc, type DesktopState } from './model';
import { uid } from './uid';

/** Notizfahnen: farbige Laschen am rechten Seitenrand — sichtbar auch an der zugeklappten Karte. */
export const FLAG_COLORS: readonly string[] = ['#f5c518', '#e5484d', '#3b82f6', '#30a46c'];

export interface Flag {
  id: string;
  docId: string;
  page: number;    // 1-basiert — Klick auf die Lasche springt hierhin
  offset: number;  // 0..1, vertikale Position am rechten Rand
  color: string;   // aus FLAG_COLORS
  label?: string;
}

export function addFlag(s: DesktopState, flag: Omit<Flag, 'id'> & { id?: string }): DesktopState {
  if (!findDoc(s, flag.docId)) throw new Error(`Dokument "${flag.docId}" nicht gefunden`);
  if (!Number.isInteger(flag.page) || flag.page < 1) throw new Error(`Ungültige Seite: ${flag.page}`);
  if (!Number.isFinite(flag.offset) || flag.offset < 0 || flag.offset > 1) throw new Error(`Ungültiger Offset: ${flag.offset}`);
  if (!FLAG_COLORS.includes(flag.color)) throw new Error(`Unbekannte Farbe: ${String(flag.color)}`);
  if (flag.label !== undefined && typeof flag.label !== 'string') throw new Error('Ungültige Beschriftung');
  const entry: Flag = {
    id: flag.id ?? uid(),
    docId: flag.docId, page: flag.page, offset: flag.offset, color: flag.color,
    ...(flag.label !== undefined ? { label: flag.label } : {}),
  };
  return { ...s, flags: [...(s.flags ?? []), entry] };
}

export function removeFlag(s: DesktopState, flagId: string): DesktopState {
  const flags = s.flags ?? [];
  if (!flags.some((f) => f.id === flagId)) throw new Error(`Fahne "${flagId}" nicht gefunden`);
  return { ...s, flags: flags.filter((f) => f.id !== flagId) };
}

/** Alle Fahnen eines Dokuments (über alle Seiten — Laschen sind immer sichtbar). */
export function flagsFor(s: DesktopState, docId: string): Flag[] {
  return (s.flags ?? []).filter((f) => f.docId === docId);
}

/** Entfernt alle Fahnen der angegebenen Dokumente (Aufräumen bei removeDoc/removeStack). */
export function removeFlagsForDocs(s: DesktopState, docIds: string[]): DesktopState {
  const flags = s.flags ?? [];
  if (flags.length === 0) return s;
  return { ...s, flags: flags.filter((f) => !docIds.includes(f.docId)) };
}
```

- [ ] **Step 4: `model.ts`, `removal.ts`, `commands.ts`, `index.ts` erweitern**

`model.ts`: `flags?: import('./flags').Flag[];`, `emptyState` + `flags: []`, `isValidState`-Zeile; `model.test.ts` anpassen. `removal.ts`: `removeFlagsForDocs` in beide Ketten. `commands.ts`:

```ts
import { addFlag, removeFlag, type Flag } from './flags';
```

```ts
  addFlag: (s, p) => wrap(() => addFlag(s, flagPayload(p.flag))),
  removeFlag: (s, p) => wrap(() => removeFlag(s, id(p.flagId, 'flagId'))),
```

```ts
function flagPayload(v: unknown): Omit<Flag, 'id'> & { id?: string } {
  const f = v as Partial<Flag> | undefined;
  if (!f || typeof f !== 'object') throw new CommandError('Feld "flag" fehlt');
  return {
    ...(typeof f.id === 'string' && f.id !== '' ? { id: f.id } : {}),
    docId: id(f.docId, 'flag.docId'),
    page: num(f.page, 'flag.page'),
    offset: num(f.offset, 'flag.offset'),
    color: text(f.color, 'flag.color'),
    ...(f.label !== undefined ? { label: text(f.label, 'flag.label') } : {}),
  };
}
```

`index.ts`: `export * from './flags';`

- [ ] **Step 5: Grün + Commit**

Run: `npm test -w packages/core` → PASS

```bash
git add packages/core/src
git commit -m "feat: Notizfahnen im Core (farbige Laschen, springen zur Seite)"
```

---

### Task 4: Core `clips.ts` + `tape.ts` — Büroklammer & Klebeband

**Files:**
- Create: `packages/core/src/clips.ts`, `packages/core/src/tape.ts`
- Test: `packages/core/src/clips.test.ts`, `packages/core/src/tape.test.ts`
- Modify: `packages/core/src/model.ts` (Felder `clips`, `taped` auf Doc/Stack/Note/Cutout), `packages/core/src/removal.ts`, `packages/core/src/notes.ts` (removeNote), `packages/core/src/cutouts.ts` (removeCutout), `packages/core/src/commands.ts`, `packages/core/src/index.ts`, `packages/core/src/model.test.ts`

**Interfaces:**
- Produces: `interface Clip { id: string; memberIds: string[] }`; `addClip(s, aId, bId, id?)` (existierende Gruppe eines Partners wird erweitert; zwei Gruppen werden verschmolzen); `removeClip(s, clipId)`; `clipOf(s, objectId): Clip | undefined`; `clipMembersOf(s, objectId): string[]` (Mitglieder inklusive objectId; ohne Gruppe nur `[objectId]`); `removeFromClips(s, objectId)` (Objekt verlässt Gruppe; Gruppen < 2 lösen sich auf); `setTaped(s, objectId, taped: boolean)`; `isTaped(s, objectId): boolean`. Commands: `addClip { aId, bId, id? }`, `removeClip { clipId }`, `tapeObject { id }`, `untapeObject { id }`. Model: `Doc.taped?`, `Stack.taped?`, `Note.taped?`, `Cutout.taped?` jeweils `boolean`.
- WICHTIG (Zyklenfreiheit): `clips.ts` und `tape.ts` importieren NUR aus `model.ts`/`uid.ts` und prüfen Objekt-Existenz direkt über `s.docs`/`s.stacks`/`(s.notes ?? [])`/`(s.cutouts ?? [])` — keine Importe aus `notes.ts`/`cutouts.ts`.

- [ ] **Step 1: Failing Tests** — `packages/core/src/clips.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addClip, removeClip, clipOf, clipMembersOf, removeFromClips } from './clips';
import { removeDoc } from './removal';
import { removeNote } from './notes';
import { applyCommand } from './commands';

function basis() {
  let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'b.pdf', { x: 300, y: 0 }, 'd2');
  return addNote(s, 'notiz', 'Hallo', { x: 600, y: 0 }, 'n1');
}

describe('clips', () => {
  it('klammert zwei Objekte; clipOf und clipMembersOf finden die Gruppe', () => {
    const s = addClip(basis(), 'd1', 'n1', 'c1');
    expect(clipOf(s, 'd1')?.id).toBe('c1');
    expect(clipMembersOf(s, 'n1')).toEqual(['d1', 'n1']);
    expect(clipMembersOf(s, 'd2')).toEqual(['d2']);
  });

  it('erweitert eine bestehende Gruppe statt eine zweite zu bilden', () => {
    let s = addClip(basis(), 'd1', 'n1', 'c1');
    s = addClip(s, 'd2', 'd1');
    expect(s.clips).toHaveLength(1);
    expect(clipMembersOf(s, 'd2').sort()).toEqual(['d1', 'd2', 'n1']);
  });

  it('verschmilzt zwei Gruppen, wenn beide Partner geklammert sind', () => {
    let s = addDoc(basis(), 'f3', 'c.pdf', { x: 0, y: 300 }, 'd3');
    s = addClip(s, 'd1', 'n1', 'c1');
    s = addClip(s, 'd2', 'd3', 'c2');
    s = addClip(s, 'd1', 'd2');
    expect(s.clips).toHaveLength(1);
    expect(clipMembersOf(s, 'd3').sort()).toEqual(['d1', 'd2', 'd3', 'n1']);
  });

  it('lehnt Selbst-Klammerung und unbekannte Objekte ab; doppelte Klammerung ist idempotent', () => {
    expect(() => addClip(basis(), 'd1', 'd1')).toThrow('sich selbst');
    expect(() => addClip(basis(), 'd1', 'nix')).toThrow('nicht gefunden');
    let s = addClip(basis(), 'd1', 'n1', 'c1');
    s = addClip(s, 'd1', 'n1');
    expect(s.clips).toHaveLength(1);
    expect(clipMembersOf(s, 'd1')).toHaveLength(2);
  });

  it('removeClip löst die Gruppe; removeFromClips lässt Gruppen unter 2 Mitgliedern verschwinden', () => {
    const s = addClip(basis(), 'd1', 'n1', 'c1');
    expect(removeClip(s, 'c1').clips).toHaveLength(0);
    expect(removeFromClips(s, 'd1').clips).toHaveLength(0);
  });

  it('removeDoc und removeNote nehmen das Objekt aus seiner Gruppe', () => {
    let s = addDoc(basis(), 'f3', 'c.pdf', { x: 0, y: 300 }, 'd3');
    s = addClip(s, 'd1', 'n1', 'c1');
    s = addClip(s, 'd3', 'd1');
    expect(clipMembersOf(removeDoc(s, 'd1'), 'n1').sort()).toEqual(['d3', 'n1']);
    expect(removeNote(removeDoc(s, 'd1'), 'n1').clips).toHaveLength(0);
  });

  it('Commands addClip/removeClip über applyCommand', () => {
    const s = applyCommand(basis(), { type: 'addClip', payload: { aId: 'd1', bId: 'n1', id: 'c1' } });
    expect(s.clips).toHaveLength(1);
    expect(applyCommand(s, { type: 'removeClip', payload: { clipId: 'c1' } }).clips).toHaveLength(0);
  });
});
```

`packages/core/src/tape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { setTaped, isTaped } from './tape';
import { applyCommand } from './commands';

describe('tape', () => {
  it('klebt Karte und Zettel fest und löst wieder', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addNote(s, 'notiz', 'x', { x: 100, y: 0 }, 'n1');
    s = setTaped(s, 'd1', true);
    s = setTaped(s, 'n1', true);
    expect(isTaped(s, 'd1')).toBe(true);
    expect(isTaped(s, 'n1')).toBe(true);
    s = setTaped(s, 'd1', false);
    expect(isTaped(s, 'd1')).toBe(false);
  });

  it('wirft bei unbekanntem Objekt', () => {
    expect(() => setTaped(emptyState(), 'nix', true)).toThrow('nicht gefunden');
  });

  it('Commands tapeObject/untapeObject über applyCommand', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = applyCommand(s, { type: 'tapeObject', payload: { id: 'd1' } });
    expect(isTaped(s, 'd1')).toBe(true);
    s = applyCommand(s, { type: 'untapeObject', payload: { id: 'd1' } });
    expect(isTaped(s, 'd1')).toBe(false);
  });
});
```

- [ ] **Step 2: Scheitern verifizieren**

Run: `npm test -w packages/core -- clips` und `npm test -w packages/core -- tape` → FAIL (Module fehlen)

- [ ] **Step 3: `packages/core/src/clips.ts` anlegen**

```ts
import type { DesktopState } from './model';
import { uid } from './uid';

/** Büroklammer: lose Gruppe — Objekte bleiben einzeln liegen, werden aber gemeinsam verschoben. */
export interface Clip {
  id: string;
  memberIds: string[];   // Doc-/Stack-/Note-/Cutout-ids
}

function objectExists(s: DesktopState, id: string): boolean {
  return (
    s.docs.some((d) => d.id === id) ||
    s.stacks.some((st) => st.id === id) ||
    (s.notes ?? []).some((n) => n.id === id) ||
    (s.cutouts ?? []).some((c) => c.id === id)
  );
}

export function clipOf(s: DesktopState, objectId: string): Clip | undefined {
  return (s.clips ?? []).find((c) => c.memberIds.includes(objectId));
}

/** Mitglieder der Gruppe des Objekts inklusive seiner selbst; ohne Gruppe nur das Objekt. */
export function clipMembersOf(s: DesktopState, objectId: string): string[] {
  return clipOf(s, objectId)?.memberIds ?? [objectId];
}

export function addClip(s: DesktopState, aId: string, bId: string, id: string = uid()): DesktopState {
  if (aId === bId) throw new Error('Ein Objekt lässt sich nicht mit sich selbst klammern');
  if (!objectExists(s, aId)) throw new Error(`Objekt "${aId}" nicht gefunden`);
  if (!objectExists(s, bId)) throw new Error(`Objekt "${bId}" nicht gefunden`);
  const a = clipOf(s, aId);
  const b = clipOf(s, bId);
  if (a && b) {
    if (a.id === b.id) return s; // schon zusammen geklammert
    // Zwei Gruppen verschmelzen in die erste
    const merged = { ...a, memberIds: [...a.memberIds, ...b.memberIds.filter((m) => !a.memberIds.includes(m))] };
    return { ...s, clips: (s.clips ?? []).filter((c) => c.id !== b.id).map((c) => (c.id === a.id ? merged : c)) };
  }
  const existing = a ?? b;
  if (existing) {
    const neu = a ? bId : aId;
    return {
      ...s,
      clips: (s.clips ?? []).map((c) => (c.id === existing.id ? { ...c, memberIds: [...c.memberIds, neu] } : c)),
    };
  }
  return { ...s, clips: [...(s.clips ?? []), { id, memberIds: [aId, bId] }] };
}

export function removeClip(s: DesktopState, clipId: string): DesktopState {
  const clips = s.clips ?? [];
  if (!clips.some((c) => c.id === clipId)) throw new Error(`Klammer "${clipId}" nicht gefunden`);
  return { ...s, clips: clips.filter((c) => c.id !== clipId) };
}

/** Objekt verlässt seine Gruppe (Aufräumen bei Entfernen/Papierkorb); Gruppen < 2 lösen sich auf. */
export function removeFromClips(s: DesktopState, objectId: string): DesktopState {
  const clips = s.clips ?? [];
  if (!clips.some((c) => c.memberIds.includes(objectId))) return s;
  return {
    ...s,
    clips: clips
      .map((c) => ({ ...c, memberIds: c.memberIds.filter((m) => m !== objectId) }))
      .filter((c) => c.memberIds.length >= 2),
  };
}
```

`packages/core/src/tape.ts`:

```ts
import type { DesktopState } from './model';

/** Klebeband: Objekt ist am Tisch festgeklebt — Drag gesperrt, bis das Band abgezogen wird. */
export function setTaped(s: DesktopState, objectId: string, taped: boolean): DesktopState {
  const flag = taped ? { taped: true as const } : {};
  const strip = <T extends { taped?: boolean }>(o: T): T => {
    const { taped: _weg, ...rest } = o;
    return { ...(rest as T), ...flag };
  };
  if (s.docs.some((d) => d.id === objectId)) {
    return { ...s, docs: s.docs.map((d) => (d.id === objectId ? strip(d) : d)) };
  }
  if (s.stacks.some((st) => st.id === objectId)) {
    return { ...s, stacks: s.stacks.map((st) => (st.id === objectId ? strip(st) : st)) };
  }
  if ((s.notes ?? []).some((n) => n.id === objectId)) {
    return { ...s, notes: (s.notes ?? []).map((n) => (n.id === objectId ? strip(n) : n)) };
  }
  if ((s.cutouts ?? []).some((c) => c.id === objectId)) {
    return { ...s, cutouts: (s.cutouts ?? []).map((c) => (c.id === objectId ? strip(c) : c)) };
  }
  throw new Error(`Objekt "${objectId}" nicht gefunden`);
}

export function isTaped(s: DesktopState, objectId: string): boolean {
  return (
    s.docs.find((d) => d.id === objectId)?.taped === true ||
    s.stacks.find((st) => st.id === objectId)?.taped === true ||
    (s.notes ?? []).find((n) => n.id === objectId)?.taped === true ||
    (s.cutouts ?? []).find((c) => c.id === objectId)?.taped === true
  );
}
```

- [ ] **Step 4: Model + Aufräum-Hooks + Commands**

`model.ts`: `Doc`, `Stack` bekommen `taped?: boolean;` (Kommentar: „Klebeband: am Tisch festgeklebt, Drag gesperrt"). `DesktopState` bekommt `clips?: import('./clips').Clip[];`, `emptyState` → `clips: []`, `isValidState`-Zeile. In `notes.ts` (`Note`) und `cutouts.ts` (`Cutout`) je `taped?: boolean;` ergänzen. `model.test.ts` Leerzustand um `clips: []`.

Aufräum-Hooks (jeweils `import { removeFromClips } from './clips';`):
- `removal.ts` → in `removeDoc` nach dem Filtern der docs: `next = removeFromClips(next, docId);` — in `removeStack` vor dem Return: `next = removeFromClips(next, stackId);` und für jede Mitglieds-id `next = removeFromClips(next, docId);`.
- `notes.ts` → in `removeNote`: `const next = removeFromClips(removeLinksFor(s, id), id);`
- `cutouts.ts` → in `removeCutout`: `const next = removeFromClips(removeLinksFor(s, id), id);`

`commands.ts`:

```ts
import { addClip, removeClip } from './clips';
import { setTaped } from './tape';
```

```ts
  addClip: (s, p) => wrap(() => addClip(s, id(p.aId, 'aId'), id(p.bId, 'bId'), optId(p.id))),
  removeClip: (s, p) => wrap(() => removeClip(s, id(p.clipId, 'clipId'))),
  tapeObject: (s, p) => wrap(() => setTaped(s, id(p.id, 'id'), true)),
  untapeObject: (s, p) => wrap(() => setTaped(s, id(p.id, 'id'), false)),
```

Achtung: `addClip(s, aId, bId, optId(p.id))` — `optId` liefert `string | undefined`; Signatur von `addClip` nutzt Default-Parameter, daher `addClip(s, a, b, optId(p.id) ?? undefined)` funktioniert direkt (undefined greift auf `uid()`).

`index.ts`: `export * from './clips';` und `export * from './tape';`

- [ ] **Step 5: Grün + Commit**

Run: `npm test -w packages/core` → PASS

```bash
git add packages/core/src
git commit -m "feat: Büroklammer (lose Gruppen) und Klebeband (Festkleben) im Core"
```

---

### Task 5: Core Hefter & Konvolut — `stacks.ts` + `konvolut.ts`

**Files:**
- Create: `packages/core/src/konvolut.ts`
- Test: `packages/core/src/konvolut.test.ts`
- Modify: `packages/core/src/model.ts` (Stack-Felder `stapled`, `open`, `openSize`, `page`), `packages/core/src/stacks.ts` (staple/unstaple + Guards), `packages/core/src/geometry.ts` (stackBox bei offen; hitTest ohne Konvolute), `packages/core/src/commands.ts`, `packages/core/src/index.ts`
- Modify (Tests): `packages/core/src/stacks.test.ts` (Guards), `packages/core/src/geometry.test.ts` (hitTest-Ausschluss)

**Interfaces:**
- Consumes: `DEFAULT_OPEN_SIZE` aus `viewer.ts`, `findStack`, `findDoc`.
- Produces: `Stack` erweitert um `stapled?: boolean; open?: boolean; openSize?: Size; page?: number` (globale Konvolut-Seite, 1-basiert). `stapleStack(s, stackId)`, `unstapleStack(s, stackId)` (setzt auch `open: false`); Guards: `dissolveStack` wirft bei `stapled` („Konvolut zuerst entheften"), `removeFromStack` wirft bei `stapled`, `stackDocs` auf ein Konvolut ist No-Op (`return s`), `hitTest` liefert keine gehefteten Stapel. `konvolut.ts`: `interface KonvolutPage { docId: string; fileId: string; page: number }`; `konvolutPages(s, stack, pageCounts: Record<string, number>): KonvolutPage[] | null` (null, wenn eine Seitenzahl fehlt; `pageOnly`-Seitenkarten zählen als genau 1 Seite mit `page = pageOnly`); `expandStack(s, id)` (wirft, wenn nicht geheftet), `collapseStack(s, id)`, `setStackPage(s, id, page)`, `resizeStack(s, id, size)` — Semantik gespiegelt von `viewer.ts`. Commands: `stapleStack { stackId }`, `unstapleStack { stackId }`, `expandStack { id }`, `collapseStack { id }`, `setStackPage { id, page }`, `resizeStack { id, size }`.

- [ ] **Step 1: Failing Tests** — `packages/core/src/konvolut.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState, findStack, type DesktopState } from './model';
import { addDoc } from './documents';
import { stackDocs, dissolveStack, removeFromStack, stapleStack, unstapleStack } from './stacks';
import { extractPage } from './viewer';
import { konvolutPages, expandStack, collapseStack, setStackPage, resizeStack } from './konvolut';
import { hitTest } from './geometry';
import { applyCommand } from './commands';

function mitStapel(): DesktopState {
  let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
  s = addDoc(s, 'f2', 'b.pdf', { x: 10, y: 10 }, 'd2');
  return stackDocs(s, 'd2', 'd1', 'st1');
}

describe('Hefter/Konvolut', () => {
  it('heftet und enthiftet; Entheften schließt den Viewer', () => {
    let s = stapleStack(mitStapel(), 'st1');
    expect(findStack(s, 'st1')?.stapled).toBe(true);
    s = expandStack(s, 'st1');
    s = unstapleStack(s, 'st1');
    expect(findStack(s, 'st1')?.stapled).toBe(false);
    expect(findStack(s, 'st1')?.open).toBe(false);
  });

  it('Guards: dissolve/removeFromStack verweigern am Konvolut, stackDocs prallt ab, hitTest ignoriert es', () => {
    let s = addDoc(mitStapel(), 'f3', 'c.pdf', { x: 500, y: 500 }, 'd3');
    s = stapleStack(s, 'st1');
    expect(() => dissolveStack(s, 'st1')).toThrow('entheften');
    expect(() => removeFromStack(s, 'd1', { x: 0, y: 0 })).toThrow('entheften');
    expect(stackDocs(s, 'd3', 'st1')).toBe(s);
    expect(hitTest(s, { x: 20, y: 20 }, 'd3')).toBeNull();
  });

  it('expandStack nur am Konvolut; setzt open/openSize/page mit Defaults', () => {
    expect(() => expandStack(mitStapel(), 'st1')).toThrow('geheftet');
    const s = expandStack(stapleStack(mitStapel(), 'st1'), 'st1');
    const st = findStack(s, 'st1')!;
    expect(st.open).toBe(true);
    expect(st.openSize).toEqual({ w: 560, h: 720 });
    expect(st.page).toBe(1);
  });

  it('collapse/setPage/resize spiegeln die Viewer-Semantik', () => {
    let s = expandStack(stapleStack(mitStapel(), 'st1'), 'st1');
    s = setStackPage(s, 'st1', 4);
    s = resizeStack(s, 'st1', { w: 700, h: 900 });
    s = collapseStack(s, 'st1');
    const st = findStack(s, 'st1')!;
    expect(st.page).toBe(4);
    expect(st.openSize).toEqual({ w: 700, h: 900 });
    expect(st.open).toBe(false);
    expect(() => setStackPage(s, 'st1', 0)).toThrow('Seite');
    expect(() => resizeStack(s, 'st1', { w: 0, h: 10 })).toThrow('Größe');
  });

  it('konvolutPages verkettet Mitgliederseiten in Stapelreihenfolge; Seitenkarten zählen 1', () => {
    // Stapel st1 = [d1 (unten), d2 (oben)] + herausgelöste Seitenkarte d3 (S. 5 von f1) obendrauf
    let s = extractPage(mitStapel(), 'd1', 5, { x: 200, y: 0 }, 'd3');
    s = stackDocs(s, 'd3', 'st1');
    s = stapleStack(s, 'st1');
    const st = findStack(s, 'st1')!;
    const pages = konvolutPages(s, st, { f1: 3, f2: 2 });
    expect(pages).toEqual([
      { docId: 'd1', fileId: 'f1', page: 1 },
      { docId: 'd1', fileId: 'f1', page: 2 },
      { docId: 'd1', fileId: 'f1', page: 3 },
      { docId: 'd2', fileId: 'f2', page: 1 },
      { docId: 'd2', fileId: 'f2', page: 2 },
      { docId: 'd3', fileId: 'f1', page: 5 },
    ]);
    expect(konvolutPages(s, st, { f1: 3 })).toBeNull(); // f2 unbekannt -> null
  });

  it('Commands laufen durch applyCommand', () => {
    let s = applyCommand(mitStapel(), { type: 'stapleStack', payload: { stackId: 'st1' } });
    s = applyCommand(s, { type: 'expandStack', payload: { id: 'st1' } });
    s = applyCommand(s, { type: 'setStackPage', payload: { id: 'st1', page: 2 } });
    s = applyCommand(s, { type: 'resizeStack', payload: { id: 'st1', size: { w: 600, h: 800 } } });
    s = applyCommand(s, { type: 'collapseStack', payload: { id: 'st1' } });
    s = applyCommand(s, { type: 'unstapleStack', payload: { stackId: 'st1' } });
    expect(findStack(s, 'st1')).toMatchObject({ stapled: false, open: false, page: 2 });
  });
});
```

- [ ] **Step 2: Scheitern verifizieren**

Run: `npm test -w packages/core -- konvolut` → FAIL

- [ ] **Step 3: `model.ts` Stack erweitern**

```ts
export interface Stack {
  id: string;
  name: string;
  docIds: string[];    // Reihenfolge: unten → oben
  position: Vec2;
  zIndex: number;
  taped?: boolean;     // Klebeband: am Tisch festgeklebt (aus Task 4, falls noch nicht vorhanden)
  stapled?: boolean;   // Hefter: festes Konvolut — feste Reihenfolge, als Ganzes durchblätterbar
  open?: boolean;      // Konvolut aufgeschlagen (großer Viewer)
  openSize?: Size;     // Größe des Konvolut-Viewers (Weltkoordinaten)
  page?: number;       // globale Konvolut-Seite über alle Mitglieder, 1-basiert
}
```

- [ ] **Step 4: `stacks.ts` erweitern**

`stapleStack`/`unstapleStack` anfügen und Guards einbauen:

```ts
export function stapleStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) throw new Error(`Stapel "${stackId}" nicht gefunden`);
  return { ...s, stacks: s.stacks.map((x) => (x.id === stackId ? { ...x, stapled: true } : x)) };
}

export function unstapleStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) throw new Error(`Stapel "${stackId}" nicht gefunden`);
  return { ...s, stacks: s.stacks.map((x) => (x.id === stackId ? { ...x, stapled: false, open: false } : x)) };
}
```

In `dissolveStack` nach dem `findStack`: `if (st.stapled) throw new Error('Konvolut zuerst entheften');`
In `removeFromStack` nach dem `stackOf`: `if (st.stapled) throw new Error('Konvolut zuerst entheften');`
In `stackDocs`: beim Treffer `targetStack` zuerst `if (targetStack.stapled) return s;`

- [ ] **Step 5: `konvolut.ts` anlegen**

```ts
import { findStack, type DesktopState, type Size, type Stack } from './model';
import { DEFAULT_OPEN_SIZE } from './viewer';

/** Eine Konvolut-Seite: welches Mitglied liefert welche lokale Seite. */
export interface KonvolutPage {
  docId: string;
  fileId: string;
  page: number;   // lokale Seite im Mitglieds-Dokument, 1-basiert
}

/**
 * Verkettete Seiten des Konvoluts in Stapelreihenfolge (unten → oben).
 * pageCounts: fileId → Seitenzahl. Fehlt eine benötigte Zahl, kommt null zurück
 * (der Client lädt nach und ruft erneut). Seitenkarten (pageOnly) zählen als 1 Seite.
 */
export function konvolutPages(
  s: DesktopState,
  stack: Stack,
  pageCounts: Record<string, number>,
): KonvolutPage[] | null {
  const pages: KonvolutPage[] = [];
  for (const docId of stack.docIds) {
    const d = s.docs.find((x) => x.id === docId);
    if (!d) continue; // defensive: verwaiste id überspringen
    if (d.pageOnly !== undefined) {
      pages.push({ docId: d.id, fileId: d.fileId, page: d.pageOnly });
      continue;
    }
    const count = pageCounts[d.fileId];
    if (!Number.isInteger(count) || count < 1) return null;
    for (let p = 1; p <= count; p++) pages.push({ docId: d.id, fileId: d.fileId, page: p });
  }
  return pages;
}

function mapStack(s: DesktopState, id: string, fn: (st: Stack) => Stack): DesktopState {
  const st = findStack(s, id);
  if (!st) throw new Error(`Stapel "${id}" nicht gefunden`);
  return { ...s, stacks: s.stacks.map((x) => (x.id === id ? fn(x) : x)) };
}

export function expandStack(s: DesktopState, id: string): DesktopState {
  const st = findStack(s, id);
  if (!st) throw new Error(`Stapel "${id}" nicht gefunden`);
  if (!st.stapled) throw new Error('Nur ein geheftetes Konvolut lässt sich als Ganzes aufschlagen');
  return mapStack(s, id, (x) => ({ ...x, open: true, openSize: x.openSize ?? DEFAULT_OPEN_SIZE, page: x.page ?? 1 }));
}

export function collapseStack(s: DesktopState, id: string): DesktopState {
  return mapStack(s, id, (x) => ({ ...x, open: false }));
}

export function setStackPage(s: DesktopState, id: string, page: number): DesktopState {
  if (!Number.isInteger(page) || page < 1) throw new Error(`Ungültige Seite: ${page}`);
  return mapStack(s, id, (x) => ({ ...x, page }));
}

export function resizeStack(s: DesktopState, id: string, size: Size): DesktopState {
  if (!(size.w > 0) || !(size.h > 0)) throw new Error(`Ungültige Größe: ${size.w}×${size.h}`);
  return mapStack(s, id, (x) => ({ ...x, openSize: { w: size.w, h: size.h } }));
}
```

- [ ] **Step 6: `geometry.ts` anpassen**

```ts
export function stackBox(st: Stack): Box {
  if (st.open) {
    const size = st.openSize ?? DEFAULT_OPEN_SIZE;
    return { x: st.position.x, y: st.position.y, w: size.w, h: size.h };
  }
  return { x: st.position.x, y: st.position.y, w: CARD_W + 24, h: CARD_H + 24 };
}
```

In `hitTest` den Stapel-Kandidaten-Filter erweitern: `.filter((st) => st.id !== excludeId && !st.stapled && inside(stackBox(st)))` — Kommentar: „Konvolute sind zu, auf sie stapelt man nicht."

In `geometry.test.ts` einen Fall ergänzen: gehefteter Stapel unter dem Punkt → `hitTest` liefert `null`. In `stacks.test.ts` je einen Guard-Fall für `dissolveStack`/`removeFromStack` (werfen bei `stapled`), falls die konvolut.test.ts-Fälle dort nicht schon abdecken (Doppelung vermeiden — die Fälle aus Step 1 reichen, dann diesen Unterschritt überspringen).

- [ ] **Step 7: `commands.ts` + `index.ts`**

```ts
import { stapleStack, unstapleStack } from './stacks';   // an bestehenden stacks-Import anhängen
import { expandStack, collapseStack, setStackPage, resizeStack } from './konvolut';
```

```ts
  stapleStack: (s, p) => wrap(() => stapleStack(s, id(p.stackId, 'stackId'))),
  unstapleStack: (s, p) => wrap(() => unstapleStack(s, id(p.stackId, 'stackId'))),
  expandStack: (s, p) => wrap(() => expandStack(s, id(p.id, 'id'))),
  collapseStack: (s, p) => wrap(() => collapseStack(s, id(p.id, 'id'))),
  setStackPage: (s, p) => wrap(() => setStackPage(s, id(p.id, 'id'), num(p.page, 'page'))),
  resizeStack: (s, p) => wrap(() => resizeStack(s, id(p.id, 'id'), size(p.size, 'size'))),
```

`index.ts`: `export * from './konvolut';`

- [ ] **Step 8: Grün + Commit**

Run: `npm test -w packages/core` → PASS

```bash
git add packages/core/src
git commit -m "feat: Hefter im Core — Stapel wird Konvolut (feste Reihenfolge, global blätterbar)"
```

---

### Task 6: Core `trash.ts` + `copy.ts` — Papierkorb & Kopierer

**Files:**
- Create: `packages/core/src/trash.ts`, `packages/core/src/copy.ts`
- Test: `packages/core/src/trash.test.ts`, `packages/core/src/copy.test.ts`
- Modify: `model.ts` (Feld `trash`), `commands.ts`, `index.ts`, `model.test.ts`

**Interfaces:**
- Consumes: alle bisherigen Module (Tasks 1–5 müssen fertig sein): `removeDoc`, `removeStack` aus `removal.ts`, `removeNote`, `removeCutout`, `marksFor`-Familie usw.
- Produces: `interface TrashedItem { id: string; kind: 'doc' | 'note' | 'cutout' | 'stack'; name: string; trashedAt: string; payload: TrashPayload }` mit `interface TrashPayload { docs: Doc[]; notes: Note[]; cutouts: Cutout[]; stacks: Stack[]; strokes: Stroke[]; marks: Mark[]; stamps: Stamp[]; flags: Flag[] }`; `trashObject(s, objectId, trashedAt, id?)`; `restoreObject(s, trashId)` (wirft, wenn ein Objekt/Dokument bereits wieder auf dem Tisch liegt); `emptyTrash(s)`; `trashedFileIds(s): string[]` (fileIds aller Dokumente in Korb-Payloads — für den j-lawyer-Abgleich in Task 7). Commands: `trashObject { id, trashedAt }`, `restoreObject { trashId }`, `emptyTrash {}`, `copyObject { id }`. `copy.ts`: `copyObject(s, objectId): DesktopState` — Karte/Seitenkarte/Zettel/Ausschnitt inkl. Annotationen mit frischen `uid()`-ids duplizieren, Position +28/+20; Stapel und Unbekanntes werfen.

- [ ] **Step 1: Failing Tests** — `packages/core/src/trash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addLink } from './links';
import { addStroke } from './ink';
import { addMark } from './marks';
import { addStamp } from './stamps';
import { addFlag, FLAG_COLORS } from './flags';
import { stackDocs, stapleStack } from './stacks';
import { addClip } from './clips';
import { trashObject, restoreObject, emptyTrash, trashedFileIds } from './trash';
import { applyCommand } from './commands';

const T = '2026-07-18T12:00:00.000Z';

function voll() {
  let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
  s = addNote(s, 'frage', 'Warum?', { x: 400, y: 0 }, 'n1');
  s = addLink(s, 'd1', 'n1', 'l1');
  s = addStroke(s, { docId: 'd1', page: 1, tool: 'pen', color: '#1d3557', width: 1.5, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], id: 'sk1' });
  s = addMark(s, { docId: 'd1', page: 1, rect: { x: 0, y: 0, w: 9, h: 9 }, kind: 'redact', id: 'm1' });
  s = addStamp(s, { docId: 'd1', page: 1, x: 1, y: 1, angle: 0, text: 'KOPIE', color: 'blue', baseW: 595, baseH: 842, id: 'sp1' });
  return addFlag(s, { docId: 'd1', page: 1, offset: 0.2, color: FLAG_COLORS[0], id: 'fg1' });
}

describe('trash', () => {
  it('legt eine Karte samt Annotationen in den Korb, kappt Schnüre und Klammern', () => {
    let s = addClip(voll(), 'd1', 'n1', 'c1');
    s = trashObject(s, 'd1', T, 't1');
    expect(s.docs).toHaveLength(0);
    expect(s.links).toHaveLength(0);
    expect(s.clips).toHaveLength(0);
    expect(s.strokes).toHaveLength(0);
    expect(s.marks).toHaveLength(0);
    const item = s.trash?.[0];
    expect(item).toMatchObject({ id: 't1', kind: 'doc', name: 'a.pdf', trashedAt: T });
    expect(item?.payload.docs).toHaveLength(1);
    expect(item?.payload.strokes).toHaveLength(1);
    expect(item?.payload.marks).toHaveLength(1);
    expect(item?.payload.stamps).toHaveLength(1);
    expect(item?.payload.flags).toHaveLength(1);
  });

  it('restoreObject legt alles zurück (ohne Schnüre) und leert den Korb-Eintrag', () => {
    let s = trashObject(voll(), 'd1', T, 't1');
    s = restoreObject(s, 't1');
    expect(s.trash).toHaveLength(0);
    expect(s.docs).toHaveLength(1);
    expect(s.strokes).toHaveLength(1);
    expect(s.stamps).toHaveLength(1);
    expect(s.links).toHaveLength(0); // Schnüre kommen nicht zurück — dokumentiert
  });

  it('Stapel wandert mit allen Mitgliedern und deren Annotationen in den Korb', () => {
    let s = addDoc(voll(), 'f2', 'b.pdf', { x: 200, y: 0 }, 'd2');
    s = stackDocs(s, 'd2', 'd1', 'st1');
    s = stapleStack(s, 'st1');
    s = trashObject(s, 'st1', T, 't1');
    expect(s.docs).toHaveLength(0);
    expect(s.stacks).toHaveLength(0);
    expect(s.trash?.[0]?.kind).toBe('stack');
    expect(s.trash?.[0]?.payload.docs).toHaveLength(2);
    expect(s.trash?.[0]?.payload.stacks).toHaveLength(1);
    expect(trashedFileIds(s).sort()).toEqual(['f1', 'f2']);
    s = restoreObject(s, 't1');
    expect(s.docs).toHaveLength(2);
    expect(s.stacks?.[0]).toMatchObject({ id: 'st1', stapled: true });
  });

  it('restore wirft, wenn das Dokument (fileId) inzwischen wieder auf dem Tisch liegt', () => {
    let s = trashObject(voll(), 'd1', T, 't1');
    s = addDoc(s, 'f1', 'a.pdf', { x: 50, y: 50 }, 'd9');
    expect(() => restoreObject(s, 't1')).toThrow('bereits');
  });

  it('Zettel und unbekannte Objekte; emptyTrash leert endgültig', () => {
    let s = trashObject(voll(), 'n1', T, 't1');
    expect(s.notes).toHaveLength(0);
    expect(s.trash?.[0]).toMatchObject({ kind: 'note', name: 'Warum?' });
    expect(() => trashObject(s, 'nix', T)).toThrow('nicht gefunden');
    expect(emptyTrash(s).trash).toHaveLength(0);
  });

  it('Commands trashObject/restoreObject/emptyTrash über applyCommand', () => {
    let s = applyCommand(voll(), { type: 'trashObject', payload: { id: 'd1', trashedAt: T, trashId: 't1' } });
    expect(s.trash).toHaveLength(1);
    s = applyCommand(s, { type: 'restoreObject', payload: { trashId: 't1' } });
    expect(s.docs).toHaveLength(1);
    expect(applyCommand(s, { type: 'emptyTrash' }).trash).toEqual([]);
    expect(() => applyCommand(s, { type: 'trashObject', payload: { id: 'd1' } })).toThrow(); // trashedAt fehlt
  });
});
```

`packages/core/src/copy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { addNote } from './notes';
import { addCutout } from './cutouts';
import { addStroke } from './ink';
import { addStamp } from './stamps';
import { stackDocs } from './stacks';
import { copyObject } from './copy';
import { applyCommand } from './commands';

describe('copy', () => {
  it('kopiert eine Karte inkl. Annotationen mit frischen ids, leicht versetzt', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 100, y: 100 }, 'd1');
    s = addStroke(s, { docId: 'd1', page: 1, tool: 'pen', color: '#1d3557', width: 1.5, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], id: 'sk1' });
    s = addStamp(s, { docId: 'd1', page: 1, x: 1, y: 1, angle: 0, text: 'KOPIE', color: 'blue', baseW: 595, baseH: 842, id: 'sp1' });
    s = copyObject(s, 'd1');
    expect(s.docs).toHaveLength(2);
    const kopie = s.docs[1];
    expect(kopie.id).not.toBe('d1');
    expect(kopie.fileId).toBe('f1');
    expect(kopie.position).toEqual({ x: 128, y: 120 });
    expect(s.strokes).toHaveLength(2);
    expect(s.stamps).toHaveLength(2);
    const strokeKopie = s.strokes!.find((st) => st.id !== 'sk1')!;
    expect(strokeKopie.docId).toBe(kopie.id);
  });

  it('kopiert Zettel und Ausschnitte', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addNote(s, 'these', 'Text', { x: 300, y: 0 }, 'n1');
    s = addCutout(s, 'd1', 1, { x: 0, y: 0, w: 50, h: 40 }, { x: 500, y: 0 }, 'c1');
    s = copyObject(s, 'n1');
    s = copyObject(s, 'c1');
    expect(s.notes).toHaveLength(2);
    expect(s.cutouts).toHaveLength(2);
    expect(s.notes![1].text).toBe('Text');
  });

  it('wirft für Stapel und Unbekanntes', () => {
    let s = addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1');
    s = addDoc(s, 'f2', 'b.pdf', { x: 10, y: 10 }, 'd2');
    s = stackDocs(s, 'd2', 'd1', 'st1');
    expect(() => copyObject(s, 'st1')).toThrow('Stapel');
    expect(() => copyObject(s, 'nix')).toThrow('nicht gefunden');
  });

  it('Command copyObject über applyCommand', () => {
    const s = applyCommand(addDoc(emptyState(), 'f1', 'a.pdf', { x: 0, y: 0 }, 'd1'), { type: 'copyObject', payload: { id: 'd1' } });
    expect(s.docs).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Scheitern verifizieren**

Run: `npm test -w packages/core -- trash` und `npm test -w packages/core -- copy` → FAIL

- [ ] **Step 3: `packages/core/src/trash.ts` anlegen**

```ts
import type { DesktopState, Doc, Stack } from './model';
import type { Note } from './notes';
import type { Cutout } from './cutouts';
import type { Stroke } from './ink';
import type { Mark } from './marks';
import type { Stamp } from './stamps';
import type { Flag } from './flags';
import { findDoc, findStack } from './model';
import { findNote } from './notes';
import { findCutout } from './cutouts';
import { removeDoc, removeStack } from './removal';
import { removeNote } from './notes';
import { removeCutout } from './cutouts';
import { uid } from './uid';

/** Papierkorb: entfernte Objekte liegen IM Korb und sind wiederherstellbar, bis geleert wird. */
export interface TrashPayload {
  docs: Doc[];
  notes: Note[];
  cutouts: Cutout[];
  stacks: Stack[];
  strokes: Stroke[];
  marks: Mark[];
  stamps: Stamp[];
  flags: Flag[];
}

export interface TrashedItem {
  id: string;
  kind: 'doc' | 'note' | 'cutout' | 'stack';
  name: string;        // Anzeigename fürs Korb-Panel
  trashedAt: string;   // ISO-Zeitpunkt, vom Client geliefert
  payload: TrashPayload;
}

function annotationsFor(s: DesktopState, docIds: string[]): Pick<TrashPayload, 'strokes' | 'marks' | 'stamps' | 'flags'> {
  return {
    strokes: (s.strokes ?? []).filter((x) => docIds.includes(x.docId)),
    marks: (s.marks ?? []).filter((x) => docIds.includes(x.docId)),
    stamps: (s.stamps ?? []).filter((x) => docIds.includes(x.docId)),
    flags: (s.flags ?? []).filter((x) => docIds.includes(x.docId)),
  };
}

export function trashObject(s: DesktopState, objectId: string, trashedAt: string, id: string = uid()): DesktopState {
  if (typeof trashedAt !== 'string' || trashedAt === '') throw new Error('Zeitstempel fehlt');
  const leer: TrashPayload = { docs: [], notes: [], cutouts: [], stacks: [], strokes: [], marks: [], stamps: [], flags: [] };
  let item: TrashedItem | null = null;
  let next: DesktopState = s;

  const doc = findDoc(s, objectId);
  const note = findNote(s, objectId);
  const cutout = findCutout(s, objectId);
  const stack = findStack(s, objectId);
  if (doc) {
    item = { id, kind: 'doc', name: doc.name, trashedAt, payload: { ...leer, docs: [doc], ...annotationsFor(s, [doc.id]) } };
    next = removeDoc(s, doc.id);
  } else if (stack) {
    const members = stack.docIds.map((d) => findDoc(s, d)).filter((d): d is Doc => !!d);
    const name = stack.name || `Stapel (${stack.docIds.length})`;
    item = { id, kind: 'stack', name, trashedAt, payload: { ...leer, docs: members, stacks: [stack], ...annotationsFor(s, stack.docIds) } };
    next = removeStack(s, stack.id);
  } else if (note) {
    item = { id, kind: 'note', name: note.text.slice(0, 60) || 'Zettel', trashedAt, payload: { ...leer, notes: [note] } };
    next = removeNote(s, note.id);
  } else if (cutout) {
    item = { id, kind: 'cutout', name: 'Ausschnitt', trashedAt, payload: { ...leer, cutouts: [cutout] } };
    next = removeCutout(s, cutout.id);
  } else {
    throw new Error(`Objekt "${objectId}" nicht gefunden`);
  }
  return { ...next, trash: [...(next.trash ?? []), item] };
}

export function restoreObject(s: DesktopState, trashId: string): DesktopState {
  const item = (s.trash ?? []).find((t) => t.id === trashId);
  if (!item) throw new Error(`Korb-Eintrag "${trashId}" nicht gefunden`);
  const p = item.payload;
  const belegt =
    p.docs.some((d) => s.docs.some((x) => x.id === d.id || x.fileId === d.fileId)) ||
    p.notes.some((n) => (s.notes ?? []).some((x) => x.id === n.id)) ||
    p.cutouts.some((c) => (s.cutouts ?? []).some((x) => x.id === c.id)) ||
    p.stacks.some((st) => s.stacks.some((x) => x.id === st.id));
  if (belegt) throw new Error('Ein Objekt aus diesem Korb-Eintrag liegt bereits wieder auf dem Tisch');
  return {
    ...s,
    docs: [...s.docs, ...p.docs],
    notes: [...(s.notes ?? []), ...p.notes],
    cutouts: [...(s.cutouts ?? []), ...p.cutouts],
    stacks: [...s.stacks, ...p.stacks],
    strokes: [...(s.strokes ?? []), ...p.strokes],
    marks: [...(s.marks ?? []), ...p.marks],
    stamps: [...(s.stamps ?? []), ...p.stamps],
    flags: [...(s.flags ?? []), ...p.flags],
    trash: (s.trash ?? []).filter((t) => t.id !== trashId),
  };
}

export function emptyTrash(s: DesktopState): DesktopState {
  return { ...s, trash: [] };
}

/** fileIds aller Dokumente im Korb — der j-lawyer-Abgleich behandelt sie als vorhanden. */
export function trashedFileIds(s: DesktopState): string[] {
  return (s.trash ?? []).flatMap((t) => t.payload.docs.map((d) => d.fileId));
}
```

Hinweis Zyklenfreiheit: `trash.ts` importiert `removal.ts`/`notes.ts`/`cutouts.ts` — keines dieser Module importiert `trash.ts`, der Graph bleibt azyklisch.

- [ ] **Step 4: `packages/core/src/copy.ts` anlegen**

```ts
import { findDoc, type DesktopState } from './model';
import { findNote } from './notes';
import { findCutout } from './cutouts';
import { rotationFor } from './documents';
import { uid } from './uid';

const OFFSET = { x: 28, y: 20 };

function maxZ(s: DesktopState): number {
  return Math.max(
    0,
    ...s.docs.map((d) => d.zIndex),
    ...s.stacks.map((st) => st.zIndex),
    ...(s.notes ?? []).map((n) => n.zIndex),
    ...(s.cutouts ?? []).map((c) => c.zIndex),
  );
}

/**
 * Kopierer: dupliziert Karte, Seitenkarte, Zettel oder Ausschnitt inkl. Annotationen.
 * Gleiche Datei-Referenz, keine Datei-Duplizierung, kein j-lawyer-Schreibvorgang.
 */
export function copyObject(s: DesktopState, objectId: string): DesktopState {
  const doc = findDoc(s, objectId);
  if (doc) {
    const neueId = uid();
    const { open: _o, openSize: _os, taped: _t, ...rest } = doc;
    const kopie = {
      ...rest,
      id: neueId,
      position: { x: doc.position.x + OFFSET.x, y: doc.position.y + OFFSET.y },
      rotation: rotationFor(neueId),
      zIndex: maxZ(s) + 1,
    };
    return {
      ...s,
      docs: [...s.docs, kopie],
      strokes: [...(s.strokes ?? []), ...(s.strokes ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
      marks: [...(s.marks ?? []), ...(s.marks ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
      stamps: [...(s.stamps ?? []), ...(s.stamps ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
      flags: [...(s.flags ?? []), ...(s.flags ?? []).filter((x) => x.docId === doc.id).map((x) => ({ ...x, id: uid(), docId: neueId }))],
    };
  }
  const note = findNote(s, objectId);
  if (note) {
    const { taped: _t, ...rest } = note;
    const kopie = { ...rest, id: uid(), position: { x: note.position.x + OFFSET.x, y: note.position.y + OFFSET.y }, zIndex: maxZ(s) + 1 };
    return { ...s, notes: [...(s.notes ?? []), kopie] };
  }
  const cutout = findCutout(s, objectId);
  if (cutout) {
    const { taped: _t, ...rest } = cutout;
    const kopie = { ...rest, id: uid(), position: { x: cutout.position.x + OFFSET.x, y: cutout.position.y + OFFSET.y }, zIndex: maxZ(s) + 1 };
    return { ...s, cutouts: [...(s.cutouts ?? []), kopie] };
  }
  if (s.stacks.some((st) => st.id === objectId)) throw new Error('Stapel lassen sich nicht kopieren');
  throw new Error(`Objekt "${objectId}" nicht gefunden`);
}
```

Hinweis: Kopien werden zugeklappt abgelegt (`open`/`openSize` entfernt), `page`/`pageOnly` bleiben erhalten.

- [ ] **Step 5: `model.ts` + `commands.ts` + `index.ts`**

`model.ts`: `trash?: import('./trash').TrashedItem[];`, `emptyState` + `trash: []`, `isValidState`-Zeile `(s.trash === undefined || Array.isArray(s.trash)) &&`; `model.test.ts` Leerzustand.

`commands.ts`:

```ts
import { trashObject, restoreObject, emptyTrash } from './trash';
import { copyObject } from './copy';
```

```ts
  trashObject: (s, p) => wrap(() => trashObject(s, id(p.id, 'id'), text(p.trashedAt, 'trashedAt'), optId(p.trashId))),
  restoreObject: (s, p) => wrap(() => restoreObject(s, id(p.trashId, 'trashId'))),
  emptyTrash: (s) => emptyTrash(s),
  copyObject: (s, p) => wrap(() => copyObject(s, id(p.id, 'id'))),
```

`index.ts`: `export * from './trash';` und `export * from './copy';`

- [ ] **Step 6: Grün + Commit**

Run: `npm test -w packages/core` → PASS

```bash
git add packages/core/src
git commit -m "feat: Papierkorb (wiederherstellbar) und Kopierer im Core"
```

---

### Task 7: Server — j-lawyer-Abgleich kennt den Papierkorb

**Files:**
- Modify: `packages/server/src/app.ts` (Funktion `syncCaseDesk`, ca. Zeile 166–191)
- Test: `packages/server/src/app.test.ts` (bestehende j-lawyer-Sync-Tests ergänzen; Fake-j-lawyer aus `testJLawyer.ts`/`testUtils.ts` wiederverwenden)

**Interfaces:**
- Consumes: `trashedFileIds` aus `@digital-desktop/core` (Task 6).
- Produces: Verhalten — ein Dokument, dessen Karte im Papierkorb liegt, bekommt beim Abgleich KEINE neue Karte.

- [ ] **Step 1: Failing Test** — in `app.test.ts` bei den vorhandenen `syncCaseDesk`-/Desk-Route-Tests (Muster der Nachbar-Tests übernehmen: Fake-j-lawyer mit einer Akte + einem Dokument, Login, `GET /api/v1/cases/:id/desk`):

```ts
it('Abgleich legt für Dokumente im Papierkorb keine neue Karte an', async () => {
  // 1. Akte öffnen -> Karte für das j-lawyer-Dokument entsteht
  const erste = await oeffneAktenDesk(); // vorhandenes Test-Hilfsmuster dieser Datei verwenden
  const karte = erste.state.docs[0];
  // 2. Karte in den Papierkorb legen (Command-Route wie in den bestehenden Command-Tests)
  await sendeCommand({ type: 'trashObject', payload: { id: karte.id, trashedAt: '2026-07-18T12:00:00.000Z' } });
  // 3. Akte erneut öffnen -> Abgleich läuft, aber es entsteht KEINE neue Karte
  const zweite = await oeffneAktenDesk();
  expect(zweite.state.docs).toHaveLength(0);
  expect(zweite.state.trash).toHaveLength(1);
});
```

(Die konkreten Helfer heißen in `app.test.ts` anders — der Implementierer übernimmt exakt das dort etablierte Muster für „Desk öffnen" und „Command senden"; der Testinhalt oben ist die fachliche Vorgabe.)

- [ ] **Step 2: Scheitern verifizieren**

Run: `npm test -w packages/server -- app` → FAIL (zweiter Abruf legt die Karte erneut an)

- [ ] **Step 3: Fix in `syncCaseDesk`**

Import ergänzen (Zeile 8): `trashedFileIds` in die bestehende `@digital-desktop/core`-Importliste aufnehmen. Dann:

```ts
const vorhanden = new Set([...state.docs.map((d) => d.fileId), ...trashedFileIds(state)]);
```

(ersetzt `const vorhanden = new Set(state.docs.map((d) => d.fileId));`). Kommentar dazu: `// Karten im Papierkorb gelten als vorhanden — sonst käme die Karte beim Abgleich zurück.`

Bewusste Randnotiz für den Report: Wird ein Dokument in j-lawyer gelöscht, während seine Karte im Korb liegt, bleibt der Korb-Eintrag bestehen; nach Wiederherstellen entfernt der nächste Abgleich die Karte regulär.

- [ ] **Step 4: Grün + Commit**

Run: `npm test -w packages/server` → PASS

```bash
git add packages/server/src
git commit -m "fix: j-lawyer-Abgleich behandelt Karten im Papierkorb als vorhanden"
```

---

### Task 8: Bleistift, Kugelschreiber & Lineal — Core-Toolliste + InkOverlay + Toolbar-Gruppen

**Files:**
- Modify: `packages/core/src/ink.ts` (`StrokeTool` um `'pencil'`)
- Modify: `packages/core/src/ink.test.ts` (pencil-Fall)
- Modify: `src/lib/components/InkOverlay.svelte` (pencil-Stil, `line`-Modus)
- Modify: `src/lib/components/DocViewer.svelte` (Toolbar in Gruppen, neue Knöpfe)

**Interfaces:**
- Produces: `StrokeTool = 'pen' | 'marker' | 'pencil'`; Client-`InkTool = StrokeTool | 'eraser' | 'line'` (der `line`-Modus speichert einen begradigten 2-Punkt-Stroke mit `tool: 'pen'` — Radierer/Skalierung/Sync brauchen keinen Sonderpfad). Toolbar-Gruppen mit Trennern (CSS-Klasse `.sep`), horizontal scrollbar (`.tools { overflow-x: auto; }`).

- [ ] **Step 1: Failing Core-Test** — in `ink.test.ts` ergänzen:

```ts
it('akzeptiert das Bleistift-Werkzeug', () => {
  const s = addStroke(mitDoc(), { docId: 'd1', page: 1, tool: 'pencil', color: '#5c6672', width: 1.2, points: [{ x: 0, y: 0 }, { x: 3, y: 3 }] });
  expect(s.strokes?.[0]?.tool).toBe('pencil');
});
```

(`mitDoc()` gemäß vorhandenem Muster der Datei; falls dort anders benannt, den bestehenden Helfer verwenden.)

Run: `npm test -w packages/core -- ink` → FAIL (`Unbekanntes Werkzeug: pencil`)

- [ ] **Step 2: Core-Fix**

`ink.ts`: `export type StrokeTool = 'pen' | 'marker' | 'pencil';` und `const TOOLS: readonly StrokeTool[] = ['pen', 'marker', 'pencil'];`

Run: `npm test -w packages/core` → PASS

- [ ] **Step 3: `InkOverlay.svelte` erweitern**

```ts
export type InkTool = StrokeTool | 'eraser' | 'line';

const TOOL_STYLE: Record<StrokeTool, { color: string; width: number; alpha: number }> = {
  pen: { color: '#1d3557', width: 1.5, alpha: 1 },        // Kugelschreiber
  marker: { color: '#ffd166', width: 9, alpha: 0.35 },     // Textmarker
  pencil: { color: '#5c6672', width: 1.2, alpha: 0.9 },    // Bleistift
};
/** Der Lineal-Modus zeichnet mit Kugelschreiber-Optik, begradigt aber zur Geraden. */
function styleFor(t: Exclude<InkTool, 'eraser'>): { tool: StrokeTool; color: string; width: number } {
  const kind: StrokeTool = t === 'line' ? 'pen' : t;
  const st = TOOL_STYLE[kind];
  return { tool: kind, color: st.color, width: st.width };
}
```

Anpassungen an den bestehenden Funktionen (Verhalten, exakt):
- `redraw()`: Vorschau-Zweig nutzt `styleFor(tool)` statt `TOOL_STYLE[tool]` und übergibt `styleFor(tool).tool` an `drawStroke` (Guard: `tool !== 'eraser'`).
- `onPointerMove()`: im Zeichen-Zweig bei `tool === 'line'` NICHT anhängen, sondern `drawing = [drawing[0], p]` (letzter koaleszierter Punkt gewinnt) — die Vorschau ist damit live eine Gerade.
- `onPointerUp()`: `const st = styleFor(tool); void desktop.command('addStroke', { stroke: { id: uid(), docId, page, tool: st.tool, color: st.color, width: st.width, points } satisfies Stroke });` — beim `line`-Modus ist `points` durch den Move-Zweig bereits `[start, ende]`.

- [ ] **Step 4: `DocViewer.svelte` Toolbar in Gruppen**

Den `<span class="tools">`-Block ersetzen durch (Reihenfolge laut Spec: Zeichnen | Abdecken (Task 9) | Stempel (Task 10) | Fahne (Task 11) | Enthefter · Schere · Lichttisch — die Platzhalter der späteren Tasks kommen dort dazu, dieser Task baut nur Zeichnen + die bestehenden drei um):

```svelte
<span class="tools">
  <button class:on={inkTool === 'pencil'} onclick={() => toggleTool('pencil')} aria-pressed={inkTool === 'pencil'} aria-label="Bleistift" title="Bleistift">✏</button>
  <button class:on={inkTool === 'pen'} onclick={() => toggleTool('pen')} aria-pressed={inkTool === 'pen'} aria-label="Kugelschreiber" title="Kugelschreiber">✎</button>
  <button class:on={inkTool === 'marker'} onclick={() => toggleTool('marker')} aria-pressed={inkTool === 'marker'} aria-label="Textmarker" title="Textmarker"><span class="marker-chip"></span></button>
  <button class:on={inkTool === 'line'} onclick={() => toggleTool('line')} aria-pressed={inkTool === 'line'} aria-label="Lineal" title="Lineal: gerade Linie ziehen">⟍</button>
  <button class:on={inkTool === 'eraser'} onclick={() => toggleTool('eraser')} aria-pressed={inkTool === 'eraser'} aria-label="Radierer" title="Radierer (nur Striche)">⌫</button>
  <span class="sep"></span>
  {#if !seitenfix}
    <button onclick={() => void desktop.command('extractPage', { docId: doc.id, page, position: { x: doc.position.x + size.w + 24, y: doc.position.y } })}
            aria-label="Seite herauslösen" title="Seite herauslösen (Enthefterzange)">⧉</button>
  {/if}
  <button class:on={inkTool === 'scissors'} onclick={() => toggleTool('scissors')} aria-pressed={inkTool === 'scissors'} aria-label="Schere" title="Schere: Ausschnitt aufziehen">✄</button>
  <button class:on={lichttisch} onclick={() => (lichttisch = !lichttisch)} aria-pressed={lichttisch} aria-label="Lichttisch" title="Lichttisch: durchscheinend übereinanderlegen">◐</button>
</span>
```

Der Typ des lokalen Werkzeugzustands wird `let inkTool = $state<InkTool | 'scissors' | null>(null);` (deckt `'line'` über `InkTool` ab). Die `InkOverlay`-Einbindung übergibt weiterhin `tool={inkTool === 'scissors' ? null : inkTool}` — Task 9 erweitert diesen Ausdruck um die Abdeck-Werkzeuge.

Wisch-Blättern (`onBodyPointerDown`) blockiert bereits bei aktivem `inkTool` — deckt `line` automatisch ab.

CSS ergänzen:

```css
.tools { display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.sep { width: 1px; height: 16px; background: #d3d9e3; margin: 0 2px; flex: none; }
```

- [ ] **Step 5: Verifizieren + Commit**

Run: `npm test` → PASS; `npm run check` → 0 Errors; `npm run build` → ok

```bash
git add packages/core/src src/lib/components
git commit -m "feat: Bleistift, Kugelschreiber-Umbenennung und Lineal (gerade Linien)"
```

---

### Task 9: Tipp-Ex & Schwärzung im Viewer — MarkLayer + Rechteck-Aufziehen

**Files:**
- Create: `src/lib/components/MarkLayer.svelte`
- Modify: `src/lib/components/DocViewer.svelte` (Rechteck-Werkzeuge verallgemeinern, Knöpfe, Einmal-Hinweis)

**Interfaces:**
- Consumes: `marksFor`, Commands `addMark`/`removeMark`, `MarkKind` (Task 1); `showToast` aus `../ui.svelte`.
- Produces: `MarkLayer`-Props: `{ docId: string; page: number; base: Size | null; renderedWidth: number; active: MarkKind | null }` — rendert die Flächen der Seite; bei aktivem Werkzeug entfernt ein Klick auf eine Fläche genau diese.

- [ ] **Step 1: Rechteck-Aufziehen verallgemeinern (`DocViewer.svelte`)**

Der Scheren-Mechanismus (`schnittDown/Move/Up`, `schnittCss`) wird von `'scissors'` auf `rectTool = 'scissors' | 'tippex' | 'redact'` verallgemeinert:

- Werkzeugzustand: `let inkTool = $state<InkTool | 'scissors' | 'tippex' | 'redact' | null>(null);`
- Abgeleitet: `const rectTool = $derived(inkTool === 'scissors' || inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null);`
- Die Overlay-Bedingung `{#if inkTool === 'scissors' && baseSize}` wird `{#if rectTool && baseSize}`; der Rahmen färbt je Werkzeug (`class:tippex`, `class:redact` am `.schnittrahmen`).
- `schnittUp` verzweigt:

```ts
if (rect.w < 12 || rect.h < 12) return;
if (rectTool === 'scissors') {
  inkTool = null;
  void desktop.command('addCutout', { docId: doc.id, page, rect, position: { x: doc.position.x + size.w + 24, y: doc.position.y + 40 } });
} else if (rectTool) {
  // Tipp-Ex/Schwärzung: Werkzeug bleibt aktiv (mehrere Flächen nacheinander)
  void desktop.command('addMark', { mark: { id: uid(), docId: doc.id, page, rect, kind: rectTool } });
}
```

(Mindestgröße für Marks: 6 statt 12 ist nicht nötig — einheitlich 12 lassen, das verwirft Mini-Wischer.)

- Einmal-Hinweis Schwärzung beim Aktivieren:

```ts
function toggleTool(t: InkTool | 'scissors' | 'tippex' | 'redact') {
  inkTool = inkTool === t ? null : t;
  if (inkTool === 'redact' && !localStorage.getItem('dd-redact-hinweis')) {
    localStorage.setItem('dd-redact-hinweis', '1');
    showToast('Hinweis: Die Schwärzung deckt nur sichtbar ab — der Text bleibt im PDF erhalten.');
  }
}
```

- Knöpfe in der Abdecken-Gruppe (nach der Zeichnen-Gruppe, vor deren `.sep`-Trenner einen weiteren Trenner setzen):

```svelte
<span class="sep"></span>
<button class:on={inkTool === 'tippex'} onclick={() => toggleTool('tippex')} aria-pressed={inkTool === 'tippex'} aria-label="Tipp-Ex" title="Tipp-Ex: weiß abdecken"><span class="tippex-chip"></span></button>
<button class:on={inkTool === 'redact'} onclick={() => toggleTool('redact')} aria-pressed={inkTool === 'redact'} aria-label="Schwärzung" title="Schwärzung: schwarz abdecken (rein visuell)">■</button>
```

```css
.tippex-chip { width: 12px; height: 12px; border-radius: 3px; background: #fff; border: 1px solid #b8c0cc; display: inline-block; }
```

- Einbindung im `pagewrap` (zwischen `InkOverlay` und der Schnittfläche):

```svelte
<MarkLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth}
           active={inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null} />
```

WICHTIG: Die `InkOverlay`-`tool`-Übergabe muss die neuen Modi ausklammern: `tool={inkTool === 'scissors' || inkTool === 'tippex' || inkTool === 'redact' ? null : inkTool}`.

- [ ] **Step 2: `MarkLayer.svelte` anlegen**

```svelte
<script lang="ts">
  import { marksFor, type MarkKind, type Size } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';

  let { docId, page, base, renderedWidth, active }:
    { docId: string; page: number; base: Size | null; renderedWidth: number; active: MarkKind | null } = $props();

  const marks = $derived(marksFor(desktop.state, docId, page));
  const f = $derived(base ? renderedWidth / base.w : 1); // Basiskoordinaten -> Overlay-Pixel
</script>

{#if base}
  {#each marks as m (m.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -- Ablösen nur im Werkzeugmodus, per Zeiger -->
    <div class="mark" class:redact={m.kind === 'redact'} class:tippex={m.kind === 'tippex'} class:active={active === m.kind}
         style:left="{m.rect.x * f}px" style:top="{m.rect.y * f}px"
         style:width="{m.rect.w * f}px" style:height="{m.rect.h * f}px"
         title={active === m.kind ? 'Klick löst die Fläche ab' : undefined}
         onclick={() => { if (active === m.kind) void desktop.command('removeMark', { markId: m.id }); }}></div>
  {/each}
{/if}

<style>
  /* Abdeckungen liegen ÜBER den Strichen (Tipp-Ex deckt auch Tinte) — DOM-Reihenfolge nach InkOverlay. */
  .mark { position: absolute; pointer-events: none; }
  .mark.redact { background: #111; }
  .mark.tippex { background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .06) inset; }
  .mark.active { pointer-events: auto; cursor: pointer; outline: 1px dashed rgba(44, 90, 160, .6); }
</style>
```

- [ ] **Step 3: Verifizieren + Commit**

Run: `npm test` → PASS; `npm run check` → 0 Errors; `npm run build` → ok. Manuelle Stichprobe im Dev-Server ist Aufgabe der E2E-Runde (Task 15).

```bash
git add src/lib/components
git commit -m "feat: Tipp-Ex und Schwärzung im Viewer (deckende Flächen, Einmal-Hinweis)"
```

---

### Task 10: Stempel-UI — Popover, StampLayer, Karten-Overlay

**Files:**
- Create: `src/lib/components/StampLayer.svelte`, `src/lib/components/StampPopover.svelte`
- Modify: `src/lib/components/DocViewer.svelte` (Stempel-Knopf + Klick-Platzierung)
- Modify: `src/lib/components/DocCard.svelte` (Stempel der sichtbaren Miniatur-Seite als Overlay)

**Interfaces:**
- Consumes: `STAMP_PRESETS`, `stampsFor`, Commands `addStamp`/`removeStamp`, `type Stamp` (Task 2).
- Produces: `StampPopover`-Props `{ onpick: (wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) => void; onclose: () => void }`; `StampLayer`-Props `{ docId: string; page: number; base: Size | null; renderedWidth: number; active: boolean }` (active = Stempel-Werkzeug an → Klick auf vorhandenen Stempel entfernt ihn). DocViewer hält `stampChoice = $state<{ text; color; withDate? } | null>(null)` — gewählter Stempel „klebt" am Werkzeug, jeder Seitenklick setzt einen Abdruck, erneuter Knopf-Klick schaltet ab.

- [ ] **Step 1: `StampPopover.svelte` anlegen**

```svelte
<script lang="ts">
  import { STAMP_PRESETS, STAMP_TEXT_MAX } from '@digital-desktop/core';

  let { onpick, onclose }:
    { onpick: (wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) => void; onclose: () => void } = $props();

  let freitext = $state('');
  function frei() {
    const text = freitext.trim();
    if (!text) return;
    onpick({ text: text.toUpperCase().slice(0, STAMP_TEXT_MAX), color: 'red' });
    freitext = '';
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -- Backdrop schließt nur -->
<div class="backdrop" onpointerdown={onclose}></div>
<div class="pop" role="menu" aria-label="Stempel wählen">
  {#each STAMP_PRESETS as p (p.text)}
    <button class:blau={p.color === 'blue'} onclick={() => onpick(p)} role="menuitem">
      {p.text}{#if p.withDate}&nbsp;<small>+ Datum</small>{/if}
    </button>
  {/each}
  <div class="frei">
    <input placeholder="Freitext…" maxlength={STAMP_TEXT_MAX} bind:value={freitext}
           onkeydown={(e) => { if (e.key === 'Enter') frei(); }} />
    <button onclick={frei} disabled={!freitext.trim()}>Stempeln</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 9600; }
  .pop { position: absolute; top: 34px; right: 8px; z-index: 9700; display: flex; flex-direction: column; gap: 4px;
         background: #fff; border-radius: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, .35); padding: 8px; min-width: 170px; }
  .pop > button { border: 2px solid #b3261e; color: #b3261e; background: #fff; border-radius: 4px;
                  font-weight: 700; letter-spacing: .08em; font-size: 12px; padding: 4px 8px; cursor: pointer; }
  .pop > button.blau { border-color: #1d4ed8; color: #1d4ed8; }
  .pop > button:hover { background: #f6f7fa; }
  .frei { display: flex; gap: 4px; margin-top: 4px; }
  .frei input { flex: 1; min-width: 0; font-size: 12px; padding: 4px 6px; border: 1px solid #cdd4df; border-radius: 4px; }
  .frei button { font-size: 12px; border: none; background: #e7ebf2; border-radius: 4px; cursor: pointer; padding: 4px 8px; }
  .frei button:disabled { opacity: .4; cursor: default; }
</style>
```

- [ ] **Step 2: `StampLayer.svelte` anlegen**

```svelte
<script lang="ts">
  import { stampsFor, type Size } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';

  let { docId, page, base, renderedWidth, active }:
    { docId: string; page: number; base: Size | null; renderedWidth: number; active: boolean } = $props();

  const stamps = $derived(stampsFor(desktop.state, docId, page));
  const f = $derived(base ? renderedWidth / base.w : 1);

  function datum(iso: string): string {
    const [j, m, t] = iso.split('-');
    return `${t}.${m}.${j}`;
  }
</script>

{#if base}
  {#each stamps as st (st.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -- Entfernen nur im Werkzeugmodus -->
    <div class="stamp" class:blau={st.color === 'blue'} class:active
         style:left="{st.x * f}px" style:top="{st.y * f}px"
         style:transform="translate(-50%, -50%) rotate({st.angle}deg) scale({f})"
         title={active ? 'Klick entfernt den Stempel' : undefined}
         onclick={(e) => { if (active) { e.stopPropagation(); void desktop.command('removeStamp', { stampId: st.id }); } }}>
      <span class="text">{st.text}</span>
      {#if st.date}<span class="datum">{datum(st.date)}</span>{/if}
    </div>
  {/each}
{/if}

<style>
  /* Stempeloptik: Konturschrift mit Rahmen, halbtransparent wie echte Stempelfarbe. */
  .stamp { position: absolute; pointer-events: none; display: flex; flex-direction: column; align-items: center;
           border: 3px solid #b3261e; color: #b3261e; border-radius: 6px; padding: 2px 10px; opacity: .82;
           font-weight: 800; letter-spacing: .12em; white-space: nowrap; background: rgba(255, 255, 255, .06);
           transform-origin: center; }
  .stamp.blau { border-color: #1d4ed8; color: #1d4ed8; }
  .stamp .text { font-size: 20px; }
  .stamp .datum { font-size: 11px; letter-spacing: .06em; }
  .stamp.active { pointer-events: auto; cursor: pointer; }
</style>
```

- [ ] **Step 3: `DocViewer.svelte` — Stempel-Werkzeug**

Zustände + Handler:

```ts
import StampPopover from './StampPopover.svelte';
import StampLayer from './StampLayer.svelte';

let stampMenu = $state(false);
let stampChoice = $state<{ text: string; color: 'red' | 'blue'; withDate?: boolean } | null>(null);

function pickStamp(wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) {
  stampMenu = false;
  stampChoice = wahl;
  inkTool = null; // Stempeln ist ein eigener Modus, Zeichnen aus
}

function stampAt(e: PointerEvent) {
  if (!stampChoice) return;
  e.stopPropagation();
  const p = pagePoint(e);
  if (!p || !baseSize) return;
  const heute = new Date().toISOString().slice(0, 10);
  void desktop.command('addStamp', {
    stamp: {
      id: uid(), docId: doc.id, page, x: p.x, y: p.y,
      angle: Math.random() * 12 - 6,
      text: stampChoice.text, color: stampChoice.color,
      ...(stampChoice.withDate ? { date: heute } : {}),
      baseW: baseSize.w, baseH: baseSize.h,
    },
  });
}
```

(`uid` aus `@digital-desktop/core` importieren, falls im Viewer noch nicht importiert; `pagePoint` existiert bereits für die Schere — sein `closest('.pagewrap')`-Zugriff funktioniert auch hier, weil die Stempelfläche im `pagewrap` liegt.)

Knopf in der Toolbar (eigene Gruppe nach Abdecken):

```svelte
<span class="sep"></span>
<button class:on={stampChoice !== null || stampMenu} onclick={() => { if (stampChoice) { stampChoice = null; } else { stampMenu = !stampMenu; } }}
        aria-label="Stempel" title={stampChoice ? `Stempel „${stampChoice.text}" abschalten` : 'Stempel wählen'}>✪</button>
```

Popover direkt nach dem `.head`-Element rendern: `{#if stampMenu}<StampPopover onpick={pickStamp} onclose={() => (stampMenu = false)} />{/if}` (der `.pop` positioniert sich absolut zum Viewer; dem `.viewer`-Wurzel-Div schadet das nicht, `overflow: hidden` clippt das Popover NICHT, weil es innerhalb der Viewer-Fläche liegt).

Stempelfläche im `pagewrap` (nach `MarkLayer`, vor der Schnittfläche):

```svelte
<StampLayer docId={doc.id} {page} base={baseSize} renderedWidth={pageWidth} active={stampChoice !== null} />
{#if stampChoice && baseSize}
  <div class="stempelflaeche" role="presentation" onpointerdown={stampAt}></div>
{/if}
```

```css
.stempelflaeche { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
```

Wichtig: `StampLayer` muss im DOM NACH `.stempelflaeche`... — nein: Entfernen-Klicks brauchen die Stempel ÜBER der Stempelfläche. Reihenfolge im `pagewrap`: `PageRenderer` → `InkOverlay` → `MarkLayer` → `{#if stampChoice}stempelflaeche{/if}` → `StampLayer`. Damit fängt die Fläche Klicks auf leerem Papier (setzt Stempel), vorhandene Stempel liegen darüber und fangen ihre eigenen Klicks (Entfernen) via `stopPropagation`.

- [ ] **Step 4: `DocCard.svelte` — Stempel auf der Miniatur**

Die Karte zeigt die Stempel der Miniatur-Seite (Seite 1 bzw. `pageOnly`):

```ts
import { stampsFor, CARD_W } from '@digital-desktop/core';
const kartenStempel = $derived(stampsFor(desktop.state, doc.id, doc.pageOnly ?? 1));
```

Im `.body`-Div nach dem `img`:

```svelte
{#each kartenStempel as st (st.id)}
  <div class="mini-stamp" class:blau={st.color === 'blue'}
       style:left="{(st.x / st.baseW) * 100}%" style:top="{(st.y / st.baseH) * 100}%"
       style:transform="translate(-50%, -50%) rotate({st.angle}deg) scale({CARD_W / st.baseW})">
    {st.text}
  </div>
{/each}
```

```css
.mini-stamp { position: absolute; pointer-events: none; border: 3px solid #b3261e; color: #b3261e;
              border-radius: 6px; padding: 2px 10px; opacity: .82; font-weight: 800; letter-spacing: .12em;
              font-size: 20px; white-space: nowrap; transform-origin: center; }
.mini-stamp.blau { border-color: #1d4ed8; color: #1d4ed8; }
```

Hinweis: Das `.body`-Div braucht `position: relative;` (dem bestehenden `.body`-CSS hinzufügen). Die Skalierung `CARD_W / st.baseW` bildet Basiskoordinaten auf die Miniaturbreite ab; die Miniatur ist `object-fit: cover; object-position: top` — kleine Abweichungen in der Höhe sind akzeptiert (Miniatur-Overlay, keine Präzisionsanzeige).

- [ ] **Step 5: Verifizieren + Commit**

Run: `npm test` → PASS; `npm run check` → 0 Errors; `npm run build` → ok

```bash
git add src/lib/components
git commit -m "feat: Stempel — Kanzlei-Set + Freitext, Abdruck im Viewer und auf der Miniatur"
```

---

### Task 11: Notizfahnen-UI — FlagRail im Viewer + Laschen an der Karte

**Files:**
- Create: `src/lib/components/FlagRail.svelte`
- Modify: `src/lib/components/DocViewer.svelte` (Fahnen-Werkzeug mit Farb-Popover, Setz-Fläche)
- Modify: `src/lib/components/DocCard.svelte` (Laschen am rechten Kartenrand)

**Interfaces:**
- Consumes: `flagsFor`, `FLAG_COLORS`, Commands `addFlag`/`removeFlag` (Task 3); `turn`-Mechanik des Viewers (Sprung zur Seite über `desktop.applyLocal` + debounced `setDocPage` — vorhandene `sendPage`).
- Produces: `FlagRail`-Props `{ doc: Doc; height: number; active: boolean; onjump: (page: number) => void }` — rendert ALLE Fahnen des Dokuments am rechten Rand des Viewer-Körpers; Klick: bei `active` entfernen, sonst `onjump(flag.page)`.

- [ ] **Step 1: `FlagRail.svelte` anlegen**

```svelte
<script lang="ts">
  import { flagsFor, type Doc } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';

  let { doc, height, active, onjump }:
    { doc: Doc; height: number; active: boolean; onjump: (page: number) => void } = $props();

  const flags = $derived(flagsFor(desktop.state, doc.id));
</script>

{#each flags as fl (fl.id)}
  <button class="fahne" class:active style:top="{fl.offset * height}px" style:background={fl.color}
          title={active ? 'Klick entfernt die Fahne' : `Zu Seite ${fl.page}`}
          aria-label={active ? 'Fahne entfernen' : `Zu Seite ${fl.page} springen`}
          onclick={(e) => {
            e.stopPropagation();
            if (active) void desktop.command('removeFlag', { flagId: fl.id });
            else onjump(fl.page);
          }}>{fl.page}</button>
{/each}

<style>
  /* Laschen hängen an der rechten Viewer-Kante nach innen (der Viewer clippt mit overflow: hidden —
     nach außen ragende Laschen gibt es nur an der Miniatur-Karte). */
  .fahne { position: absolute; right: 0; width: 26px; height: 18px; border: none; border-radius: 4px 0 0 4px;
           font-size: 10px; font-weight: 700; color: rgba(0, 0, 0, .65); text-align: left; padding: 0 0 0 4px;
           cursor: pointer; box-shadow: -1px 1px 3px rgba(0, 0, 0, .3); z-index: 5; }
  .fahne.active { outline: 1px dashed rgba(44, 90, 160, .8); }
</style>
```

- [ ] **Step 2: `DocViewer.svelte` — Fahnen-Werkzeug**

Zustände:

```ts
import FlagRail from './FlagRail.svelte';
import { FLAG_COLORS } from '@digital-desktop/core';

let flagMenu = $state(false);
let flagColor = $state<string | null>(null); // gewählte Farbe = Werkzeug aktiv

function setFlagAt(e: PointerEvent) {
  if (!flagColor || !baseSize) return;
  e.stopPropagation();
  const p = pagePoint(e);
  if (!p) return;
  const offset = Math.min(1, Math.max(0, p.y / baseSize.h));
  void desktop.command('addFlag', { flag: { id: uid(), docId: doc.id, page, offset, color: flagColor } });
  flagColor = null; // eine Fahne pro Aktivierung — bewusst, kein Dauer-Modus
}
```

Toolbar (Fahnen-Gruppe nach Stempel):

```svelte
<span class="sep"></span>
<button class:on={flagColor !== null || flagMenu} onclick={() => { if (flagColor) { flagColor = null; } else { flagMenu = !flagMenu; } }}
        aria-label="Notizfahne" title="Notizfahne setzen">⚑</button>
```

Farb-Popover nach dem `.head` (Muster StampPopover, aber inline und klein):

```svelte
{#if flagMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -- Backdrop schließt nur -->
  <div class="flag-backdrop" onpointerdown={() => (flagMenu = false)}></div>
  <div class="flag-pop" role="menu" aria-label="Fahnenfarbe">
    {#each FLAG_COLORS as farbe (farbe)}
      <button style:background={farbe} aria-label="Farbe wählen" onclick={() => { flagColor = farbe; flagMenu = false; }}></button>
    {/each}
  </div>
{/if}
```

```css
.flag-backdrop { position: fixed; inset: 0; z-index: 9600; }
.flag-pop { position: absolute; top: 34px; right: 8px; z-index: 9700; display: flex; gap: 6px;
            background: #fff; border-radius: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, .35); padding: 8px; }
.flag-pop button { width: 22px; height: 22px; border: none; border-radius: 4px; cursor: pointer; }
```

Setz-Fläche + Rail im Viewer: Die Rail ist ein Geschwister-Element NACH dem `.body` innerhalb des `.viewer` — so bleiben die Laschen an der Viewer-Kante stehen, auch wenn der Seiteninhalt im `.body` scrollt:

```svelte
<div class="rail" bind:clientHeight={bodyH} aria-hidden={false}>
  <FlagRail {doc} height={bodyH} active={flagColor !== null}
            onjump={(p) => { if (!seitenfix) { desktop.applyLocal((s) => setDocPage(s, doc.id, p)); pendingPage = p; sendPage(p); } }} />
</div>
```

`let bodyH = $state(0);` und CSS:

```css
.rail { position: absolute; top: 36px; right: 0; bottom: 0; width: 0; overflow: visible; }
```

(36px ≈ Kopfzeilenhöhe; die Laschen positionieren sich innerhalb der Rail absolut, `width: 0` hält sie aus dem Layoutfluss.)

Dazu die Setz-Fläche im `pagewrap` (Muster Stempelfläche):

```svelte
{#if flagColor && baseSize}
  <div class="stempelflaeche" role="presentation" onpointerdown={setFlagAt}></div>
{/if}
```

(Wiederverwendung der `.stempelflaeche`-CSS-Klasse ist gewollt — gleiche Geometrie.) `onjump` interagiert mit dem vorhandenen Debounce-Mechanismus (`pendingPage`, `sendPage`) exakt wie `turn()`.

- [ ] **Step 3: `DocCard.svelte` — Laschen an der Karte**

```ts
import { flagsFor } from '@digital-desktop/core';
const kartenFahnen = $derived(flagsFor(desktop.state, doc.id));
```

Direkt im `.card`-Div (nach `.name`):

```svelte
{#each kartenFahnen as fl (fl.id)}
  <div class="mini-fahne" style:top="{fl.offset * CARD_H}px" style:background={fl.color}></div>
{/each}
```

```css
.mini-fahne { position: absolute; right: -8px; width: 16px; height: 10px; border-radius: 0 3px 3px 0;
              box-shadow: 1px 1px 2px rgba(0, 0, 0, .3); pointer-events: none; }
```

(`CARD_H` ist in DocCard bereits importiert.)

- [ ] **Step 4: Verifizieren + Commit**

Run: `npm test` → PASS; `npm run check` → 0 Errors; `npm run build` → ok

```bash
git add src/lib/components
git commit -m "feat: Notizfahnen — Laschen setzen, zur Seite springen, an der Miniatur sichtbar"
```

---

### Task 12: Kontextmenüs & Tisch-Werkzeuge — Kopierer, Klebeband, Büroklammer, Hefter-Menü, Papierkorb-Einträge

**Files:**
- Create: `src/lib/groupDrag.ts`
- Modify: `src/lib/ui.svelte.ts` (`clippingFromId`), `src/lib/menus.ts` (alle Menüs), `src/lib/components/CutoutCard.svelte` (Menü + Guards), `src/lib/components/DocCard.svelte`, `src/lib/components/NoteCard.svelte`, `src/lib/components/StackCard.svelte`, `src/lib/components/Desktop.svelte` (Anklammern-Hinweis)

**Interfaces:**
- Consumes: Commands aus Tasks 4–6 (`copyObject`, `tapeObject`/`untapeObject`, `addClip`/`removeClip`, `trashObject`, `stapleStack`/`unstapleStack`, `expandStack`), `clipOf`, `clipMembersOf`, `isTaped`, `moveDoc`, `moveStack`, `moveNote`, `moveCutout`.
- Produces: `ui.clippingFromId: string | null`; `groupDrag.ts` mit `moveGroupLocal(memberIds, dx, dy)` (verschiebt alle Gruppen-Mitglieder lokal) und `commitGroupMove(memberIds)` (persistiert alle Positionen). Menü-Vertrag: „Vom Schreibtisch entfernen" heißt überall jetzt „In den Papierkorb" und sendet `trashObject` mit `trashedAt: new Date().toISOString()`.

- [ ] **Step 1: `src/lib/groupDrag.ts` anlegen**

```ts
import { clipMembersOf, findDoc, findStack, findNote, findCutout, moveDoc, moveStack, moveNote, moveCutout, type DesktopState } from '@digital-desktop/core';
import { desktop } from './store.svelte';

function moveAny(s: DesktopState, id: string, dx: number, dy: number): DesktopState {
  const doc = findDoc(s, id);
  if (doc) return moveDoc(s, id, { x: doc.position.x + dx, y: doc.position.y + dy });
  const st = findStack(s, id);
  if (st) return moveStack(s, id, { x: st.position.x + dx, y: st.position.y + dy });
  const n = findNote(s, id);
  if (n) return moveNote(s, id, { x: n.position.x + dx, y: n.position.y + dy });
  const c = findCutout(s, id);
  if (c) return moveCutout(s, id, { x: c.position.x + dx, y: c.position.y + dy });
  return s;
}

/** Büroklammer-Gruppenzug: alle Mitglieder folgen demselben Delta (nur lokal, ohne Server-Roundtrip). */
export function moveGroupLocal(memberIds: string[], dx: number, dy: number): void {
  desktop.applyLocal((s) => memberIds.reduce((acc, id) => moveAny(acc, id, dx, dy), s));
}

/** Persistiert die aktuellen Positionen aller Gruppen-Mitglieder nach dem Loslassen. */
export function commitGroupMove(memberIds: string[]): void {
  const s = desktop.state;
  for (const id of memberIds) {
    const doc = findDoc(s, id);
    if (doc) { void desktop.command('moveDoc', { id, position: { ...doc.position } }); continue; }
    const st = findStack(s, id);
    if (st) { void desktop.command('moveStack', { stackId: id, position: { ...st.position } }); continue; }
    const n = findNote(s, id);
    if (n) { void desktop.command('moveNote', { id, position: { ...n.position } }); continue; }
    const c = findCutout(s, id);
    if (c) void desktop.command('moveCutout', { id, position: { ...c.position } });
  }
}

/** Mitglieder der Klammer-Gruppe des Objekts (inklusive seiner selbst). */
export function groupOf(id: string): string[] {
  return clipMembersOf(desktop.state, id);
}
```

- [ ] **Step 2: `ui.svelte.ts` erweitern**

```ts
  /** Büroklammer: „Anklammern an…" wartet auf das Zielobjekt (Muster linkingFromId). */
  clippingFromId: null as string | null,
```

In `Desktop.svelte` neben dem Verknüpfen-Hinweis:

```svelte
{#if ui.clippingFromId}
  <div class="hint">Anklammern: Ziel anklicken (Esc bricht ab)</div>
{/if}
```

Und im `Escape`-Handler von `Desktop.svelte`: `ui.clippingFromId = null;` ergänzen.

- [ ] **Step 3: `menus.ts` — Menüs erweitern**

Imports ergänzen: `clipOf, isTaped, type Cutout` aus `@digital-desktop/core`; `ui` ist schon importiert.

Gemeinsame Helfer oben in `menus.ts`:

```ts
function papierkorbEintrag(objektId: string): MenuItem {
  return { label: 'In den Papierkorb', action: () => void desktop.command('trashObject', { id: objektId, trashedAt: new Date().toISOString() }) };
}

function befestigungsEintraege(objektId: string): MenuItem[] {
  const items: MenuItem[] = [];
  items.push(
    isTaped(desktop.state, objektId)
      ? { label: 'Band abziehen', action: () => void desktop.command('untapeObject', { id: objektId }) }
      : { label: 'Festkleben', action: () => void desktop.command('tapeObject', { id: objektId }) },
  );
  const clip = clipOf(desktop.state, objektId);
  items.push({ label: 'Anklammern an…', action: () => { ui.clippingFromId = objektId; } });
  if (clip) items.push({ label: 'Klammer entfernen', action: () => void desktop.command('removeClip', { clipId: clip.id }) });
  return items;
}
```

`showDocMenuAt`: Eintrag `{ label: 'Kopieren', action: () => void desktop.command('copyObject', { id: doc.id }) }` nach „Verknüpfen…" einfügen, dann `...befestigungsEintraege(doc.id)`, und „Vom Schreibtisch entfernen" durch `papierkorbEintrag(doc.id)` ersetzen.

`showStackMenuAt` komplett neu:

```ts
export function showStackMenuAt(x: number, y: number, stack: Stack): void {
  const basis: MenuItem[] = stack.stapled
    ? [
        { label: 'Aufschlagen', action: () => void desktop.command('expandStack', { id: stack.id }) },
        { label: 'Entheften', action: () => void desktop.command('unstapleStack', { stackId: stack.id }) },
      ]
    : [
        { label: 'Auffächern', action: () => { ui.fannedStackId = ui.fannedStackId === stack.id ? null : stack.id; } },
        { label: 'Heften', action: () => void desktop.command('stapleStack', { stackId: stack.id }) },
        { label: 'Stapel auflösen', action: () => void desktop.command('dissolveStack', { stackId: stack.id }) },
      ];
  ui.menu = {
    x, y,
    items: [
      ...basis,
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(stack.id) },
      { label: 'Benennen…', action: () => { ui.editingStackId = stack.id; } },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = stack.id; } },
      ...befestigungsEintraege(stack.id),
      papierkorbEintrag(stack.id),
    ],
  };
}
```

`showNoteMenuAt`: nach „Verknüpfen…" → `{ label: 'Kopieren', action: () => void desktop.command('copyObject', { id: note.id }) }`, `...befestigungsEintraege(note.id)`, Entfernen → `papierkorbEintrag(note.id)`.

Für Ausschnitte einen zentralen Menü-Bauer ergänzen (und `CutoutCard.svelte` auf ihn umstellen — die dortige lokale `menue()`-Funktion ruft künftig `showCutoutMenuAt(x, y, cutout)` auf; vorhandene Einträge der lokalen Funktion in den zentralen Bauer übernehmen):

```ts
export function showCutoutMenuAt(x: number, y: number, cutout: Cutout): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = cutout.id; } },
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: cutout.id }) },
      ...befestigungsEintraege(cutout.id),
      papierkorbEintrag(cutout.id),
    ],
  };
}
```

(Falls die bestehende CutoutCard-`menue()` weitere Einträge hat, z. B. „Vom Schreibtisch entfernen" via `removeCutout`: durch die obigen ersetzen — Entfernen läuft jetzt über den Papierkorb.)

- [ ] **Step 4: Karten-Komponenten — Klebeband-Guard, Klammer-Ziel, Gruppenzug, Optik**

Für ALLE vier Komponenten (`DocCard`, `StackCard`, `NoteCard`, `CutoutCard`) gilt dasselbe Muster; hier exemplarisch `DocCard.svelte`, die anderen analog (StackCard nutzt `moveStack`-applyLocal, NoteCard `moveNote`, CutoutCard `moveCutout` — die Komponenten haben die identische Drag-Struktur):

1. Imports: `import { moveGroupLocal, commitGroupMove, groupOf } from '../groupDrag';` und `isTaped, clipOf` zum core-Import ergänzen.
2. Abgeleitete Zustände:

```ts
const taped = $derived(doc.taped === true);
const geklammert = $derived(clipOf(desktop.state, doc.id) !== undefined);
```

3. `onPointerDown` — NACH dem Linking-Block, VOR dem Drag-Start:

```ts
if (ui.clippingFromId && ui.clippingFromId !== doc.id) {
  const from = ui.clippingFromId;
  ui.clippingFromId = null;
  desktop.command('addClip', { aId: from, bId: doc.id, id: uid() }).catch((e) => showToast(e instanceof Error ? e.message : 'Anklammern fehlgeschlagen'));
  return;
}
if (ui.clippingFromId === doc.id) { ui.clippingFromId = null; return; }
if (taped) return; // festgeklebt: kein Drag — Menü/Doppelklick bleiben möglich
```

(`showToast` aus `../ui.svelte` importieren, wo noch nicht vorhanden.)

4. `onPointerMove` — Gruppenzug statt Einzelzug, wenn geklammert:

```ts
const dx = (e.clientX - last.x) / vp.scale;
const dy = (e.clientY - last.y) / vp.scale;
last = { x: e.clientX, y: e.clientY };
if (geklammert) moveGroupLocal(groupOf(doc.id), dx, dy);
else desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + dx, y: doc.position.y + dy }));
```

5. `onPointerUp` — beim geklammerten Zug KEIN Stapel-hitTest (die Gruppe legt sich nicht auf Stapel), stattdessen:

```ts
if (geklammert) { commitGroupMove(groupOf(doc.id)); activePointer = null; return; }
```

(vor dem bestehenden hitTest-Block einfügen; NoteCard/CutoutCard/StackCard haben keinen hitTest — dort einfach `commitGroupMove` statt des einzelnen move-Commands.)

6. Optik im Markup (im `.card`-Div bzw. Wurzel-Div der jeweiligen Karte):

```svelte
{#if taped}<div class="tape" aria-hidden="true"></div>{/if}
{#if geklammert}<div class="klammer" aria-hidden="true">🖇</div>{/if}
```

```css
.tape { position: absolute; top: -8px; left: 24px; width: 64px; height: 20px; transform: rotate(-8deg);
        background: rgba(240, 235, 210, .65); border: 1px solid rgba(180, 170, 140, .5); border-radius: 2px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, .15); pointer-events: none; }
.klammer { position: absolute; top: -10px; right: 10px; font-size: 18px; pointer-events: none;
           filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
```

7. `DocViewer.svelte` Kopf-Drag: in `onHeaderPointerDown` als erste Zeile nach dem Button-Guard `if (doc.taped) return;` — auch aufgeschlagene festgeklebte Papiere bleiben liegen. Analog blockiert `StackCard`s Konvolut-Viewer-Kopf (Task 13) über dasselbe Feld.

- [ ] **Step 5: Verifizieren + Commit**

Run: `npm test` → PASS; `npm run check` → 0 Errors; `npm run build` → ok

```bash
git add src/lib
git commit -m "feat: Kopierer, Klebeband, Büroklammer und Hefter-Menü auf dem Tisch"
```

---

### Task 13: Konvolut-Viewer — Hefter im Client

**Files:**
- Create: `src/lib/pageCounts.ts`, `src/lib/components/KonvolutViewer.svelte`
- Test: `src/lib/pageCounts.test.ts`
- Modify: `src/lib/components/StackCard.svelte` (Konvolut-Optik, Doppelklick, Viewer-Einbindung, Fächer-Sperre)

**Interfaces:**
- Consumes: `konvolutPages`, `expandStack`/`collapseStack`/`setStackPage`/`resizeStack`-Commands (Task 5), `PageRenderer`, `InkOverlay`, `MarkLayer`, `StampLayer`, `moveStack`, `debounce`.
- Produces: `getPageCount(api: ApiClient, fileId: string): Promise<number>` mit Modul-Cache + In-Flight-Dedup; `invalidatePageCounts(): void` (für Tests). `KonvolutViewer`-Props `{ stack: Stack; vp: Viewport }`.

- [ ] **Step 1: Failing Test** — `src/lib/pageCounts.test.ts` (Muster `fileCache.test.ts` dieser Codebasis für API-Mocks übernehmen; pdfjs wird gemockt):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 7, destroy: vi.fn() }) })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

import * as pdfjs from 'pdfjs-dist';
import { getPageCount, invalidatePageCounts } from './pageCounts';

const api = { fetchFile: vi.fn(async () => new Uint8Array([1, 2, 3])) } as never;

describe('pageCounts', () => {
  beforeEach(() => {
    invalidatePageCounts();
    vi.clearAllMocks();
  });

  it('liefert die Seitenzahl und cacht sie (kein zweiter Abruf)', async () => {
    expect(await getPageCount(api, 'f1')).toBe(7);
    expect(await getPageCount(api, 'f1')).toBe(7);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });

  it('dedupliziert parallele Anfragen (In-Flight)', async () => {
    const [a, b] = await Promise.all([getPageCount(api, 'f2'), getPageCount(api, 'f2')]);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });
});
```

Run: `npm test -- pageCounts` → FAIL (Modul fehlt)

- [ ] **Step 2: `src/lib/pageCounts.ts` anlegen**

```ts
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { FILE_STORE, idbGet, idbPut } from './idb';
import type { ApiClient } from './api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Seitenzahlen je Datei — fürs Konvolut-Blättern. Cache + In-Flight-Dedup. */
const counts = new Map<string, number>();
const inFlight = new Map<string, Promise<number>>();

async function bytesFor(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const cached = await idbGet(FILE_STORE, fileId).catch(() => null);
  if (cached) return cached;
  const bytes = await api.fetchFile(fileId);
  await idbPut(FILE_STORE, fileId, bytes).catch(() => {});
  return bytes;
}

export function getPageCount(api: ApiClient, fileId: string): Promise<number> {
  const bekannt = counts.get(fileId);
  if (bekannt !== undefined) return Promise.resolve(bekannt);
  const laufend = inFlight.get(fileId);
  if (laufend) return laufend;
  const p = (async () => {
    const data = await bytesFor(api, fileId);
    let pdf: pdfjs.PDFDocumentProxy | undefined;
    try {
      pdf = await pdfjs.getDocument({ data }).promise;
      counts.set(fileId, pdf.numPages);
      return pdf.numPages;
    } finally {
      await pdf?.destroy?.();
      inFlight.delete(fileId);
    }
  })();
  inFlight.set(fileId, p);
  return p;
}

/** Nur für Tests. */
export function invalidatePageCounts(): void {
  counts.clear();
  inFlight.clear();
}
```

Run: `npm test -- pageCounts` → PASS

- [ ] **Step 3: `KonvolutViewer.svelte` anlegen**

Aufbau gespiegelt von `DocViewer.svelte` (Kopf-Drag → `moveStack`, Anfasser → `resizeStack`, ✕ → `collapseStack`, Blättern debounced → `setStackPage`, Pfeiltasten, Wischen), aber über die verketteten Konvolut-Seiten:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    konvolutPages, moveStack, setStackPage, DEFAULT_OPEN_SIZE, uid,
    type KonvolutPage, type Size, type Stack, type Viewport,
  } from '@digital-desktop/core';
  import { debounce } from '../debounce';
  import { desktop } from '../store.svelte';
  import { getPageCount } from '../pageCounts';
  import PageRenderer from './PageRenderer.svelte';
  import InkOverlay, { type InkTool } from './InkOverlay.svelte';
  import MarkLayer from './MarkLayer.svelte';
  import StampLayer from './StampLayer.svelte';
  import StampPopover from './StampPopover.svelte';

  let { stack, vp }: { stack: Stack; vp: Viewport } = $props();

  // Seitenzahlen aller Mitglieder laden -> pages ist null, bis alles bekannt ist
  let pageCounts = $state<Record<string, number>>({});
  $effect(() => {
    const api = desktop.api;
    if (!api) return;
    for (const docId of stack.docIds) {
      const d = desktop.state.docs.find((x) => x.id === docId);
      if (!d || d.pageOnly !== undefined || pageCounts[d.fileId] !== undefined) continue;
      void getPageCount(api, d.fileId).then((n) => { pageCounts = { ...pageCounts, [d.fileId]: n }; });
    }
  });
  const pages = $derived(konvolutPages(desktop.state, stack, pageCounts));
  const globalPage = $derived(Math.min(stack.page ?? 1, pages?.length ?? 1));
  const aktuelle = $derived<KonvolutPage | null>(pages?.[globalPage - 1] ?? null);
  const size = $derived(stack.openSize ?? DEFAULT_OPEN_SIZE);
  const pageWidth = $derived(Math.round(size.w - 20));
  let baseSize = $state<Size | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  let lichttisch = $state(false);
  let inkTool = $state<InkTool | 'tippex' | 'redact' | null>(null);
  function toggleTool(t: InkTool | 'tippex' | 'redact') { inkTool = inkTool === t ? null : t; }

  onMount(() => wrapEl?.focus({ preventScroll: true }));

  // Blättern: sofort lokal, debounced zum Server (Muster DocViewer)
  let pendingPage: number | null = null;
  const sendPage = debounce(350, (p: number) => { pendingPage = null; void desktop.command('setStackPage', { id: stack.id, page: p }); });
  onDestroy(() => {
    sendPage.cancel();
    if (pendingPage !== null && desktop.status === 'online') void desktop.command('setStackPage', { id: stack.id, page: pendingPage });
  });
  function turn(delta: number) {
    if (!pages) return;
    const next = globalPage + delta;
    if (next < 1 || next > pages.length) return;
    desktop.applyLocal((s) => setStackPage(s, stack.id, next));
    pendingPage = next;
    sendPage(next);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Kopf-Drag (Muster DocViewer, aber moveStack + taped-Guard)
  let dragging = false, moved = false, headLast = { x: 0, y: 0 };
  function onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0 || stack.taped) return;
    e.stopPropagation();
    dragging = true; moved = false;
    headLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: stack.id });
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    const dx = (e.clientX - headLast.x) / vp.scale;
    const dy = (e.clientY - headLast.y) / vp.scale;
    headLast = { x: e.clientX, y: e.clientY };
    desktop.applyLocal((s) => moveStack(s, stack.id, { x: stack.position.x + dx, y: stack.position.y + dy }));
  }
  function onHeaderPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveStack', { stackId: stack.id, position: { ...stack.position } });
  }

  // Wischen + Anfasser: identisches Muster wie DocViewer
  let swipeX = 0, swiping = false;
  function onBodyPointerDown(e: PointerEvent) { if (inkTool) return; if (e.pointerType === 'touch') { swiping = true; swipeX = e.clientX; } }
  function onBodyPointerUp(e: PointerEvent) {
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }
  let resizing = false, gripLast = { x: 0, y: 0 };
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true; gripLast = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const dx = (e.clientX - gripLast.x) / vp.scale;
    const dy = (e.clientY - gripLast.y) / vp.scale;
    gripLast = { x: e.clientX, y: e.clientY };
    const w = Math.max(220, size.w + dx);
    const h = Math.max(280, size.h + dy);
    desktop.applyLocal((s) => ({ ...s, stacks: s.stacks.map((x) => x.id === stack.id ? { ...x, openSize: { w, h } } : x) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeStack', { id: stack.id, size: { w: size.w, h: size.h } });
  }

  // Stempel (Muster DocViewer, wirkt auf das Mitglieds-Dokument der aktuellen Seite)
  let stampMenu = $state(false);
  let stampChoice = $state<{ text: string; color: 'red' | 'blue'; withDate?: boolean } | null>(null);
  function pickStamp(wahl: { text: string; color: 'red' | 'blue'; withDate?: boolean }) {
    stampMenu = false; stampChoice = wahl; inkTool = null;
  }
  function pagePoint(e: PointerEvent): { x: number; y: number } | null {
    const wrap = (e.currentTarget as HTMLElement).closest('.pagewrap');
    if (!wrap || !baseSize) return null;
    const r = wrap.getBoundingClientRect();
    const f = baseSize.w / pageWidth;
    return { x: (e.clientX - r.left) * f, y: (e.clientY - r.top) * f };
  }
  function stampAt(e: PointerEvent) {
    if (!stampChoice || !aktuelle || !baseSize) return;
    e.stopPropagation();
    const p = pagePoint(e);
    if (!p) return;
    const heute = new Date().toISOString().slice(0, 10);
    void desktop.command('addStamp', {
      stamp: {
        id: uid(), docId: aktuelle.docId, page: aktuelle.page, x: p.x, y: p.y,
        angle: Math.random() * 12 - 6, text: stampChoice.text, color: stampChoice.color,
        ...(stampChoice.withDate ? { date: heute } : {}),
        baseW: baseSize.w, baseH: baseSize.h,
      },
    });
  }
</script>

<svelte:window onkeydown={(e) => { if (document.activeElement === wrapEl) onKey(e); }} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- bewusst fokussierbar: Pfeiltasten blättern -->
<div class="viewer" class:licht={lichttisch} role="group" aria-label={stack.name || 'Konvolut'} bind:this={wrapEl} tabindex="0"
     style:left="{stack.position.x}px" style:top="{stack.position.y}px" style:z-index={stack.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" role="toolbar" tabindex="-1" aria-label="Konvolutleiste" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp} onpointercancel={onHeaderPointerUp}>
    <span class="title">📎 {stack.name || 'Konvolut'}</span>
    <span class="tools">
      <button class:on={inkTool === 'pencil'} onclick={() => toggleTool('pencil')} aria-pressed={inkTool === 'pencil'} aria-label="Bleistift" title="Bleistift">✏</button>
      <button class:on={inkTool === 'pen'} onclick={() => toggleTool('pen')} aria-pressed={inkTool === 'pen'} aria-label="Kugelschreiber" title="Kugelschreiber">✎</button>
      <button class:on={inkTool === 'marker'} onclick={() => toggleTool('marker')} aria-pressed={inkTool === 'marker'} aria-label="Textmarker" title="Textmarker"><span class="marker-chip"></span></button>
      <button class:on={inkTool === 'line'} onclick={() => toggleTool('line')} aria-pressed={inkTool === 'line'} aria-label="Lineal" title="Lineal">⟍</button>
      <button class:on={inkTool === 'eraser'} onclick={() => toggleTool('eraser')} aria-pressed={inkTool === 'eraser'} aria-label="Radierer" title="Radierer">⌫</button>
      <span class="sep"></span>
      <button class:on={inkTool === 'tippex'} onclick={() => toggleTool('tippex')} aria-pressed={inkTool === 'tippex'} aria-label="Tipp-Ex" title="Tipp-Ex"><span class="tippex-chip"></span></button>
      <button class:on={inkTool === 'redact'} onclick={() => toggleTool('redact')} aria-pressed={inkTool === 'redact'} aria-label="Schwärzung" title="Schwärzung">■</button>
      <span class="sep"></span>
      <button class:on={stampChoice !== null || stampMenu} onclick={() => { if (stampChoice) { stampChoice = null; } else { stampMenu = !stampMenu; } }} aria-label="Stempel" title="Stempel">✪</button>
      <button class:on={lichttisch} onclick={() => (lichttisch = !lichttisch)} aria-pressed={lichttisch} aria-label="Lichttisch" title="Lichttisch">◐</button>
    </span>
    <span class="pager">
      <button onclick={() => turn(-1)} disabled={!pages || globalPage <= 1} aria-label="Zurück">‹</button>
      <span class="pos">{globalPage}{#if pages} / {pages.length}{/if}</span>
      <button onclick={() => turn(1)} disabled={!pages || globalPage >= pages.length} aria-label="Weiter">›</button>
    </span>
    <button class="close" onclick={() => void desktop.command('collapseStack', { id: stack.id })} aria-label="Schließen">✕</button>
  </div>
  {#if stampMenu}<StampPopover onpick={pickStamp} onclose={() => (stampMenu = false)} />{/if}
  <div class="body" role="presentation" onwheel={(e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); }} onpointerdown={onBodyPointerDown} onpointerup={onBodyPointerUp}>
    {#if desktop.api && aktuelle}
      <div class="pagewrap">
        <PageRenderer api={desktop.api} fileId={aktuelle.fileId} page={aktuelle.page} targetWidth={pageWidth} onbasesize={(s) => (baseSize = s)} />
        <InkOverlay docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth}
                    tool={inkTool === 'tippex' || inkTool === 'redact' ? null : inkTool} />
        <MarkLayer docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth}
                   active={inkTool === 'tippex' || inkTool === 'redact' ? inkTool : null} />
        {#if stampChoice && baseSize}
          <div class="stempelflaeche" role="presentation" onpointerdown={stampAt}></div>
        {/if}
        <StampLayer docId={aktuelle.docId} page={aktuelle.page} base={baseSize} renderedWidth={pageWidth} active={stampChoice !== null} />
      </div>
    {:else}
      <div class="laden">Seiten werden gezählt…</div>
    {/if}
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} onpointercancel={onResizeUp} aria-hidden="true"></div>
</div>

<style>
  /* CSS 1:1 vom DocViewer übernehmen (viewer/head/title/tools/sep/pager/pos/body/grip/pagewrap/
     marker-chip/tippex-chip/stempelflaeche/licht) plus: */
  .laden { color: #dfe5ee; font-size: 13px; padding: 40px; }
</style>
```

(Der Style-Block wird beim Umsetzen konkret mit den kopierten DocViewer-Regeln gefüllt — bewusste Duplikation im Bestandsmuster, wie CSS-Duplikation zwischen Dialogen bereits akzeptiert ist.)

**Nachtrag (verbindlich, Lehre aus Tasks 9/10 — überstimmt den Code-Block oben, wo abweichend):**
Der Code-Block zeigt Tipp-Ex-/Schwärzungs-Knöpfe und den MarkLayer, aber KEINE Aufzieh-Fläche — ohne sie ließen sich im Konvolut Abdeckungen nur entfernen, nie anlegen. Ergänze den Rechteck-Mechanismus aus dem DocViewer, beschränkt auf `'tippex' | 'redact'` (kein Scissors im Konvolut): Zustände `schnitt`/`schnittPointer`, Handler `schnittDown/Move/Up` (bei Up: `addMark` mit `docId: aktuelle.docId, page: aktuelle.page`; Werkzeug bleibt aktiv), `schnittCss`, `.schnittflaeche`/`.schnittrahmen`-CSS wie im DocViewer. Verbindliche DOM-Reihenfolge im `pagewrap` (Stacking: ganzflächige Interaktionsflächen fangen Klicks ihrer DOM-Nachfolger NICHT ab, deshalb Layer mit eigenen Klick-Zielen ans Ende): `PageRenderer` → `InkOverlay` → `{#if rectTool && baseSize}`-Schnittflächen-Block → `MarkLayer` → `{#if stampChoice && baseSize}`-Stempelflächen-Block → `StampLayer`. svelte-ignore-Codes komma-separiert (Svelte-5-Runes).

- [ ] **Step 4: `StackCard.svelte` — Konvolut-Zustand**

1. `{#if stack.open}<KonvolutViewer {stack} {vp} />{:else} …bestehende Karte… {/if}` als äußerste Verzweigung (Muster `DocCard`).
2. Doppelklick auf die Karte: `ondblclick={() => { if (stack.stapled) void desktop.command('expandStack', { id: stack.id }); }}`.
3. Fächer-Sperre: die Auffächern-Interaktion (`ui.fannedStackId`) darf für geheftete Stapel nicht angeboten werden — Menü regelt das schon (Task 12); falls die Karte selbst eine Fan-Geste hat, mit `stack.stapled` guarden.
4. Konvolut-Optik an der zugeklappten Karte: statt Fächer-Symbol eine Heftklammer + Seitenbadge:

```svelte
{#if stack.stapled}<div class="heftklammer" aria-hidden="true">📎</div>{/if}
```

```css
.heftklammer { position: absolute; top: -8px; left: 12px; font-size: 18px; pointer-events: none;
               filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .3)); }
```

5. Stapel-Ziehen bei `stack.taped` blocken (Task-12-Muster, falls dort noch nicht geschehen).

- [ ] **Step 5: Verifizieren + Commit**

Run: `npm test` → PASS; `npm run check` → 0 Errors; `npm run build` → ok

```bash
git add src/lib
git commit -m "feat: Konvolut-Viewer — gehefteter Stapel blättert als Ganzes über alle Mitglieder"
```

---

### Task 14: Papierkorb-UI — `TrashCan.svelte` + Hineinziehen

**Files:**
- Create: `src/lib/components/TrashCan.svelte`
- Modify: `src/lib/ui.svelte.ts` (`trashRect`, `trashOpen`), `src/lib/components/Desktop.svelte` (Einbindung), `src/lib/components/DocCard.svelte`, `NoteCard.svelte`, `CutoutCard.svelte`, `StackCard.svelte` (Drop-auf-Korb beim Loslassen)

**Interfaces:**
- Consumes: Commands `trashObject`/`restoreObject`/`emptyTrash` (Task 6), `desktop.mode` (`'jlawyer'`-Erkennung wie in `Desktop.svelte` Upload-Pfad).
- Produces: `ui.trashRect: { x: number; y: number; w: number; h: number } | null` (Bildschirm-Rechteck des Korbs, vom TrashCan gepflegt), `ui.trashOpen: boolean`; Helfer `pointerUeberKorb(clientX, clientY): boolean` (Export aus `ui.svelte.ts`).

- [ ] **Step 1: `ui.svelte.ts` erweitern**

```ts
  /** Papierkorb: Bildschirm-Rechteck (Drop-Ziel) und geöffnetes Panel. */
  trashRect: null as { x: number; y: number; w: number; h: number } | null,
  trashOpen: false,
```

```ts
/** Liegt der Zeiger über dem Papierkorb? (Drop-Erkennung beim Karten-Loslassen) */
export function pointerUeberKorb(clientX: number, clientY: number): boolean {
  const r = ui.trashRect;
  return !!r && clientX >= r.x && clientX <= r.x + r.w && clientY >= r.y && clientY <= r.y + r.h;
}
```

- [ ] **Step 2: `TrashCan.svelte` anlegen**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';

  const items = $derived(desktop.state.trash ?? []);
  let el = $state<HTMLDivElement | null>(null);

  function messen() {
    if (!el) return;
    const r = el.getBoundingClientRect();
    ui.trashRect = { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  onMount(() => {
    messen();
    window.addEventListener('resize', messen);
    return () => { window.removeEventListener('resize', messen); ui.trashRect = null; };
  });

  const KIND_LABEL: Record<string, string> = { doc: 'Dokument', note: 'Zettel', cutout: 'Ausschnitt', stack: 'Stapel' };

  function zeit(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function wiederherstellen(id: string) {
    desktop.command('restoreObject', { trashId: id }).catch((e) => showToast(e instanceof Error ? e.message : 'Wiederherstellen fehlgeschlagen'));
  }

  function leeren() {
    const jl = desktop.mode === 'jlawyer'
      ? ' In j-lawyer wird nichts gelöscht — Akten-Dokumente kämen beim nächsten Abgleich als frische Karte zurück.'
      : '';
    if (!confirm(`Papierkorb endgültig leeren (${items.length} Einträge)?${jl}`)) return;
    void desktop.command('emptyTrash', {});
    ui.trashOpen = false;
  }
</script>

<div class="korb" bind:this={el}>
  <button class="eimer" onclick={() => (ui.trashOpen = !ui.trashOpen)}
          aria-label="Papierkorb" title="Papierkorb" aria-expanded={ui.trashOpen}>
    🗑{#if items.length > 0}<span class="badge">{items.length}</span>{/if}
  </button>
</div>
{#if ui.trashOpen}
  <div class="panel" role="dialog" aria-label="Papierkorb">
    {#if items.length === 0}
      <div class="leer">Der Papierkorb ist leer.</div>
    {:else}
      <ul>
        {#each items as t (t.id)}
          <li>
            <span class="art">{KIND_LABEL[t.kind] ?? t.kind}</span>
            <span class="name" title={t.name}>{t.name}</span>
            <span class="wann">{zeit(t.trashedAt)}</span>
            <button onclick={() => wiederherstellen(t.id)}>Wiederherstellen</button>
          </li>
        {/each}
      </ul>
      <button class="leeren" onclick={leeren}>Korb leeren…</button>
    {/if}
  </div>
{/if}

<style>
  /* Tisch-Stil wie DeskControls: dunkles Panel, Creme-Symbole. */
  .korb { position: fixed; right: 16px; bottom: 16px; z-index: 9000; }
  .eimer { position: relative; width: 52px; height: 52px; border: none; border-radius: 12px; cursor: pointer;
           background: rgba(20, 32, 28, .88); color: #f2e2b8; font-size: 24px;
           box-shadow: 0 4px 14px rgba(0, 0, 0, .35); }
  .badge { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; border-radius: 10px;
           background: #c0392b; color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; padding: 0 4px; }
  .panel { position: fixed; right: 16px; bottom: 76px; z-index: 9400; width: 320px; max-height: 50vh; overflow: auto;
           background: rgba(20, 32, 28, .96); color: #ece5d4; border-radius: 12px; padding: 10px;
           box-shadow: 0 10px 30px rgba(0, 0, 0, .45); font-size: 12px; }
  .leer { padding: 10px; opacity: .8; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li { display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center;
       background: rgba(255, 255, 255, .06); border-radius: 8px; padding: 6px 8px; }
  .art { opacity: .7; }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wann { opacity: .6; font-variant-numeric: tabular-nums; }
  li button, .leeren { border: none; border-radius: 6px; background: rgba(242, 226, 184, .15); color: #f2e2b8;
                       cursor: pointer; font-size: 11px; padding: 4px 8px; }
  li button:hover, .leeren:hover { background: rgba(242, 226, 184, .28); }
  .leeren { margin-top: 8px; width: 100%; }
</style>
```

- [ ] **Step 3: `Desktop.svelte` einbinden**

`import TrashCan from './TrashCan.svelte';` und nach `<DeskControls …/>`: `<TrashCan />`. (Falls `DeskControls` unten rechts sitzt und kollidiert: Der Korb sitzt laut Spec unten rechts — `DeskControls` prüfen; sitzt das Bedienfeld unten MITTIG oder LINKS, bleibt es unangetastet. Kollidiert es rechts, den Korb per `right: 16px` und das Bedienfeld unverändert lassen, aber den Korb 70px höher setzen: `bottom: 86px` — Sichtprüfung in der E2E-Runde.)

- [ ] **Step 4: Drop-auf-Korb in den vier Karten-Komponenten**

In `onPointerUp` JEDER Karte (DocCard, NoteCard, CutoutCard, StackCard) direkt nach der `moved`-Prüfung und VOR hitTest/move-Command:

```ts
if (pointerUeberKorb(e.clientX, e.clientY)) {
  void desktop.command('trashObject', { id: doc.id, trashedAt: new Date().toISOString() });
  activePointer = null;
  return;
}
```

(`pointerUeberKorb` aus `../ui.svelte` importieren; bei NoteCard/CutoutCard/StackCard die jeweilige Objekt-id verwenden. Beim Klammer-Gruppenzug aus Task 12 gilt: Der Korb-Drop wirft nur das gezogene Objekt hinein — `trashObject` nimmt es automatisch aus seiner Klammer-Gruppe; die übrigen Mitglieder bleiben liegen. Der Gruppen-`commitGroupMove` läuft in diesem Fall NICHT — `return` vor dem Gruppen-Commit einbauen bzw. den Korb-Check VOR den Gruppen-Zweig setzen.)

- [ ] **Step 5: Verifizieren + Commit**

Run: `npm test` → PASS; `npm run check` → 0 Errors; `npm run build` → ok

```bash
git add src/lib
git commit -m "feat: Papierkorb — Korb mit Inhalt, Wiederherstellen und Leeren"
```

---

### Task 15: E2E-Verifikation, UAT-Block A9, Abschluss

**Files:**
- Modify: `docs/uat/2026-07-18-uat-sammelliste.md` (Block A9, Zählung), `.superpowers/sdd/progress.md` (Abschnitt Werkzeugkasten)

**Interfaces:** keine neuen — reine Verifikations- und Doku-Runde.

- [ ] **Step 1: Automatisierte Gesamtprüfung**

Run: `npm test` → alle Workspaces PASS (Core deutlich > 219 Tests). `npm run check` → 0 Errors. `npm run build` → ok. `DATA_DIR=/tmp/dd-wz npm run server` starten und per HTTP-Smoke eine Command-Kette gegen `/api/v1/…` prüfen (Muster IV-Task 7): `addDoc → addMark → addStamp → addFlag → stapleStack (nach 2. addDoc + stackDocs) → expandStack → trashObject → restoreObject` — jeweils Status 200 und Felder im zurückgegebenen State.

- [ ] **Step 2: Chrome-E2E-Vorprüfung (Browser-Automatisierung, Muster A5–A8)**

Checks, jeweils mit zweitem Fenster-Kontext für Live-Sync, wo sinnvoll: (1) Bleistift/Kugelschreiber/Lineal zeichnen — Lineal ergibt exakte Gerade; (2) Tipp-Ex + Schwärzung decken ab, Ablösen per Klick im Werkzeugmodus, Einmal-Hinweis erscheint genau einmal; (3) Stempel EINGANG mit Datum auf Seite 1 → auch auf Miniatur sichtbar; Freitext-Stempel; Entfernen; (4) Fahne setzen → Lasche an Karte, Klick im Viewer springt zur Seite; (5) Stapel heften → Konvolut blättert über beide Dokumente, Annotation auf Konvolut-Seite landet beim Mitglied (nach Entheften prüfen); (6) Klammer-Gruppe zieht gemeinsam; Klebeband sperrt Drag; (7) Kopieren dupliziert Karte samt Stempel; (8) Karte in Korb ziehen → Badge 1, Wiederherstellen legt zurück, Leeren mit confirm; (9) Reload: alles liegt wie zuvor; Zweitfenster folgt live.

- [ ] **Step 3: UAT-Block A9 in `docs/uat/2026-07-18-uat-sammelliste.md`**

Neuen Abschnitt „A9 — Werkzeugkasten-Runde (NEU, automatisiert in Chrome vorgeprüft)" nach A8 einfügen mit genau diesen Punkten (Zählung im Kopf der Datei und in der Block-A-Überschrift entsprechend erhöhen):

```markdown
### A9 — Werkzeugkasten-Runde (NEU, automatisiert in Chrome vorgeprüft)

- [ ] A9.1 Bleistift (grau) und Kugelschreiber (dunkelblau) zeichnen; Radierer entfernt beide.
- [ ] A9.2 Lineal: Ziehen ergibt eine exakte Gerade (Vorschau schon während des Ziehens gerade).
- [ ] A9.3 Tipp-Ex deckt weiß, Schwärzung schwarz; Radierer lässt beide stehen; Ablösen nur per Klick im jeweiligen Werkzeugmodus. Beim ersten Schwärzen erscheint der Hinweis „Text bleibt im PDF" (nur einmal).
- [ ] A9.4 Stempel: EINGANG trägt das Tagesdatum; Freitext-Stempel funktioniert; Stempel auf Seite 1 erscheint auf der Miniatur-Karte; im Stempelmodus entfernt ein Klick den Abdruck.
- [ ] A9.5 Notizfahne: Farbe wählen, an den Seitenrand setzen → Lasche an Karte und im Viewer; Klick auf Lasche springt zur Seite; im Fahnenmodus entfernt der Klick sie.
- [ ] A9.6 Hefter: Stapel heften → Karte zeigt 📎, kein Auffächern mehr; Doppelklick blättert als Konvolut über ALLE Mitglieder (Seitenzahl „g / G" stimmt); Zeichnen/Stempeln auf einer Konvolut-Seite bleibt nach Entheften beim richtigen Dokument.
- [ ] A9.7 Büroklammer: „Anklammern an…" → beide Objekte ziehen gemeinsam (Abstände bleiben); „Klammer entfernen" löst die Gruppe.
- [ ] A9.8 Klebeband: „Festkleben" sperrt das Ziehen (Maus und Finger), Klebestreifen sichtbar; „Band abziehen" gibt frei.
- [ ] A9.9 Kopierer: „Kopieren" auf Karte mit Stempel/Strichen → Duplikat samt Annotationen liegt versetzt daneben; Kopie eines Zettels und eines Ausschnitts.
- [ ] A9.10 Papierkorb: Karte hineinziehen ODER „In den Papierkorb" → Badge zählt; Panel zeigt Art/Name/Zeit; Wiederherstellen legt zurück (Schnüre sind weg — ok?); „Korb leeren…" fragt nach und löscht endgültig.
- [ ] A9.11 j-lawyer-Modus: Akten-Karte in den Korb → Abgleich legt KEINE neue Karte an; nach „Leeren" kommt das Dokument beim nächsten Abgleich als frische Karte (gewollt — im Dialog erklärt).
- [ ] A9.12 Reload + Zweitfenster: Marks, Stempel, Fahnen, Konvolut-Zustand, Klammern, Klebeband und Korb-Inhalt überleben ein Neuladen und erscheinen im Zweitfenster live.
- [ ] A9.13 **Produktentscheidungen bestätigen:** Fahne = eine pro Aktivierung ok? Stempel-Optik/Sortiment ok? Konvolut ohne Enthefter/Schere im Kopf ok (nur am Einzeldokument)?
```

- [ ] **Step 4: `.superpowers/sdd/progress.md` ergänzen**

Neuer Abschnitt „# Werkzeugkasten-Runde (Plan: docs/superpowers/plans/2026-07-18-werkzeugkasten.md, Branch feature/inline-viewer)" mit einer Zeile je erledigtem Task (Commit-Bereiche, Review-Ergebnis, notierte Minors) — Muster der bestehenden Abschnitte.

- [ ] **Step 5: Commit**

```bash
git add docs/uat docs/superpowers .superpowers/sdd/progress.md
git commit -m "docs: UAT-Block A9 Werkzeugkasten-Runde, Progress aktualisiert"
```

---

## Plan-Selbstprüfung (beim Schreiben erledigt)

- **Spec-Abdeckung:** marks (T1/T9), stamps (T2/T10), flags (T3/T11), clips+tape (T4/T12), Hefter/Konvolut (T5/T13), trash+copy (T6/T12/T14), j-lawyer-Abgleich (T7), Bleistift/Kugelschreiber/Lineal (T8), UAT (T15). Zurückgestellt laut Spec: Scanner/Locher/Schredder, MCP-Anbindung.
- **Bewusste Abweichungen vom Spec-Wortlaut:** (a) Fahnen-Setzfläche ist die ganze Seite, nicht nur „der rechte Rand" — der Klickpunkt bestimmt nur den vertikalen Offset; einfacher und robuster. (b) Laschen ragen im VIEWER nach innen (overflow: hidden clippt), an der Miniatur-Karte nach außen. (c) Eine Fahne pro Aktivierung (kein Dauer-Modus) — als Produktfrage in A9.13. Alle drei bei UAT bestätigen lassen.
- **Typ-Konsistenz:** Command-Namen und Payload-Felder zwischen Core-Tasks und UI-Tasks abgeglichen (`trashObject {id, trashedAt, trashId?}`, `addClip {aId, bId, id?}`, `expandStack {id}` vs. `stapleStack {stackId}` — Uneinheitlichkeit stackId/id folgt dem Bestand: `dissolveStack {stackId}` vs. `expandDoc {id}`).

