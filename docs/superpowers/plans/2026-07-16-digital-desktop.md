# Digital Desktop — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine Mac-Desktop-App (Tauri 2 + Svelte), die einen zoombaren grafischen Schreibtisch für referenzierte PDF-Dateien bietet — mit Verschieben, Doppelklick-Öffnen in Vorschau, Verknüpfungslinien mit Notizen und Stapeln.

**Architecture:** Tauri 2 liefert die native Shell und Dateisystem-/Dialog-/Opener-Plugins (kein eigener Rust-Code). Die gesamte Logik lebt im Svelte-Frontend: reine TypeScript-Zustandsfunktionen (`state → state`, Vitest-getestet) plus Svelte-5-Komponenten für Canvas, Karten, Linien und Stapel. Zustand wird als JSON mit Backup im AppData-Ordner persistiert.

**Tech Stack:** Tauri 2, Svelte 5 (Runes, SvelteKit static), TypeScript, Vite, Vitest, pdfjs-dist, Tauri-Plugins fs/dialog/opener.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-digital-desktop-design.md` — bei Widerspruch gilt die Spec.
- Alle UI-Texte auf Deutsch.
- PDFs werden **nur referenziert** (absoluter Pfad); die App löscht **niemals** Dateien des Nutzers.
- Zustand: `desktop.json` (+ `desktop.json.bak` als Backup) im AppData-Ordner der App; Miniaturen-Cache unter `thumbnails/<docId>.png` ebenda.
- Zustandslogik ausschließlich als reine Funktionen `(state, …) → state` in `src/lib/state/`; UI mutiert nur über `desktop.apply(fn)`.
- Innerhalb von `src/lib` nur **relative Imports** (kein `$lib`), damit Vitest ohne Alias-Konfiguration läuft.
- IDs via `crypto.randomUUID()`, in Funktionen als optionaler Parameter injizierbar (Testbarkeit).
- Tauri-Identifier: `de.baumfalk.digitaldesktop`, Produktname: `Digital Desktop`.
- Jeder Commit endet mit der Zeile `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Dateistruktur

```
src/
├── routes/+page.svelte            # Einstieg: init + <Desktop/>
├── lib/
│   ├── state/
│   │   ├── model.ts               # Typen, Konstanten, Finder-Helfer
│   │   ├── documents.ts           # addDoc, moveDoc, bringToFront, setDocPath, setMissing
│   │   ├── links.ts               # addLink, Notizen, removeLinksFor, collectLinkedPaths
│   │   ├── stacks.ts              # stackDocs, removeFromStack, dissolveStack, rename, move
│   │   ├── removal.ts             # removeDoc, removeStack (entitätsübergreifendes Aufräumen)
│   │   ├── viewport.ts            # Viewport, screenToWorld, zoomAt, zoomToFit
│   │   └── geometry.ts            # docBox, stackBox, allBoxes, hitTest
│   ├── persistence.ts             # (de)serialize + load/save mit Backup (plugin-fs)
│   ├── debounce.ts                # debounce-Helfer
│   ├── store.svelte.ts            # globaler Runes-Store `desktop` mit Autosave
│   ├── ui.svelte.ts               # UI-Zustand: Kontextmenü, Verknüpfen-Modus, Stapel-Umbenennung
│   ├── menus.ts                   # Kontextmenü-Einträge für Dokument & Stapel, relink, openWithLinked
│   ├── thumbnails.ts              # pdf.js-Miniatur + PNG-Cache
│   └── components/
│       ├── Desktop.svelte         # Fläche, Pan/Zoom, Drop, Toolbar
│       ├── DocCard.svelte         # Dokumentkarte
│       ├── StackCard.svelte       # Stapelkarte + Auffächern
│       ├── LinkLayer.svelte       # SVG-Linien + Notiz-Popover
│       └── ContextMenu.svelte     # generisches Kontextmenü
src-tauri/                          # generiert; nur Config/Capabilities anpassen
```

Tests liegen jeweils neben dem Modul (`model.test.ts` usw.).

---

### Task 1: Projekt-Scaffold & Tooling

**Files:**
- Create: gesamtes Tauri+Svelte-Gerüst (generiert)
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `package.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: lauffähige Dev-App (`npm run tauri dev`), `npm test` (Vitest), installierte Plugins `fs`, `dialog`, `opener`, `pdfjs-dist`.

- [ ] **Step 1: Rust-Toolchain prüfen**

Run: `rustc --version`
Expected: Versionsausgabe (z.B. `rustc 1.8x`). Falls „command not found“: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y` und Terminal-Env neu laden (`source "$HOME/.cargo/env"`).

- [ ] **Step 2: Projekt scaffolden und in die Repo-Wurzel übernehmen**

Das Repo-Wurzelverzeichnis ist nicht leer (docs/, .git/), daher in ein Temp-Verzeichnis scaffolden und hineinsynchronisieren:

```bash
cd "$(mktemp -d)"
npm create tauri-app@latest digital-desktop -- --template svelte-ts --manager npm --yes
rsync -a digital-desktop/ "/Users/patrickbaumfalk/Projekte/Digital Desktop/"
cd "/Users/patrickbaumfalk/Projekte/Digital Desktop"
npm install
```

Hinweis: Das svelte-ts-Template ist SvelteKit-basiert (adapter-static, SSR aus) — Einstiegspunkt ist `src/routes/+page.svelte`.

- [ ] **Step 3: Tauri-Plugins und Frontend-Abhängigkeiten installieren**

```bash
npm run tauri add fs
npm run tauri add dialog
npm run tauri add opener
npm install pdfjs-dist
npm install -D vitest
```

- [ ] **Step 4: App-Identität und Fenster konfigurieren**

In `src-tauri/tauri.conf.json` setzen (vorhandene Schlüssel ändern, Rest belassen):

```json
{
  "productName": "Digital Desktop",
  "identifier": "de.baumfalk.digitaldesktop",
  "app": {
    "windows": [
      {
        "title": "Digital Desktop",
        "width": 1280,
        "height": 800,
        "dragDropEnabled": true
      }
    ]
  }
}
```

- [ ] **Step 5: Capabilities (Berechtigungen) setzen**

`src-tauri/capabilities/default.json` komplett ersetzen durch:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Digital Desktop: Dateizugriff, Dialoge, Öffnen in Standard-App",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    "fs:default",
    { "identifier": "fs:allow-read-file", "allow": [{ "path": "**" }, { "path": "$HOME/**" }] },
    { "identifier": "fs:allow-read-text-file", "allow": [{ "path": "**" }, { "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-write-file", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-write-text-file", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-copy-file", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-mkdir", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-exists", "allow": [{ "path": "**" }, { "path": "$HOME/**" }] },
    { "identifier": "opener:allow-open-path", "allow": [{ "path": "**" }] },
    { "identifier": "opener:allow-reveal-item-in-dir", "allow": [{ "path": "**" }] }
  ]
}
```

Hinweis: Falls beim späteren Dev-Lauf ein Permission-Fehler in der Konsole erscheint („fs.read_file not allowed …“), die gemeldete Permission hier ergänzen — die Fehlermeldung nennt den exakten Identifier.

- [ ] **Step 6: Vitest einrichten**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

In `package.json` unter `"scripts"` ergänzen:

```json
"test": "vitest run"
```

- [ ] **Step 7: Verifizieren**

Run: `npm test -- --passWithNoTests`
Expected: `No test files found` bzw. exit code 0.

Run: `npm run tauri dev`
Expected: Erster Lauf kompiliert Rust (dauert einige Minuten), dann öffnet sich ein Fenster „Digital Desktop“ mit der Template-Startseite. Fenster schließen, Prozess beenden.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: Tauri-2+Svelte-Scaffold mit fs/dialog/opener-Plugins und Vitest" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Datenmodell & Dokument-Logik

**Files:**
- Create: `src/lib/state/model.ts`
- Create: `src/lib/state/documents.ts`
- Test: `src/lib/state/documents.test.ts`

**Interfaces:**
- Produces (model.ts): Typen `Vec2 {x,y}`, `Doc {id, path, position, rotation, zIndex, missing}`, `Link {id, fromId, toId, note}`, `Stack {id, name, docIds, position, zIndex}`, `DesktopState {docs, links, stacks}`; Konstanten `CARD_W = 180`, `CARD_H = 240`; Helfer `emptyState()`, `findDoc(s, id)`, `findStack(s, id)`, `stackOf(s, docId)`, `freeDocs(s)`.
- Produces (documents.ts): `rotationFor(id): number`, `addDoc(s, path, position, id?)`, `moveDoc(s, id, position)`, `bringToFront(s, id)` (wirkt auf Doc- **und** Stack-ids), `setDocPath(s, id, path)`, `setMissing(s, id, missing)`.

- [ ] **Step 1: Failing Tests schreiben**

Create `src/lib/state/documents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc, moveDoc, bringToFront, setDocPath, setMissing, rotationFor } from './documents';

const pos = { x: 10, y: 20 };

describe('addDoc', () => {
  it('legt ein Dokument mit Position, Rotation und zIndex 1 an', () => {
    const s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0]).toMatchObject({ id: 'id-a', path: '/tmp/a.pdf', position: pos, missing: false });
    expect(s.docs[0].zIndex).toBe(1);
  });

  it('vergibt aufsteigende zIndex-Werte', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = addDoc(s, '/tmp/b.pdf', pos, 'id-b');
    expect(s.docs[1].zIndex).toBe(2);
  });

  it('ignoriert eine Datei, die schon auf dem Tisch liegt', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = addDoc(s, '/tmp/a.pdf', { x: 0, y: 0 }, 'id-b');
    expect(s.docs).toHaveLength(1);
  });
});

