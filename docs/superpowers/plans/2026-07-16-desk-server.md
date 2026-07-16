# Digital Desktop v2 Teilprojekt 1 — Server-Fundament & Client-Umbau: Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Digital Desktop wird Client-Server: Ein Node-Server (Fastify + SQLite + WebSocket) besitzt Benutzer, Schreibtische, Zustand und PDF-Ablage; die bestehende Tauri-App wird zum Client mit Login, Upload statt Pfad-Referenz und Live-Sync.

**Architecture:** Monorepo mit npm-Workspaces: `packages/core` (pure Zustandslogik + Kommando-Registry, von Server UND Client genutzt), `packages/server` (Fastify, better-sqlite3, ws; Karten-Zustand als JSON-Spalte pro Desk, PDFs als `files/<sha256>.pdf`), Wurzel = Tauri-Client. Server ist die einzige Wahrheit; Client sendet Kommandos (HTTP) und empfängt `{rev, state}`-Broadcasts (WebSocket); transiente Drags bleiben lokal.

**Tech Stack:** npm-Workspaces, TypeScript, Fastify 5 (+ cors, multipart, websocket), better-sqlite3, argon2, tsx, Vitest; Client: Svelte 5, Tauri 2 (+ Plugins http, websocket, fs, dialog, opener), pdfjs-dist.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-desk-server-design.md` — bei Widerspruch gilt die Spec.
- Alle UI-Texte und Server-Fehlermeldungen auf Deutsch.
- `packages/core`: nur pure Funktionen `(state, …) → state`, keine I/O-, Tauri- oder Node-API-Abhängigkeit; relative Imports innerhalb des Pakets.
- API-Prefix `/api/v1`; Auth via `Authorization: Bearer <token>` (WS: `?token=`); Kommando-Typen exakt: addDoc, moveDoc, bringToFront, removeDoc, addLink, setLinkNote, removeLink, stackDocs, removeFromStack, dissolveStack, renameStack, moveStack, removeStack.
- Server: Port-Default 4810 (ENV `PORT`), Datenordner-Default `./data` (ENV `DATA_DIR`); Uploads nur `.pdf` mit `%PDF-`-Signatur, max. 100 MB; Passwörter argon2id, Mindestlänge 8; Sitzungsverfall nach 30 Tagen Inaktivität.
- Client löscht nie Original-Dateien des Nutzers; Uploads lassen Originale unberührt.
- IDs via `crypto.randomUUID()`, in core-Funktionen als optionaler Parameter injizierbar.
- **Bau-Reihenfolge-Hinweis:** Ab Task 2 bis einschließlich Task 11 ist der Tauri-Client bewusst nicht lauffähig/kompilierbar (Modellwechsel `path`→`fileId`). Qualitäts-Gate bis dahin: `npm test` (Vitest). `svelte-check` und App-Start sind erst ab Task 12 wieder Gates.
- Jeder Commit endet mit der Zeile `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Dateistruktur

```
package.json                    Workspace-Root (+ Client-Abhängigkeiten wie bisher)
packages/core/
├── package.json                @digital-desktop/core, exports ./src/index.ts
└── src/
    ├── index.ts                Re-Exports aller Module
    ├── model.ts                Typen (Doc mit fileId+name), Finder, isValidState
    ├── documents.ts            addDoc(fileId, name, …), moveDoc, bringToFront
    ├── links.ts                addLink, Notizen, collectLinkedDocs
    ├── stacks.ts | removal.ts | viewport.ts | geometry.ts   (aus src/lib/state)
    └── commands.ts             applyCommand(state, {type, payload}), CommandError
packages/server/
├── package.json                @digital-desktop/server
├── Dockerfile
└── src/
    ├── main.ts                 ENV lesen, Backup rotieren, DB öffnen, App starten
    ├── db.ts                   openDb (Schema: users, sessions, desks, desk_members, files)
    ├── auth.ts                 createUser, login, validateToken, logout, needsSetup
    ├── files.ts                storeFile (sha256-Dedup, tmp+rename), getFilePath
    ├── deskStore.ts            Desk-CRUD, applyDeskCommand (Transaktion, rev++), putDeskState
    ├── broadcast.ts            register/unregister/broadcast pro Desk
    ├── app.ts                  buildApp: Routen, Auth-Hook, CORS, Multipart, WS
    ├── backup.ts               rotateBackup (letzte 5 Stände)
    └── testUtils.ts            createTestApp für die Server-Tests
src/lib/                        Client (Wurzel-App)
├── api.ts                      ApiClient (plugin-http fetch)
├── session.ts                  Session {serverUrl, token} in AppData
├── fileCache.ts                ensureCached(fileId) → lokaler Cache-Pfad
├── importV1.ts                 v1-desktop.json → Upload + PUT state
├── store.svelte.ts             KOMPLETT NEU: Server-Zustand, applyLocal, command, WS
├── menus.ts | thumbnails.ts    umgebaut auf fileId/API
└── components/
    ├── LoginScreen.svelte      NEU: Login/Ersteinrichtung
    └── Desktop|DocCard|StackCard|LinkLayer (angepasst)
```

---

### Task 1: Monorepo-Umbau & core-Paket extrahieren

**Files:**
- Modify: `package.json` (Workspaces + Dependency + Script), `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/src/index.ts`
- Move: `src/lib/state/*` → `packages/core/src/` (inkl. Tests)
- Modify: alle Client-Importe von `./state/...` bzw. `../state/...` auf `@digital-desktop/core`

**Interfaces:**
- Produces: Paket `@digital-desktop/core` (Version 0.1.0), importierbar aus Client und späteren Server-Tasks; `npm test` läuft weiterhin alle Tests (Wurzel + packages).

- [ ] **Step 1: Workspaces einrichten**

In der Wurzel-`package.json` ergänzen (oberste Ebene):

```json
"workspaces": ["packages/*"]
```

und unter `"dependencies"`:

```json
"@digital-desktop/core": "0.1.0"
```

- [ ] **Step 2: core-Paket anlegen und Zustandsmodule verschieben**

Create `packages/core/package.json`:

```json
{
  "name": "@digital-desktop/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

```bash
mkdir -p packages/core/src
git mv src/lib/state/model.ts src/lib/state/documents.ts src/lib/state/links.ts \
       src/lib/state/stacks.ts src/lib/state/removal.ts src/lib/state/viewport.ts \
       src/lib/state/geometry.ts packages/core/src/
git mv src/lib/state/documents.test.ts src/lib/state/links.test.ts \
       src/lib/state/stacks.test.ts src/lib/state/removal.test.ts \
       src/lib/state/viewport.test.ts src/lib/state/geometry.test.ts packages/core/src/
rmdir src/lib/state
```

Create `packages/core/src/index.ts`:

```ts
export * from './model';
export * from './documents';
export * from './links';
export * from './stacks';
export * from './removal';
export * from './viewport';
export * from './geometry';
```

- [ ] **Step 3: Client-Importe umstellen**

In allen Dateien unter `src/` jede Import-Zeile aus `…/state/<modul>` durch einen Import aus `@digital-desktop/core` ersetzen. Betroffen (Import-Zeilen zusammenfassen, benannte Importe unverändert):
`src/lib/store.svelte.ts`, `src/lib/persistence.ts`, `src/lib/persistence.test.ts`, `src/lib/menus.ts`, `src/lib/thumbnails.ts`, `src/lib/ui.svelte.ts` (falls state-Import vorhanden), `src/lib/components/Desktop.svelte`, `DocCard.svelte`, `StackCard.svelte`, `LinkLayer.svelte`.
Beispiel: aus `import { CARD_W, CARD_H, type Doc } from '../state/model';` wird `import { CARD_W, CARD_H, type Doc } from '@digital-desktop/core';`.

- [ ] **Step 4: Vitest auf die Pakete ausweiten**

`vitest.config.ts` ersetzen durch:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: Installieren und verifizieren**

```bash
npm install
npm test
```

Expected: alle 42 Tests grün (jetzt teils unter `packages/core/src/`).

Run: `npx svelte-check --tolerate-warnings 2>&1 | tail -5` (falls das Flag fehlt: ohne Flag)
Expected: 0 Errors — die Umstellung ist rein mechanisch, der Client kompiliert noch.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: Monorepo mit Workspaces, Zustandslogik nach @digital-desktop/core extrahiert" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: core-Modell auf Server-Dateien umstellen (fileId statt path)

**Files:**
- Modify: `packages/core/src/model.ts`, `documents.ts`, `links.ts`
- Modify: `packages/core/src/documents.test.ts`, `links.test.ts`, `stacks.test.ts`, `removal.test.ts`, `geometry.test.ts`
- Create: `packages/core/src/model.test.ts`
- Delete: `src/lib/persistence.ts`, `src/lib/persistence.test.ts` (v1-Persistenz stirbt; der v1-Import in Task 13 liest die Datei direkt)

**Interfaces:**
- Produces: `Doc { id, fileId, name, position, rotation, zIndex }` (path/missing entfallen); `addDoc(s, fileId, name, position, id?)` (Dedup per fileId); `setDocPath`/`setMissing` ENTFERNT; `collectLinkedPaths` ersetzt durch `collectLinkedDocs(s, entityId): Doc[]` (Entität selbst + direkte Partner, Stapel expandiert, dedupliziert per Doc-id); NEU `isValidState(v: unknown): v is DesktopState`.
- **Achtung:** Ab hier kompiliert der Client absichtlich nicht mehr (Global Constraints). Gate: nur `npm test`.

- [ ] **Step 1: Tests anpassen (failing)**

`packages/core/src/documents.test.ts` komplett ersetzen durch:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc, moveDoc, bringToFront, rotationFor } from './documents';

const pos = { x: 10, y: 20 };

describe('addDoc', () => {
  it('legt ein Dokument mit fileId, Name, Position, Rotation und zIndex 1 an', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0]).toMatchObject({ id: 'id-a', fileId: 'file-a', name: 'a.pdf', position: pos });
    expect(s.docs[0].zIndex).toBe(1);
  });

  it('vergibt aufsteigende zIndex-Werte', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-b', 'b.pdf', pos, 'id-b');
    expect(s.docs[1].zIndex).toBe(2);
  });

  it('ignoriert eine Server-Datei, die schon auf dem Tisch liegt', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-a', 'nochmal.pdf', { x: 0, y: 0 }, 'id-b');
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
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = moveDoc(s, 'id-a', { x: 99, y: 7 });
    expect(s.docs[0].position).toEqual({ x: 99, y: 7 });
  });

  it('hebt ein Dokument über alle anderen (auch Stapel)', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = addDoc(s, 'file-b', 'b.pdf', pos, 'id-b');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 5 }] };
    s = bringToFront(s, 'id-a');
    expect(s.docs[0].zIndex).toBe(6);
  });

  it('hebt auch einen Stapel nach vorn', () => {
    let s = addDoc(emptyState(), 'file-a', 'a.pdf', pos, 'id-a');
    s = { ...s, stacks: [{ id: 'st-1', name: '', docIds: [], position: pos, zIndex: 0 }] };
    s = bringToFront(s, 'st-1');
    expect(s.stacks[0].zIndex).toBe(2);
  });
});
```

`packages/core/src/links.test.ts` komplett ersetzen durch:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState, type DesktopState } from './model';
import { addDoc } from './documents';
import {
  addLink, setLinkNote, removeLink, removeLinksFor, linkedEntityIds, collectLinkedDocs,
} from './links';

function docs(n: number): DesktopState {
  let s = emptyState();
  for (let i = 0; i < n; i++) s = addDoc(s, `file-${i}`, `${i}.pdf`, { x: 0, y: 0 }, `id-${i}`);
  return s;
}

