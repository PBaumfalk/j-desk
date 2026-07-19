# Inline-Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein PDF auf dem Schreibtisch „aufschlagen" — die Karte wächst an ihrer Position zu einer großen, lesbaren Karte; eine Seite groß, blättern per Pfeil/Taste/Wischen, Größe ziehbar, mehrere gleichzeitig offen; Offen-Zustand, Größe und Seite reisen im gespeicherten, live-synchronisierten Schreibtisch mit.

**Architecture:** Drei optionale Felder an `Doc` (`open`/`openSize`/`page`), vier neue reine Zustandsfunktionen in `packages/core/src/viewer.ts` plus vier Command-Handler in `commands.ts` (server-validiert wie alle anderen). Client: neue Komponente `PageRenderer.svelte` (rendert eine PDF-Seite via pdfjs auf ein Canvas, mit IndexedDB-Bytes + kleinem In-Memory-Cache) und `DocViewer.svelte` (die große aufgeschlagene Karte); `DocCard.svelte` delegiert bei `doc.open` an `DocViewer`. Live-Sync und Persistenz laufen über den bestehenden Command-/WebSocket-Weg.

**Tech Stack:** TypeScript, `@digital-desktop/core` (pure), Svelte 5 (Runes), `pdfjs-dist`, Vitest, Fastify/SQLite (Server unverändert außer Command-Weiterreichung, die generisch ist).

**Spec:** `docs/superpowers/specs/2026-07-17-inline-viewer-design.md`

## Global Constraints

- Node ≥ 20; npm-Workspace-Monorepo (`packages/core`, `packages/server`, `packages/mcp` + Wurzel-Client). `packages/mcp` wird NICHT angefasst.
- UI-Texte, Kommentare, Commit-Messages auf Deutsch; Commit-Präfixe `feat:`/`fix:`/`docs:` wie im Repo.
- Neue `Doc`-Felder sind OPTIONAL (`open?`, `openSize?`, `page?`) — bestehende Schreibtische bleiben gültig, keine Migration. `isValidState` bleibt unverändert (prüft nur `id`/`fileId`/`name`).
- Command-Namen exakt: `expandDoc`, `collapseDoc`, `setDocPage`, `resizeDoc` (kollidieren nicht mit der Client-Funktion `openDoc` in `menus.ts`).
- Kernmodell verhindert `page < 1`; die Obergrenze (Seitenzahl) klemmt der Client anhand von pdfjs.
- `openSize` erzwingt positive Maße; Standardgröße beim ersten Aufschlagen: `{ w: 560, h: 720 }`.
- Reine Zustandslogik in `packages/core` bleibt browser-frei und unit-getestet; Server reicht Commands generisch über `applyCommand` weiter (kein Server-Code nötig für neue Commands).
- Tests: `npm test` (Vitest) nach jedem Task grün. Typprüfung `npm run check` ab Task 6 (Client) vollständig grün außer den vorbestehenden 9 ARIA-Warnungen.

---

### Task 1: Datenmodell — optionale Viewer-Felder an `Doc`

**Files:**
- Modify: `packages/core/src/model.ts` (Interface `Doc`, ca. Zeile 3–11)
- Test: `packages/core/src/model.test.ts` (vorhanden — Abwärtskompatibilität ergänzen)

**Interfaces:**
- Consumes: nichts Neues.
- Produces: `interface Doc` trägt zusätzlich `open?: boolean; openSize?: { w: number; h: number }; page?: number`. Typ-Alias `export interface Size { w: number; h: number }` in `model.ts` für Wiederverwendung durch `viewer.ts` und Commands.

- [ ] **Step 1: Failing Test** — in `packages/core/src/model.test.ts` ergänzen (Import `isValidState`, `emptyState` ggf. vorhanden):

```ts
import { isValidState } from './model';

describe('Doc-Viewer-Felder (Abwärtskompatibilität)', () => {
  it('akzeptiert einen Zustand OHNE die neuen Viewer-Felder', () => {
    const s = { docs: [{ id: 'a', fileId: 'f', name: 'a.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1 }], links: [], stacks: [] };
    expect(isValidState(s)).toBe(true);
  });

  it('akzeptiert einen Zustand MIT open/openSize/page', () => {
    const s = { docs: [{ id: 'a', fileId: 'f', name: 'a.pdf', position: { x: 0, y: 0 }, rotation: 0, zIndex: 1, open: true, openSize: { w: 560, h: 720 }, page: 3 }], links: [], stacks: [] };
    expect(isValidState(s)).toBe(true);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/core/src/model.test.ts`
Expected: FAIL — TypeScript akzeptiert `open`/`openSize`/`page` noch nicht als bekannte Felder (bzw. der Test kompiliert nicht).