describe('rotationFor', () => {
  it('ist deterministisch und liegt in [-3, 3] Grad', () => {
    expect(rotationFor('id-a')).toBe(rotationFor('id-a'));
    for (const id of ['a', 'b', 'c', 'id-xyz']) {
      expect(Math.abs(rotationFor(id))).toBeLessThanOrEqual(3);
    }
  });
});

describe('moveDoc / bringToFront', () => {
  it('verschiebt ein Dokument', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = moveDoc(s, 'id-a', { x: 99, y: 7 });
    expect(s.docs[0].position).toEqual({ x: 99, y: 7 });
  });

  it('hebt ein Dokument über alle anderen (auch Stapel)', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = addDoc(s, '/tmp/b.pdf', pos, 'id-b');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 5 }] };
    s = bringToFront(s, 'id-a');
    expect(s.docs[0].zIndex).toBe(6);
  });

  it('hebt auch einen Stapel nach vorn', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 0 }] };
    s = bringToFront(s, 'st-1');
    expect(s.stacks[0].zIndex).toBe(2);
  });
});

describe('setDocPath / setMissing', () => {
  it('setzt neuen Pfad und löscht die missing-Markierung', () => {
    let s = addDoc(emptyState(), '/tmp/a.pdf', pos, 'id-a');
    s = setMissing(s, 'id-a', true);
    expect(s.docs[0].missing).toBe(true);
    s = setDocPath(s, 'id-a', '/tmp/neu.pdf');
    expect(s.docs[0]).toMatchObject({ path: '/tmp/neu.pdf', missing: false });
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './model'` (bzw. `./documents`).

- [ ] **Step 3: Implementieren**

Create `src/lib/state/model.ts`:

```ts
export interface Vec2 { x: number; y: number }

export interface Doc {
  id: string;
  path: string;        // absoluter Dateipfad (nur Referenz)
  position: Vec2;      // Weltkoordinaten, linke obere Ecke
  rotation: number;    // Grad, feste leichte Zufallsdrehung
  zIndex: number;
  missing: boolean;    // Datei aktuell nicht auffindbar
}

export interface Link {
  id: string;
  fromId: string;      // Doc- oder Stack-id
  toId: string;        // Doc- oder Stack-id
  note: string;
}

export interface Stack {
  id: string;
  name: string;
  docIds: string[];    // Reihenfolge: unten → oben
  position: Vec2;
  zIndex: number;
}

export interface DesktopState {
  docs: Doc[];
  links: Link[];
  stacks: Stack[];
}

export const CARD_W = 180;
export const CARD_H = 240;

export function emptyState(): DesktopState {
  return { docs: [], links: [], stacks: [] };
}

export function findDoc(s: DesktopState, id: string): Doc | undefined {
  return s.docs.find((d) => d.id === id);
}

export function findStack(s: DesktopState, id: string): Stack | undefined {
  return s.stacks.find((st) => st.id === id);
}

export function stackOf(s: DesktopState, docId: string): Stack | undefined {
  return s.stacks.find((st) => st.docIds.includes(docId));
}

export function freeDocs(s: DesktopState): Doc[] {
  return s.docs.filter((d) => !stackOf(s, d.id));
}
```

Create `src/lib/state/documents.ts`:

```ts
import type { DesktopState, Vec2 } from './model';

function maxZ(s: DesktopState): number {
  return Math.max(0, ...s.docs.map((d) => d.zIndex), ...s.stacks.map((st) => st.zIndex));
}

/** Deterministische leichte Drehung aus der id, in [-3, 3] Grad. */
export function rotationFor(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 61) - 30) / 10;
}

export function addDoc(
  s: DesktopState,
  path: string,
  position: Vec2,
  id: string = crypto.randomUUID(),
): DesktopState {
  if (s.docs.some((d) => d.path === path)) return s; // liegt schon auf dem Tisch
  const doc = { id, path, position, rotation: rotationFor(id), zIndex: maxZ(s) + 1, missing: false };
  return { ...s, docs: [...s.docs, doc] };
}

export function moveDoc(s: DesktopState, id: string, position: Vec2): DesktopState {
  return { ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, position } : d)) };
}

/** Hebt ein Dokument oder einen Stapel über alles andere. */
export function bringToFront(s: DesktopState, id: string): DesktopState {
  const z = maxZ(s) + 1;
  return {
    ...s,
    docs: s.docs.map((d) => (d.id === id ? { ...d, zIndex: z } : d)),
    stacks: s.stacks.map((st) => (st.id === id ? { ...st, zIndex: z } : st)),
  };
}

export function setDocPath(s: DesktopState, id: string, path: string): DesktopState {
  return { ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, path, missing: false } : d)) };
}

export function setMissing(s: DesktopState, id: string, missing: boolean): DesktopState {
  return { ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, missing } : d)) };
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS, alle Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/lib/state
git commit -m "feat: Datenmodell und Dokument-Logik (addDoc, moveDoc, bringToFront)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Verknüpfungs-Logik

**Files:**
- Create: `src/lib/state/links.ts`
- Test: `src/lib/state/links.test.ts`

**Interfaces:**
- Consumes: Typen und Finder aus `./model` (Task 2).
- Produces: `addLink(s, fromId, toId, id?)` (lehnt Selbst- und Duplikat-Verknüpfungen in beiden Richtungen ab), `setLinkNote(s, linkId, note)`, `removeLink(s, linkId)`, `removeLinksFor(s, entityId)`, `linkedEntityIds(s, entityId): string[]`, `collectLinkedPaths(s, entityId): string[]` (Pfade der Entität selbst plus aller direkt verknüpften; Stapel werden zu ihren Dokumentpfaden aufgelöst; fehlende Dateien ausgelassen; dedupliziert).

- [ ] **Step 1: Failing Tests schreiben**

Create `src/lib/state/links.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import {
  addLink, setLinkNote, removeLink, removeLinksFor, linkedEntityIds, collectLinkedPaths,
} from './links';

function twoDocs(): DesktopState {
  let s = addDoc(emptyState(), '/tmp/a.pdf', { x: 0, y: 0 }, 'id-a');
  return addDoc(s, '/tmp/b.pdf', { x: 0, y: 0 }, 'id-b');
}

describe('addLink', () => {
  it('legt eine Verknüpfung mit leerer Notiz an', () => {
    const s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    expect(s.links).toEqual([{ id: 'l-1', fromId: 'id-a', toId: 'id-b', note: '' }]);
  });

  it('lehnt Selbstverknüpfung ab', () => {
    const s = addLink(twoDocs(), 'id-a', 'id-a', 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('lehnt Duplikate in beiden Richtungen ab', () => {
    let s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    s = addLink(s, 'id-a', 'id-b', 'l-2');
    s = addLink(s, 'id-b', 'id-a', 'l-3');
    expect(s.links).toHaveLength(1);
  });
});

describe('Notiz und Entfernen', () => {
  it('setzt eine Notiz', () => {
    let s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    s = setLinkNote(s, 'l-1', 'Rechnung zu Vertrag X');
    expect(s.links[0].note).toBe('Rechnung zu Vertrag X');
  });

  it('entfernt eine Verknüpfung per id', () => {
    let s = addLink(twoDocs(), 'id-a', 'id-b', 'l-1');
    s = removeLink(s, 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('entfernt alle Verknüpfungen einer Entität', () => {
    let s = addDoc(twoDocs(), '/tmp/c.pdf', { x: 0, y: 0 }, 'id-c');
    s = addLink(s, 'id-a', 'id-b', 'l-1');
    s = addLink(s, 'id-c', 'id-a', 'l-2');
    s = addLink(s, 'id-b', 'id-c', 'l-3');
    s = removeLinksFor(s, 'id-a');
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });
});

describe('linkedEntityIds / collectLinkedPaths', () => {
  it('liefert die Gegenseiten aller Verknüpfungen', () => {
    let s = addDoc(twoDocs(), '/tmp/c.pdf', { x: 0, y: 0 }, 'id-c');
    s = addLink(s, 'id-a', 'id-b', 'l-1');
    s = addLink(s, 'id-c', 'id-a', 'l-2');
    expect(linkedEntityIds(s, 'id-a').sort()).toEqual(['id-b', 'id-c']);
  });

  it('sammelt eigenen Pfad plus verknüpfte, Stapel aufgelöst, ohne fehlende Dateien', () => {
    let s = addDoc(twoDocs(), '/tmp/c.pdf', { x: 0, y: 0 }, 'id-c');
    s = addDoc(s, '/tmp/d.pdf', { x: 0, y: 0 }, 'id-d');
    s = {
      ...s,
      docs: s.docs.map((d) => (d.id === 'id-d' ? { ...d, missing: true } : d)),
      stacks: [{ id: 'st-1', name: '', docIds: ['id-c', 'id-d'], position: { x: 0, y: 0 }, zIndex: 0 }],
    };
    s = addLink(s, 'id-a', 'st-1', 'l-1');
    expect(collectLinkedPaths(s, 'id-a').sort()).toEqual(['/tmp/a.pdf', '/tmp/c.pdf']);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './links'`.

- [ ] **Step 3: Implementieren**

Create `src/lib/state/links.ts`:

```ts
import { findDoc, findStack, type DesktopState } from './model';

export function addLink(
  s: DesktopState,
  fromId: string,
  toId: string,
  id: string = crypto.randomUUID(),
): DesktopState {
  if (fromId === toId) return s;
  const exists = s.links.some(
    (l) => (l.fromId === fromId && l.toId === toId) || (l.fromId === toId && l.toId === fromId),
  );
  if (exists) return s;
  return { ...s, links: [...s.links, { id, fromId, toId, note: '' }] };
}

export function setLinkNote(s: DesktopState, linkId: string, note: string): DesktopState {
  return { ...s, links: s.links.map((l) => (l.id === linkId ? { ...l, note } : l)) };
}

export function removeLink(s: DesktopState, linkId: string): DesktopState {
  return { ...s, links: s.links.filter((l) => l.id !== linkId) };
}

export function removeLinksFor(s: DesktopState, entityId: string): DesktopState {
  return { ...s, links: s.links.filter((l) => l.fromId !== entityId && l.toId !== entityId) };
}

export function linkedEntityIds(s: DesktopState, entityId: string): string[] {
  return s.links
    .filter((l) => l.fromId === entityId || l.toId === entityId)
    .map((l) => (l.fromId === entityId ? l.toId : l.fromId));
}

/** Pfade der Entität selbst plus aller direkt verknüpften Entitäten (Stapel → alle enthaltenen Dokumente). */
export function collectLinkedPaths(s: DesktopState, entityId: string): string[] {
  const paths: string[] = [];
  const addEntity = (id: string) => {
    const st = findStack(s, id);
    if (st) {
      for (const docId of st.docIds) {
        const d = findDoc(s, docId);
        if (d && !d.missing) paths.push(d.path);
      }
      return;
    }
    const d = findDoc(s, id);
    if (d && !d.missing) paths.push(d.path);
  };
  addEntity(entityId);
  for (const other of linkedEntityIds(s, entityId)) addEntity(other);
  return [...new Set(paths)];
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/state
git commit -m "feat: Verknüpfungs-Logik mit Notizen und Pfadsammlung" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Stapel-Logik

**Files:**
- Create: `src/lib/state/stacks.ts`
- Test: `src/lib/state/stacks.test.ts`

**Interfaces:**
- Consumes: `./model` (Finder, Typen), `removeLinksFor` aus `./links`.
- Produces: `stackDocs(s, draggedId, targetId, newStackId?)` (targetId darf Doc- oder Stack-id sein; freies Doc + freies Doc → neuer Stapel an Zielposition; Ziel in/als Stapel → oben anfügen; gezogenes Doc noch in einem Stapel → unverändert), `removeFromStack(s, docId, position)` (löst Stapel auf, wenn nur 1 Dokument übrig bleibt), `dissolveStack(s, stackId)` (Dokumente versetzt daneben, Stapel-Verknüpfungen entfernt), `renameStack(s, stackId, name)`, `moveStack(s, stackId, position)`.

- [ ] **Step 1: Failing Tests schreiben**

Create `src/lib/state/stacks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState, findStack, stackOf, type DesktopState } from './model';
import { addDoc } from './documents';
import { addLink } from './links';
import { stackDocs, removeFromStack, dissolveStack, renameStack, moveStack } from './stacks';

function docs(n: number): DesktopState {
  let s = emptyState();
  for (let i = 0; i < n; i++) s = addDoc(s, `/tmp/${i}.pdf`, { x: i * 10, y: i * 10 }, `id-${i}`);
  return s;
}

describe('stackDocs', () => {
  it('erzeugt aus zwei freien Dokumenten einen Stapel an der Zielposition', () => {
    const s = stackDocs(docs(2), 'id-1', 'id-0', 'st-1');
    expect(s.stacks).toHaveLength(1);
    expect(s.stacks[0]).toMatchObject({ id: 'st-1', docIds: ['id-0', 'id-1'], position: { x: 0, y: 0 } });
  });

  it('legt ein Dokument oben auf einen bestehenden Stapel (Ziel = Stack-id)', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('legt ein Dokument auf den Stapel, wenn das Ziel-Dokument gestapelt ist', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'id-0');
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-1', 'id-2']);
  });

  it('ändert nichts, wenn das gezogene Dokument selbst gestapelt ist oder Ziel = Quelle', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    expect(stackDocs(s, 'id-1', 'id-2')).toBe(s);
    expect(stackDocs(s, 'id-2', 'id-2')).toBe(s);
  });
});

describe('removeFromStack', () => {
  it('nimmt ein Dokument heraus und setzt es an die neue Position', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    s = removeFromStack(s, 'id-1', { x: 500, y: 500 });
    expect(stackOf(s, 'id-1')).toBeUndefined();
    expect(s.docs.find((d) => d.id === 'id-1')!.position).toEqual({ x: 500, y: 500 });
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-2']);
  });

  it('löst den Stapel auf, wenn nur ein Dokument übrig bleibt', () => {
    let s = stackDocs(docs(2), 'id-1', 'id-0', 'st-1');
    s = addLink(s, 'st-1', 'id-1', 'l-1'); // hängt am Stapel
    s = removeFromStack(s, 'id-1', { x: 500, y: 500 });
    expect(s.stacks).toHaveLength(0);
    expect(s.links).toHaveLength(0); // Stapel-Verknüpfung mit entfernt
    expect(stackOf(s, 'id-0')).toBeUndefined();
  });
});