describe('addLink', () => {
  it('legt eine Verknüpfung mit leerer Notiz an', () => {
    const s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    expect(s.links).toEqual([{ id: 'l-1', fromId: 'id-0', toId: 'id-1', note: '' }]);
  });

  it('lehnt Selbstverknüpfung ab', () => {
    const s = addLink(docs(2), 'id-0', 'id-0', 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('lehnt Duplikate in beiden Richtungen ab', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-0', 'id-1', 'l-2');
    s = addLink(s, 'id-1', 'id-0', 'l-3');
    expect(s.links).toHaveLength(1);
  });
});

describe('Notiz und Entfernen', () => {
  it('setzt eine Notiz', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = setLinkNote(s, 'l-1', 'Rechnung zu Vertrag X');
    expect(s.links[0].note).toBe('Rechnung zu Vertrag X');
  });

  it('entfernt eine Verknüpfung per id', () => {
    let s = addLink(docs(2), 'id-0', 'id-1', 'l-1');
    s = removeLink(s, 'l-1');
    expect(s.links).toHaveLength(0);
  });

  it('entfernt alle Verknüpfungen einer Entität', () => {
    let s = docs(3);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    s = addLink(s, 'id-1', 'id-2', 'l-3');
    s = removeLinksFor(s, 'id-0');
    expect(s.links.map((l) => l.id)).toEqual(['l-3']);
  });
});

describe('linkedEntityIds / collectLinkedDocs', () => {
  it('liefert die Gegenseiten aller Verknüpfungen', () => {
    let s = docs(3);
    s = addLink(s, 'id-0', 'id-1', 'l-1');
    s = addLink(s, 'id-2', 'id-0', 'l-2');
    expect(linkedEntityIds(s, 'id-0').sort()).toEqual(['id-1', 'id-2']);
  });

  it('sammelt das Dokument selbst plus Verknüpfte, Stapel expandiert, dedupliziert', () => {
    let s = docs(4);
    s = {
      ...s,
      stacks: [{ id: 'st-1', name: '', docIds: ['id-2', 'id-3'], position: { x: 0, y: 0 }, zIndex: 0 }],
    };
    s = addLink(s, 'id-0', 'st-1', 'l-1');
    s = addLink(s, 'id-0', 'id-2', 'l-2'); // id-2 steckt im Stapel → darf nicht doppelt erscheinen
    expect(collectLinkedDocs(s, 'id-0').map((d) => d.id).sort()).toEqual(['id-0', 'id-2', 'id-3']);
  });
});
```

Create `packages/core/src/model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState, isValidState } from './model';
import { addDoc } from './documents';

describe('isValidState', () => {
  it('akzeptiert einen gültigen Zustand', () => {
    const s = addDoc(emptyState(), 'file-a', 'a.pdf', { x: 1, y: 2 }, 'id-a');
    expect(isValidState(JSON.parse(JSON.stringify(s)))).toBe(true);
  });

  it('lehnt Nicht-Objekte und falsche Strukturen ab', () => {
    expect(isValidState(null)).toBe(false);
    expect(isValidState({ docs: 5 })).toBe(false);
    expect(isValidState({ docs: [], links: [] })).toBe(false);
    expect(isValidState({ docs: [{ id: 'x' }], links: [], stacks: [] })).toBe(false);
  });
});
```

In `packages/core/src/stacks.test.ts`, `removal.test.ts`, `geometry.test.ts` die Test-Helfer auf die neue `addDoc`-Signatur umstellen — jede Zeile der Form
`addDoc(s, \`/tmp/${i}.pdf\`, …, \`id-${i}\`)` bzw. `addDoc(…, '/tmp/a.pdf', pos, 'id-a')` wird zu
`addDoc(s, \`file-${i}\`, \`${i}.pdf\`, …, \`id-${i}\`)` bzw. `addDoc(…, 'file-a', 'a.pdf', pos, 'id-a')` (drittes Argument = Name, Positionsargument rückt an Stelle 4). Assertions auf `path` gibt es in diesen drei Dateien nicht — nur die Aufrufe ändern sich.

Dann:

```bash
git rm src/lib/persistence.ts src/lib/persistence.test.ts
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `addDoc` hat noch die alte Signatur, `collectLinkedDocs`/`isValidState` existieren nicht.

- [ ] **Step 3: Implementieren**

In `packages/core/src/model.ts` das `Doc`-Interface ersetzen durch:

```ts
export interface Doc {
  id: string;
  fileId: string;      // Server-Datei (files-Tabelle)
  name: string;        // Anzeigename (Original-Dateiname)
  position: Vec2;      // Weltkoordinaten, linke obere Ecke
  rotation: number;    // Grad, feste leichte Zufallsdrehung
  zIndex: number;
}
```

und am Dateiende ergänzen:

```ts
export function isValidState(v: unknown): v is DesktopState {
  if (!v || typeof v !== 'object') return false;
  const s = v as DesktopState;
  return (
    Array.isArray(s.docs) &&
    Array.isArray(s.links) &&
    Array.isArray(s.stacks) &&
    s.docs.every(
      (d) =>
        !!d && typeof d.id === 'string' && typeof d.fileId === 'string' && typeof d.name === 'string',
    )
  );
}
```

In `packages/core/src/documents.ts`: `addDoc` ersetzen durch:

```ts
export function addDoc(
  s: DesktopState,
  fileId: string,
  name: string,
  position: Vec2,
  id: string = crypto.randomUUID(),
): DesktopState {
  if (s.docs.some((d) => d.fileId === fileId)) return s; // liegt schon auf dem Tisch
  const doc = { id, fileId, name, position, rotation: rotationFor(id), zIndex: maxZ(s) + 1 };
  return { ...s, docs: [...s.docs, doc] };
}
```

`setDocPath` und `setMissing` ersatzlos löschen.

In `packages/core/src/links.ts`: `collectLinkedPaths` ersetzen durch:

```ts
/** Dokumente der Entität selbst plus aller direkt verknüpften Entitäten (Stapel → enthaltene Dokumente), dedupliziert. */
export function collectLinkedDocs(s: DesktopState, entityId: string): Doc[] {
  const docs = new Map<string, Doc>();
  const addEntity = (id: string) => {
    const st = findStack(s, id);
    if (st) {
      for (const docId of st.docIds) {
        const d = findDoc(s, docId);
        if (d) docs.set(d.id, d);
      }
      return;
    }
    const d = findDoc(s, id);
    if (d) docs.set(d.id, d);
  };
  addEntity(entityId);
  for (const other of linkedEntityIds(s, entityId)) addEntity(other);
  return [...docs.values()];
}
```

(Import oben ergänzen: `import { findDoc, findStack, type DesktopState, type Doc } from './model';`)

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS — alle core-Tests grün (debounce-Tests der Wurzel ebenfalls). Der Client kompiliert ab jetzt absichtlich nicht (kein Gate bis Task 12).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat!: core-Modell auf Server-Dateien umgestellt (fileId/name statt path/missing)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: core-Kommando-Registry

**Files:**
- Create: `packages/core/src/commands.ts`
- Test: `packages/core/src/commands.test.ts`
- Modify: `packages/core/src/index.ts` (Export ergänzen)

**Interfaces:**
- Produces: `interface Command { type: string; payload?: Record<string, unknown> }`; `applyCommand(state, cmd): DesktopState` (wirft `CommandError` bei unbekanntem Typ oder ungültiger Payload); `class CommandError extends Error`. Payload-Formate:
  addDoc `{fileId, name, position, id?}` · moveDoc `{id, position}` · bringToFront `{id}` · removeDoc `{id}` · addLink `{fromId, toId, id?}` · setLinkNote `{linkId, note}` · removeLink `{linkId}` · stackDocs `{draggedId, targetId, id?}` · removeFromStack `{docId, position}` · dissolveStack `{stackId}` · renameStack `{stackId, name}` · moveStack `{stackId, position}` · removeStack `{stackId}`.

- [ ] **Step 1: Failing Tests schreiben**

Create `packages/core/src/commands.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyState } from './model';
import { addDoc } from './documents';
import { applyCommand, CommandError } from './commands';

const base = () => addDoc(emptyState(), 'file-a', 'a.pdf', { x: 0, y: 0 }, 'id-a');