- [ ] **Step 3: Implementierung** — in `packages/core/src/model.ts` das `Doc`-Interface erweitern und `Size` ergänzen:

```ts
export interface Size { w: number; h: number }

export interface Doc {
  id: string;
  fileId: string;      // Server-Datei (files-Tabelle)
  name: string;        // Anzeigename (Original-Dateiname)
  position: Vec2;      // Weltkoordinaten, linke obere Ecke
  rotation: number;    // Grad, feste leichte Zufallsdrehung
  zIndex: number;
  open?: boolean;      // aufgeschlagen (große Karte) statt Miniatur
  openSize?: Size;     // Größe der großen Karte (Weltkoordinaten)
  page?: number;       // aktuell sichtbare Seite, 1-basiert
}
```

`isValidState` bleibt UNVERÄNDERT (prüft weiterhin nur `id`/`fileId`/`name` als String — die neuen Felder sind additiv und werden nicht hart geprüft).

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run packages/core/src/model.test.ts && npm test`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/model.ts packages/core/src/model.test.ts
git commit -m "feat(core): optionale Viewer-Felder open/openSize/page an Doc"
```

---

### Task 2: Zustandslogik `viewer.ts` + Tests

**Files:**
- Create: `packages/core/src/viewer.ts`
- Test: `packages/core/src/viewer.test.ts` (neu)

**Interfaces:**
- Consumes: `DesktopState`, `Doc`, `Size` aus `./model` (Task 1).
- Produces vier reine Funktionen (werfen `CommandError` bei unbekanntem Dokument bzw. ungültigen Werten — importiert aus `./commands`):
  - `expandDoc(s: DesktopState, id: string): DesktopState` — setzt `open=true`; falls `openSize` fehlt → `DEFAULT_OPEN_SIZE`; falls `page` fehlt → `1`.
  - `collapseDoc(s: DesktopState, id: string): DesktopState` — setzt `open=false` (Größe/Seite bleiben erhalten).
  - `setDocPage(s: DesktopState, id: string, page: number): DesktopState` — setzt `page`; wirft bei `page < 1` oder nicht-ganzzahlig.
  - `resizeDoc(s: DesktopState, id: string, size: Size): DesktopState` — setzt `openSize`; wirft bei `w <= 0` oder `h <= 0`.
  - Export `DEFAULT_OPEN_SIZE: Size = { w: 560, h: 720 }`.

Zyklus-Vermeidung: `commands.ts` importiert aus `viewer.ts` (Task 3), NICHT umgekehrt. `viewer.ts` wirft bei fachlichen Verstößen (`page >= 1`, `w/h > 0`, Dokument existiert) eine generische `Error` und bleibt frei von `commands.ts`. Die Übersetzung in `CommandError` (und die Eingabe-Typprüfung) macht die Command-Schicht in Task 3. Die Tests hier erwarten daher nur `toThrow()` (ohne Fehlerklasse).

- [ ] **Step 1: Failing Test** — `packages/core/src/viewer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { expandDoc, collapseDoc, setDocPage, resizeDoc, DEFAULT_OPEN_SIZE } from './viewer';

const pos = { x: 0, y: 0 };
function withDoc() { return addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a'); }

describe('expandDoc', () => {
  it('schlägt ein Dokument auf und setzt Standardgröße + Seite 1', () => {
    const s = expandDoc(withDoc(), 'id-a');
    expect(s.docs[0].open).toBe(true);
    expect(s.docs[0].openSize).toEqual(DEFAULT_OPEN_SIZE);
    expect(s.docs[0].page).toBe(1);
  });

  it('behält vorhandene Größe und Seite beim erneuten Aufschlagen', () => {
    let s = expandDoc(withDoc(), 'id-a');
    s = resizeDoc(s, 'id-a', { w: 800, h: 600 });
    s = setDocPage(s, 'id-a', 4);
    s = collapseDoc(s, 'id-a');
    s = expandDoc(s, 'id-a');
    expect(s.docs[0].openSize).toEqual({ w: 800, h: 600 });
    expect(s.docs[0].page).toBe(4);
    expect(s.docs[0].open).toBe(true);
  });

  it('wirft bei unbekanntem Dokument', () => {
    expect(() => expandDoc(emptyState(), 'fehlt')).toThrow();
  });
});

describe('collapseDoc', () => {
  it('klappt zu, ohne Größe/Seite zu verlieren', () => {
    let s = setDocPage(expandDoc(withDoc(), 'id-a'), 'id-a', 2);
    s = collapseDoc(s, 'id-a');
    expect(s.docs[0].open).toBe(false);
    expect(s.docs[0].page).toBe(2);
  });
  it('wirft bei unbekanntem Dokument', () => {
    expect(() => collapseDoc(emptyState(), 'fehlt')).toThrow();
  });
});

describe('setDocPage', () => {
  it('setzt die Seite', () => {
    const s = setDocPage(expandDoc(withDoc(), 'id-a'), 'id-a', 7);
    expect(s.docs[0].page).toBe(7);
  });
  it('lehnt page < 1 und nicht-ganzzahlige Seiten ab', () => {
    const s = expandDoc(withDoc(), 'id-a');
    expect(() => setDocPage(s, 'id-a', 0)).toThrow();
    expect(() => setDocPage(s, 'id-a', -3)).toThrow();
    expect(() => setDocPage(s, 'id-a', 1.5)).toThrow();
  });
  it('wirft bei unbekanntem Dokument', () => {
    expect(() => setDocPage(emptyState(), 'fehlt', 1)).toThrow();
  });
});

describe('resizeDoc', () => {
  it('setzt die Größe', () => {
    const s = resizeDoc(expandDoc(withDoc(), 'id-a'), 'id-a', { w: 640, h: 480 });
    expect(s.docs[0].openSize).toEqual({ w: 640, h: 480 });
  });
  it('lehnt nicht-positive Maße ab', () => {
    const s = expandDoc(withDoc(), 'id-a');
    expect(() => resizeDoc(s, 'id-a', { w: 0, h: 480 })).toThrow();
    expect(() => resizeDoc(s, 'id-a', { w: 640, h: -1 })).toThrow();
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/core/src/viewer.test.ts`
Expected: FAIL — `./viewer` existiert nicht.