describe('dissolveStack', () => {
  it('legt die Dokumente versetzt nebeneinander und entfernt Stapel samt Stapel-Verknüpfungen', () => {
    let s = stackDocs(docs(3), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    s = addLink(s, 'st-1', 'id-2', 'l-1');
    s = dissolveStack(s, 'st-1');
    expect(s.stacks).toHaveLength(0);
    expect(s.links).toHaveLength(0);
    const ps = ['id-0', 'id-1', 'id-2'].map((id) => s.docs.find((d) => d.id === id)!.position);
    expect(ps[0]).toEqual({ x: 0, y: 0 });
    expect(ps[1]).toEqual({ x: 40, y: 24 });
    expect(ps[2]).toEqual({ x: 80, y: 48 });
  });
});

describe('renameStack / moveStack', () => {
  it('benennt und verschiebt einen Stapel', () => {
    let s = stackDocs(docs(2), 'id-1', 'id-0', 'st-1');
    s = renameStack(s, 'st-1', 'Projekt X');
    s = moveStack(s, 'st-1', { x: 7, y: 8 });
    expect(findStack(s, 'st-1')).toMatchObject({ name: 'Projekt X', position: { x: 7, y: 8 } });
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './stacks'`.

- [ ] **Step 3: Implementieren**

Create `src/lib/state/stacks.ts`:

```ts
import { findDoc, findStack, stackOf, type DesktopState, type Vec2 } from './model';
import { removeLinksFor } from './links';

export function stackDocs(
  s: DesktopState,
  draggedId: string,
  targetId: string,
  newStackId: string = crypto.randomUUID(),
): DesktopState {
  if (draggedId === targetId) return s;
  if (stackOf(s, draggedId)) return s; // erst aus dem alten Stapel ziehen
  const targetStack = findStack(s, targetId) ?? stackOf(s, targetId);
  if (targetStack) {
    return {
      ...s,
      stacks: s.stacks.map((st) =>
        st.id === targetStack.id ? { ...st, docIds: [...st.docIds, draggedId] } : st,
      ),
    };
  }
  const target = findDoc(s, targetId);
  if (!target) return s;
  const stack = {
    id: newStackId,
    name: '',
    docIds: [targetId, draggedId],
    position: target.position,
    zIndex: target.zIndex,
  };
  return { ...s, stacks: [...s.stacks, stack] };
}

export function removeFromStack(s: DesktopState, docId: string, position: Vec2): DesktopState {
  const st = stackOf(s, docId);
  if (!st) return s;
  let next: DesktopState = {
    ...s,
    docs: s.docs.map((d) => (d.id === docId ? { ...d, position } : d)),
    stacks: s.stacks.map((x) =>
      x.id === st.id ? { ...x, docIds: x.docIds.filter((i) => i !== docId) } : x,
    ),
  };
  if (findStack(next, st.id)!.docIds.length === 1) next = dissolveStack(next, st.id);
  return next;
}

export function dissolveStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) return s;
  const docs = s.docs.map((d) => {
    const i = st.docIds.indexOf(d.id);
    return i < 0 ? d : { ...d, position: { x: st.position.x + i * 40, y: st.position.y + i * 24 } };
  });
  return removeLinksFor(
    { ...s, docs, stacks: s.stacks.filter((x) => x.id !== stackId) },
    stackId,
  );
}

export function renameStack(s: DesktopState, stackId: string, name: string): DesktopState {
  return { ...s, stacks: s.stacks.map((st) => (st.id === stackId ? { ...st, name } : st)) };
}

export function moveStack(s: DesktopState, stackId: string, position: Vec2): DesktopState {
  return { ...s, stacks: s.stacks.map((st) => (st.id === stackId ? { ...st, position } : st)) };
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/state
git commit -m "feat: Stapel-Logik mit Auto-Auflösung und Verknüpfungs-Aufräumen" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Entfernen mit entitätsübergreifendem Aufräumen

**Files:**
- Create: `src/lib/state/removal.ts`
- Test: `src/lib/state/removal.test.ts`

**Interfaces:**
- Consumes: `./model`, `removeLinksFor` aus `./links`, `dissolveStack` aus `./stacks`.
- Produces: `removeDoc(s, docId)` (entfernt Karte + alle Verknüpfungen; nimmt es aus seinem Stapel, löst 1er-Rest-Stapel auf), `removeStack(s, stackId)` (entfernt Stapel **und** enthaltene Karten samt aller Verknüpfungen). Es werden nie Dateien gelöscht — nur Zustandseinträge.

- [ ] **Step 1: Failing Tests schreiben**

Create `src/lib/state/removal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState, findStack, type DesktopState } from './model';
import { addDoc } from './documents';
import { addLink } from './links';
import { stackDocs } from './stacks';
import { removeDoc, removeStack } from './removal';

function base(): DesktopState {
  let s = emptyState();
  for (let i = 0; i < 4; i++) s = addDoc(s, `/tmp/${i}.pdf`, { x: 0, y: 0 }, `id-${i}`);
  return s;
}

describe('removeDoc', () => {
  it('entfernt Dokument und alle daran hängenden Verknüpfungen', () => {
    let s = addLink(base(), 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    s = addLink(s, 'id-1', 'id-2', 'l-3');
    s = removeDoc(s, 'id-0');
    expect(s.docs.map((d) => d.id)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });

  it('nimmt das Dokument aus einem 3er-Stapel, Stapel bleibt bestehen', () => {
    let s = stackDocs(base(), 'id-1', 'id-0', 'st-1');
    s = stackDocs(s, 'id-2', 'st-1');
    s = removeDoc(s, 'id-1');
    expect(findStack(s, 'st-1')!.docIds).toEqual(['id-0', 'id-2']);
  });

  it('löst einen 2er-Stapel auf, wenn ein Dokument entfernt wird', () => {
    let s = stackDocs(base(), 'id-1', 'id-0', 'st-1');
    s = removeDoc(s, 'id-1');
    expect(s.stacks).toHaveLength(0);
    expect(s.docs.some((d) => d.id === 'id-0')).toBe(true);
  });
});

describe('removeStack', () => {
  it('entfernt Stapel, enthaltene Dokumente und alle betroffenen Verknüpfungen', () => {
    let s = stackDocs(base(), 'id-1', 'id-0', 'st-1');
    s = addLink(s, 'st-1', 'id-2', 'l-1');   // am Stapel
    s = addLink(s, 'id-0', 'id-3', 'l-2');   // an enthaltenem Dokument
    s = addLink(s, 'id-2', 'id-3', 'l-3');   // unbeteiligt
    s = removeStack(s, 'st-1');
    expect(s.stacks).toHaveLength(0);
    expect(s.docs.map((d) => d.id)).toEqual(['id-2', 'id-3']);
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './removal'`.

- [ ] **Step 3: Implementieren**

Create `src/lib/state/removal.ts`:

```ts
import { findStack, stackOf, type DesktopState } from './model';
import { removeLinksFor } from './links';
import { dissolveStack } from './stacks';

export function removeDoc(s: DesktopState, docId: string): DesktopState {
  const st = stackOf(s, docId);
  let next = removeLinksFor(s, docId);
  next = { ...next, docs: next.docs.filter((d) => d.id !== docId) };
  if (st) {
    next = {
      ...next,
      stacks: next.stacks.map((x) =>
        x.id === st.id ? { ...x, docIds: x.docIds.filter((i) => i !== docId) } : x,
      ),
    };
    if (findStack(next, st.id)!.docIds.length === 1) next = dissolveStack(next, st.id);
  }
  return next;
}

export function removeStack(s: DesktopState, stackId: string): DesktopState {
  const st = findStack(s, stackId);
  if (!st) return s;
  let next = removeLinksFor(s, stackId);
  for (const docId of st.docIds) next = removeLinksFor(next, docId);
  return {
    ...next,
    docs: next.docs.filter((d) => !st.docIds.includes(d.id)),
    stacks: next.stacks.filter((x) => x.id !== stackId),
  };
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/state
git commit -m "feat: Entfernen von Dokumenten und Stapeln mit Verknüpfungs-Aufräumen" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Viewport & Geometrie

**Files:**
- Create: `src/lib/state/viewport.ts`
- Create: `src/lib/state/geometry.ts`
- Test: `src/lib/state/viewport.test.ts`, `src/lib/state/geometry.test.ts`

**Interfaces:**
- Consumes: `./model` (`CARD_W`, `CARD_H`, `freeDocs`, Typen).
- Produces (viewport.ts): `interface Viewport { x, y, scale }` (screen = world·scale + offset), `screenToWorld(vp, p): Vec2`, `zoomAt(vp, screenPt, factor, min = 0.15, max = 3): Viewport` (Punkt unter dem Cursor bleibt fix, scale geklemmt), `interface Box { x, y, w, h }`, `zoomToFit(boxes, view {w, h}, padding = 80): Viewport` (leer → `{x: 0, y: 0, scale: 1}`).
- Produces (geometry.ts): `docBox(doc): Box`, `stackBox(stack): Box` (CARD + 24 px Versatzrand), `allBoxes(s): Box[]` (freie Docs + Stapel), `hitTest(s, worldPt, excludeId): { kind: 'doc' | 'stack'; id: string } | null` (oberster Treffer nach zIndex; gestapelte Dokumente werden nicht einzeln getroffen).

- [ ] **Step 1: Failing Tests schreiben**

Create `src/lib/state/viewport.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { screenToWorld, zoomAt, zoomToFit, type Viewport } from './viewport';

describe('screenToWorld', () => {
  it('rechnet Bildschirm- in Weltkoordinaten um', () => {
    const vp: Viewport = { x: 100, y: 50, scale: 2 };
    expect(screenToWorld(vp, { x: 300, y: 250 })).toEqual({ x: 100, y: 100 });
  });
});

describe('zoomAt', () => {
  it('hält den Punkt unter dem Cursor fix', () => {
    const vp: Viewport = { x: 10, y: 20, scale: 1 };
    const cursor = { x: 400, y: 300 };
    const before = screenToWorld(vp, cursor);
    const after = screenToWorld(zoomAt(vp, cursor, 1.5), cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('klemmt den Zoomfaktor auf [0.15, 3]', () => {
    const vp: Viewport = { x: 0, y: 0, scale: 1 };
    expect(zoomAt(vp, { x: 0, y: 0 }, 100).scale).toBe(3);
    expect(zoomAt(vp, { x: 0, y: 0 }, 0.0001).scale).toBe(0.15);
  });
});

describe('zoomToFit', () => {
  it('liefert Standard-Viewport bei leerer Fläche', () => {
    expect(zoomToFit([], { w: 800, h: 600 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('zentriert den Inhalt und hält das Padding ein', () => {
    const vp = zoomToFit([{ x: 0, y: 0, w: 100, h: 100 }, { x: 900, y: 400, w: 100, h: 100 }], { w: 1000, h: 700 });
    // Bounding-Box-Zentrum (500, 250) landet in der Viewmitte (500, 350)
    expect(500 * vp.scale + vp.x).toBeCloseTo(500);
    expect(250 * vp.scale + vp.y).toBeCloseTo(350);
    // Inhalt (1000 breit) passt in 1000 - 2*80 → scale = 840/1000
    expect(vp.scale).toBeCloseTo(0.84);
  });
});
```

Create `src/lib/state/geometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState, CARD_W, CARD_H, type DesktopState } from './model';
import { addDoc } from './documents';
import { stackDocs } from './stacks';
import { docBox, stackBox, allBoxes, hitTest } from './geometry';

function base(): DesktopState {
  let s = addDoc(emptyState(), '/tmp/a.pdf', { x: 0, y: 0 }, 'id-a');
  s = addDoc(s, '/tmp/b.pdf', { x: 50, y: 50 }, 'id-b');
  return addDoc(s, '/tmp/c.pdf', { x: 1000, y: 1000 }, 'id-c');
}

describe('Boxen', () => {
  it('docBox nutzt Kartenmaße, stackBox hat 24 px Versatzrand', () => {
    const s = base();
    expect(docBox(s.docs[0])).toEqual({ x: 0, y: 0, w: CARD_W, h: CARD_H });
    const st = { id: 'st', name: '', docIds: [], position: { x: 5, y: 6 }, zIndex: 0 };
    expect(stackBox(st)).toEqual({ x: 5, y: 6, w: CARD_W + 24, h: CARD_H + 24 });
  });

  it('allBoxes enthält freie Dokumente und Stapel, keine gestapelten Dokumente', () => {
    const s = stackDocs(base(), 'id-b', 'id-a', 'st-1');
    expect(allBoxes(s)).toHaveLength(2); // id-c frei + st-1
  });
});

describe('hitTest', () => {
  it('trifft das oberste Element (höchster zIndex) und ignoriert excludeId', () => {
    const s = base(); // id-b (z=2) überlappt id-a (z=1) bei (60, 60)
    expect(hitTest(s, { x: 60, y: 60 }, 'id-x')).toEqual({ kind: 'doc', id: 'id-b' });
    expect(hitTest(s, { x: 60, y: 60 }, 'id-b')).toEqual({ kind: 'doc', id: 'id-a' });
  });

  it('trifft Stapel statt der enthaltenen Dokumente und null bei Leerraum', () => {
    const s = stackDocs(base(), 'id-b', 'id-a', 'st-1');
    expect(hitTest(s, { x: 10, y: 10 }, 'id-x')).toEqual({ kind: 'stack', id: 'st-1' });
    expect(hitTest(s, { x: 5000, y: 5000 }, 'id-x')).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './viewport'` (bzw. `./geometry`).

- [ ] **Step 3: Implementieren**

Create `src/lib/state/viewport.ts`:

```ts
import type { Vec2 } from './model';

/** screen = world * scale + (x, y) */
export interface Viewport { x: number; y: number; scale: number }

export interface Box { x: number; y: number; w: number; h: number }

export function screenToWorld(vp: Viewport, p: Vec2): Vec2 {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

export function zoomAt(vp: Viewport, screenPt: Vec2, factor: number, min = 0.15, max = 3): Viewport {
  const scale = Math.min(max, Math.max(min, vp.scale * factor));
  const w = screenToWorld(vp, screenPt);
  return { scale, x: screenPt.x - w.x * scale, y: screenPt.y - w.y * scale };
}

export function zoomToFit(boxes: Box[], view: { w: number; h: number }, padding = 80): Viewport {
  if (boxes.length === 0) return { x: 0, y: 0, scale: 1 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const scale = Math.min(
    3,
    Math.max(0.15, Math.min((view.w - 2 * padding) / (maxX - minX || 1), (view.h - 2 * padding) / (maxY - minY || 1))),
  );
  return {
    scale,
    x: view.w / 2 - ((minX + maxX) / 2) * scale,
    y: view.h / 2 - ((minY + maxY) / 2) * scale,
  };
}
```

Create `src/lib/state/geometry.ts`:

```ts
import { CARD_W, CARD_H, freeDocs, type DesktopState, type Doc, type Stack, type Vec2 } from './model';
import type { Box } from './viewport';

export function docBox(d: Doc): Box {
  return { x: d.position.x, y: d.position.y, w: CARD_W, h: CARD_H };
}

export function stackBox(st: Stack): Box {
  return { x: st.position.x, y: st.position.y, w: CARD_W + 24, h: CARD_H + 24 };
}

export function allBoxes(s: DesktopState): Box[] {
  return [...freeDocs(s).map(docBox), ...s.stacks.map(stackBox)];
}

export function hitTest(
  s: DesktopState,
  p: Vec2,
  excludeId: string,
): { kind: 'doc' | 'stack'; id: string } | null {
  const inside = (b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  const candidates = [
    ...s.stacks
      .filter((st) => st.id !== excludeId && inside(stackBox(st)))
      .map((st) => ({ kind: 'stack' as const, id: st.id, z: st.zIndex })),
    ...freeDocs(s)
      .filter((d) => d.id !== excludeId && inside(docBox(d)))
      .map((d) => ({ kind: 'doc' as const, id: d.id, z: d.zIndex })),
  ];
  candidates.sort((a, b) => b.z - a.z);
  return candidates[0] ? { kind: candidates[0].kind, id: candidates[0].id } : null;
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/state
git commit -m "feat: Viewport-Transformationen und Geometrie mit Hit-Test" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Persistenz mit Backup

**Files:**
- Create: `src/lib/persistence.ts`
- Test: `src/lib/persistence.test.ts`

**Interfaces:**
- Consumes: `emptyState`, `DesktopState` aus `./state/model`; `@tauri-apps/plugin-fs`, `@tauri-apps/api/path`.
- Produces: `deserialize(json: string): DesktopState | null` (pur; null bei Parse-Fehler oder falscher Struktur), `loadState(): Promise<DesktopState>` (Reihenfolge: `desktop.json` → `desktop.json.bak` → leer), `saveState(s): Promise<void>` (legt vor dem Schreiben ein Backup der Vorversion an).

- [ ] **Step 1: Failing Tests für den puren Teil schreiben**

Create `src/lib/persistence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState } from './state/model';
import { addDoc } from './state/documents';
import { deserialize } from './persistence';

describe('deserialize', () => {
  it('liest einen gültigen Zustand', () => {
    const s = addDoc(emptyState(), '/tmp/a.pdf', { x: 1, y: 2 }, 'id-a');
    expect(deserialize(JSON.stringify(s))).toEqual(s);
  });

  it('liefert null bei kaputtem JSON', () => {
    expect(deserialize('{ kaputt')).toBeNull();
  });

  it('liefert null bei falscher Struktur', () => {
    expect(deserialize('{"docs": 5}')).toBeNull();
    expect(deserialize('null')).toBeNull();
    expect(deserialize('{"docs": [], "links": []}')).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './persistence'`.

- [ ] **Step 3: Implementieren**

Create `src/lib/persistence.ts`:

```ts
import {
  BaseDirectory, copyFile, exists, mkdir, readTextFile, writeTextFile,
} from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { emptyState, type DesktopState } from './state/model';

const FILE = 'desktop.json';
const BAK = 'desktop.json.bak';
const base = { baseDir: BaseDirectory.AppData };

export function deserialize(json: string): DesktopState | null {
  try {
    const v = JSON.parse(json);
    if (!v || !Array.isArray(v.docs) || !Array.isArray(v.links) || !Array.isArray(v.stacks)) return null;
    return v as DesktopState;
  } catch {
    return null;
  }
}

async function ensureAppDataDir(): Promise<void> {
  const dir = await appDataDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/** Lädt desktop.json; bei Fehler/Beschädigung das Backup; sonst leerer Schreibtisch. */
export async function loadState(): Promise<DesktopState> {
  await ensureAppDataDir();
  for (const file of [FILE, BAK]) {
    try {
      if (await exists(file, base)) {
        const s = deserialize(await readTextFile(file, base));
        if (s) return s;
      }
    } catch {
      // weiter mit dem nächsten Kandidaten
    }
  }
  return emptyState();
}

/** Schreibt den Zustand; die Vorversion wird vorher als .bak gesichert. */
export async function saveState(s: DesktopState): Promise<void> {
  await ensureAppDataDir();
  if (await exists(FILE, base)) {
    await copyFile(FILE, BAK, { fromPathBaseDir: BaseDirectory.AppData, toPathBaseDir: BaseDirectory.AppData });
  }
  await writeTextFile(FILE, JSON.stringify(s, null, 2), base);
}
```

Hinweis: `loadState`/`saveState` laufen nur in der Tauri-Umgebung und werden manuell verifiziert (Task 9); Vitest testet nur `deserialize`.

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat: Persistenz mit Backup-Fallback" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Debounce & globaler Store

**Files:**
- Create: `src/lib/debounce.ts`
- Create: `src/lib/store.svelte.ts`
- Test: `src/lib/debounce.test.ts`

**Interfaces:**
- Consumes: `loadState`/`saveState` (Task 7), `setMissing` (Task 2), `exists` aus `@tauri-apps/plugin-fs`.
- Produces (debounce.ts): `debounce<T extends unknown[]>(ms: number, fn: (...a: T) => void): (...a: T) => void`.
- Produces (store.svelte.ts): Singleton `desktop` mit `get state(): DesktopState`, `init(): Promise<void>` (lädt Zustand, markiert fehlende Dateien via `exists`), `apply(fn: (s: DesktopState) => DesktopState, opts?: { transient?: boolean })` — wendet die pure Funktion an und speichert debounced (400 ms); `transient: true` überspringt das Speichern (für Drag-Zwischenschritte).

- [ ] **Step 1: Failing Test für debounce schreiben**

Create `src/lib/debounce.test.ts`:

```ts
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
```

- [ ] **Step 2: Test laufen lassen — er muss fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './debounce'`.

- [ ] **Step 3: Implementieren**

Create `src/lib/debounce.ts`:

```ts
export function debounce<T extends unknown[]>(ms: number, fn: (...a: T) => void): (...a: T) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: T) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
```

Create `src/lib/store.svelte.ts`:

```ts
import { exists } from '@tauri-apps/plugin-fs';
import { emptyState, type DesktopState } from './state/model';
import { setMissing } from './state/documents';
import { loadState, saveState } from './persistence';
import { debounce } from './debounce';

let state = $state<DesktopState>(emptyState());

const saveSoon = debounce(400, () => {
  void saveState($state.snapshot(state));
});

export const desktop = {
  get state(): DesktopState {
    return state;
  },

  async init(): Promise<void> {
    state = await loadState();
    for (const d of [...state.docs]) {
      const ok = await exists(d.path).catch(() => false);
      if (ok === d.missing) state = setMissing(state, d.id, !ok);
    }
  },

  apply(fn: (s: DesktopState) => DesktopState, opts: { transient?: boolean } = {}): void {
    state = fn(state);
    if (!opts.transient) saveSoon();
  },
};
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS (der Store selbst wird in Task 9 manuell in der App verifiziert).

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat: globaler Runes-Store mit debounced Autosave" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Canvas, Dokumentkarten & Import

**Files:**
- Modify: `src/routes/+page.svelte` (Template-Demo komplett ersetzen)
- Create: `src/lib/components/Desktop.svelte`
- Create: `src/lib/components/DocCard.svelte`

**Interfaces:**
- Consumes: `desktop` (Task 8), `freeDocs`/`CARD_W`/`CARD_H` (Task 2), `addDoc`/`moveDoc`/`bringToFront` (Task 2), `screenToWorld`/`zoomAt`/`zoomToFit`/`allBoxes` (Task 6), Tauri-Plugins `dialog`, `opener`, `@tauri-apps/api/webview`.
- Produces: `Desktop.svelte` (Props: keine; rendert die Fläche) und `DocCard.svelte` (Props: `doc: Doc`, `vp: Viewport`). Spätere Tasks erweitern beide per Modify-Schritten.

- [ ] **Step 1: Einstiegsseite ersetzen**

`src/routes/+page.svelte` komplett ersetzen durch (etwaige Template-Reste wie Greet-Komponenten in `src/lib` löschen):

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import Desktop from '../lib/components/Desktop.svelte';
  import { desktop } from '../lib/store.svelte';

  let ready = $state(false);
  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    await desktop.init();
    ready = true;
  });
</script>

{#if ready}<Desktop />{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
```

- [ ] **Step 2: Desktop.svelte anlegen**

Create `src/lib/components/Desktop.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { desktop } from '../store.svelte';
  import { freeDocs } from '../state/model';
  import { addDoc } from '../state/documents';
  import { screenToWorld, zoomAt, zoomToFit, type Viewport } from '../state/viewport';
  import { allBoxes } from '../state/geometry';
  import DocCard from './DocCard.svelte';

  let vp = $state<Viewport>({ x: 0, y: 0, scale: 1 });
  let el: HTMLDivElement;
  let panning = $state(false);
  let spaceDown = $state(false);

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad-Pinch kommt in der Webview als wheel-Event mit ctrlKey an
      vp = zoomAt(vp, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.01));
    } else {
      vp = { ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY };
    }
  }
  function onPointerDown(e: PointerEvent) {
    panning = true;
    el.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (panning) vp = { ...vp, x: vp.x + e.movementX, y: vp.y + e.movementY };
  }
  function onPointerUp() {
    panning = false;
  }

  function fitAll() {
    vp = zoomToFit(allBoxes(desktop.state), { w: el.clientWidth, h: el.clientHeight });
  }

  async function addViaDialog() {
    const picked = await openDialog({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!picked) return;
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    (Array.isArray(picked) ? picked : [picked]).forEach((p, i) => {
      desktop.apply((s) => addDoc(s, p, { x: center.x + i * 28, y: center.y + i * 20 }));
    });
  }

  onMount(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown = true; };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== 'drop') return;
      const dpr = window.devicePixelRatio;
      const world = screenToWorld(vp, { x: e.payload.position.x / dpr, y: e.payload.position.y / dpr });
      e.payload.paths
        .filter((p) => p.toLowerCase().endsWith('.pdf'))
        .forEach((p, i) => desktop.apply((s) => addDoc(s, p, { x: world.x + i * 28, y: world.y + i * 20 })));
    }).then((u) => { unlisten = u; });
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      unlisten?.();
    };
  });
</script>

<div class="desk" bind:this={el} class:grabbing={spaceDown || panning}
     onwheel={onWheel} onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}>
  <div class="world" style:transform="translate({vp.x}px, {vp.y}px) scale({vp.scale})">
    {#each freeDocs(desktop.state) as doc (doc.id)}
      <DocCard {doc} {vp} />
    {/each}
  </div>
  <div class="toolbar">
    <button onclick={addViaDialog} title="PDF hinzufügen">＋ PDF</button>
    <button onclick={fitAll}>Übersicht</button>
  </div>
</div>

<style>
  .desk { position: fixed; inset: 0; overflow: hidden;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .desk.grabbing { cursor: grabbing; }
  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; }
  .toolbar button { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
                    background: rgba(255,255,255,.92); cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
</style>
```

- [ ] **Step 3: DocCard.svelte anlegen**

Create `src/lib/components/DocCard.svelte`:

```svelte
<script lang="ts">
  import { CARD_W, CARD_H, type Doc } from '../state/model';
  import type { Viewport } from '../state/viewport';
  import { desktop } from '../store.svelte';
  import { moveDoc, bringToFront } from '../state/documents';
  import { openPath } from '@tauri-apps/plugin-opener';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let dragging = false;
  let moved = false;
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true;
    moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    desktop.apply((s) => bringToFront(s, doc.id));
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.apply(
      (s) => moveDoc(s, doc.id, { x: doc.position.x + e.movementX / vp.scale, y: doc.position.y + e.movementY / vp.scale }),
      { transient: true },
    );
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) desktop.apply((s) => s); // persistiert die Endposition
  }
</script>

<div class="card" class:missing={doc.missing}
     style:left="{doc.position.x}px" style:top="{doc.position.y}px"
     style:z-index={doc.zIndex} style:transform="rotate({doc.rotation}deg)"
     style:width="{CARD_W}px" style:height="{CARD_H}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}
     ondblclick={() => { if (!doc.missing) void openPath(doc.path); }}>
  <div class="body">
    {#if doc.missing}
      <div class="warn">⚠️<br />Datei fehlt</div>
    {:else}
      <div class="fallback">PDF</div>
    {/if}
  </div>
  <div class="name">{doc.path.split('/').pop()}</div>
</div>

<style>
  .card { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 4px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, .35); cursor: grab; user-select: none; }
  .card.missing { opacity: .55; filter: grayscale(1); }
  .body { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden;
          border-radius: 4px 4px 0 0; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  .warn { text-align: center; font-size: 14px; }
  .name { padding: 4px 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          background: rgba(255, 255, 255, .9); border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
</style>
```

- [ ] **Step 4: Manuell verifizieren**

Run: `npm run tauri dev`

Prüfliste:
1. Über „＋ PDF“ eine PDF wählen → Karte erscheint in der Bildschirmmitte (weiße Karte mit „PDF“-Platzhalter und Dateiname).
2. Eine PDF aus dem Finder auf das Fenster ziehen → Karte erscheint an der Abwurfstelle; Nicht-PDFs werden ignoriert.
3. Karte ziehen → sie folgt dem Cursor, zuletzt angefasste Karte liegt oben.
4. Doppelklick → PDF öffnet sich in Vorschau.
5. Zwei-Finger-Scrollen bewegt die Ansicht; Pinch (oder Cmd+Scrollen) zoomt um den Cursor; Ziehen auf leerer Fläche pant.
6. „Übersicht“ → alle Karten sichtbar und zentriert.
7. App beenden und neu starten → alle Karten liegen an ihrer letzten Position (Autosave/Load funktioniert).

Falls die Konsole (Terminal, in dem `tauri dev` läuft) einen Permission-Fehler zeigt, den genannten Identifier in `src-tauri/capabilities/default.json` ergänzen.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Schreibtisch-Canvas mit Pan/Zoom, Import, Karten-Drag und Öffnen in Vorschau" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: PDF-Miniaturen mit Cache

**Files:**
- Create: `src/lib/thumbnails.ts`
- Modify: `src/lib/components/DocCard.svelte`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `Doc` (Task 2), plugin-fs, `pdfjs-dist`.
- Produces: `getThumbnail(doc: Doc): Promise<string | null>` (Object-URL der PNG-Miniatur; Cache in AppData `thumbnails/<docId>.png`; `null` bei defektem/geschütztem PDF), `invalidateThumbnail(id: string): void`.

- [ ] **Step 1: Berechtigung fürs Cache-Löschen ergänzen**

In `src-tauri/capabilities/default.json` im `permissions`-Array ergänzen:

```json
{ "identifier": "fs:allow-remove", "allow": [{ "path": "$APPDATA/**" }] }
```

- [ ] **Step 2: thumbnails.ts anlegen**

Create `src/lib/thumbnails.ts`:

```ts
import {
  BaseDirectory, exists, mkdir, readFile, remove, writeFile,
} from '@tauri-apps/plugin-fs';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Doc } from './state/model';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = { baseDir: BaseDirectory.AppData };
const cachePath = (id: string) => `thumbnails/${id}.png`;
const urls = new Map<string, string>();

function remember(id: string, bytes: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  urls.set(id, url);
  return url;
}

/** Object-URL der Miniatur der ersten Seite; nutzt den PNG-Cache, sonst rendern. Null, wenn nicht renderbar. */
export async function getThumbnail(doc: Doc): Promise<string | null> {
  const cached = urls.get(doc.id);
  if (cached) return cached;
  try {
    if (await exists(cachePath(doc.id), base)) {
      return remember(doc.id, await readFile(cachePath(doc.id), base));
    }
    const data = await readFile(doc.path);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const scale = 360 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob fehlgeschlagen'))), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await mkdir('thumbnails', { ...base, recursive: true }).catch(() => {});
    await writeFile(cachePath(doc.id), bytes, base).catch(() => {});
    return remember(doc.id, bytes);
  } catch {
    return null; // defekt oder passwortgeschützt → Karte zeigt generisches Symbol
  }
}

/** Nach „Datei neu verknüpfen…“: gecachte Miniatur verwerfen. */
export function invalidateThumbnail(id: string): void {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  void remove(cachePath(id), base).catch(() => {});
}
```

- [ ] **Step 3: DocCard an Miniaturen anschließen**

In `src/lib/components/DocCard.svelte` im `<script>` ergänzen:

```ts
import { getThumbnail } from '../thumbnails';

let thumb = $state<string | null>(null);
$effect(() => {
  doc.path; // Abhängigkeit: nach „Neu verknüpfen“ neu rendern
  if (doc.missing) { thumb = null; return; }
  void getThumbnail(doc).then((t) => (thumb = t));
});
```

Im Markup den `body`-Block ersetzen durch:

```svelte
  <div class="body">
    {#if doc.missing}
      <div class="warn">⚠️<br />Datei fehlt</div>
    {:else if thumb}
      <img src={thumb} alt="" draggable="false" />
    {:else}
      <div class="fallback">PDF</div>
    {/if}
  </div>
```

Im `<style>` ergänzen:

```css
  img { width: 100%; height: 100%; object-fit: cover; object-position: top; pointer-events: none; }
```

- [ ] **Step 4: Manuell verifizieren**

Run: `npm run tauri dev`

1. Vorhandene Karten zeigen jetzt die erste PDF-Seite als Miniatur.
2. App neu starten → Miniaturen erscheinen sofort (aus dem Cache, ohne Neu-Rendern; erkennbar an `~/Library/Application Support/de.baumfalk.digitaldesktop/thumbnails/*.png`).
3. Eine bewusst kaputte Datei mit Endung `.pdf` (z.B. umbenannte Textdatei) hineinziehen → Karte mit „PDF“-Platzhalter, keine Fehler-Popups; Verschieben funktioniert.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: PDF-Miniaturen der ersten Seite mit PNG-Cache" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Kontextmenü & Verknüpfungs-UI

**Files:**
- Create: `src/lib/ui.svelte.ts`
- Create: `src/lib/menus.ts`
- Create: `src/lib/components/ContextMenu.svelte`
- Create: `src/lib/components/LinkLayer.svelte`
- Modify: `src/lib/components/DocCard.svelte`, `src/lib/components/Desktop.svelte`

**Interfaces:**
- Consumes: Links-Logik (Task 3), removal (Task 5), `invalidateThumbnail` (Task 10), plugin-dialog/opener.
- Produces (ui.svelte.ts): `interface MenuItem { label: string; action: () => void }`; `ui`-Singleton mit `linkingFromId: string | null`, `editingStackId: string | null`, `menu: { x, y, items: MenuItem[] } | null`.
- Produces (menus.ts): `showDocMenu(e: MouseEvent, doc: Doc)`, `showStackMenu(e: MouseEvent, stack: Stack)`, `openWithLinked(entityId: string)`, `relinkDoc(doc: Doc): Promise<void>`.
- Produces: `ContextMenu.svelte` (keine Props, liest `ui.menu`), `LinkLayer.svelte` (keine Props; rendert Linien + Notiz-Popover in Weltkoordinaten).

- [ ] **Step 1: UI-Zustand anlegen**

Create `src/lib/ui.svelte.ts`:

```ts
export interface MenuItem {
  label: string;
  action: () => void;
}

export const ui = $state({
  linkingFromId: null as string | null,
  editingStackId: null as string | null,
  fannedStackId: null as string | null,
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
});
```

- [ ] **Step 2: Menü-Aktionen anlegen**

Create `src/lib/menus.ts`:

```ts
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import type { Doc, Stack } from './state/model';
import { collectLinkedPaths } from './state/links';
import { setDocPath } from './state/documents';
import { dissolveStack } from './state/stacks';
import { removeDoc, removeStack } from './state/removal';
import { desktop } from './store.svelte';
import { ui } from './ui.svelte';
import { invalidateThumbnail } from './thumbnails';

export function openWithLinked(entityId: string): void {
  for (const p of collectLinkedPaths(desktop.state, entityId)) void openPath(p);
}

export async function relinkDoc(doc: Doc): Promise<void> {
  const picked = await openDialog({ multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (typeof picked === 'string') {
    invalidateThumbnail(doc.id);
    desktop.apply((s) => setDocPath(s, doc.id, picked));
  }
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  const items = doc.missing
    ? [
        { label: 'Datei neu verknüpfen…', action: () => void relinkDoc(doc) },
        { label: 'Vom Schreibtisch entfernen', action: () => desktop.apply((s) => removeDoc(s, doc.id)) },
      ]
    : [
        { label: 'Öffnen', action: () => void openPath(doc.path) },
        { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
        { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
        { label: 'Im Finder zeigen', action: () => void revealItemInDir(doc.path) },
        { label: 'Vom Schreibtisch entfernen', action: () => desktop.apply((s) => removeDoc(s, doc.id)) },
      ];
  ui.menu = { x: e.clientX, y: e.clientY, items };
}

export function showStackMenu(e: MouseEvent, stack: Stack): void {
  ui.menu = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Auffächern', action: () => { ui.fannedStackId = ui.fannedStackId === stack.id ? null : stack.id; } },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(stack.id) },
      { label: 'Benennen…', action: () => { ui.editingStackId = stack.id; } },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = stack.id; } },
      { label: 'Stapel auflösen', action: () => desktop.apply((s) => dissolveStack(s, stack.id)) },
      { label: 'Vom Schreibtisch entfernen', action: () => desktop.apply((s) => removeStack(s, stack.id)) },
    ],
  };
}
```

- [ ] **Step 3: ContextMenu-Komponente anlegen**

Create `src/lib/components/ContextMenu.svelte`:

```svelte
<script lang="ts">
  import { ui } from '../ui.svelte';
</script>

{#if ui.menu}
  <div class="backdrop" onpointerdown={() => (ui.menu = null)} oncontextmenu={(e) => { e.preventDefault(); ui.menu = null; }}></div>
  <div class="menu" style:left="{ui.menu.x}px" style:top="{ui.menu.y}px">
    {#each ui.menu.items as item (item.label)}
      <button onpointerdown={(e) => e.stopPropagation()} onclick={() => { item.action(); ui.menu = null; }}>
        {item.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 99998; }
  .menu { position: fixed; z-index: 99999; min-width: 220px; padding: 4px; border-radius: 10px;
          background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; }
  .menu button { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
                 font-size: 13px; cursor: pointer; }
  .menu button:hover { background: #e8eefc; }
</style>
```

- [ ] **Step 4: LinkLayer-Komponente anlegen**

Create `src/lib/components/LinkLayer.svelte`:

```svelte
<script lang="ts">
  import { desktop } from '../store.svelte';
  import { CARD_W, CARD_H, findDoc, findStack, stackOf, type Vec2 } from '../state/model';
  import { removeLink, setLinkNote } from '../state/links';

  let openLinkId = $state<string | null>(null);
  const openLink = $derived(desktop.state.links.find((l) => l.id === openLinkId) ?? null);

  /** Linien-Endpunkt: Kartenmitte; liegt das Dokument in einem Stapel, endet die Linie am Stapel. */
  function endpoint(id: string): Vec2 | null {
    const s = desktop.state;
    const stack = findStack(s, id) ?? stackOf(s, id);
    if (stack) return { x: stack.position.x + (CARD_W + 24) / 2, y: stack.position.y + (CARD_H + 24) / 2 };
    const d = findDoc(s, id);
    return d ? { x: d.position.x + CARD_W / 2, y: d.position.y + CARD_H / 2 } : null;
  }

  function curve(a: Vec2, b: Vec2): string {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return `M ${a.x} ${a.y} Q ${mx - (dy / len) * 40} ${my + (dx / len) * 40} ${b.x} ${b.y}`;
  }
</script>

<svg class="links">
  {#each desktop.state.links as link (link.id)}
    {@const a = endpoint(link.fromId)}
    {@const b = endpoint(link.toId)}
    {#if a && b}
      <path d={curve(a, b)} class="hit" onpointerdown={(e) => { e.stopPropagation(); openLinkId = link.id; }} />
      <path d={curve(a, b)} class="line" />
      {#if link.note}
        <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + 28} text-anchor="middle" class="note">{link.note}</text>
      {/if}
    {/if}
  {/each}
</svg>

{#if openLink}
  {@const a = endpoint(openLink.fromId)}
  {@const b = endpoint(openLink.toId)}
  {#if a && b}
    <div class="popover" style:left="{(a.x + b.x) / 2}px" style:top="{(a.y + b.y) / 2}px"
         onpointerdown={(e) => e.stopPropagation()}>
      <textarea placeholder="Notiz zur Verknüpfung…" value={openLink.note}
        oninput={(e) => { const note = (e.currentTarget as HTMLTextAreaElement).value; desktop.apply((s) => setLinkNote(s, openLink.id, note)); }}
      ></textarea>
      <div class="row">
        <button onclick={() => { desktop.apply((s) => removeLink(s, openLink.id)); openLinkId = null; }}>Verknüpfung lösen</button>
        <button onclick={() => (openLinkId = null)}>Schließen</button>
      </div>
    </div>
  {/if}
{/if}

<style>
  svg.links { position: absolute; overflow: visible; width: 1px; height: 1px; }
  path.line { fill: none; stroke: #f2e2b8; stroke-width: 2; pointer-events: none; }
  path.hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; }
  text.note { fill: #fdf9ec; font-size: 12px; paint-order: stroke; stroke: rgba(0, 0, 0, .55); stroke-width: 3px; }
  .popover { position: absolute; transform: translate(-50%, 10px); z-index: 100000; width: 230px;
             background: #fff; border-radius: 10px; padding: 10px; box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
             display: flex; flex-direction: column; gap: 8px; }
  textarea { width: 100%; min-height: 60px; font: inherit; font-size: 12px; box-sizing: border-box; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row button { font-size: 12px; cursor: pointer; }
</style>
```

Hinweis: Das Popover liegt im gezoomten Welt-Layer und skaliert mit — bei üblichen Zoomstufen (0.5–1.5) gut lesbar und für v1 in Ordnung.

- [ ] **Step 5: DocCard erweitern (Kontextmenü + Verknüpfen-Klick)**

In `src/lib/components/DocCard.svelte` importieren:

```ts
import { addLink } from '../state/links';
import { ui } from '../ui.svelte';
import { showDocMenu } from '../menus';
```

Am Anfang von `onPointerDown` (direkt nach dem `e.stopPropagation();`) einfügen:

```ts
    if (ui.linkingFromId && ui.linkingFromId !== doc.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      desktop.apply((s) => addLink(s, from, doc.id));
      return;
    }
    if (ui.linkingFromId === doc.id) {
      ui.linkingFromId = null;
      return;
    }
```

Am Karten-`<div>` ergänzen:

```svelte
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, doc); }}
```

- [ ] **Step 6: Desktop erweitern (Layer einhängen, Verknüpfen-Hinweis, Escape)**

In `src/lib/components/Desktop.svelte` importieren:

```ts
import LinkLayer from './LinkLayer.svelte';
import ContextMenu from './ContextMenu.svelte';
import { ui } from '../ui.svelte';
```

In `onMount` den `down`-Handler ersetzen durch:

```ts
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = true;
      if (e.code === 'Escape') { ui.linkingFromId = null; ui.menu = null; }
    };
```

Im Markup: als erstes Kind von `.world` (vor dem `{#each}`) `<LinkLayer />` einfügen; nach der Toolbar einfügen:

```svelte
  {#if ui.linkingFromId}
    <div class="hint">Verknüpfen: Ziel anklicken (Esc bricht ab)</div>
  {/if}
  <ContextMenu />
```

Im `<style>` ergänzen:

```css
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
          border-radius: 999px; background: rgba(20, 40, 90, .85); color: #fff; font-size: 13px; z-index: 9999; }
```

- [ ] **Step 7: Manuell verifizieren**

Run: `npm run tauri dev`

1. Rechtsklick auf Karte → deutsches Kontextmenü mit 5 Einträgen; „Öffnen“ und „Im Finder zeigen“ funktionieren.
2. „Verknüpfen…“ → Hinweisbanner erscheint; Klick auf zweite Karte → geschwungene helle Linie zwischen beiden. Esc bricht den Modus ab.
3. Klick auf die Linie → Popover; Notiz „Rechnung zu Vertrag X“ eintippen, schließen → Notiz steht als Text an der Linienmitte. Neustart → Linie und Notiz sind noch da.
4. „Verknüpfung lösen“ → Linie verschwindet.
5. Zweite Verknüpfung zwischen denselben Karten (auch andersherum) wird nicht angelegt.
6. „Mit allen Verknüpften öffnen“ → beide PDFs öffnen sich in Vorschau.
7. „Vom Schreibtisch entfernen“ → Karte und ihre Linien verschwinden; die Datei existiert weiterhin im Finder.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: Kontextmenü und Verknüpfungen mit Linien, Notizen und gemeinsamem Öffnen" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Stapel-UI & fehlende Dateien

**Files:**
- Create: `src/lib/components/StackCard.svelte`
- Modify: `src/lib/components/DocCard.svelte` (Ablegen auf Karte/Stapel → stapeln)
- Modify: `src/lib/components/Desktop.svelte` (Stapel rendern)

**Interfaces:**
- Consumes: Stapel-Logik (Task 4), `hitTest` (Task 6), `showStackMenu`/`ui` (Task 11), `getThumbnail` (Task 10).
- Produces: `StackCard.svelte` (Props: `stack: Stack`, `vp: Viewport`) — Klick fächert auf/zu, Ziehen verschiebt, gefächerte Einträge lassen sich herausziehen (>30 px) oder per Klick öffnen; Umbenennen über `ui.editingStackId`.

- [ ] **Step 1: StackCard.svelte anlegen**

Create `src/lib/components/StackCard.svelte`:

```svelte
<script lang="ts">
  import { CARD_W, CARD_H, findDoc, type Stack } from '../state/model';
  import { screenToWorld, type Viewport } from '../state/viewport';
  import { desktop } from '../store.svelte';
  import { bringToFront } from '../state/documents';
  import { moveStack, removeFromStack, renameStack } from '../state/stacks';
  import { addLink } from '../state/links';
  import { openPath } from '@tauri-apps/plugin-opener';
  import { ui } from '../ui.svelte';
  import { showStackMenu } from '../menus';
  import { getThumbnail } from '../thumbnails';

  let { stack, vp }: { stack: Stack; vp: Viewport } = $props();
  const fanned = $derived(ui.fannedStackId === stack.id);

  const topDoc = $derived(findDoc(desktop.state, stack.docIds[stack.docIds.length - 1]));
  let thumb = $state<string | null>(null);
  $effect(() => {
    if (topDoc && !topDoc.missing) void getThumbnail(topDoc).then((t) => (thumb = t));
    else thumb = null;
  });

  let dragging = false;
  let moved = false;
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== stack.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      desktop.apply((s) => addLink(s, from, stack.id));
      return;
    }
    if (ui.linkingFromId === stack.id) {
      ui.linkingFromId = null;
      return;
    }
    dragging = true;
    moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    desktop.apply((s) => bringToFront(s, stack.id));
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.apply(
      (s) => moveStack(s, stack.id, { x: stack.position.x + e.movementX / vp.scale, y: stack.position.y + e.movementY / vp.scale }),
      { transient: true },
    );
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) desktop.apply((s) => s);
    else ui.fannedStackId = fanned ? null : stack.id;
  }

  /** Gefächerter Eintrag: >30 px ziehen = herausnehmen, sonst Klick = öffnen. */
  function fanPointerDown(e: PointerEvent, docId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const onUp = (up: PointerEvent) => {
      window.removeEventListener('pointerup', onUp);
      if (Math.hypot(up.clientX - startX, up.clientY - startY) > 30) {
        const w = screenToWorld(vp, { x: up.clientX, y: up.clientY });
        desktop.apply((s) => removeFromStack(s, docId, { x: w.x - CARD_W / 2, y: w.y - CARD_H / 2 }));
      } else {
        const d = findDoc(desktop.state, docId);
        if (d && !d.missing) void openPath(d.path);
      }
    };
    window.addEventListener('pointerup', onUp);
  }
</script>

<div class="stack" style:left="{stack.position.x}px" style:top="{stack.position.y}px" style:z-index={stack.zIndex}
     style:width="{CARD_W + 24}px" style:height="{CARD_H + 24}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}
     oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showStackMenu(e, stack); }}>
  <div class="sheet s2"></div>
  <div class="sheet s1"></div>
  <div class="sheet top">
    {#if thumb}
      <img src={thumb} alt="" draggable="false" />
    {:else}
      <div class="fallback">PDF</div>
    {/if}
  </div>
  <div class="badge">{stack.docIds.length}</div>
  {#if ui.editingStackId === stack.id}
    <input class="name" value={stack.name} placeholder="Stapelname"
           onpointerdown={(e) => e.stopPropagation()}
           onchange={(e) => { const name = (e.currentTarget as HTMLInputElement).value; desktop.apply((s) => renameStack(s, stack.id, name)); ui.editingStackId = null; }} />
  {:else if stack.name}
    <div class="name label">{stack.name}</div>
  {/if}

  {#if fanned}
    <div class="fan">
      {#each stack.docIds as docId (docId)}
        {@const d = findDoc(desktop.state, docId)}
        {#if d}
          <div class="fan-card" onpointerdown={(e) => fanPointerDown(e, docId)}>
            {d.path.split('/').pop()}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .stack { position: absolute; cursor: grab; user-select: none; }
  .sheet { position: absolute; width: 180px; height: 240px; background: #fff; border-radius: 4px;
           box-shadow: 0 6px 18px rgba(0, 0, 0, .35); overflow: hidden; }
  .sheet.s2 { left: 16px; top: 16px; transform: rotate(2deg); }
  .sheet.s1 { left: 8px; top: 8px; transform: rotate(-1.5deg); }
  .sheet.top { left: 0; top: 0; display: flex; align-items: center; justify-content: center; }
  .sheet img { width: 100%; height: 100%; object-fit: cover; object-position: top; pointer-events: none; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  .badge { position: absolute; top: -10px; right: 2px; min-width: 22px; height: 22px; border-radius: 11px;
           background: #d9534f; color: #fff; font-size: 12px; font-weight: 700;
           display: flex; align-items: center; justify-content: center; padding: 0 5px; }
  .name { position: absolute; left: 0; bottom: -26px; width: 100%; text-align: center; font-size: 12px; }
  .name.label { color: #fdf9ec; text-shadow: 0 1px 3px rgba(0, 0, 0, .7); }
  input.name { box-sizing: border-box; border-radius: 6px; border: none; padding: 3px 6px; }
  .fan { position: absolute; left: 0; top: 100%; margin-top: 34px; display: flex; flex-direction: column;
         gap: 4px; width: 220px; background: rgba(255, 255, 255, .95); border-radius: 10px; padding: 6px;
         box-shadow: 0 8px 30px rgba(0, 0, 0, .35); }
  .fan-card { padding: 7px 9px; border-radius: 6px; background: #fff; border: 1px solid #e5e5e5;
              font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .fan-card:hover { background: #eef3ff; }
</style>
```

- [ ] **Step 2: DocCard — Ablegen auf Karte/Stapel stapelt**

In `src/lib/components/DocCard.svelte` importieren:

```ts
import { stackDocs } from '../state/stacks';
import { hitTest } from '../state/geometry';
```

`onPointerUp` ersetzen durch:

```ts
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    const center = { x: doc.position.x + CARD_W / 2, y: doc.position.y + CARD_H / 2 };
    const hit = hitTest(desktop.state, center, doc.id);
    if (hit) desktop.apply((s) => stackDocs(s, doc.id, hit.id));
    else desktop.apply((s) => s); // persistiert die Endposition
  }
```

- [ ] **Step 3: Desktop — Stapel rendern**

In `src/lib/components/Desktop.svelte`:

```ts
import StackCard from './StackCard.svelte';
```

Im Markup nach dem DocCard-`{#each}` einfügen:

```svelte
    {#each desktop.state.stacks as stack (stack.id)}
      <StackCard {stack} {vp} />
    {/each}
```

- [ ] **Step 4: Manuell verifizieren**

Run: `npm run tauri dev`

1. Karte auf eine andere ziehen und loslassen → Stapel entsteht (versetzte Blätter, rotes Anzahl-Badge „2“).
2. Weitere Karte auf den Stapel ziehen → Badge zeigt „3“.
3. Klick auf den Stapel → Liste fächert auf; Klick auf einen Eintrag öffnet das PDF; Eintrag >30 px wegziehen → Dokument liegt als freie Karte an der Zielstelle.
4. Herausziehen bis nur eins übrig ist → Stapel löst sich auf.
5. Rechtsklick auf Stapel → Menü; „Benennen…“ → Eingabefeld unter dem Stapel, Name bleibt nach Neustart erhalten; „Stapel auflösen“ legt die Karten versetzt nebeneinander.
6. Verknüpfung von einer freien Karte zu einem Stapel ziehen („Verknüpfen…“) → Linie endet am Stapel. Karte mit bestehender Verknüpfung in einen Stapel legen → ihre Linie endet jetzt am Stapel; nach dem Herausziehen wieder an der Karte.
7. Fehlende Dateien: App beenden, eine referenzierte PDF im Finder umbenennen, App starten → Karte ausgegraut mit „⚠️ Datei fehlt“; Doppelklick tut nichts; Rechtsklick → „Datei neu verknüpfen…“ auf die umbenannte Datei → Miniatur erscheint, Verknüpfungen sind noch da.
8. `desktop.json` absichtlich beschädigen (z.B. erste Zeile löschen), App starten → Zustand aus `desktop.json.bak` geladen, Schreibtisch nicht leer.

- [ ] **Step 5: Abschluss-Commit**

```bash
npm test
git add -A
git commit -m "feat: Stapel-UI mit Auffächern, Benennen und Umgang mit fehlenden Dateien" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Run: `npm test`
Expected: PASS — alle Unit-Tests weiterhin grün.