describe('applyCommand', () => {
  it('führt addDoc mit optionaler id aus', () => {
    const s = applyCommand(emptyState(), {
      type: 'addDoc',
      payload: { fileId: 'file-a', name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' },
    });
    expect(s.docs[0]).toMatchObject({ id: 'id-a', fileId: 'file-a', name: 'a.pdf' });
  });

  it('führt moveDoc aus', () => {
    const s = applyCommand(base(), { type: 'moveDoc', payload: { id: 'id-a', position: { x: 9, y: 9 } } });
    expect(s.docs[0].position).toEqual({ x: 9, y: 9 });
  });

  it('führt die Verknüpfungs- und Stapel-Kommandos aus', () => {
    let s = addDoc(base(), 'file-b', 'b.pdf', { x: 0, y: 0 }, 'id-b');
    s = applyCommand(s, { type: 'addLink', payload: { fromId: 'id-a', toId: 'id-b', id: 'l-1' } });
    s = applyCommand(s, { type: 'setLinkNote', payload: { linkId: 'l-1', note: 'gehört zusammen' } });
    expect(s.links[0].note).toBe('gehört zusammen');
    s = applyCommand(s, { type: 'stackDocs', payload: { draggedId: 'id-b', targetId: 'id-a', id: 'st-1' } });
    expect(s.stacks[0].docIds).toEqual(['id-a', 'id-b']);
    s = applyCommand(s, { type: 'renameStack', payload: { stackId: 'st-1', name: 'Projekt' } });
    expect(s.stacks[0].name).toBe('Projekt');
    s = applyCommand(s, { type: 'removeStack', payload: { stackId: 'st-1' } });
    expect(s.stacks).toHaveLength(0);
    expect(s.docs).toHaveLength(0);
  });

  it('wirft CommandError bei unbekanntem Typ', () => {
    expect(() => applyCommand(base(), { type: 'kaputt', payload: {} })).toThrow(CommandError);
  });

  it('wirft CommandError bei fehlenden oder falschen Feldern', () => {
    expect(() => applyCommand(base(), { type: 'moveDoc', payload: { id: 'id-a' } })).toThrow(CommandError);
    expect(() =>
      applyCommand(base(), { type: 'moveDoc', payload: { id: 'id-a', position: { x: 'nein', y: 0 } } }),
    ).toThrow(CommandError);
    expect(() => applyCommand(base(), { type: 'addLink', payload: { fromId: 'id-a' } })).toThrow(CommandError);
  });

  it('leere Strings sind für Notiz und Stapelname erlaubt, nicht aber für ids', () => {
    let s = addDoc(base(), 'file-b', 'b.pdf', { x: 0, y: 0 }, 'id-b');
    s = applyCommand(s, { type: 'addLink', payload: { fromId: 'id-a', toId: 'id-b', id: 'l-1' } });
    s = applyCommand(s, { type: 'setLinkNote', payload: { linkId: 'l-1', note: '' } });
    expect(s.links[0].note).toBe('');
    expect(() => applyCommand(s, { type: 'removeLink', payload: { linkId: '' } })).toThrow(CommandError);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './commands'`.

- [ ] **Step 3: Implementieren**

Create `packages/core/src/commands.ts`:

```ts
import type { DesktopState, Vec2 } from './model';
import { addDoc, moveDoc, bringToFront } from './documents';
import { addLink, setLinkNote, removeLink } from './links';
import { stackDocs, removeFromStack, dissolveStack, renameStack, moveStack } from './stacks';
import { removeDoc, removeStack } from './removal';

export class CommandError extends Error {}

export interface Command {
  type: string;
  payload?: Record<string, unknown>;
}

function id(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') throw new CommandError(`Feld "${field}" fehlt oder ist leer`);
  return v;
}

function optId(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function text(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new CommandError(`Feld "${field}" fehlt oder ist kein Text`);
  return v;
}

function vec(v: unknown, field: string): Vec2 {
  const p = v as Vec2 | undefined;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new CommandError(`Feld "${field}" fehlt oder ist keine Position {x, y}`);
  }
  return { x: p.x, y: p.y };
}

const handlers: Record<string, (s: DesktopState, p: Record<string, unknown>) => DesktopState> = {
  addDoc: (s, p) => addDoc(s, id(p.fileId, 'fileId'), text(p.name, 'name'), vec(p.position, 'position'), optId(p.id)),
  moveDoc: (s, p) => moveDoc(s, id(p.id, 'id'), vec(p.position, 'position')),
  bringToFront: (s, p) => bringToFront(s, id(p.id, 'id')),
  removeDoc: (s, p) => removeDoc(s, id(p.id, 'id')),
  addLink: (s, p) => addLink(s, id(p.fromId, 'fromId'), id(p.toId, 'toId'), optId(p.id)),
  setLinkNote: (s, p) => setLinkNote(s, id(p.linkId, 'linkId'), text(p.note, 'note')),
  removeLink: (s, p) => removeLink(s, id(p.linkId, 'linkId')),
  stackDocs: (s, p) => stackDocs(s, id(p.draggedId, 'draggedId'), id(p.targetId, 'targetId'), optId(p.id)),
  removeFromStack: (s, p) => removeFromStack(s, id(p.docId, 'docId'), vec(p.position, 'position')),
  dissolveStack: (s, p) => dissolveStack(s, id(p.stackId, 'stackId')),
  renameStack: (s, p) => renameStack(s, id(p.stackId, 'stackId'), text(p.name, 'name')),
  moveStack: (s, p) => moveStack(s, id(p.stackId, 'stackId'), vec(p.position, 'position')),
  removeStack: (s, p) => removeStack(s, id(p.stackId, 'stackId')),
};

export function applyCommand(state: DesktopState, cmd: Command): DesktopState {
  const handler = handlers[cmd.type];
  if (!handler) throw new CommandError(`Unbekanntes Kommando: ${String(cmd.type)}`);
  return handler(state, cmd.payload ?? {});
}
```

In `packages/core/src/index.ts` ergänzen:

```ts
export * from './commands';
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat: Kommando-Registry mit Payload-Validierung im core-Paket" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: server-Paket & Datenbank-Schema

**Files:**
- Create: `packages/server/package.json`, `packages/server/src/db.ts`
- Test: `packages/server/src/db.test.ts`
- Modify: Wurzel-`package.json` (Script `server`)

**Interfaces:**
- Produces: `openDb(path: string): Db` (better-sqlite3-Datenbank mit WAL, foreign_keys und den Tabellen users, sessions, desks, desk_members, files); Typ-Alias `Db`.

- [ ] **Step 1: Paket anlegen und Abhängigkeiten installieren**

Create `packages/server/package.json`:

```json
{
  "name": "@digital-desktop/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@digital-desktop/core": "0.1.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/multipart": "^9.0.0",
    "@fastify/websocket": "^11.0.0",
    "argon2": "^0.41.0",
    "better-sqlite3": "^11.0.0",
    "fastify": "^5.0.0",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "ws": "^8.18.0",
    "@types/ws": "^8.5.0"
  }
}
```

In der Wurzel-`package.json` unter `"scripts"` ergänzen:

```json
"server": "npm run dev -w @digital-desktop/server"
```

```bash
mkdir -p packages/server/src
npm install
```

Hinweis: better-sqlite3 und argon2 bringen Prebuilds mit; falls `npm install` nativ kompilieren will und scheitert, Xcode-CLT prüfen (`xcode-select --install`) und im Report dokumentieren.

- [ ] **Step 2: Failing Test schreiben**

Create `packages/server/src/db.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from './db';

describe('openDb', () => {
  it('legt alle Tabellen an', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['users', 'sessions', 'desks', 'desk_members', 'files']) {
      expect(names).toContain(t);
    }
  });

  it('erzwingt eindeutige Benutzernamen', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
    ins.run('u1', 'patrick', 'h', 0);
    expect(() => ins.run('u2', 'patrick', 'h', 0)).toThrow();
  });
});
```

- [ ] **Step 3: Test laufen lassen — er muss fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 4: Implementieren**

Create `packages/server/src/db.ts`:

```ts
import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      state TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS desk_members (
      desk_id TEXT NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (desk_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}
```

- [ ] **Step 5: Test laufen lassen — er muss bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Server-Paket mit SQLite-Schema" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Auth-Modul

**Files:**
- Create: `packages/server/src/auth.ts`
- Test: `packages/server/src/auth.test.ts`

**Interfaces:**
- Consumes: `openDb`/`Db` (Task 4).
- Produces: `needsSetup(db): boolean`; `createUser(db, username, password): Promise<string>` (wirft `AuthError` bei leerem Namen oder Passwort < 8 Zeichen); `login(db, username, password): Promise<string | null>` (Token oder null); `validateToken(db, token): { userId: string } | null` (aktualisiert last_used_at; löscht Sitzungen > 30 Tage inaktiv); `logout(db, token): void`; `class AuthError extends Error`.

- [ ] **Step 1: Failing Tests schreiben**

Create `packages/server/src/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from './db';
import { needsSetup, createUser, login, validateToken, logout, AuthError } from './auth';

describe('Auth', () => {
  it('needsSetup ist true ohne Benutzer und false danach', async () => {
    const db = openDb(':memory:');
    expect(needsSetup(db)).toBe(true);
    await createUser(db, 'patrick', 'geheim-genug');
    expect(needsSetup(db)).toBe(false);
  });

  it('lehnt leeren Namen und kurze Passwörter ab', async () => {
    const db = openDb(':memory:');
    await expect(createUser(db, '  ', 'geheim-genug')).rejects.toThrow(AuthError);
    await expect(createUser(db, 'patrick', 'kurz')).rejects.toThrow(AuthError);
  });

  it('Login liefert Token bei richtigem, null bei falschem Passwort', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    expect(await login(db, 'patrick', 'falsch-falsch')).toBeNull();
    expect(await login(db, 'unbekannt', 'geheim-genug')).toBeNull();
    const token = await login(db, 'patrick', 'geheim-genug');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validateToken erkennt gültige Tokens und aktualisiert last_used_at', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    const token = (await login(db, 'patrick', 'geheim-genug'))!;
    const before = db.prepare('SELECT last_used_at FROM sessions WHERE token = ?').get(token) as { last_used_at: number };
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(before.last_used_at - 1000, token);
    expect(validateToken(db, token)).toEqual({ userId: expect.any(String) });
    const after = db.prepare('SELECT last_used_at FROM sessions WHERE token = ?').get(token) as { last_used_at: number };
    expect(after.last_used_at).toBeGreaterThan(before.last_used_at - 1000);
    expect(validateToken(db, 'gibtsnicht')).toBeNull();
  });

  it('Sitzungen älter als 30 Tage Inaktivität verfallen', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    const token = (await login(db, 'patrick', 'geheim-genug'))!;
    const staleAge = 31 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(Date.now() - staleAge, token);
    expect(validateToken(db, token)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('logout löscht die Sitzung', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    const token = (await login(db, 'patrick', 'geheim-genug'))!;
    logout(db, token);
    expect(validateToken(db, token)).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Implementieren**

Create `packages/server/src/auth.ts`:

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Db } from './db';

export class AuthError extends Error {}

const SESSION_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export function needsSetup(db: Db): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n === 0;
}

export async function createUser(db: Db, username: string, password: string): Promise<string> {
  if (username.trim() === '') throw new AuthError('Benutzername darf nicht leer sein');
  if (password.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const userId = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    userId, username.trim(), hash, Date.now(),
  );
  return userId;
}

export async function login(db: Db, username: string, password: string): Promise<string | null> {
  const user = db
    .prepare('SELECT id, password_hash FROM users WHERE username = ?')
    .get(username.trim()) as { id: string; password_hash: string } | undefined;
  if (!user) return null;
  if (!(await argon2.verify(user.password_hash, password))) return null;
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)').run(
    token, user.id, Date.now(), Date.now(),
  );
  return token;
}

export function validateToken(db: Db, token: string): { userId: string } | null {
  const row = db
    .prepare('SELECT user_id, last_used_at FROM sessions WHERE token = ?')
    .get(token) as { user_id: string; last_used_at: number } | undefined;
  if (!row) return null;
  if (Date.now() - row.last_used_at > SESSION_MAX_IDLE_MS) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(Date.now(), token);
  return { userId: row.user_id };
}

export function logout(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS (argon2-Hashing macht diese Tests etwas langsamer — normal).

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat: Auth mit argon2id, Sitzungs-Tokens und 30-Tage-Verfall" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Datei-Ablage

**Files:**
- Create: `packages/server/src/files.ts`
- Test: `packages/server/src/files.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 4).
- Produces: `interface FileMeta { id, sha256, originalName, size }`; `storeFile(db, dataDir, bytes: Buffer, originalName): FileMeta` (wirft `FileError` bei falscher Endung/Signatur/Größe; sha256-Dedup: gleiche Bytes → gleiche FileMeta; Schreiben via tmp+rename nach `<dataDir>/files/<sha256>.pdf`); `getFilePath(db, dataDir, fileId): string | null`; `fileExists(db, fileId): boolean`; `class FileError extends Error`.

- [ ] **Step 1: Failing Tests schreiben**

Create `packages/server/src/files.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './db';
import { storeFile, getFilePath, fileExists, FileError } from './files';

const pdfBytes = (inhalt: string) => Buffer.from(`%PDF-1.4\n${inhalt}`);

let db: Db;
let dataDir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dataDir = mkdtempSync(join(tmpdir(), 'dd-files-'));
});

describe('storeFile', () => {
  it('speichert eine PDF unter files/<sha256>.pdf und registriert sie', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'Rechnung.pdf');
    expect(meta.originalName).toBe('Rechnung.pdf');
    const stored = join(dataDir, 'files', `${meta.sha256}.pdf`);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).equals(pdfBytes('eins'))).toBe(true);
    expect(readdirSync(join(dataDir, 'files')).some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  it('dedupliziert inhaltsgleiche Uploads', () => {
    const a = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    const b = storeFile(db, dataDir, pdfBytes('eins'), 'kopie.pdf');
    expect(b.id).toBe(a.id);
    expect(readdirSync(join(dataDir, 'files'))).toHaveLength(1);
  });

  it('lehnt falsche Endung, fehlende PDF-Signatur und leere Dateien ab', () => {
    expect(() => storeFile(db, dataDir, pdfBytes('x'), 'notiz.txt')).toThrow(FileError);
    expect(() => storeFile(db, dataDir, Buffer.from('kein pdf'), 'a.pdf')).toThrow(FileError);
    expect(() => storeFile(db, dataDir, Buffer.alloc(0), 'a.pdf')).toThrow(FileError);
  });
});

describe('getFilePath / fileExists', () => {
  it('liefert den Pfad einer gespeicherten Datei und null für Unbekanntes', () => {
    const meta = storeFile(db, dataDir, pdfBytes('eins'), 'a.pdf');
    expect(getFilePath(db, dataDir, meta.id)).toBe(join(dataDir, 'files', `${meta.sha256}.pdf`));
    expect(getFilePath(db, dataDir, 'gibtsnicht')).toBeNull();
    expect(fileExists(db, meta.id)).toBe(true);
    expect(fileExists(db, 'gibtsnicht')).toBe(false);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './files'`.

- [ ] **Step 3: Implementieren**

Create `packages/server/src/files.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

export class FileError extends Error {}

export interface FileMeta {
  id: string;
  sha256: string;
  originalName: string;
  size: number;
}

const MAX_SIZE = 100 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-');

export function storeFile(db: Db, dataDir: string, bytes: Buffer, originalName: string): FileMeta {
  if (!originalName.toLowerCase().endsWith('.pdf')) throw new FileError('Nur PDF-Dateien (.pdf) werden akzeptiert');
  if (bytes.length === 0) throw new FileError('Datei ist leer');
  if (bytes.length > MAX_SIZE) throw new FileError('Datei ist größer als 100 MB');
  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) throw new FileError('Datei ist keine gültige PDF');

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = db
    .prepare('SELECT id, sha256, original_name AS originalName, size FROM files WHERE sha256 = ?')
    .get(sha256) as FileMeta | undefined;
  if (existing) return existing;

  const filesDir = join(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const tmp = join(filesDir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(filesDir, `${sha256}.pdf`));

  const id = randomUUID();
  db.prepare('INSERT INTO files (id, sha256, original_name, size, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, sha256, originalName, bytes.length, Date.now(),
  );
  return { id, sha256, originalName, size: bytes.length };
}

export function getFilePath(db: Db, dataDir: string, fileId: string): string | null {
  const row = db.prepare('SELECT sha256 FROM files WHERE id = ?').get(fileId) as { sha256: string } | undefined;
  if (!row) return null;
  const path = join(dataDir, 'files', `${row.sha256}.pdf`);
  return existsSync(path) ? path : null;
}

export function fileExists(db: Db, fileId: string): boolean {
  return db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId) !== undefined;
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat: PDF-Ablage mit sha256-Dedup und atomarem Schreiben" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Desk-Store mit Kommandoausführung

**Files:**
- Create: `packages/server/src/deskStore.ts`
- Test: `packages/server/src/deskStore.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 4); `applyCommand`, `CommandError`, `isValidState`, `emptyState`, Typen aus `@digital-desktop/core` (Tasks 2–3).
- Produces: `interface DeskInfo { id, name, ownerId }`; `interface DeskState { rev: number; state: DesktopState }`; `createDesk(db, ownerId, name): DeskInfo`; `listDesks(db): DeskInfo[]`; `renameDesk(db, deskId, name): void`; `deleteDesk(db, deskId): void` (beide werfen `DeskNotFoundError` bei unbekannter id); `getDeskState(db, deskId): DeskState | null`; `applyDeskCommand(db, deskId, cmd): DeskState` (Transaktion: Kommando anwenden, rev+1, speichern; `CommandError` propagiert, rev bleibt unverändert); `putDeskState(db, deskId, state: unknown): DeskState` (wirft `InvalidStateError` bei ungültiger Struktur); Fehlerklassen `DeskNotFoundError`, `InvalidStateError`.

- [ ] **Step 1: Failing Tests schreiben**

Create `packages/server/src/deskStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CommandError } from '@digital-desktop/core';
import { openDb, type Db } from './db';
import {
  createDesk, listDesks, renameDesk, deleteDesk, getDeskState,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError,
} from './deskStore';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
});

describe('Desk-CRUD', () => {
  it('legt an, listet, benennt um und löscht', () => {
    const desk = createDesk(db, 'u1', 'Schreibtisch 1');
    expect(listDesks(db)).toEqual([{ id: desk.id, name: 'Schreibtisch 1', ownerId: 'u1' }]);
    renameDesk(db, desk.id, 'Projekte');
    expect(listDesks(db)[0].name).toBe('Projekte');
    deleteDesk(db, desk.id);
    expect(listDesks(db)).toHaveLength(0);
    expect(() => renameDesk(db, desk.id, 'x')).toThrow(DeskNotFoundError);
    expect(() => deleteDesk(db, desk.id)).toThrow(DeskNotFoundError);
  });

  it('neuer Schreibtisch startet leer mit rev 0', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(getDeskState(db, desk.id)).toEqual({ rev: 0, state: { docs: [], links: [], stacks: [] } });
    expect(getDeskState(db, 'gibtsnicht')).toBeNull();
  });
});

describe('applyDeskCommand', () => {
  it('wendet Kommandos an und zählt rev hoch', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const r1 = applyDeskCommand(db, desk.id, {
      type: 'addDoc',
      payload: { fileId: 'file-a', name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' },
    });
    expect(r1.rev).toBe(1);
    expect(r1.state.docs).toHaveLength(1);
    const r2 = applyDeskCommand(db, desk.id, { type: 'moveDoc', payload: { id: 'id-a', position: { x: 9, y: 9 } } });
    expect(r2.rev).toBe(2);
    expect(getDeskState(db, desk.id)!.state.docs[0].position).toEqual({ x: 9, y: 9 });
  });

  it('ungültiges Kommando: CommandError, rev unverändert', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    expect(() => applyDeskCommand(db, desk.id, { type: 'kaputt', payload: {} })).toThrow(CommandError);
    expect(getDeskState(db, desk.id)!.rev).toBe(0);
    expect(() => applyDeskCommand(db, 'gibtsnicht', { type: 'moveDoc', payload: {} })).toThrow(DeskNotFoundError);
  });
});

describe('putDeskState', () => {
  it('ersetzt den Zustand komplett und validiert die Struktur', () => {
    const desk = createDesk(db, 'u1', 'Neu');
    const state = {
      docs: [{ id: 'id-a', fileId: 'file-a', name: 'a.pdf', position: { x: 0, y: 0 }, rotation: 1, zIndex: 1 }],
      links: [],
      stacks: [],
    };
    const r = putDeskState(db, desk.id, state);
    expect(r.rev).toBe(1);
    expect(getDeskState(db, desk.id)!.state.docs).toHaveLength(1);
    expect(() => putDeskState(db, desk.id, { docs: 5 })).toThrow(InvalidStateError);
    expect(() => putDeskState(db, 'gibtsnicht', state)).toThrow(DeskNotFoundError);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './deskStore'`.

- [ ] **Step 3: Implementieren**

Create `packages/server/src/deskStore.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  applyCommand, emptyState, isValidState, type Command, type DesktopState,
} from '@digital-desktop/core';
import type { Db } from './db';

export class DeskNotFoundError extends Error {}
export class InvalidStateError extends Error {}

export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
}

export interface DeskState {
  rev: number;
  state: DesktopState;
}

export function createDesk(db: Db, ownerId: string, name: string): DeskInfo {
  const id = randomUUID();
  db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(
    id, name, ownerId, JSON.stringify(emptyState()), Date.now(),
  );
  return { id, name, ownerId };
}

export function listDesks(db: Db): DeskInfo[] {
  return db
    .prepare('SELECT id, name, owner_id AS ownerId FROM desks ORDER BY created_at')
    .all() as DeskInfo[];
}

export function renameDesk(db: Db, deskId: string, name: string): void {
  const result = db.prepare('UPDATE desks SET name = ? WHERE id = ?').run(name, deskId);
  if (result.changes === 0) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
}

export function deleteDesk(db: Db, deskId: string): void {
  const result = db.prepare('DELETE FROM desks WHERE id = ?').run(deskId);
  if (result.changes === 0) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
}

export function getDeskState(db: Db, deskId: string): DeskState | null {
  const row = db.prepare('SELECT state, rev FROM desks WHERE id = ?').get(deskId) as
    | { state: string; rev: number }
    | undefined;
  return row ? { rev: row.rev, state: JSON.parse(row.state) as DesktopState } : null;
}

export function applyDeskCommand(db: Db, deskId: string, cmd: Command): DeskState {
  const txn = db.transaction((): DeskState => {
    const row = db.prepare('SELECT state, rev FROM desks WHERE id = ?').get(deskId) as
      | { state: string; rev: number }
      | undefined;
    if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    const next = applyCommand(JSON.parse(row.state) as DesktopState, cmd);
    const rev = row.rev + 1;
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(next), rev, deskId);
    return { rev, state: next };
  });
  return txn();
}

export function putDeskState(db: Db, deskId: string, state: unknown): DeskState {
  if (!isValidState(state)) throw new InvalidStateError('Ungültiger Schreibtisch-Zustand');
  const txn = db.transaction((): DeskState => {
    const row = db.prepare('SELECT rev FROM desks WHERE id = ?').get(deskId) as { rev: number } | undefined;
    if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
    const rev = row.rev + 1;
    db.prepare('UPDATE desks SET state = ?, rev = ? WHERE id = ?').run(JSON.stringify(state), rev, deskId);
    return { rev, state };
  });
  return txn();
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat: Desk-Store mit transaktionaler Kommandoausführung und rev-Zähler" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: HTTP-API mit Auth-Hook, Upload und WebSocket-Route

**Files:**
- Create: `packages/server/src/broadcast.ts`, `packages/server/src/app.ts`, `packages/server/src/testUtils.ts`
- Test: `packages/server/src/app.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7 komplett.
- Produces: `buildApp({ db, dataDir }): Promise<FastifyInstance>` mit allen Routen aus der Spec (inkl. `PUT /desks/:id/state`); `broadcast.ts` mit `register(deskId, socket)`, `unregister(deskId, socket)`, `broadcast(deskId, msg)`; `createTestApp()` (testUtils): legt In-Memory-DB + Temp-Datenordner + Benutzer `test`/`test-passwort` an und liefert `{ app, db, dataDir, token, authHeaders }`.

- [ ] **Step 1: Failing Tests schreiben**

Create `packages/server/src/testUtils.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from './db';
import { createUser, login } from './auth';
import { buildApp } from './app';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  dataDir: string;
  token: string;
  authHeaders: { authorization: string };
}

export async function createTestApp(): Promise<TestContext> {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'dd-server-'));
  await createUser(db, 'test', 'test-passwort');
  const token = (await login(db, 'test', 'test-passwort'))!;
  const app = await buildApp({ db, dataDir });
  return { app, db, dataDir, token, authHeaders: { authorization: `Bearer ${token}` } };
}
```

Create `packages/server/src/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestApp } from './testUtils';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

describe('Auth-Routen', () => {
  it('status/setup/login-Ablauf', async () => {
    const { app: freshApp } = await (async () => {
      const { openDb } = await import('./db');
      const { buildApp } = await import('./app');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      return { app: await buildApp({ db: openDb(':memory:'), dataDir: mkdtempSync(join(tmpdir(), 'dd-')) }) };
    })();

    let res = await freshApp.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(res.json()).toEqual({ needsSetup: true });

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { username: 'patrick', password: 'geheim-genug' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^[0-9a-f]{64}$/);

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { username: 'zweiter', password: 'geheim-genug' },
    });
    expect(res.statusCode).toBe(403);

    res = await freshApp.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { username: 'patrick', password: 'falsch-falsch' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ohne Token: 401 auf geschützten Routen', async () => {
    const { app } = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks' });
    expect(res.statusCode).toBe(401);
  });

  it('logout macht das Token ungültig', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authHeaders });
    const res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders });
    expect(res.statusCode).toBe(401);
  });
});

describe('Desk-Routen', () => {
  it('CRUD und Zustand', async () => {
    const { app, authHeaders } = await createTestApp();
    let res = await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Projekte' } });
    expect(res.statusCode).toBe(201);
    const desk = res.json();

    res = await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders });
    expect(res.json()).toHaveLength(1);

    res = await app.inject({ method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: authHeaders, payload: { name: 'Neu' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect(res.json()).toEqual({ rev: 0, state: { docs: [], links: [], stacks: [] } });

    res = await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: authHeaders });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });
});

describe('Kommandos', () => {
  it('führt gültige Kommandos aus, weist ungültige mit 400 ab', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const { storeFile } = await import('./files');
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();

    let res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rev).toBe(1);

    res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: 'gibtsnicht', name: 'x.pdf', position: { x: 0, y: 0 } } },
    });
    expect(res.statusCode).toBe(400); // unbekannte fileId

    res = await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'kaputt', payload: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unbekanntes Kommando');

    res = await app.inject({
      method: 'POST', url: '/api/v1/desks/gibtsnicht/commands', headers: authHeaders,
      payload: { type: 'moveDoc', payload: { id: 'id-a', position: { x: 0, y: 0 } } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /state ersetzt den Zustand, validiert die Struktur', async () => {
    const { app, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    let res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: { docs: [], links: [], stacks: [] },
    });
    expect(res.json().rev).toBe(1);
    res = await app.inject({
      method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: authHeaders,
      payload: { docs: 5 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Dateien (echter HTTP-Server für multipart)', () => {
  it('Upload, Dedup, Ablehnung und Download', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/api/v1`;

    const upload = async (bytes: Buffer, name: string) => {
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
      return fetch(`${base}/files`, { method: 'POST', headers: authHeaders, body: fd });
    };

    let res = await upload(pdf, 'a.pdf');
    expect(res.status).toBe(201);
    const { fileId } = (await res.json()) as { fileId: string };

    res = await upload(pdf, 'kopie.pdf');
    expect(((await res.json()) as { fileId: string }).fileId).toBe(fileId); // Dedup

    res = await upload(Buffer.from('kein pdf'), 'a.pdf');
    expect(res.status).toBe(400);

    res = await fetch(`${base}/files/${fileId}`, { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);

    res = await fetch(`${base}/files/gibtsnicht`, { headers: authHeaders });
    expect(res.status).toBe(404);

    await app.close();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './app'`.

- [ ] **Step 3: Implementieren**

Create `packages/server/src/broadcast.ts`:

```ts
interface Sendable {
  send(data: string): void;
}

const rooms = new Map<string, Set<Sendable>>();

export function register(deskId: string, socket: Sendable): void {
  let room = rooms.get(deskId);
  if (!room) rooms.set(deskId, (room = new Set()));
  room.add(socket);
}

export function unregister(deskId: string, socket: Sendable): void {
  const room = rooms.get(deskId);
  room?.delete(socket);
  if (room && room.size === 0) rooms.delete(deskId);
}

export function broadcast(deskId: string, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const socket of rooms.get(deskId) ?? []) {
    try {
      socket.send(data);
    } catch {
      // toter Socket — wird über sein close-Event ausgetragen
    }
  }
}
```

Create `packages/server/src/app.ts`:

```ts
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { CommandError, type Command } from '@digital-desktop/core';
import type { Db } from './db';
import { needsSetup, createUser, login, logout, validateToken, AuthError } from './auth';
import {
  createDesk, listDesks, renameDesk, deleteDesk, getDeskState,
  applyDeskCommand, putDeskState, DeskNotFoundError, InvalidStateError,
} from './deskStore';
import { storeFile, getFilePath, fileExists, FileError } from './files';
import { register, unregister, broadcast } from './broadcast';

export interface AppOptions {
  db: Db;
  dataDir: string;
}

const PUBLIC_PATHS = new Set(['/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup']);

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const query = req.query as { token?: string };
  return query?.token ?? null;
}

export async function buildApp({ db, dataDir }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(path)) return;
    const token = bearerToken(req);
    const session = token ? validateToken(db, token) : null;
    if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
    (req as FastifyRequest & { userId: string }).userId = session.userId;
  });

  // ---- Auth ----
  app.get('/api/v1/auth/status', async () => ({ needsSetup: needsSetup(db) }));

  app.post('/api/v1/auth/setup', async (req, reply) => {
    if (!needsSetup(db)) return reply.code(403).send({ error: 'Es existiert bereits ein Konto' });
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    try {
      await createUser(db, String(username ?? ''), String(password ?? ''));
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    return { token: await login(db, String(username), String(password)) };
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const token = await login(db, String(username ?? ''), String(password ?? ''));
    if (!token) return reply.code(401).send({ error: 'Benutzername oder Passwort falsch' });
    return { token };
  });

  app.post('/api/v1/auth/logout', async (req) => {
    const token = bearerToken(req);
    if (token) logout(db, token);
    return { ok: true };
  });

  // ---- Schreibtische ----
  app.get('/api/v1/desks', async () => listDesks(db));

  app.post('/api/v1/desks', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    const userId = (req as FastifyRequest & { userId: string }).userId;
    reply.code(201);
    return createDesk(db, userId, name.trim());
  });

  app.patch('/api/v1/desks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    try {
      renameDesk(db, id, name.trim());
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.delete('/api/v1/desks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      deleteDesk(db, id);
    } catch (e) {
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    return { ok: true };
  });

  app.get('/api/v1/desks/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    return result;
  });

  app.post('/api/v1/desks/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cmd = (req.body ?? {}) as Command;
    if (cmd.type === 'addDoc' && !fileExists(db, String((cmd.payload as { fileId?: unknown })?.fileId ?? ''))) {
      return reply.code(400).send({ error: 'Unbekannte fileId' });
    }
    try {
      const result = applyDeskCommand(db, id, cmd);
      broadcast(id, result);
      return result;
    } catch (e) {
      if (e instanceof CommandError) return reply.code(400).send({ error: e.message });
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  app.put('/api/v1/desks/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = putDeskState(db, id, req.body);
      broadcast(id, result);
      return result;
    } catch (e) {
      if (e instanceof InvalidStateError) return reply.code(400).send({ error: e.message });
      if (e instanceof DeskNotFoundError) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  // ---- Dateien ----
  app.post('/api/v1/files', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Keine Datei im Request' });
    const bytes = await part.toBuffer();
    try {
      const meta = storeFile(db, dataDir, bytes, part.filename);
      reply.code(201);
      return { fileId: meta.id, name: meta.originalName };
    } catch (e) {
      if (e instanceof FileError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get('/api/v1/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = getFilePath(db, dataDir, id);
    if (!path) return reply.code(404).send({ error: 'Datei nicht gefunden' });
    reply.header('content-type', 'application/pdf');
    return readFileSync(path);
  });

  // ---- WebSocket ----
  app.get('/api/v1/desks/:id/ws', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    register(id, socket);
    socket.on('close', () => unregister(id, socket));
  });

  return app;
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS. Falls der multipart-Upload-Test an `FormData` im `fetch` scheitert (ältere Node-Version), Node ≥ 20 sicherstellen (`node --version`) und im Report dokumentieren.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat: HTTP-API mit Auth-Hook, Desk-Routen, Upload/Download und WS-Route" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: WebSocket-Broadcast-Test, main.ts, Backup & Dockerfile

**Files:**
- Create: `packages/server/src/backup.ts`, `packages/server/src/main.ts`, `packages/server/Dockerfile`
- Test: `packages/server/src/backup.test.ts`, `packages/server/src/ws.test.ts`

**Interfaces:**
- Consumes: `buildApp` (Task 8), `openDb` (Task 4).
- Produces: `rotateBackup(dataDir, keep = 5): void`; lauffähiger Server via `npm run server` (ENV: `PORT` Default 4810, `DATA_DIR` Default `./data`, DB-Datei `desktop.sqlite`); Dockerfile.

- [ ] **Step 1: Failing Tests schreiben**

Create `packages/server/src/backup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateBackup } from './backup';

describe('rotateBackup', () => {
  it('tut nichts ohne DB-Datei', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    rotateBackup(dir);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('legt Backups an und behält nur die letzten 5', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-bak-'));
    writeFileSync(join(dir, 'desktop.sqlite'), 'daten');
    for (let i = 0; i < 7; i++) {
      rotateBackup(dir);
      await new Promise((r) => setTimeout(r, 5)); // eindeutige Zeitstempel
    }
    const backups = readdirSync(join(dir, 'backup')).filter((f) => f.endsWith('.sqlite'));
    expect(backups).toHaveLength(5);
  });
});
```

Create `packages/server/src/ws.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { createTestApp } from './testUtils';
import { storeFile } from './files';

const pdf = Buffer.from('%PDF-1.4\ninhalt');

describe('WebSocket-Broadcast', () => {
  it('verbundene Clients erhalten {rev, state} nach jedem Kommando', async () => {
    const { app, db, dataDir, token, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };

    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })
    ).json();
    const meta = storeFile(db, dataDir, pdf, 'a.pdf');

    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?token=${token}`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const message = new Promise<{ rev: number; state: { docs: unknown[] } }>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    });

    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 1, y: 2 }, id: 'id-a' } },
    });

    const msg = await message;
    expect(msg.rev).toBe(1);
    expect(msg.state.docs).toHaveLength(1);

    ws.close();
    await app.close();
  });

  it('WS ohne gültiges Token wird abgewiesen', async () => {
    const { app, authHeaders } = await createTestApp();
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (
      await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })
    ).json();

    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?token=falsch`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', () => resolve(true));
    });
    expect(failed).toBe(true);
    await app.close();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module './backup'` (ws.test schlägt beim backup-Import nicht fehl, aber backup.test tut es; ws.test läuft gegen bestehenden Code und sollte direkt grün sein — falls nicht, ist das ein echter Befund für Task 8).