- [ ] **Step 3: Implementierung** — `packages/core/src/viewer.ts`:

```ts
import type { DesktopState, Size } from './model';

export const DEFAULT_OPEN_SIZE: Size = { w: 560, h: 720 };

function mapDoc(s: DesktopState, id: string, fn: (d: DesktopState['docs'][number]) => DesktopState['docs'][number]): DesktopState {
  let found = false;
  const docs = s.docs.map((d) => (d.id === id ? ((found = true), fn(d)) : d));
  if (!found) throw new Error(`Dokument "${id}" nicht gefunden`);
  return { ...s, docs };
}

export function expandDoc(s: DesktopState, id: string): DesktopState {
  return mapDoc(s, id, (d) => ({
    ...d,
    open: true,
    openSize: d.openSize ?? DEFAULT_OPEN_SIZE,
    page: d.page ?? 1,
  }));
}

export function collapseDoc(s: DesktopState, id: string): DesktopState {
  return mapDoc(s, id, (d) => ({ ...d, open: false }));
}

export function setDocPage(s: DesktopState, id: string, page: number): DesktopState {
  if (!Number.isInteger(page) || page < 1) throw new Error(`Ungültige Seite: ${page}`);
  return mapDoc(s, id, (d) => ({ ...d, page }));
}

export function resizeDoc(s: DesktopState, id: string, size: Size): DesktopState {
  if (!(size.w > 0) || !(size.h > 0)) throw new Error(`Ungültige Größe: ${size.w}×${size.h}`);
  return mapDoc(s, id, (d) => ({ ...d, openSize: { w: size.w, h: size.h } }));
}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run packages/core/src/viewer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/viewer.ts packages/core/src/viewer.test.ts
git commit -m "feat(core): viewer.ts — expand/collapse/setPage/resize als reine Zustandslogik"
```

---

### Task 3: Commands verdrahten + Export

**Files:**
- Modify: `packages/core/src/commands.ts` (Import + `handlers`-Objekt)
- Modify: `packages/core/src/index.ts` (Export von `viewer`)
- Test: `packages/core/src/commands.test.ts` (vorhanden — neue Command-Fälle ergänzen)

**Interfaces:**
- Consumes: `expandDoc`, `collapseDoc`, `setDocPage`, `resizeDoc` aus `./viewer` (Task 2); Validierungshelfer `id`, `text`, `vec`, `CommandError` sind in `commands.ts` vorhanden.
- Produces: vier neue Command-Typen, aufrufbar über `applyCommand(state, { type, payload })`:
  - `expandDoc` — payload `{ id }`
  - `collapseDoc` — payload `{ id }`
  - `setDocPage` — payload `{ id, page }` (`page`: endliche Zahl; `viewer.setDocPage` erzwingt `>= 1` ganzzahlig)
  - `resizeDoc` — payload `{ id, size: { w, h } }`
  Neuer Helfer `num(v, field)` in `commands.ts` (endliche Zahl) und `size(v, field)` (Objekt `{w,h}` aus endlichen Zahlen). `packages/core/src/index.ts` exportiert `./viewer`.

- [ ] **Step 1: Failing Test** — in `packages/core/src/commands.test.ts` ergänzen:

```ts
import { applyCommand, CommandError } from './commands';
import { emptyState } from './model';
import { addDoc } from './documents';

describe('Viewer-Commands', () => {
  const base = () => addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'id-a');

  it('expandDoc / collapseDoc', () => {
    let s = applyCommand(base(), { type: 'expandDoc', payload: { id: 'id-a' } });
    expect(s.docs[0].open).toBe(true);
    expect(s.docs[0].page).toBe(1);
    s = applyCommand(s, { type: 'collapseDoc', payload: { id: 'id-a' } });
    expect(s.docs[0].open).toBe(false);
  });

  it('setDocPage setzt die Seite und lehnt page < 1 ab', () => {
    const s = applyCommand(base(), { type: 'expandDoc', payload: { id: 'id-a' } });
    expect(applyCommand(s, { type: 'setDocPage', payload: { id: 'id-a', page: 5 } }).docs[0].page).toBe(5);
    expect(() => applyCommand(s, { type: 'setDocPage', payload: { id: 'id-a', page: 0 } })).toThrow();
  });

  it('setDocPage wirft CommandError bei fehlender/ungültiger Zahl', () => {
    const s = applyCommand(base(), { type: 'expandDoc', payload: { id: 'id-a' } });
    expect(() => applyCommand(s, { type: 'setDocPage', payload: { id: 'id-a' } })).toThrow(CommandError);
  });

  it('resizeDoc setzt die Größe und lehnt nicht-positive Maße ab', () => {
    const s = applyCommand(base(), { type: 'expandDoc', payload: { id: 'id-a' } });
    expect(applyCommand(s, { type: 'resizeDoc', payload: { id: 'id-a', size: { w: 700, h: 500 } } }).docs[0].openSize).toEqual({ w: 700, h: 500 });
    expect(() => applyCommand(s, { type: 'resizeDoc', payload: { id: 'id-a', size: { w: 0, h: 500 } } })).toThrow();
  });

  it('resizeDoc wirft CommandError bei fehlendem size', () => {
    const s = applyCommand(base(), { type: 'expandDoc', payload: { id: 'id-a' } });
    expect(() => applyCommand(s, { type: 'resizeDoc', payload: { id: 'id-a' } })).toThrow(CommandError);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/core/src/commands.test.ts`
Expected: FAIL — `Unbekanntes Kommando: expandDoc` bzw. Helfer fehlen.

- [ ] **Step 3: Implementierung** — in `packages/core/src/commands.ts`:

Import ergänzen (zu den bestehenden Imports):

```ts
import { expandDoc, collapseDoc, setDocPage, resizeDoc } from './viewer';
import type { Size } from './model';
```

Zwei Helfer ergänzen (bei den vorhandenen `id`/`text`/`vec`):

```ts
function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CommandError(`Feld "${field}" fehlt oder ist keine Zahl`);
  return v;
}

function size(v: unknown, field: string): Size {
  const p = v as Size | undefined;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.w) || !Number.isFinite(p.h)) {
    throw new CommandError(`Feld "${field}" fehlt oder ist keine Größe {w, h}`);
  }
  return { w: p.w, h: p.h };
}
```

Im `handlers`-Objekt vier Einträge ergänzen. Da `viewer.ts` bei fachlich ungültigen Werten (`page < 1`, `w/h <= 0`, Dokument fehlt) eine generische `Error` wirft, in einen `CommandError` übersetzen, damit die Command-Schicht einheitlich `CommandError` liefert:

```ts
  expandDoc: (s, p) => wrap(() => expandDoc(s, id(p.id, 'id'))),
  collapseDoc: (s, p) => wrap(() => collapseDoc(s, id(p.id, 'id'))),
  setDocPage: (s, p) => wrap(() => setDocPage(s, id(p.id, 'id'), num(p.page, 'page'))),
  resizeDoc: (s, p) => wrap(() => resizeDoc(s, id(p.id, 'id'), size(p.size, 'size'))),
```

Und den kleinen Übersetzungshelfer `wrap` oberhalb des `handlers`-Objekts ergänzen (fängt die fachlichen `Error` aus `viewer.ts` und macht daraus `CommandError`; ein bereits geworfener `CommandError` bleibt unverändert):

```ts
function wrap(fn: () => DesktopState): DesktopState {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError(e instanceof Error ? e.message : 'Ungültige Aktion');
  }
}
```

- [ ] **Step 4: Export ergänzen** — in `packages/core/src/index.ts` eine Zeile hinzufügen:

```ts
export * from './viewer';
```

- [ ] **Step 5: Tests laufen lassen — müssen bestehen**

Run: `npx vitest run packages/core/src/commands.test.ts && npm test`
Expected: PASS (alle)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/commands.ts packages/core/src/index.ts packages/core/src/commands.test.ts
git commit -m "feat(core): Viewer-Commands expandDoc/collapseDoc/setDocPage/resizeDoc verdrahtet"
```

---

### Task 4: Server-Durchreichung verifizieren (Regressionstest, kein Produktivcode)

Der Server wendet Commands generisch über `applyCommand` an (`packages/server/src/deskStore.ts`) und speichert den Zustand als JSON. Die neuen Commands funktionieren daher ohne Server-Änderung — dieser Task sichert das mit einem Test ab.

**Files:**
- Test: `packages/server/src/deskStore.test.ts` (vorhanden — Fall ergänzen)

**Interfaces:**
- Consumes: `applyDeskCommand`, `getDeskState`, `createDesk` (Muster aus vorhandenen Tests in `deskStore.test.ts`).
- Produces: nichts — reiner Regressionstest.

- [ ] **Step 1: Failing/Absicherungs-Test** — in `packages/server/src/deskStore.test.ts` ergänzen (bestehendes Test-Setup/Helper der Datei wiederverwenden; unten das Muster mit In-Memory-DB):

```ts
import { openDb } from './db';
import { createDesk, applyDeskCommand, getDeskState } from './deskStore';
import { addDoc, emptyState } from '@digital-desktop/core';

describe('deskStore reicht Viewer-Commands durch', () => {
  it('expandDoc/setDocPage/resizeDoc landen im gespeicherten Zustand', () => {
    const db = openDb(':memory:');
    const desk = createDesk(db, 'Test', 'user-1');
    // Dokument über putState/Command einbringen: erst per addDoc-Command-Äquivalent
    applyDeskCommand(db, desk.id, { type: 'addDoc', payload: { fileId: 'f', name: 'a.pdf', position: { x: 0, y: 0 }, id: 'id-a' } });
    applyDeskCommand(db, desk.id, { type: 'expandDoc', payload: { id: 'id-a' } });
    applyDeskCommand(db, desk.id, { type: 'setDocPage', payload: { id: 'id-a', page: 3 } });
    applyDeskCommand(db, desk.id, { type: 'resizeDoc', payload: { id: 'id-a', size: { w: 800, h: 600 } } });
    const { state } = getDeskState(db, desk.id)!;
    expect(state.docs[0]).toMatchObject({ open: true, page: 3, openSize: { w: 800, h: 600 } });
    db.close();
  });
});
```

(Falls die Signaturen von `createDesk`/`applyDeskCommand`/`getDeskState` in der Datei abweichen, das exakte Muster aus den bestehenden Tests derselben Datei übernehmen — Signaturen dort sind maßgeblich. `addDoc`/`emptyState` werden hier nur importiert, falls ein direkter Zustandsaufbau nötig ist; der Command-Weg über `addDoc` ist vorzuziehen.)

- [ ] **Step 2: Test laufen lassen**

Run: `npx vitest run packages/server/src/deskStore.test.ts`
Expected: PASS (belegt, dass keine Server-Änderung nötig ist). Falls FAIL wegen abweichender Helper-Signaturen: Test an das vorhandene Muster der Datei angleichen, nicht den Produktivcode ändern.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/deskStore.test.ts
git commit -m "test(server): Viewer-Commands werden generisch durchgereicht und persistiert"
```

---

### Task 5: `PageRenderer.svelte` — eine PDF-Seite scharf rendern (+ In-Memory-Cache als reine Funktion)

**Files:**
- Create: `src/lib/pageCache.ts` (reine Cache-Logik, testbar)
- Test: `src/lib/pageCache.test.ts` (neu)
- Create: `src/lib/components/PageRenderer.svelte`

**Interfaces:**
- Consumes: die PDF-Bytes-Beschaffung wie in `thumbnails.ts` (IndexedDB-Cache `FILE_STORE`/`idbGet` + `api.fetchFile`), `pdfjs` + `workerUrl` wie in `thumbnails.ts` (Zeilen 1–7 dort als Vorbild).
- Produces:
  - `pageCache.ts`: `pageCacheKey(fileId: string, page: number, targetWidth: number): string` (z. B. `` `${fileId}:${page}:${targetWidth}` ``) und eine kleine LRU-artige Map-Hülle `class PageBitmapCache { get(key): ImageBitmap | undefined; set(key, bmp): void }` mit Obergrenze (z. B. 12 Einträge, ältester fliegt). Reine Logik, ohne DOM.
  - `PageRenderer.svelte`: Props `{ api: ApiClient; fileId: string; page: number; targetWidth: number; onpagecount?: (n: number) => void }`. Rendert Seite `page` von `fileId` in Breite `targetWidth` (× devicePixelRatio) auf ein `<canvas>`; meldet die Gesamtseitenzahl einmalig via `onpagecount`. Fehlerpfad: Platzhalter-Text „Seite kann nicht angezeigt werden". Die gerenderte Seite liegt in einem `<div class="page">` mit `position: relative` (Struktur-Leitplanke für spätere Annotations-Canvas).