- [ ] **Step 3: Implementieren**

Create `packages/server/src/backup.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Sichert die SQLite-Datei nach backup/ und behält die letzten `keep` Stände. */
export function rotateBackup(dataDir: string, keep = 5): void {
  const dbFile = join(dataDir, 'desktop.sqlite');
  if (!existsSync(dbFile)) return;
  const backupDir = join(dataDir, 'backup');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(dbFile, join(backupDir, `desktop-${stamp}.sqlite`));
  const backups = readdirSync(backupDir).filter((f) => f.endsWith('.sqlite')).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(join(backupDir, old));
  }
}
```

Create `packages/server/src/main.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db';
import { rotateBackup } from './backup';
import { buildApp } from './app';

const port = Number(process.env.PORT ?? 4810);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');

mkdirSync(dataDir, { recursive: true });
rotateBackup(dataDir); // vor dem Öffnen der DB — kein WAL-Zwischenstand im Backup
const db = openDb(join(dataDir, 'desktop.sqlite'));

const app = await buildApp({ db, dataDir });
await app.listen({ port, host: '0.0.0.0' });
console.log(`Digital-Desktop-Server läuft auf Port ${port} (Daten: ${dataDir})`);
```

Create `packages/server/Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --workspace @digital-desktop/server --include-workspace-root=false
ENV PORT=4810 DATA_DIR=/data
VOLUME /data
EXPOSE 4810
CMD ["npx", "tsx", "packages/server/src/main.ts"]
```