- [ ] **Step 1: Failing Test** — `src/lib/pageCache.test.ts`:

```ts
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
```

Insertion-Order-Verdrängung (Map behält Einfügereihenfolge) genügt — kein echtes LRU nötig.

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/lib/pageCache.test.ts`
Expected: FAIL — `./pageCache` existiert nicht.

- [ ] **Step 3: Implementierung** — `src/lib/pageCache.ts`:

```ts
export function pageCacheKey(fileId: string, page: number, targetWidth: number): string {
  return `${fileId}:${page}:${targetWidth}`;
}

/** Kleiner Bitmap-Cache mit Insertion-Order-Verdrängung (kein echtes LRU nötig). */
export class PageBitmapCache {
  private map = new Map<string, ImageBitmap>();
  constructor(private max = 12) {}

  get(key: string): ImageBitmap | undefined {
    return this.map.get(key);
  }

  set(key: string, bmp: ImageBitmap): void {
    this.map.set(key, bmp);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
```

- [ ] **Step 4: Cache-Test grün**

Run: `npx vitest run src/lib/pageCache.test.ts`
Expected: PASS

- [ ] **Step 5: `PageRenderer.svelte` anlegen** — `src/lib/components/PageRenderer.svelte`:

```svelte
<script lang="ts">
  import * as pdfjs from 'pdfjs-dist';
  import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
  import { FILE_STORE, idbGet, idbPut } from '../idb';
  import type { ApiClient } from '../api';
  import { pageCacheKey, PageBitmapCache } from '../pageCache';

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  let { api, fileId, page, targetWidth, onpagecount }:
    { api: ApiClient; fileId: string; page: number; targetWidth: number; onpagecount?: (n: number) => void } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let failed = $state(false);
  const cache = new PageBitmapCache();
  let renderToken = 0;

  async function bytesFor(id: string): Promise<Uint8Array> {
    const cached = await idbGet(FILE_STORE, id).catch(() => null);
    if (cached) return cached;
    const bytes = await api.fetchFile(id);
    await idbPut(FILE_STORE, id, bytes).catch(() => {});
    return bytes;
  }

  async function render(): Promise<void> {
    const token = ++renderToken;
    failed = false;
    try {
      const key = pageCacheKey(fileId, page, targetWidth);
      let bmp = cache.get(key);
      if (!bmp) {
        const data = await bytesFor(fileId);
        const pdf = await pdfjs.getDocument({ data }).promise;
        if (token !== renderToken) return;
        onpagecount?.(pdf.numPages);
        const p = Math.min(Math.max(1, page), pdf.numPages); // clampen auf 1..Seitenzahl
        const pg = await pdf.getPage(p);
        const scale = (targetWidth * (window.devicePixelRatio || 1)) / pg.getViewport({ scale: 1 }).width;
        const viewport = pg.getViewport({ scale });
        const off = document.createElement('canvas');
        off.width = Math.ceil(viewport.width);
        off.height = Math.ceil(viewport.height);
        await pg.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport }).promise;
        if (token !== renderToken) return;
        bmp = await createImageBitmap(off);
        cache.set(key, bmp);
      }
      if (token !== renderToken || !canvas) return;
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    } catch {
      if (token === renderToken) failed = true;
    }
  }

  $effect(() => {
    // Abhängig von fileId/page/targetWidth neu rendern
    fileId; page; targetWidth;
    if (canvas) void render();
  });
</script>