- [ ] **Step 4: Tests laufen lassen und Server manuell starten**

Run: `npm test`
Expected: PASS (alle Wurzel-, core- und server-Tests).

Run: `npm run server` (im Hintergrund), dann `curl -s http://localhost:4810/api/v1/auth/status`
Expected: `{"needsSetup":true}` — danach Server beenden. Der `data/`-Ordner entsteht in `packages/server/data/`; `.gitignore` der Wurzel um `packages/server/data/` ergänzen.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Server-Start mit Backup-Rotation, WS-Broadcast-Tests und Dockerfile" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Client — Tauri-Plugins, API-Client & Session

**Files:**
- Modify: `src-tauri/capabilities/default.json` (komplett ersetzen), Tauri-Plugins installieren
- Create: `src/lib/api.ts`, `src/lib/session.ts`
- Test: `src/lib/session.test.ts`

**Interfaces:**
- Produces: `class ApiClient { constructor(baseUrl, token?); token; status(); setup(u,p); login(u,p); logout(); listDesks(); createDesk(name); getState(deskId); sendCommand(deskId, cmd); putState(deskId, state); uploadFile(bytes, name): Promise<string>; fetchFile(fileId): Promise<Uint8Array>; wsUrl(deskId): string }`; `class ApiError extends Error { status: number }`; `interface DeskInfo`, `interface DeskState`; `interface Session { serverUrl, token }`, `parseSession(json): Session | null`, `loadSession()`, `saveSession(s)`, `clearSession()`.
- Hinweis: Client kompiliert weiterhin nicht vollständig (alte Module folgen in Task 11/12) — Gate: `npm test`.

- [ ] **Step 1: Plugins installieren und Capabilities ersetzen**

```bash
npm run tauri add http
npm run tauri add websocket
```

`src-tauri/capabilities/default.json` komplett ersetzen durch:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Digital Desktop: Dateizugriff, Dialoge, Öffnen, Server-API",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-destroy",
    "dialog:default",
    "fs:default",
    "websocket:default",
    { "identifier": "http:default", "allow": [{ "url": "http://**" }, { "url": "https://**" }] },
    { "identifier": "fs:allow-read-file", "allow": [{ "path": "**" }, { "path": "$HOME/**" }] },
    { "identifier": "fs:allow-read-text-file", "allow": [{ "path": "**" }, { "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-write-file", "allow": [{ "path": "$APPDATA/**" }, { "path": "$APPCACHE/**" }, { "path": "$HOME/**" }] },
    { "identifier": "fs:allow-write-text-file", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-copy-file", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-mkdir", "allow": [{ "path": "$APPDATA/**" }, { "path": "$APPCACHE/**" }] },
    { "identifier": "fs:allow-exists", "allow": [{ "path": "**" }, { "path": "$HOME/**" }, { "path": "$APPCACHE/**" }] },
    { "identifier": "fs:allow-remove", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "fs:allow-rename", "allow": [{ "path": "$APPDATA/**" }] },
    { "identifier": "opener:allow-open-path", "allow": [{ "path": "**" }] },
    { "identifier": "opener:allow-reveal-item-in-dir", "allow": [{ "path": "**" }] }
  ]
}
```

- [ ] **Step 2: Failing Test für parseSession schreiben**

Create `src/lib/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSession } from './session';

describe('parseSession', () => {
  it('liest eine gültige Sitzung', () => {
    expect(parseSession('{"serverUrl":"http://x:4810","token":"abc"}')).toEqual({
      serverUrl: 'http://x:4810',
      token: 'abc',
    });
  });

  it('liefert null bei kaputtem JSON oder falscher Struktur', () => {
    expect(parseSession('{ kaputt')).toBeNull();
    expect(parseSession('null')).toBeNull();
    expect(parseSession('{"serverUrl":"http://x"}')).toBeNull();
    expect(parseSession('{"serverUrl":5,"token":"abc"}')).toBeNull();
  });
});
```

Run: `npm test`
Expected: FAIL — `Cannot find module './session'`.

- [ ] **Step 3: session.ts und api.ts implementieren**

Create `src/lib/session.ts`:

```ts
import { BaseDirectory, exists, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';

export interface Session {
  serverUrl: string;
  token: string;
}

const FILE = 'session.json';
const base = { baseDir: BaseDirectory.AppData };

export function parseSession(json: string): Session | null {
  try {
    const v = JSON.parse(json) as Session | null;
    if (!v || typeof v.serverUrl !== 'string' || typeof v.token !== 'string') return null;
    return { serverUrl: v.serverUrl, token: v.token };
  } catch {
    return null;
  }
}

export async function loadSession(): Promise<Session | null> {
  try {
    if (await exists(FILE, base)) return parseSession(await readTextFile(FILE, base));
  } catch {
    // wie nicht vorhanden behandeln
  }
  return null;
}

export async function saveSession(session: Session): Promise<void> {
  await writeTextFile(FILE, JSON.stringify(session), base);
}

export async function clearSession(): Promise<void> {
  await remove(FILE, base).catch(() => {});
}
```

Create `src/lib/api.ts`:

```ts
import { fetch } from '@tauri-apps/plugin-http';
import type { Command, DesktopState } from '@digital-desktop/core';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
}

export interface DeskState {
  rev: number;
  state: DesktopState;
}

export class ApiClient {
  constructor(
    public baseUrl: string,
    public token: string | null = null,
  ) {}

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private async parseError(res: Response): Promise<ApiError> {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // kein JSON-Body — Statuscode reicht
    }
    return new ApiError(message, res.status);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...this.authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await this.parseError(res);
    return (await res.json()) as T;
  }

  status(): Promise<{ needsSetup: boolean }> {
    return this.request('GET', '/auth/status');
  }

  async setup(username: string, password: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/auth/setup', { username, password });
    this.token = r.token;
  }

  async login(username: string, password: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/auth/login', { username, password });
    this.token = r.token;
  }

  async logout(): Promise<void> {
    await this.request('POST', '/auth/logout').finally(() => (this.token = null));
  }

  listDesks(): Promise<DeskInfo[]> {
    return this.request('GET', '/desks');
  }

  createDesk(name: string): Promise<DeskInfo> {
    return this.request('POST', '/desks', { name });
  }

  getState(deskId: string): Promise<DeskState> {
    return this.request('GET', `/desks/${deskId}/state`);
  }

  sendCommand(deskId: string, cmd: Command): Promise<DeskState> {
    return this.request('POST', `/desks/${deskId}/commands`, cmd);
  }

  putState(deskId: string, state: DesktopState): Promise<DeskState> {
    return this.request('PUT', `/desks/${deskId}/state`, state);
  }

  async uploadFile(bytes: Uint8Array, name: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    const res = await fetch(`${this.baseUrl}/api/v1/files`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) throw await this.parseError(res);
    return ((await res.json()) as { fileId: string }).fileId;
  }

  async fetchFile(fileId: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/api/v1/files/${fileId}`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.parseError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  wsUrl(deskId: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/desks/${deskId}/ws?token=${this.token ?? ''}`;
  }
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: API-Client, Session-Ablage und Tauri-Plugins http/websocket" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Client — Store, UI-Zustand, Datei-Cache, Miniaturen, Menüs

**Files:**
- Modify (komplett ersetzen): `src/lib/store.svelte.ts`, `src/lib/ui.svelte.ts`, `src/lib/thumbnails.ts`, `src/lib/menus.ts`
- Create: `src/lib/fileCache.ts`

**Interfaces:**
- Consumes: `ApiClient` (Task 10), core-Funktionen (Tasks 2–3), Tauri-Plugin websocket.
- Produces:
  - `desktop`: `state`, `status` (`'connecting' | 'online' | 'offline' | 'loggedOut'`), `api: ApiClient | null`, `deskId: string | null`, `start(api)` (lädt/erzeugt „Schreibtisch 1", verbindet WS), `applyLocal(fn)` (nur lokal, für Drags), `command(type, payload)` (optimistisch lokal + Server; bei Fehler refresh + Toast), `refresh()`, `stop()`.
  - `ui` + `showToast(message)`; `ensureCached(api, fileId): Promise<string>` (lokaler Cache-Pfad); `getThumbnail(api, doc)`; `openDoc(doc)`, `openWithLinked(entityId)`, `downloadDoc(doc)`, `showDocMenu(e, doc)`, `showStackMenu(e, stack)`.
- Hinweis: Komponenten folgen in Task 12 — Gate weiterhin nur `npm test`.

- [ ] **Step 1: ui.svelte.ts ersetzen**

`src/lib/ui.svelte.ts` komplett ersetzen durch:

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
  toast: null as string | null,
});

export function showToast(message: string): void {
  ui.toast = message;
  setTimeout(() => {
    if (ui.toast === message) ui.toast = null;
  }, 4000);
}
```

- [ ] **Step 2: store.svelte.ts ersetzen**

`src/lib/store.svelte.ts` komplett ersetzen durch:

```ts
import WebSocket from '@tauri-apps/plugin-websocket';
import { applyCommand, emptyState, type Command, type DesktopState } from '@digital-desktop/core';
import type { ApiClient } from './api';
import { showToast } from './ui.svelte';

let state = $state<DesktopState>(emptyState());
let status = $state<'connecting' | 'online' | 'offline' | 'loggedOut'>('loggedOut');
let rev = 0;
let api: ApiClient | null = null;
let deskId: string | null = null;
let ws: Awaited<ReturnType<typeof WebSocket.connect>> | null = null;
let reconnectDelay = 1000;
let stopped = false;