<div class="page" style:width="{targetWidth}px">
  {#if failed}
    <div class="ph">Seite kann nicht angezeigt werden</div>
  {:else}
    <canvas bind:this={canvas}></canvas>
  {/if}
</div>

<style>
  .page { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .2); }
  canvas { display: block; width: 100%; height: auto; }
  .ph { display: flex; align-items: center; justify-content: center; min-height: 200px;
        color: #a33; font-size: 13px; padding: 20px; text-align: center; }
</style>
```

- [ ] **Step 6: Tests + Typprüfung**

Run: `npm test && npm run check`
Expected: Vitest PASS; `svelte-check` bringt außer den 9 vorbestehenden ARIA-Warnungen keine neuen Fehler in `pageCache.ts`/`PageRenderer.svelte`. (Der Renderer wird in Task 6 eingebunden; er kompiliert eigenständig fehlerfrei.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/pageCache.ts src/lib/pageCache.test.ts src/lib/components/PageRenderer.svelte
git commit -m "feat: PageRenderer — einzelne PDF-Seite scharf rendern mit Bitmap-Cache"
```

---

### Task 6: `DocViewer.svelte` + `DocCard`-Integration + Kontextmenü

**Files:**
- Create: `src/lib/components/DocViewer.svelte`
- Modify: `src/lib/components/DocCard.svelte`
- Modify: `src/lib/menus.ts` (Kontextmenü „Aufschlagen" / „In neuem Tab öffnen")

**Interfaces:**
- Consumes: `PageRenderer.svelte` (Task 5); `desktop.command(...)` mit den Commands aus Task 3; `desktop.api`; `Doc`, `Viewport` aus core.
- Produces: `DocViewer.svelte` mit Props `{ doc: Doc; vp: Viewport }` — die große aufgeschlagene Karte (rahmt `PageRenderer`, Blätter-Pfeile + „Seite / Gesamt", ✕, Größe-Anfasser, verschiebbar über `doc.position`). `DocCard.svelte` rendert bei `doc.open === true` statt der Miniatur den `DocViewer`. `menus.ts`: `openDoc` → im Menü als „In neuem Tab öffnen"; neuer Menüeintrag „Aufschlagen" löst `expandDoc` aus.

- [ ] **Step 1: `DocViewer.svelte` anlegen**

```svelte
<script lang="ts">
  import { moveDoc, type Doc, type Viewport } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import PageRenderer from './PageRenderer.svelte';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let pageCount = $state<number | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);
  const page = $derived(doc.page ?? 1);
  const size = $derived(doc.openSize ?? { w: 560, h: 720 });

  let dragging = false, moved = false;
  function onHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true; moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
  }
  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.applyLocal((s) => moveDoc(s, doc.id, { x: doc.position.x + e.movementX / vp.scale, y: doc.position.y + e.movementY / vp.scale }));
  }
  function onHeaderPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }

  function turn(delta: number) {
    const next = page + delta;
    if (next < 1 || (pageCount !== null && next > pageCount)) return;
    void desktop.command('setDocPage', { id: doc.id, page: next });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); turn(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); turn(1); }
  }

  // Wischen zum Blättern (horizontal)
  let swipeX = 0, swiping = false;
  function onBodyPointerDown(e: PointerEvent) { if (e.pointerType === 'touch') { swiping = true; swipeX = e.clientX; } }
  function onBodyPointerUp(e: PointerEvent) {
    if (!swiping) return; swiping = false;
    const dx = e.clientX - swipeX;
    if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
  }

  // Größe ziehen (Anfasser unten rechts)
  let resizing = false;
  function onResizeDown(e: PointerEvent) {
    e.stopPropagation(); e.preventDefault();
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    const w = Math.max(220, size.w + e.movementX / vp.scale);
    const h = Math.max(280, size.h + e.movementY / vp.scale);
    desktop.applyLocal((s) => ({ ...s, docs: s.docs.map((d) => d.id === doc.id ? { ...d, openSize: { w, h } } : d) }));
  }
  function onResizeUp() {
    if (!resizing) return;
    resizing = false;
    void desktop.command('resizeDoc', { id: doc.id, size: { w: size.w, h: size.h } });
  }
</script>

<svelte:window onkeydown={(e) => { if (document.activeElement === wrapEl) onKey(e); }} />

<div class="viewer" bind:this={wrapEl} tabindex="0"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px" style:z-index={doc.zIndex}
     style:width="{size.w}px" style:height="{size.h}px">
  <div class="head" onpointerdown={onHeaderPointerDown} onpointermove={onHeaderPointerMove} onpointerup={onHeaderPointerUp}>
    <span class="title">{doc.name}</span>
    <span class="pager">
      <button onclick={() => turn(-1)} disabled={page <= 1} aria-label="Zurück">‹</button>
      <span class="pos">{page}{#if pageCount} / {pageCount}{/if}</span>
      <button onclick={() => turn(1)} disabled={pageCount !== null && page >= pageCount} aria-label="Weiter">›</button>
    </span>
    <button class="close" onclick={() => void desktop.command('collapseDoc', { id: doc.id })} aria-label="Schließen">✕</button>
  </div>
  <div class="body" onpointerdown={onBodyPointerDown} onpointerup={onBodyPointerUp}>
    {#if desktop.api}
      <PageRenderer api={desktop.api} fileId={doc.fileId} {page} targetWidth={Math.round(size.w)} onpagecount={(n) => (pageCount = n)} />
    {/if}
  </div>
  <div class="grip" onpointerdown={onResizeDown} onpointermove={onResizeMove} onpointerup={onResizeUp} aria-hidden="true"></div>
</div>

<style>
  .viewer { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 6px;
            box-shadow: 0 10px 34px rgba(0, 0, 0, .45); overflow: hidden; }
  .viewer:focus { outline: 2px solid #2c5aa0; }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #f2f4f8;
          border-bottom: 1px solid #e4e8ef; cursor: grab; user-select: none; }
  .title { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pager { display: flex; align-items: center; gap: 6px; }
  .pager button, .close { border: none; background: #e7ebf2; border-radius: 5px; cursor: pointer;
          width: 24px; height: 24px; font-size: 15px; line-height: 1; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pos { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .body { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start;
          background: #52616b; padding: 10px; }
  .grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 50%, #b8c0cc 50%); }
</style>
```

Hinweis: Das `onkeydown` in `<svelte:window>` reagiert nur, wenn die Viewer-Karte (`wrapEl`) den Fokus hat — so blättert die Pfeiltaste gezielt in der zuletzt angeklickten aufgeschlagenen Karte, nicht global.

- [ ] **Step 2: `DocCard.svelte` integrieren** — im Markup den geöffneten Zustand abzweigen. Oben im `<script>` importieren:

```ts
  import DocViewer from './DocViewer.svelte';
```

Das äußere Markup so ändern, dass bei `doc.open` der Viewer statt der Miniatur rendert. Konkret den bestehenden `<div class="card" …>` … `</div>`-Block umschließen:

```svelte
{#if doc.open}
  <DocViewer {doc} {vp} />
{:else}
  <div class="card"
       style:left="{doc.position.x}px" style:top="{doc.position.y}px"
       style:z-index={doc.zIndex} style:transform="rotate({doc.rotation}deg)"
       style:width="{CARD_W}px" style:height="{CARD_H}px"
       onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}
       ondblclick={() => void desktop.command('expandDoc', { id: doc.id })}
       oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, doc); }}>
    <div class="body">
      {#if thumb}
        <img src={thumb} alt="" draggable="false" />
      {:else}
        <div class="fallback">PDF</div>
      {/if}
    </div>
    <div class="name">{doc.name}</div>
  </div>
{/if}
```

Wichtig: Der Doppelklick öffnet jetzt den Inline-Viewer (`expandDoc`) statt `openDoc` (neuer Tab). Der Import `openDoc` bleibt für das Kontextmenü erhalten.

- [ ] **Step 3: `menus.ts` — Kontextmenü anpassen** — in `showDocMenu` den ersten Eintrag ersetzen und „In neuem Tab öffnen" ergänzen:

```ts
    items: [
      { label: 'Aufschlagen', action: () => void desktop.command('expandDoc', { id: doc.id }) },
      { label: 'In neuem Tab öffnen', action: () => void openDoc(doc) },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeDoc', { id: doc.id }) },
    ],
```

(`desktop` ist in `menus.ts` bereits importiert.)

- [ ] **Step 4: Typprüfung + Tests**

Run: `npm run check && npm test`
Expected: `svelte-check` ohne neue Fehler (außer den 9 vorbestehenden ARIA-Warnungen; der `.grip`/`.head`-Interaktions-Divs können je eine gleichartige ARIA-Warnung erzeugen — das entspricht dem Bestandsmuster und ist akzeptiert). Vitest PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/DocViewer.svelte src/lib/components/DocCard.svelte src/lib/menus.ts
git commit -m "feat: Inline-Viewer — DocViewer, Doppelklick schlägt auf, Kontextmenü angepasst"
```

---

### Task 7: End-to-End-Verifikation

**Files:** keine — Verifikations-Task; gefundene Fehler als eigene `fix:`-Commits.

- [ ] **Step 1: Produktionsnah starten**

```bash
npm run build && DATA_DIR=/tmp/dd-viewer npm run server
```

- [ ] **Step 2: Browser-Checkliste unter `http://localhost:4810`**

1. Konto anlegen, ein mehrseitiges PDF hinzufügen.
2. Doppelklick auf die Karte → sie schlägt an ihrer Position zu großer Karte auf, Seite 1 groß sichtbar.
3. Blättern per ‹/›, per Pfeiltasten (Karte fokussiert), per Wischen (Touch/iPad) → Seite wechselt, „Seite / Gesamt" stimmt.
4. Größe am Anfasser unten rechts ziehen → Karte wird größer/kleiner, Seite skaliert mit.
5. Kopfzeile ziehen → Karte verschiebt sich.
6. Zweites PDF ebenfalls aufschlagen → beide gleichzeitig offen.
7. ✕ → zurück zur Miniatur; erneut aufschlagen → gleiche Seite/Größe wie zuvor.
8. Kontextmenü „In neuem Tab öffnen" → rohes PDF im neuen Tab.
9. Seite neu laden → aufgeschlagene Karten liegen wie zuvor da (Seite/Größe erhalten).
10. Zweites Fenster, gleiches Konto/Schreibtisch: Aufschlagen und Blättern in Fenster A → Fenster B folgt live (WebSocket).
11. Server stoppen → Banner, Aktionen gesperrt; gecachte Seiten bleiben sichtbar.

- [ ] **Step 3: Abschluss**

Run: `npm test && npm run check`
Expected: PASS — Inline-Viewer fertig für Review/UAT. Gefundene Punkte als `fix:`-Commits.