export const desktop = {
  get state(): DesktopState {
    return state;
  },
  get status() {
    return status;
  },
  get api(): ApiClient | null {
    return api;
  },
  get deskId(): string | null {
    return deskId;
  },

  /** Nach erfolgreichem Login: ersten Schreibtisch laden (oder anlegen) und WS verbinden. */
  async start(client: ApiClient): Promise<void> {
    api = client;
    stopped = false;
    status = 'connecting';
    const desks = await client.listDesks();
    deskId = desks[0]?.id ?? (await client.createDesk('Schreibtisch 1')).id;
    const result = await client.getState(deskId);
    rev = result.rev;
    state = result.state;
    await connectWs();
  },

  /** Nur lokal anwenden (Drag-Zwischenschritte) — der Server erfährt nichts. */
  applyLocal(fn: (s: DesktopState) => DesktopState): void {
    state = fn(state);
  },

  /** Optimistisch lokal anwenden, dann ans Backend; die Server-Antwort ist maßgeblich. */
  async command(type: string, payload: Command['payload']): Promise<void> {
    if (!api || !deskId) return;
    const cmd: Command = { type, payload };
    try {
      state = applyCommand(state, cmd);
    } catch {
      // Server validiert maßgeblich
    }
    try {
      const result = await api.sendCommand(deskId, cmd);
      if (result.rev >= rev) {
        rev = result.rev;
        state = result.state;
      }
    } catch (e) {
      await this.refresh().catch(() => {});
      showToast(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
    }
  },

  /** Kompletten Zustand vom Server holen (nach Reconnect oder Fehler). */
  async refresh(): Promise<void> {
    if (!api || !deskId) return;
    const result = await api.getState(deskId);
    if (result.rev >= rev) {
      rev = result.rev;
      state = result.state;
    }
  },

  async stop(): Promise<void> {
    stopped = true;
    status = 'loggedOut';
    await ws?.disconnect().catch(() => {});
    ws = null;
  },
};

async function connectWs(): Promise<void> {
  if (!api || !deskId || stopped) return;
  try {
    ws = await WebSocket.connect(api.wsUrl(deskId));
    reconnectDelay = 1000;
    status = 'online';
    ws.addListener((msg) => {
      if (msg.type === 'Text') {
        const data = JSON.parse(msg.data as string) as { rev: number; state: DesktopState };
        if (data.rev >= rev) {
          rev = data.rev;
          state = data.state;
        }
      } else if (msg.type === 'Close') {
        onDisconnected();
      }
    });
  } catch {
    onDisconnected();
  }
}

function onDisconnected(): void {
  if (stopped) return;
  status = 'offline';
  ws = null;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  setTimeout(() => {
    void (async () => {
      await desktop.refresh().catch(() => {});
      await connectWs();
    })();
  }, delay);
}
```

- [ ] **Step 3: fileCache.ts anlegen, thumbnails.ts und menus.ts ersetzen**

Create `src/lib/fileCache.ts`:

```ts
import { BaseDirectory, exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { appCacheDir, join } from '@tauri-apps/api/path';
import type { ApiClient } from './api';

const base = { baseDir: BaseDirectory.AppCache };

/** Lädt die Server-Datei einmalig in den lokalen Cache und liefert den absoluten Pfad. */
export async function ensureCached(api: ApiClient, fileId: string): Promise<string> {
  const rel = `files/${fileId}.pdf`;
  if (!(await exists(rel, base))) {
    await mkdir('files', { ...base, recursive: true }).catch(() => {});
    await writeFile(rel, await api.fetchFile(fileId), base);
  }
  return await join(await appCacheDir(), rel);
}
```

`src/lib/thumbnails.ts` komplett ersetzen durch:

```ts
import { BaseDirectory, exists, mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Doc } from '@digital-desktop/core';
import type { ApiClient } from './api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = { baseDir: BaseDirectory.AppData };
const cachePath = (fileId: string) => `thumbnails/${fileId}.png`;
const urls = new Map<string, string>();

function remember(fileId: string, bytes: Uint8Array): string {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  urls.set(fileId, url);
  return url;
}

/** Object-URL der Miniatur der ersten Seite (PNG-Cache pro fileId); null, wenn nicht renderbar. */
export async function getThumbnail(api: ApiClient, doc: Doc): Promise<string | null> {
  const cached = urls.get(doc.fileId);
  if (cached) return cached;
  try {
    if (await exists(cachePath(doc.fileId), base)) {
      return remember(doc.fileId, await readFile(cachePath(doc.fileId), base));
    }
    const data = await api.fetchFile(doc.fileId);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const scale = 360 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob fehlgeschlagen'))), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await mkdir('thumbnails', { ...base, recursive: true }).catch(() => {});
    await writeFile(cachePath(doc.fileId), bytes, base).catch(() => {});
    return remember(doc.fileId, bytes);
  } catch {
    return null; // defekt oder (noch) nicht ladbar → generisches Symbol
  }
}
```

`src/lib/menus.ts` komplett ersetzen durch:

```ts
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { writeFile } from '@tauri-apps/plugin-fs';
import { collectLinkedDocs, type Doc, type Stack } from '@digital-desktop/core';
import { desktop } from './store.svelte';
import { ui, showToast } from './ui.svelte';
import { ensureCached } from './fileCache';

export async function openDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  try {
    await openPath(await ensureCached(desktop.api, doc.fileId));
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Öffnen fehlgeschlagen');
  }
}

export function openWithLinked(entityId: string): void {
  for (const d of collectLinkedDocs(desktop.state, entityId)) void openDoc(d);
}

export async function downloadDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  const target = await saveDialog({ defaultPath: doc.name });
  if (typeof target !== 'string') return;
  try {
    await writeFile(target, await desktop.api.fetchFile(doc.fileId));
    showToast(`Gespeichert: ${doc.name}`);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Herunterladen fehlgeschlagen');
  }
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  ui.menu = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Öffnen', action: () => void openDoc(doc) },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeDoc', { id: doc.id }) },
    ],
  };
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
      { label: 'Stapel auflösen', action: () => void desktop.command('dissolveStack', { stackId: stack.id }) },
      { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeStack', { stackId: stack.id }) },
    ],
  };
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npm test`
Expected: PASS (unverändert — dieser Task liefert Module, die erst Task 12 verdrahtet).

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat: Client-Rückgrat — Server-Store mit WS-Sync, Datei-Cache, Menüs auf Kommandos" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Client — Komponenten, Login-Screen und App-Fluss

**Files:**
- Create: `src/lib/components/LoginScreen.svelte`
- Modify (komplett ersetzen): `src/routes/+page.svelte`, `src/lib/components/Desktop.svelte`, `src/lib/components/DocCard.svelte`, `src/lib/components/StackCard.svelte`
- Modify (gezielt): `src/lib/components/LinkLayer.svelte`

**Interfaces:**
- Consumes: alles aus Tasks 10–11; `debounce` (bestehend); core-Funktionen.
- Produces: lauffähige App gegen laufenden Server. Ab diesem Task gelten wieder alle Gates: `npm test`, `svelte-check` (0 Errors) und `npm run tauri dev`.

- [ ] **Step 1: LoginScreen.svelte anlegen**

Create `src/lib/components/LoginScreen.svelte`:

```svelte
<script lang="ts">
  import { ApiClient, ApiError } from '../api';
  import { saveSession, type Session } from '../session';

  let { onConnected }: { onConnected: (s: Session) => Promise<void> } = $props();

  let serverUrl = $state('http://localhost:4810');
  let username = $state('');
  let password = $state('');
  let needsSetup = $state<boolean | null>(null);
  let error = $state('');
  let busy = $state(false);

  async function checkServer(): Promise<void> {
    error = '';
    needsSetup = null;
    try {
      needsSetup = (await new ApiClient(serverUrl).status()).needsSetup;
    } catch {
      error = 'Server nicht erreichbar — URL prüfen';
    }
  }

  async function submit(): Promise<void> {
    busy = true;
    error = '';
    try {
      if (needsSetup === null) await checkServer();
      const api = new ApiClient(serverUrl);
      if (needsSetup) await api.setup(username, password);
      else await api.login(username, password);
      const session = { serverUrl, token: api.token! };
      await saveSession(session);
      await onConnected(session);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Verbindung fehlgeschlagen';
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form class="card" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <h1>Digital Desktop</h1>
    <label>Server-URL
      <input bind:value={serverUrl} onblur={() => void checkServer()} placeholder="http://192.168.1.10:4810" />
    </label>
    {#if needsSetup}<p class="hint">Ersteinrichtung: Lege das erste Konto an (Passwort min. 8 Zeichen).</p>{/if}
    <label>Benutzername <input bind:value={username} autocomplete="username" /></label>
    <label>Passwort <input type="password" bind:value={password} autocomplete="current-password" /></label>
    {#if error}<p class="error">{error}</p>{/if}
    <button disabled={busy || !serverUrl || !username || !password}>
      {needsSetup ? 'Konto anlegen' : 'Anmelden'}
    </button>
  </form>
</div>

<style>
  .wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .card { display: flex; flex-direction: column; gap: 12px; width: 320px; padding: 28px;
          border-radius: 14px; background: rgba(255, 255, 255, .96); box-shadow: 0 12px 40px rgba(0, 0, 0, .4); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  input { padding: 7px 9px; border: 1px solid #ccc; border-radius: 7px; font: inherit; }
  .hint { margin: 0; font-size: 12px; color: #2c5aa0; }
  .error { margin: 0; font-size: 12px; color: #b02a2a; }
  button { padding: 8px; border: none; border-radius: 8px; background: #2c5aa0; color: #fff;
           font-size: 14px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
```

- [ ] **Step 2: +page.svelte ersetzen**

`src/routes/+page.svelte` komplett ersetzen durch:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
  import Desktop from '../lib/components/Desktop.svelte';
  import LoginScreen from '../lib/components/LoginScreen.svelte';
  import { desktop } from '../lib/store.svelte';
  import { ApiClient } from '../lib/api';
  import { loadSession, clearSession, type Session } from '../lib/session';
  import { maybeOfferV1Import } from '../lib/importV1';

  let phase = $state<'loading' | 'login' | 'desk'>('loading');

  async function connect(session: Session): Promise<void> {
    const api = new ApiClient(session.serverUrl, session.token);
    await desktop.start(api);
    phase = 'desk';
    void maybeOfferV1Import(api);
  }

  onMount(async () => {
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    const win = getCurrentWindow();
    try {
      const quitItem = await MenuItem.new({
        text: 'Digital Desktop beenden',
        accelerator: 'CmdOrCtrl+Q',
        action: async () => {
          await win.destroy();
        },
      });
      const appSubmenu = await Submenu.new({ text: 'Digital Desktop', items: [quitItem] });
      const editSubmenu = await Submenu.new({
        text: 'Bearbeiten',
        items: [
          await PredefinedMenuItem.new({ item: 'Undo' }),
          await PredefinedMenuItem.new({ item: 'Redo' }),
          await PredefinedMenuItem.new({ item: 'Separator' }),
          await PredefinedMenuItem.new({ item: 'Cut' }),
          await PredefinedMenuItem.new({ item: 'Copy' }),
          await PredefinedMenuItem.new({ item: 'Paste' }),
          await PredefinedMenuItem.new({ item: 'SelectAll' }),
        ],
      });
      await (await Menu.new({ items: [appSubmenu, editSubmenu] })).setAsAppMenu();
    } catch {
      // Menü ist Komfort — Start nicht blockieren
    }

    const session = await loadSession();
    if (!session) {
      phase = 'login';
      return;
    }
    try {
      await connect(session);
    } catch {
      await clearSession();
      phase = 'login';
    }
  });
</script>

{#if phase === 'login'}
  <LoginScreen onConnected={connect} />
{:else if phase === 'desk'}
  <Desktop />
{/if}

<style>
  :global(html, body) { margin: 0; height: 100%; overflow: hidden; }
</style>
```

Hinweis: Der Save-Flush aus v1 entfällt bewusst — es gibt keinen lokalen Zustand mehr, jede bestätigte Aktion liegt bereits auf dem Server. `importV1.ts` existiert erst in Task 13 — lege dafür in DIESEM Task eine Platzhalter-Datei an, damit die App kompiliert:

Create `src/lib/importV1.ts`:

```ts
import type { ApiClient } from './api';

/** Wird in Task 13 implementiert (v1-Datenübernahme). */
export async function maybeOfferV1Import(_api: ApiClient): Promise<void> {
  // bewusst leer
}
```

- [ ] **Step 3: Desktop.svelte ersetzen**

`src/lib/components/Desktop.svelte` komplett ersetzen durch:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { readFile } from '@tauri-apps/plugin-fs';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import {
    freeDocs, screenToWorld, zoomAt, zoomToFit, allBoxes,
    type Vec2, type Viewport,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { ui, showToast } from '../ui.svelte';
  import DocCard from './DocCard.svelte';
  import StackCard from './StackCard.svelte';
  import LinkLayer from './LinkLayer.svelte';
  import ContextMenu from './ContextMenu.svelte';

  let vp = $state<Viewport>({ x: 0, y: 0, scale: 1 });
  let el: HTMLDivElement;
  let panning = $state(false);
  let spaceDown = $state(false);

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      vp = zoomAt(vp, { x: e.clientX, y: e.clientY }, Math.exp(-e.deltaY * 0.01));
    } else {
      vp = { ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY };
    }
  }
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || e.target !== el) return;
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

  async function addPdfFromPath(path: string, position: Vec2): Promise<void> {
    if (!desktop.api) return;
    const name = path.split('/').pop() ?? 'Dokument.pdf';
    try {
      const fileId = await desktop.api.uploadFile(await readFile(path), name);
      await desktop.command('addDoc', { fileId, name, position });
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Upload fehlgeschlagen: ${name}`);
    }
  }

  async function addViaDialog(): Promise<void> {
    const picked = await openDialog({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!picked) return;
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    const paths = Array.isArray(picked) ? picked : [picked];
    for (const [i, p] of paths.entries()) {
      await addPdfFromPath(p, { x: center.x + i * 28, y: center.y + i * 20 });
    }
  }

  onMount(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = true;
      if (e.code === 'Escape') {
        ui.linkingFromId = null;
        ui.menu = null;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type !== 'drop') return;
        const dpr = window.devicePixelRatio;
        const world = screenToWorld(vp, { x: e.payload.position.x / dpr, y: e.payload.position.y / dpr });
        e.payload.paths
          .filter((p) => p.toLowerCase().endsWith('.pdf'))
          .forEach((p, i) => void addPdfFromPath(p, { x: world.x + i * 28, y: world.y + i * 20 }));
      })
      .then((u) => {
        unlisten = u;
      });
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
    <LinkLayer />
    {#each freeDocs(desktop.state) as doc (doc.id)}
      <DocCard {doc} {vp} />
    {/each}
    {#each desktop.state.stacks as stack (stack.id)}
      <StackCard {stack} {vp} />
    {/each}
  </div>
  <div class="toolbar">
    <button onclick={() => void addViaDialog()} title="PDF hinzufügen">＋ PDF</button>
    <button onclick={fitAll}>Übersicht</button>
  </div>
  {#if ui.linkingFromId}
    <div class="hint">Verknüpfen: Ziel anklicken (Esc bricht ab)</div>
  {/if}
  {#if desktop.status === 'offline' || desktop.status === 'connecting'}
    <div class="banner">
      {desktop.status === 'offline' ? 'Verbindung getrennt — verbinde neu…' : 'Verbinde…'}
    </div>
    <div class="blocker"></div>
  {/if}
  {#if ui.toast}
    <div class="toast">{ui.toast}</div>
  {/if}
  <ContextMenu />
</div>

<style>
  .desk { position: fixed; inset: 0; overflow: hidden;
          background: radial-gradient(1200px 800px at 40% 30%, #3a5c4e, #27423a 70%, #1d332d); }
  .desk.grabbing { cursor: grabbing; }
  .world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .toolbar { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; z-index: 9000; }
  .toolbar button { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
                    background: rgba(255, 255, 255, .92); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
          border-radius: 999px; background: rgba(20, 40, 90, .85); color: #fff; font-size: 13px; z-index: 9999; }
  .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
            border-radius: 999px; background: rgba(140, 60, 20, .9); color: #fff; font-size: 13px; z-index: 99000; }
  .blocker { position: fixed; inset: 0; z-index: 98000; cursor: wait; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
           border-radius: 10px; background: rgba(20, 20, 20, .88); color: #fff; font-size: 13px; z-index: 99500; }
</style>
```

- [ ] **Step 4: DocCard.svelte ersetzen**

`src/lib/components/DocCard.svelte` komplett ersetzen durch:

```svelte
<script lang="ts">
  import {
    CARD_W, CARD_H, moveDoc, hitTest, type Doc, type Viewport,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { showDocMenu, openDoc } from '../menus';
  import { getThumbnail } from '../thumbnails';

  let { doc, vp }: { doc: Doc; vp: Viewport } = $props();

  let thumb = $state<string | null>(null);
  $effect(() => {
    doc.fileId;
    if (desktop.api) void getThumbnail(desktop.api, doc).then((t) => (thumb = t));
  });

  let dragging = false;
  let moved = false;
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ui.linkingFromId && ui.linkingFromId !== doc.id) {
      const from = ui.linkingFromId;
      ui.linkingFromId = null;
      void desktop.command('addLink', { fromId: from, toId: doc.id });
      return;
    }
    if (ui.linkingFromId === doc.id) {
      ui.linkingFromId = null;
      return;
    }
    dragging = true;
    moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: doc.id });
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.applyLocal((s) =>
      moveDoc(s, doc.id, { x: doc.position.x + e.movementX / vp.scale, y: doc.position.y + e.movementY / vp.scale }),
    );
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    const center = { x: doc.position.x + CARD_W / 2, y: doc.position.y + CARD_H / 2 };
    const hit = hitTest(desktop.state, center, doc.id);
    if (hit) void desktop.command('stackDocs', { draggedId: doc.id, targetId: hit.id });
    else void desktop.command('moveDoc', { id: doc.id, position: { x: doc.position.x, y: doc.position.y } });
  }

</script>

<div class="card"
     style:left="{doc.position.x}px" style:top="{doc.position.y}px"
     style:z-index={doc.zIndex} style:transform="rotate({doc.rotation}deg)"
     style:width="{CARD_W}px" style:height="{CARD_H}px"
     onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp}
     ondblclick={() => void openDoc(doc)}
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

<style>
  .card { position: absolute; display: flex; flex-direction: column; background: #fff; border-radius: 4px;
          box-shadow: 0 6px 18px rgba(0, 0, 0, .35); cursor: grab; user-select: none; }
  .body { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden;
          border-radius: 4px 4px 0 0; }
  img { width: 100%; height: 100%; object-fit: cover; object-position: top; pointer-events: none; }
  .fallback { font-weight: 700; color: #b33; font-size: 22px; }
  .name { padding: 4px 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          background: rgba(255, 255, 255, .9); border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
</style>
```

- [ ] **Step 5: StackCard.svelte ersetzen**

`src/lib/components/StackCard.svelte` komplett ersetzen durch:

```svelte
<script lang="ts">
  import {
    CARD_W, CARD_H, findDoc, moveStack, screenToWorld, type Stack, type Viewport,
  } from '@digital-desktop/core';
  import { desktop } from '../store.svelte';
  import { ui } from '../ui.svelte';
  import { showDocMenu, showStackMenu, openDoc } from '../menus';
  import { getThumbnail } from '../thumbnails';

  let { stack, vp }: { stack: Stack; vp: Viewport } = $props();
  const fanned = $derived(ui.fannedStackId === stack.id);

  const topDoc = $derived(findDoc(desktop.state, stack.docIds[stack.docIds.length - 1]));
  let thumb = $state<string | null>(null);
  $effect(() => {
    if (topDoc && desktop.api) void getThumbnail(desktop.api, topDoc).then((t) => (thumb = t));
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
      void desktop.command('addLink', { fromId: from, toId: stack.id });
      return;
    }
    if (ui.linkingFromId === stack.id) {
      ui.linkingFromId = null;
      return;
    }
    dragging = true;
    moved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    void desktop.command('bringToFront', { id: stack.id });
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    moved = true;
    desktop.applyLocal((s) =>
      moveStack(s, stack.id, { x: stack.position.x + e.movementX / vp.scale, y: stack.position.y + e.movementY / vp.scale }),
    );
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (moved) void desktop.command('moveStack', { stackId: stack.id, position: { x: stack.position.x, y: stack.position.y } });
    else ui.fannedStackId = fanned ? null : stack.id;
  }

  /** Gefächerter Eintrag: >30 px ziehen = herausnehmen, sonst Klick = öffnen. */
  function fanPointerDown(e: PointerEvent, docId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const cleanup = () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
    };
    const onUp = (up: PointerEvent) => {
      cleanup();
      if (Math.hypot(up.clientX - startX, up.clientY - startY) > 30) {
        const w = screenToWorld(vp, { x: up.clientX, y: up.clientY });
        void desktop.command('removeFromStack', {
          docId,
          position: { x: w.x - CARD_W / 2, y: w.y - CARD_H / 2 },
        });
      } else {
        const d = findDoc(desktop.state, docId);
        if (d) void openDoc(d);
      }
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', cleanup);
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
           onchange={(e) => { const name = (e.currentTarget as HTMLInputElement).value; void desktop.command('renameStack', { stackId: stack.id, name }); ui.editingStackId = null; }} />
  {:else if stack.name}
    <div class="name label">{stack.name}</div>
  {/if}

  {#if fanned}
    <div class="fan">
      {#each stack.docIds as docId (docId)}
        {@const d = findDoc(desktop.state, docId)}
        {#if d}
          <div class="fan-card" onpointerdown={(e) => fanPointerDown(e, docId)}
               oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); showDocMenu(e, d); }}>
            {d.name}
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

- [ ] **Step 6: LinkLayer.svelte anpassen**

In `src/lib/components/LinkLayer.svelte`:

Import-Zeilen ersetzen durch:

```ts
  import {
    CARD_W, CARD_H, findDoc, findStack, stackOf, setLinkNote, type Vec2,
  } from '@digital-desktop/core';
  import { debounce } from '../debounce';
  import { desktop } from '../store.svelte';
```

Nach den Imports ergänzen:

```ts
  const sendNote = debounce(400, (linkId: string, note: string) => {
    void desktop.command('setLinkNote', { linkId, note });
  });
```

Das `oninput` der Notiz-Textarea ersetzen durch:

```svelte
        oninput={(e) => {
          const note = (e.currentTarget as HTMLTextAreaElement).value;
          desktop.applyLocal((s) => setLinkNote(s, openLink.id, note));
          sendNote(openLink.id, note);
        }}
```

Den „Verknüpfung lösen"-Button-Handler ersetzen durch:

```svelte
        <button onclick={() => { void desktop.command('removeLink', { linkId: openLink.id }); openLinkId = null; }}>Verknüpfung lösen</button>
```

(Der alte direkte `desktop.apply(...)`-Aufruf existiert nicht mehr.)

- [ ] **Step 7: Verifizieren**

```bash
npm test
npx svelte-check 2>&1 | tail -5
```

Expected: alle Tests grün; svelte-check 0 Errors (a11y-Warnungen wie gehabt).

Dann Ende-zu-Ende gegen den echten Server:

```bash
npm run server   # Terminal 1 (weiterlaufen lassen)
npm run tauri dev   # Terminal 2
```

Prüfliste (manuell durch den Ausführenden, soweit ohne Maus-Interaktion möglich; Rest als „pending user verification" dokumentieren):
1. App startet → Ersteinrichtungs-Maske (Server meldet needsSetup) → Konto anlegen → leerer Schreibtisch erscheint, „Schreibtisch 1" wurde per API angelegt.
2. Terminal-Logs beider Prozesse frei von Fehlern/Permission-Meldungen.
3. App neu starten → direkt eingeloggt (Session-Datei), Schreibtisch lädt vom Server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: Client komplett auf Server umgestellt — Login, Upload, Kommandos, Live-Sync" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: v1-Datenübernahme

**Files:**
- Modify (komplett ersetzen): `src/lib/importV1.ts`
- Test: `src/lib/importV1.test.ts`

**Interfaces:**
- Consumes: `ApiClient` (Task 10), `desktop` (Task 11), plugin-fs/dialog.
- Produces: `parseV1(json): V1State | null`; `buildImportedState(v1, fileIdByDocId): DesktopState` (pur: überspringt Dokumente ohne Upload, Stapel mit < 2 überlebenden Mitgliedern werden aufgelöst, Verknüpfungen ohne beide Endpunkte entfallen); `maybeOfferV1Import(api)` (fragt nur bei vorhandener v1-Datei UND leerem aktuellem Schreibtisch; lädt hoch, `PUT /state`, benennt Datei in `desktop.json.importiert` um, meldet Ergebnis inkl. übersprungener Pfade).

- [ ] **Step 1: Failing Tests schreiben**

Create `src/lib/importV1.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseV1, buildImportedState } from './importV1';

const v1 = {
  docs: [
    { id: 'id-a', path: '/tmp/a.pdf', position: { x: 1, y: 2 }, rotation: 1.5, zIndex: 1, missing: false },
    { id: 'id-b', path: '/tmp/b.pdf', position: { x: 3, y: 4 }, rotation: -1, zIndex: 2, missing: false },
    { id: 'id-c', path: '/tmp/fehlt.pdf', position: { x: 5, y: 6 }, rotation: 0, zIndex: 3, missing: true },
  ],
  links: [
    { id: 'l-1', fromId: 'id-a', toId: 'id-b', note: 'zusammen' },
    { id: 'l-2', fromId: 'id-a', toId: 'id-c', note: '' },
  ],
  stacks: [{ id: 'st-1', name: 'P', docIds: ['id-b', 'id-c'], position: { x: 0, y: 0 }, zIndex: 4 }],
};

describe('parseV1', () => {
  it('liest einen gültigen v1-Zustand und lehnt Müll ab', () => {
    expect(parseV1(JSON.stringify(v1))).not.toBeNull();
    expect(parseV1('{ kaputt')).toBeNull();
    expect(parseV1('{"docs":[{"id":5}],"links":[],"stacks":[]}')).toBeNull();
  });
});

describe('buildImportedState', () => {
  it('übernimmt hochgeladene Dokumente mit Position/Rotation/zIndex und Namen aus dem Pfad', () => {
    const map = new Map([['id-a', 'file-a'], ['id-b', 'file-b']]); // id-c fehlt lokal
    const s = buildImportedState(parseV1(JSON.stringify(v1))!, map);
    expect(s.docs).toHaveLength(2);
    expect(s.docs[0]).toMatchObject({ id: 'id-a', fileId: 'file-a', name: 'a.pdf', position: { x: 1, y: 2 } });
  });

  it('löst Stapel mit weniger als 2 überlebenden Mitgliedern auf und filtert Verknüpfungen', () => {
    const map = new Map([['id-a', 'file-a'], ['id-b', 'file-b']]);
    const s = buildImportedState(parseV1(JSON.stringify(v1))!, map);
    expect(s.stacks).toHaveLength(0); // st-1 hatte id-b + id-c, id-c fehlt → aufgelöst
    expect(s.links.map((l) => l.id)).toEqual(['l-1']); // l-2 zeigte auf id-c
  });

  it('behält Stapel mit 2+ überlebenden Mitgliedern samt Verknüpfung auf den Stapel', () => {
    const map = new Map([['id-a', 'file-a'], ['id-b', 'file-b'], ['id-c', 'file-c']]);
    const withStackLink = { ...v1, links: [...v1.links, { id: 'l-3', fromId: 'st-1', toId: 'id-a', note: '' }] };
    const s = buildImportedState(parseV1(JSON.stringify(withStackLink))!, map);
    expect(s.stacks).toHaveLength(1);
    expect(s.links.map((l) => l.id).sort()).toEqual(['l-1', 'l-2', 'l-3']);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — sie müssen fehlschlagen**

Run: `npm test`
Expected: FAIL — `parseV1`/`buildImportedState` existieren im Platzhalter nicht.

- [ ] **Step 3: Implementieren**

`src/lib/importV1.ts` komplett ersetzen durch:

```ts
import { BaseDirectory, exists, readFile, readTextFile, rename } from '@tauri-apps/plugin-fs';
import { ask, message } from '@tauri-apps/plugin-dialog';
import type { DesktopState, Link, Stack, Vec2 } from '@digital-desktop/core';
import type { ApiClient } from './api';
import { desktop } from './store.svelte';

interface V1Doc {
  id: string;
  path: string;
  position: Vec2;
  rotation: number;
  zIndex: number;
}

export interface V1State {
  docs: V1Doc[];
  links: Link[];
  stacks: Stack[];
}

const V1_FILE = 'desktop.json';
const base = { baseDir: BaseDirectory.AppData };

export function parseV1(json: string): V1State | null {
  try {
    const v = JSON.parse(json) as V1State | null;
    if (!v || !Array.isArray(v.docs) || !Array.isArray(v.links) || !Array.isArray(v.stacks)) return null;
    if (!v.docs.every((d) => !!d && typeof d.id === 'string' && typeof d.path === 'string')) return null;
    return v;
  } catch {
    return null;
  }
}

function baseName(path: string): string {
  return path.split('/').pop() ?? 'Dokument.pdf';
}

/** Pur: baut aus v1-Zustand + Upload-Zuordnung den neuen Zustand (fehlende Dateien übersprungen). */
export function buildImportedState(v1: V1State, fileIdByDocId: Map<string, string>): DesktopState {
  const docs = v1.docs
    .filter((d) => fileIdByDocId.has(d.id))
    .map((d) => ({
      id: d.id,
      fileId: fileIdByDocId.get(d.id)!,
      name: baseName(d.path),
      position: d.position,
      rotation: d.rotation,
      zIndex: d.zIndex,
    }));
  const docIds = new Set(docs.map((d) => d.id));
  const stacks = v1.stacks
    .map((st) => ({ ...st, docIds: st.docIds.filter((i) => docIds.has(i)) }))
    .filter((st) => st.docIds.length >= 2);
  const stackIds = new Set(stacks.map((st) => st.id));
  const links = v1.links.filter((l) =>
    [l.fromId, l.toId].every((id) => docIds.has(id) || stackIds.has(id)),
  );
  return { docs, links, stacks };
}

/** Bietet nach dem ersten Login einmalig die Übernahme der lokalen v1-Daten an. */
export async function maybeOfferV1Import(api: ApiClient): Promise<void> {
  try {
    if (!(await exists(V1_FILE, base))) return;
    if (desktop.state.docs.length > 0) return; // nur in einen leeren Schreibtisch importieren
    const v1 = parseV1(await readTextFile(V1_FILE, base));
    if (!v1 || v1.docs.length === 0) return;

    const yes = await ask(
      `Es wurde ein Schreibtisch aus der alten Version gefunden (${v1.docs.length} Dokumente). Auf den Server übernehmen?`,
      { title: 'Digital Desktop', kind: 'info' },
    );
    if (!yes) return;

    const fileIdByDocId = new Map<string, string>();
    const skipped: string[] = [];
    for (const d of v1.docs) {
      try {
        fileIdByDocId.set(d.id, await api.uploadFile(await readFile(d.path), baseName(d.path)));
      } catch {
        skipped.push(d.path);
      }
    }

    const state = buildImportedState(v1, fileIdByDocId);
    if (!desktop.deskId) return;
    await api.putState(desktop.deskId, state);
    await desktop.refresh();
    await rename(V1_FILE, 'desktop.json.importiert', {
      oldPathBaseDir: BaseDirectory.AppData,
      newPathBaseDir: BaseDirectory.AppData,
    });
    await message(
      skipped.length === 0
        ? `Übernommen: ${state.docs.length} Dokumente.`
        : `Übernommen: ${state.docs.length} Dokumente.\nÜbersprungen (lokal nicht gefunden):\n${skipped.join('\n')}`,
      { title: 'Import abgeschlossen' },
    );
  } catch {
    // Import ist Komfort — Fehler dürfen den App-Start nie verhindern
  }
}
```

- [ ] **Step 4: Tests laufen lassen — sie müssen bestehen**

Run: `npm test` und `npx svelte-check 2>&1 | tail -5`
Expected: PASS bzw. 0 Errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat: v1-Datenübernahme — Upload der referenzierten PDFs und Zustand-Import" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: README, Betrieb & Abschluss-Verifikation

**Files:**
- Modify (komplett ersetzen): `README.md`

**Interfaces:**
- Produces: dokumentierter Betrieb (Dev, Heimnetz, Docker, HTTPS-Hinweis); verifiziertes Gesamtsystem.

- [ ] **Step 1: README ersetzen**

`README.md` komplett ersetzen durch:

```markdown
# Digital Desktop

Ein grafischer Schreibtisch für PDF-Dateien: Karten frei anordnen, verknüpfen, stapeln —
als Mac-App (Tauri) mit einem Server im Netzwerk (Node + SQLite).

## Struktur

- `packages/core` — pure Zustandslogik (von Server und Client genutzt)
- `packages/server` — HTTP-API + WebSocket + SQLite + PDF-Ablage
- Wurzel — Tauri-Client (Svelte)

## Entwicklung

    npm install
    npm run server        # Server auf http://localhost:4810 (Daten: packages/server/data/)
    npm run tauri dev     # Client (zweites Terminal)
    npm test              # alle Tests (core + server + Client-Module)

Beim ersten Start legt die App über die Ersteinrichtungs-Maske das erste Konto an.

## Server im Heimnetz / auf dem NAS

Direkt mit Node (≥ 20):

    PORT=4810 DATA_DIR=/pfad/zu/daten npm run server

Oder mit Docker:

    docker build -f packages/server/Dockerfile -t digital-desktop-server .
    docker run -d -p 4810:4810 -v dd-data:/data digital-desktop-server

In der App als Server-URL dann `http://<host>:4810` eintragen.

**Zugriff übers Internet:** nur hinter einem HTTPS-Reverse-Proxy (z. B. Caddy:
`reverse_proxy localhost:4810` mit automatischem TLS).

## Bekannte Einschränkungen

- Offline-Editing gibt es nicht: ohne Serververbindung sind Aktionen gesperrt.
- Gleichzeitige Bearbeitung: letzter Schreiber gewinnt (für Kartenpositionen unkritisch).
- Benutzerverwaltung/Teilen und Mehrschreibtisch-UI folgen in späteren Ausbaustufen
  (API und Datenmodell sind vorbereitet).
```

- [ ] **Step 2: Gesamtsystem verifizieren**

```bash
npm test
npx svelte-check 2>&1 | tail -5
npm run server   # Terminal 1
npm run tauri dev   # Terminal 2
```

Automatisierbar prüfen: beide Prozesse starten fehlerfrei; `curl -s http://localhost:4810/api/v1/auth/status` antwortet.

Manuelle Endabnahme (durch den Nutzer, als „pending user verification" dokumentieren):
1. Ersteinrichtung → leerer Schreibtisch; App-Neustart → automatisch angemeldet.
2. v1-Import-Dialog erscheint (falls alte desktop.json vorhanden); Übernahme mit Positionen/Verknüpfungen/Stapeln.
3. PDF aus dem Finder ziehen → Karte mit Miniatur (Original bleibt liegen); Doppelklick → Vorschau öffnet die Server-Kopie.
4. Verknüpfen mit Notiz; Stapeln; Auffächern; Herausziehen; Benennen; Herunterladen…
5. Zweites Fenster/Gerät: gleiche Änderungen erscheinen live (WebSocket).
6. Server stoppen → Banner „Verbindung getrennt", Aktionen gesperrt; Server starten → automatische Wiederverbindung.
7. Cmd+Q und Neustart → Zustand vollständig vorhanden (liegt auf dem Server).

- [ ] **Step 3: Abschluss-Commit**

```bash
git add -A
git commit -m "docs: Betriebsanleitung für Client-Server-Setup" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
