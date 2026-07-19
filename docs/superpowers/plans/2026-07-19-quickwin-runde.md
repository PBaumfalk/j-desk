# Quickwin-Runde Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gedankenobjekte komplett (12 Zettel-Typen inkl. „Eigener" mit Freitext-Badge, To-do abhakbar), Schredder im Korb-Panel, MCP liest den ganzen Werkzeugkasten und bekommt gefahrlose Schreib-Tools.

**Architecture:** Bewährtes Rundenmuster: Core-Funktion + Command (generisch über die bestehende Command-Route, kein Server-Produktivcode) → Svelte-Komponente → MCP-Tool über `sendCommand`. Reihenfolge Zettel → Schredder → MCP, damit das MCP die neuen Felder direkt mitliest.

**Tech Stack:** TypeScript, Svelte 5 (Runes), Vitest, MCP-SDK + zod (packages/mcp). Keine neuen Dependencies.

**Spec:** `docs/superpowers/specs/2026-07-19-quickwin-runde-design.md`

## Global Constraints

- UI-Texte, Kommentare, Fehlermeldungen, Commit-Messages auf Deutsch.
- Alle neuen Modell-Felder optional — Alt-States ohne Migration gültig.
- Zettel: `NOTE_KINDS`-Erweiterung exakt `behauptung, beweisziel, idee, todo, argument, rechtsfrage, eigen`; `customLabel` NUR bei `eigen` (Pflicht, max. 24 Zeichen = `NOTE_BADGE_MAX`); `done` nur bei `todo` setzbar.
- MCP: alle Freitexte (Stempel-Text, Korb-Name, `customLabel`) anonymisiert lesen, deanonymisiert schreiben (Muster `add_note`/`deanon`); KEINE Tools für `emptyTrash`/`shredTrashItem`/marks/tape.
- Tests: `npx vitest run <datei>` fokussiert, einmal `npx vitest run` (volle Suite) + `npm run check` vor UI-Commits.
- Jeder Commit endet mit:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QdeYjTVNGfLh9ciFfgeXZt
  ```

---

### Task 1: Core — Zettel-Typen, customLabel, To-do-done (TDD)

**Files:**
- Modify: `packages/core/src/notes.ts`
- Modify: `packages/core/src/commands.ts` (Handler `addNote` ca. Zeile 92; neuer Handler `setNoteDone`)
- Test: `packages/core/src/notes.test.ts` (erweitern)

**Interfaces:**
- Consumes: `mapNote`, `maxZ`, `uid`, Helfer `text`/`id`/`optId`/`vec`/`CommandError` in commands.ts.
- Produces: `NOTE_KINDS` (12 Einträge), `NOTE_BADGE_MAX = 24`, `Note.customLabel?: string`, `Note.done?: boolean`, `addNote(s, kind, text, position, id?, customLabel?)`, `setNoteDone(s, id, done)`, Commands `addNote` (payload + `customLabel`) und `setNoteDone` (payload `{ id, done }`). Tasks 2/5/6 verlassen sich auf genau diese Namen.

- [ ] **Step 1: Failing Tests ergänzen**

In `packages/core/src/notes.test.ts` ergänzen (bestehende Tests unverändert lassen; Importe um `setNoteDone, NOTE_BADGE_MAX` erweitern):

```ts
describe('neue Gedankenobjekt-Typen', () => {
  it('kennt alle 12 Typen inklusive eigen', () => {
    for (const kind of ['behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen'] as const) {
      const s = addNote(emptyState(), kind, 'x', { x: 0, y: 0 }, 'n1', kind === 'eigen' ? 'Zeugenfrage' : undefined);
      expect(findNote(s, 'n1')?.kind).toBe(kind);
    }
  });

  it('eigen verlangt ein Badge (max. 24 Zeichen), andere Typen verbieten es', () => {
    expect(() => addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1')).toThrow('Badge');
    expect(() => addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1', '  ')).toThrow('Badge');
    expect(() => addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1', 'a'.repeat(NOTE_BADGE_MAX + 1))).toThrow('Badge');
    expect(() => addNote(emptyState(), 'frage', 'x', { x: 0, y: 0 }, 'n1', 'Extra')).toThrow('eigen');
    const s = addNote(emptyState(), 'eigen', 'x', { x: 0, y: 0 }, 'n1', ' Mandanteninfo ');
    expect(findNote(s, 'n1')?.customLabel).toBe('Mandanteninfo');
  });

  it('setNoteDone hakt nur To-dos ab', () => {
    let s = addNote(emptyState(), 'todo', 'Frist prüfen', { x: 0, y: 0 }, 'n1');
    s = setNoteDone(s, 'n1', true);
    expect(findNote(s, 'n1')?.done).toBe(true);
    s = setNoteDone(s, 'n1', false);
    expect(findNote(s, 'n1')?.done).toBe(false);
    const frage = addNote(emptyState(), 'frage', 'x', { x: 0, y: 0 }, 'n2');
    expect(() => setNoteDone(frage, 'n2', true)).toThrow('To-do');
    expect(() => setNoteDone(s, 'nix', true)).toThrow('nicht gefunden');
  });

  it('Commands: addNote mit customLabel, setNoteDone verlangt boolean', () => {
    const s = applyCommand(emptyState(), {
      type: 'addNote',
      payload: { kind: 'eigen', text: '', position: { x: 1, y: 2 }, id: 'n1', customLabel: 'Zeugenfrage' },
    });
    expect(findNote(s, 'n1')?.customLabel).toBe('Zeugenfrage');
    const t = applyCommand(emptyState(), { type: 'addNote', payload: { kind: 'todo', text: '', position: { x: 0, y: 0 }, id: 'n2' } });
    const done = applyCommand(t, { type: 'setNoteDone', payload: { id: 'n2', done: true } });
    expect(findNote(done, 'n2')?.done).toBe(true);
    expect(() => applyCommand(t, { type: 'setNoteDone', payload: { id: 'n2', done: 'ja' } })).toThrow('done');
  });
});
```

(Falls `notes.test.ts` `applyCommand` noch nicht importiert: aus `./commands` ergänzen.)

- [ ] **Step 2: Fehlschlag zeigen**

Run: `npx vitest run packages/core/src/notes.test.ts`
Expected: FAIL (unbekannte Typen, `setNoteDone` existiert nicht).

- [ ] **Step 3: notes.ts erweitern**

```ts
export const NOTE_KINDS = [
  'notiz', 'frage', 'these', 'angriffspunkt', 'risiko',
  'behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen',
] as const;
```

`Note` um zwei Felder ergänzen:

```ts
  customLabel?: string; // nur bei kind 'eigen': frei benanntes Badge
  done?: boolean;       // nur bei kind 'todo': abgehakt
```

`NOTE_BADGE_MAX` exportieren und `addNote` ersetzen:

```ts
export const NOTE_BADGE_MAX = 24;

export function addNote(
  s: DesktopState,
  kind: NoteKind,
  text: string,
  position: Vec2,
  id: string = uid(),
  customLabel?: string,
): DesktopState {
  if (!NOTE_KINDS.includes(kind)) throw new Error(`Unbekannter Zettel-Typ: ${String(kind)}`);
  if (kind === 'eigen') {
    if (typeof customLabel !== 'string' || customLabel.trim() === '' || customLabel.trim().length > NOTE_BADGE_MAX) {
      throw new Error(`Badge-Text fehlt oder ist länger als ${NOTE_BADGE_MAX} Zeichen`);
    }
  } else if (customLabel !== undefined) {
    throw new Error('Badge-Text ist nur beim Typ "eigen" erlaubt');
  }
  const note: Note = {
    id, kind, text, position, zIndex: maxZ(s) + 1,
    ...(kind === 'eigen' ? { customLabel: customLabel!.trim() } : {}),
  };
  return { ...s, notes: [...(s.notes ?? []), note] };
}

/** To-do abhaken/aufheben — nur für kind 'todo' erlaubt. */
export function setNoteDone(s: DesktopState, id: string, done: boolean): DesktopState {
  return mapNote(s, id, (n) => {
    if (n.kind !== 'todo') throw new Error('Nur To-do-Zettel können abgehakt werden');
    return { ...n, done };
  });
}
```

- [ ] **Step 4: commands.ts erweitern**

`addNote`-Handler ersetzen und `setNoteDone` daneben einfügen (Import `setNoteDone` aus `./notes`):

```ts
  addNote: (s, p) => wrap(() => addNote(s, p.kind as NoteKind, text(p.text, 'text'), vec(p.position, 'position'), optId(p.id),
    p.customLabel === undefined ? undefined : text(p.customLabel, 'customLabel'))),
  setNoteDone: (s, p) => {
    if (typeof p.done !== 'boolean') throw new CommandError('Feld "done" muss true oder false sein');
    return wrap(() => setNoteDone(s, id(p.id, 'id'), p.done as boolean));
  },
```

- [ ] **Step 5: Tests grün + volle Suite**

Run: `npx vitest run packages/core/src/notes.test.ts && npx vitest run`
Expected: PASS, keine Regressionen.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/notes.ts packages/core/src/notes.test.ts packages/core/src/commands.ts
git commit -m "feat: Gedankenobjekte komplett — 12 Zettel-Typen, Freitext-Badge, To-do abhakbar (Core)"
```

---

### Task 2: Client — Zettel-UI (Labels, Farben, To-do-Kreis, Typwahl)

**Files:**
- Modify: `src/lib/menus.ts` (`NOTE_KIND_LABELS`, Zeile ~7)
- Modify: `src/lib/ui.svelte.ts` (`ui.menu`-Typ)
- Modify: `src/lib/components/ContextMenu.svelte`
- Modify: `src/lib/components/NoteCard.svelte`
- Modify: `src/lib/components/Desktop.svelte` (`zettelTypAuswahl`, Zeile ~139)

**Interfaces:**
- Consumes: `NOTE_KINDS`, `NOTE_BADGE_MAX`, `Note.customLabel`/`done`, Commands `addNote`/`setNoteDone` aus Task 1.
- Produces: `ui.menu` erweitert um `columns?: number` und `input?: { placeholder: string; onSubmit: (text: string) => void }` — Task-übergreifend wiederverwendbar.

- [ ] **Step 1: Labels ergänzen (menus.ts)**

```ts
export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  notiz: 'Notiz', frage: 'Frage', these: 'These', angriffspunkt: 'Angriffspunkt', risiko: 'Risiko',
  behauptung: 'Behauptung', beweisziel: 'Beweisziel', idee: 'Idee', todo: 'To-do',
  argument: 'Argument', rechtsfrage: 'Rechtsfrage', eigen: 'Eigener',
};
```

(Bestehende fünf Labels beibehalten, falls Wortlaut abweicht — nur ergänzen.)

- [ ] **Step 2: ui.menu erweitern (ui.svelte.ts)**

```ts
export interface MenuInput {
  placeholder: string;
  onSubmit: (text: string) => void;
}
```

Im `$state`: `menu: null as { x: number; y: number; items: MenuItem[]; columns?: number; input?: MenuInput } | null,`

- [ ] **Step 3: ContextMenu.svelte — Eingabefeld + zwei Spalten**

Menu-Markup ersetzen:

```svelte
  <div class="menu" class:zweispaltig={ui.menu.columns === 2} role="menu" style:left="{ui.menu.x}px" style:top="{ui.menu.y}px">
    {#if ui.menu.input}
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus maxlength="24" placeholder={ui.menu.input.placeholder}
             onpointerdown={(e) => e.stopPropagation()}
             onkeydown={(e) => {
               e.stopPropagation();
               if (e.key === 'Enter') {
                 const wert = e.currentTarget.value.trim();
                 if (wert && ui.menu?.input) { ui.menu.input.onSubmit(wert); ui.menu = null; }
               }
               if (e.key === 'Escape') ui.menu = null;
             }} />
    {/if}
    {#each ui.menu.items as item (item.label)}
      <button onpointerdown={(e) => e.stopPropagation()} onclick={() => { if (Date.now() - openedAt < 300) return; item.action(); ui.menu = null; }}>
        {item.label}
      </button>
    {/each}
  </div>
```

CSS ergänzen:

```css
  .menu.zweispaltig { display: grid; grid-template-columns: 1fr 1fr; }
  .menu input { margin: 4px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; grid-column: 1 / -1; }
```

- [ ] **Step 4: Desktop.svelte — Typwahl zweispaltig + „Eigener…"**

`zettelTypAuswahl` ersetzen (Import `NOTE_BADGE_MAX` nicht nötig — maxlength macht das Feld):

```ts
  /** Zettel anlegen (Bildschirmmitte) und sofort in den Bearbeiten-Modus gehen. */
  function zettelAnlegen(kind: NoteKind, customLabel?: string): void {
    const center = screenToWorld(vp, { x: el.clientWidth / 2, y: el.clientHeight / 2 });
    const id = uid();
    void desktop
      .command('addNote', {
        kind, text: '', position: { x: center.x - NOTE_W / 2, y: center.y - NOTE_H / 2 }, id,
        ...(customLabel !== undefined ? { customLabel } : {}),
      })
      .then(() => (ui.editingNoteId = id));
  }

  /** Zettel-Typ wählen (zweispaltig); „Eigener…" fragt das Badge im Menü ab. */
  function zettelTypAuswahl(x: number, y: number): void {
    ui.menu = {
      x, y, columns: 2,
      items: NOTE_KINDS.map((kind: NoteKind) => ({
        label: kind === 'eigen' ? 'Eigener…' : NOTE_KIND_LABELS[kind],
        action: kind === 'eigen'
          ? () => queueMicrotask(() => {
              ui.menu = { x, y, items: [], input: { placeholder: 'Bezeichnung (z. B. Zeugenfrage)', onSubmit: (t) => zettelAnlegen('eigen', t) } };
            })
          : () => zettelAnlegen(kind),
      })),
    };
  }
```

- [ ] **Step 5: NoteCard.svelte — Farben, Badge, To-do-Kreis**

Badge-Block ersetzen (nach den `tape`/`klammer`-Zeilen):

```svelte
  {#if note.kind !== 'notiz'}
    <div class="kopf">
      {#if note.kind === 'todo'}
        <button class="haken" aria-pressed={note.done === true}
                aria-label={note.done ? 'Abhaken aufheben' : 'Als erledigt abhaken'}
                onpointerdown={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
                onclick={() => void desktop.command('setNoteDone', { id: note.id, done: !(note.done === true) })}>
          {note.done ? '✓' : ''}
        </button>
      {/if}
      {#if note.kind !== 'notiz'}
        <div class="badge">{note.kind === 'eigen' ? (note.customLabel ?? 'Eigener') : NOTE_KIND_LABELS[note.kind]}</div>
      {/if}
    </div>
  {/if}
```

Auf dem Wurzel-`div` zusätzlich `class:erledigt={note.done === true}`. CSS ergänzen/ersetzen:

```css
  .note.kind-behauptung { background: #e8d5b5; }
  .note.kind-beweisziel { background: #b8ded6; }
  .note.kind-idee { background: #f8cfe0; }
  .note.kind-todo { background: #e8e8e4; }
  .note.kind-argument { background: #c5ebe6; }
  .note.kind-rechtsfrage { background: #ddd0f0; }
  .note.kind-eigen { background: #f3ecd8; }
  .note.erledigt { opacity: .65; }
  .note.erledigt .text { text-decoration: line-through; }
  .kopf { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .kopf .badge { margin-bottom: 0; }
  .haken { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid rgba(0, 0, 0, .45);
           background: rgba(255, 255, 255, .5); cursor: pointer; padding: 0; font-size: 12px;
           line-height: 1; color: #1d3557; flex: none; }
```

- [ ] **Step 6: Prüfen + Commit**

Run: `npx vitest run && npm run check && npm run build`
Expected: alles grün, 0 Errors/Warnings.

```bash
git add src/lib/menus.ts src/lib/ui.svelte.ts src/lib/components/ContextMenu.svelte src/lib/components/NoteCard.svelte src/lib/components/Desktop.svelte
git commit -m "feat: Zettel-UI — 12 Typen zweispaltig, Freitext-Badge, To-do-Abhaken"
```

---

### Task 3: Core — Schredder (TDD)

**Files:**
- Modify: `packages/core/src/trash.ts`
- Modify: `packages/core/src/commands.ts` (neben `restoreObject`, Zeile ~116)
- Test: `packages/core/src/trash.test.ts` (erweitern)

**Interfaces:**
- Produces: `shredTrashItem(s, trashId)`, Command `shredTrashItem` (payload `{ trashId }`). Task 4 nutzt das Command.

- [ ] **Step 1: Failing Tests**

In `packages/core/src/trash.test.ts` ergänzen (Import `shredTrashItem`):

```ts
describe('shredTrashItem', () => {
  it('entfernt genau einen Eintrag endgültig — Wiederherstellen danach unmöglich', () => {
    let s = trashObject(mitDoc(), 'd1', '2026-07-19T10:00:00Z', 't1');
    s = addNote(s, 'notiz', 'bleibt', { x: 0, y: 0 }, 'n1');
    s = trashObject(s, 'n1', '2026-07-19T10:01:00Z', 't2');
    const nach = shredTrashItem(s, 't1');
    expect((nach.trash ?? []).map((t) => t.id)).toEqual(['t2']);
    expect(() => restoreObject(nach, 't1')).toThrow('nicht gefunden');
  });

  it('unbekannte trashId wird abgewiesen; Command-Weg funktioniert', () => {
    expect(() => shredTrashItem(emptyState(), 'nix')).toThrow('nicht gefunden');
    const s = trashObject(mitDoc(), 'd1', '2026-07-19T10:00:00Z', 't1');
    const nach = applyCommand(s, { type: 'shredTrashItem', payload: { trashId: 't1' } });
    expect(nach.trash ?? []).toEqual([]);
  });
});
```

(Helfer `mitDoc()`/Importe existieren in der Datei bereits — bei Bedarf `addNote` aus `./notes` importieren.)

- [ ] **Step 2: Fehlschlag zeigen**

Run: `npx vitest run packages/core/src/trash.test.ts` → FAIL (`shredTrashItem` fehlt).

- [ ] **Step 3: Implementieren**

In `trash.ts` nach `emptyTrash`:

```ts
/** Schredder: entfernt genau einen Korb-Eintrag endgültig (kein Wiederherstellen mehr). */
export function shredTrashItem(s: DesktopState, trashId: string): DesktopState {
  if (!(s.trash ?? []).some((t) => t.id === trashId)) throw new Error(`Korb-Eintrag "${trashId}" nicht gefunden`);
  return { ...s, trash: (s.trash ?? []).filter((t) => t.id !== trashId) };
}
```

In `commands.ts` (Import erweitern):

```ts
  shredTrashItem: (s, p) => wrap(() => shredTrashItem(s, id(p.trashId, 'trashId'))),
```

- [ ] **Step 4: Grün + Suite + Commit**

Run: `npx vitest run packages/core/src/trash.test.ts && npx vitest run` → PASS.

```bash
git add packages/core/src/trash.ts packages/core/src/trash.test.ts packages/core/src/commands.ts
git commit -m "feat: Schredder im Core — einzelner Korb-Eintrag endgültig (shredTrashItem)"
```

---

### Task 4: Client — Schreddern-Knopf im Korb-Panel

**Files:**
- Modify: `src/lib/components/TrashCan.svelte`

**Interfaces:**
- Consumes: Command `shredTrashItem` aus Task 3; `desktop.mode` für den j-lawyer-Hinweis.

- [ ] **Step 1: Funktion + Knopf**

Im Script (neben `wiederherstellen`):

```ts
  function schreddern(t: { id: string; name: string }) {
    const jl = desktop.mode === 'jlawyer'
      ? ' In j-lawyer wird nichts gelöscht — das Dokument käme beim nächsten Abgleich als frische Karte zurück.'
      : '';
    if (!confirm(`„${t.name}" endgültig schreddern?${jl}`)) return;
    desktop.command('shredTrashItem', { trashId: t.id }).catch((e) => showToast(e instanceof Error ? e.message : 'Schreddern fehlgeschlagen'));
  }
```

Im Eintrag-Markup nach dem „Wiederherstellen"-Button:

```svelte
            <button class="schreddern" onclick={() => schreddern(t)}>Schreddern…</button>
```

Grid der Liste anpassen: `li { grid-template-columns: auto 1fr auto auto auto; … }` und CSS ergänzen:

```css
  li button.schreddern { background: rgba(192, 57, 43, .35); }
  li button.schreddern:hover { background: rgba(192, 57, 43, .55); }
```

- [ ] **Step 2: Prüfen + Commit**

Run: `npx vitest run && npm run check && npm run build` → grün.

```bash
git add src/lib/components/TrashCan.svelte
git commit -m "feat: Schreddern-Knopf im Korb-Panel — einzelner Eintrag endgültig, mit Bestätigung"
```

---

### Task 5: MCP — Werkzeugkasten lesen (get_desk, TDD)

**Files:**
- Modify: `packages/mcp/src/deskApi.ts` (Typen, Zeile 33–40)
- Modify: `packages/mcp/src/server.ts` (`get_desk`, Zeile 49–71)
- Test: `packages/mcp/src/tools-read.test.ts` (erweitern)

**Interfaces:**
- Consumes: Zustands-Felder `stamps`/`flags`/`marks`/`clips`/`trash`/`stacks[].stapled`/`*.taped`/`notes[].customLabel|done` (Serverseite liefert sie generisch im State durch).
- Produces: erweitertes `get_desk`-Ergebnis `{ name, docs, stacks, links, notes, cutouts, stamps, flags, markCounts, clips, trash }` — Task 6 und die Doku bauen darauf.

- [ ] **Step 1: deskApi-Typen erweitern**

```ts
export interface Note { id: string; kind: string; text: string; position: { x: number; y: number }; zIndex: number; customLabel?: string; done?: boolean; taped?: boolean }
export interface Stamp { id: string; docId: string; page: number; text: string; color: string; date?: string }
export interface Flag { id: string; docId: string; page: number; offset: number; color: string }
export interface Mark { id: string; docId: string; kind: string }
export interface Clip { id: string; memberIds: string[] }
export interface TrashedItem { id: string; kind: string; name: string; trashedAt: string }
```

`Doc`/`Cutout` um `taped?: boolean`, `Stack` um `stapled?: boolean; taped?: boolean` ergänzen. `DeskState.state` um `stamps?: Stamp[]; flags?: Flag[]; marks?: Mark[]; clips?: Clip[]; trash?: TrashedItem[]` erweitern.

- [ ] **Step 2: Failing Tests**

In `packages/mcp/src/tools-read.test.ts` einen Test ergänzen, der über den bestehenden Test-Harness (`testServer.ts`-Muster der Datei) einen Desk-State mit je einem Stempel (`text: 'Fristsache Müller'`), einer Fahne, einer Tipp-Ex- und einer Schwärzungs-Mark, einer Klammer, einem gehefteten Stapel, einem Korb-Eintrag (`name: 'Rechnung Meier'`) und einem eigen-Zettel (`customLabel: 'Zeugenfrage'`, dazu ein `todo` mit `done: true`) hinterlegt und prüft:

```ts
    const r = ergebnisVon(get_desk);           // Aufruf-Muster der Datei übernehmen
    expect(r.stamps).toHaveLength(1);
    expect(r.stamps[0].text).not.toContain('Müller');          // anonymisiert
    expect(r.flags[0]).toMatchObject({ page: expect.any(Number), color: expect.any(String) });
    expect(r.markCounts).toEqual({ d1: { tippex: 1, redact: 1 } });
    expect(r.clips[0].memberIds.length).toBeGreaterThan(1);
    expect(r.stacks[0].stapled).toBe(true);
    expect(r.trash[0].name).not.toContain('Meier');            // anonymisiert
    expect(r.notes.find((n) => n.kind === 'eigen')?.customLabel).not.toContain('Zeugenfrage');
    expect(r.notes.find((n) => n.kind === 'todo')?.done).toBe(true);
```

Der Test nutzt den Fake-Anonymisierer des Harness (liefert erkennbar veränderte Namen) — exakte Assertions an dessen Muster anpassen (z. B. `toBe('[ANON:…]')`, wie die bestehenden Tests es tun).

Run: `npx vitest run packages/mcp/src/tools-read.test.ts` → FAIL.

- [ ] **Step 3: get_desk erweitern (server.ts)**

Den Tool-Body ersetzen — Anonymisierungs-Batch in EXAKT dieser Reihenfolge erweitern (Indexrechnung!):

```ts
    const notesRoh = s.state.notes ?? [];
    const stampsRoh = s.state.stamps ?? [];
    const trashRoh = s.state.trash ?? [];
    const eigenNotes = notesRoh.filter((n) => n.kind === 'eigen');
    const texte = [
      info.name,
      ...s.state.docs.map((d) => d.name),
      ...s.state.stacks.map((st) => st.name),
      ...s.state.links.map((l) => l.note),
      ...notesRoh.map((n) => n.text),
      ...stampsRoh.map((st) => st.text),
      ...trashRoh.map((t) => t.name),
      ...eigenNotes.map((n) => n.customLabel ?? ''),
    ];
    const anon = await anonymizer.anonNames(texte);
    let i = 0;
    const name = anon[i++];
    const docs = s.state.docs.map((d) => ({ id: d.id, name: anon[i++], position: d.position, kind: d.kind ?? 'pdf', ...(d.taped ? { taped: true } : {}) }));
    const stacks = s.state.stacks.map((st) => ({ id: st.id, name: anon[i++], docIds: st.docIds, position: st.position, stapled: st.stapled === true }));
    const links = s.state.links.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, note: anon[i++] }));
    const noteTexte = notesRoh.map(() => anon[i++]);
    const stamps = stampsRoh.map((st) => ({ id: st.id, docId: st.docId, page: st.page, text: anon[i++], color: st.color, ...(st.date ? { date: st.date } : {}) }));
    const trash = trashRoh.map((t) => ({ id: t.id, kind: t.kind, name: anon[i++], trashedAt: t.trashedAt }));
    const eigenAnon = new Map(eigenNotes.map((n) => [n.id, anon[i++]] as const));
    const notes = notesRoh.map((n, idx) => ({
      id: n.id, kind: n.kind, text: noteTexte[idx], position: n.position,
      ...(n.kind === 'eigen' ? { customLabel: eigenAnon.get(n.id) } : {}),
      ...(n.kind === 'todo' ? { done: n.done === true } : {}),
      ...(n.taped ? { taped: true } : {}),
    }));
    const cutouts = (s.state.cutouts ?? []).map((c) => ({ id: c.id, page: c.page, position: c.position }));
    const flags = (s.state.flags ?? []).map((f) => ({ id: f.id, docId: f.docId, page: f.page, color: f.color }));
    const markCounts: Record<string, { tippex: number; redact: number }> = {};
    for (const m of s.state.marks ?? []) {
      const eintrag = (markCounts[m.docId] ??= { tippex: 0, redact: 0 });
      if (m.kind === 'tippex') eintrag.tippex++; else eintrag.redact++;
    }
    const clips = (s.state.clips ?? []).map((c) => ({ id: c.id, memberIds: c.memberIds }));
    return { name, docs, stacks, links, notes, cutouts, stamps, flags, markCounts, clips, trash };
```

Tool-Beschreibung anpassen: `'Liefert den kompletten Schreibtisch: Karten, Stapel (inkl. Konvolut-Status), Verknüpfungen, Zettel, Ausschnitte, Stempel, Fahnen, Tipp-Ex/Schwärzungs-Zähler, Klammern und Papierkorb (Texte anonymisiert).'`

- [ ] **Step 4: Grün + Suite + Commit**

Run: `npx vitest run packages/mcp/src/tools-read.test.ts && npx vitest run` → PASS.

```bash
git add packages/mcp/src/deskApi.ts packages/mcp/src/server.ts packages/mcp/src/tools-read.test.ts
git commit -m "feat: MCP liest den Werkzeugkasten — Stempel, Fahnen, Marks-Zähler, Klammern, Konvolute, Korb"
```

---

### Task 6: MCP — gefahrlose Schreib-Tools (TDD)

**Files:**
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/src/tools-write.test.ts` (erweitern)

**Interfaces:**
- Consumes: `cmd()`-Helfer, `deanon()`, Commands `addStamp`/`removeStamp`/`addFlag`/`removeFlag`/`stapleStack`/`unstapleStack`/`addClip`/`removeClip`/`trashObject`/`restoreObject`/`setNoteDone`; Core-Regeln: Stamp braucht `x/y/angle/baseW/baseH/color/text` (max. 40), Flag braucht `offset` 0..1 und Farbe aus `FLAG_COLORS` (`#f5c518` gelb, `#e5484d` rot, `#3b82f6` blau, `#30a46c` grün).
- Produces: 11 neue Tools; `add_note`-Enum erweitert.

- [ ] **Step 1: Failing Tests**

In `packages/mcp/src/tools-write.test.ts` je Tool einen Happy-Path (Command kommt mit korrektem type/payload am Fake-Server an) und für `add_stamp` zusätzlich: Freitext wird deanonymisiert, Auto-Position liegt im rechten oberen Bereich (`x > baseW / 2 && y < baseH / 4`), Preset `EINGANG` trägt ein `date`. Für `add_note`: kind `'rechtsfrage'` wird akzeptiert, `'eigen'` verlangt `customLabel`. Muster und Harness der Datei übernehmen.

Run: `npx vitest run packages/mcp/src/tools-write.test.ts` → FAIL.

- [ ] **Step 2: Tools registrieren (server.ts)**

`add_note`-Enum ersetzen durch die 12 Typen und `customLabel` ergänzen:

```ts
    { deskId: z.string(), kind: z.enum(['notiz', 'frage', 'these', 'angriffspunkt', 'risiko', 'behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen']),
      text: z.string(), x: z.number(), y: z.number(), customLabel: z.string().optional() },
    async (a) => {
      const id = randomUUID();
      await cmd(a.deskId, 'addNote', {
        kind: a.kind, text: deanon(String(a.text)), position: { x: a.x, y: a.y }, id,
        ...(a.customLabel !== undefined ? { customLabel: deanon(String(a.customLabel)) } : {}),
      });
      return { ok: true, id };
    });
```

Neue Tools (nach `remove_note` einfügen; `STAMP_BASE = { baseW: 595, baseH: 842 }` — A4-Basis, das Overlay skaliert über baseW/baseH, bei abweichenden Seitengrößen sitzt der Stempel nur näherungsweise oben rechts):

```ts
  const FLAG_FARBEN: Record<string, string> = { gelb: '#f5c518', rot: '#e5484d', blau: '#3b82f6', gruen: '#30a46c' };
  const STAMP_PRESETS: Record<string, { color: 'red' | 'blue'; withDate?: boolean }> = {
    ERLEDIGT: { color: 'red' }, WICHTIG: { color: 'red' }, 'FRIST!': { color: 'red' },
    GEPRÜFT: { color: 'blue' }, EINGANG: { color: 'blue', withDate: true }, ENTWURF: { color: 'blue' }, KOPIE: { color: 'blue' },
  };

  tool(server, 'add_stamp',
    'Stempelt eine Dokumentseite: preset (ERLEDIGT/WICHTIG/FRIST!/GEPRÜFT/EINGANG/ENTWURF/KOPIE) ODER freeText (Platzhalter werden übersetzt). Position automatisch oben rechts.',
    { deskId: z.string(), docId: z.string(), page: z.number(), preset: z.string().optional(), freeText: z.string().optional() },
    async (a) => {
      const id = randomUUID();
      const preset = a.preset === undefined ? undefined : STAMP_PRESETS[String(a.preset)];
      if (a.preset !== undefined && !preset) throw new Error(`Unbekanntes Preset: ${String(a.preset)}`);
      if (!preset && a.freeText === undefined) throw new Error('preset oder freeText angeben');
      const text = preset ? String(a.preset) : deanon(String(a.freeText));
      await cmd(a.deskId, 'addStamp', { stamp: {
        id, docId: a.docId, page: a.page, x: 595 - 130, y: 70,
        angle: (id.charCodeAt(0) % 13) - 6, text, color: preset?.color ?? 'blue',
        ...(preset?.withDate ? { date: new Date().toISOString().slice(0, 10) } : {}),
        baseW: 595, baseH: 842,
      } });
      return { ok: true, id };
    });

  tool(server, 'remove_stamp', 'Entfernt einen Stempelabdruck.', { deskId: z.string(), stampId: z.string() },
    (a) => cmd(a.deskId, 'removeStamp', { stampId: a.stampId }));

  tool(server, 'add_flag', 'Setzt eine Notizfahne (gelb/rot/blau/gruen) an den Seitenrand — Klick springt zur Seite.',
    { deskId: z.string(), docId: z.string(), page: z.number(), color: z.enum(['gelb', 'rot', 'blau', 'gruen']) },
    async (a) => {
      const id = randomUUID();
      const s = await desk.getState(base, token, String(a.deskId));
      const vorhandene = (s.state.flags ?? []).filter((f) => f.docId === a.docId).length;
      await cmd(a.deskId, 'addFlag', { flag: { id, docId: a.docId, page: a.page, offset: Math.min(0.9, 0.08 + vorhandene * 0.18), color: FLAG_FARBEN[String(a.color)] } });
      return { ok: true, id };
    });

  tool(server, 'remove_flag', 'Entfernt eine Notizfahne.', { deskId: z.string(), flagId: z.string() },
    (a) => cmd(a.deskId, 'removeFlag', { flagId: a.flagId }));

  tool(server, 'staple_stack', 'Heftet einen Stapel zum Konvolut (blättert dann als Ganzes).', { deskId: z.string(), stackId: z.string() },
    (a) => cmd(a.deskId, 'stapleStack', { stackId: a.stackId }));

  tool(server, 'unstaple_stack', 'Entheftet ein Konvolut wieder zum losen Stapel.', { deskId: z.string(), stackId: z.string() },
    (a) => cmd(a.deskId, 'unstapleStack', { stackId: a.stackId }));

  tool(server, 'clip_objects', 'Klammert zwei Objekte zusammen (gemeinsames Verschieben).', { deskId: z.string(), aId: z.string(), bId: z.string() },
    (a) => cmd(a.deskId, 'addClip', { aId: a.aId, bId: a.bId, id: randomUUID() }));

  tool(server, 'remove_clip', 'Löst eine Büroklammer-Gruppe.', { deskId: z.string(), clipId: z.string() },
    (a) => cmd(a.deskId, 'removeClip', { clipId: a.clipId }));

  tool(server, 'trash_object', 'Legt ein Objekt in den Papierkorb (wiederherstellbar — NICHT endgültig).', { deskId: z.string(), objectId: z.string() },
    (a) => cmd(a.deskId, 'trashObject', { id: a.objectId, trashedAt: new Date().toISOString() }));

  tool(server, 'restore_trash', 'Holt einen Korb-Eintrag zurück auf den Tisch.', { deskId: z.string(), trashId: z.string() },
    (a) => cmd(a.deskId, 'restoreObject', { trashId: a.trashId }));

  tool(server, 'set_note_done', 'Hakt einen To-do-Zettel ab oder hebt das Abhaken auf.', { deskId: z.string(), noteId: z.string(), done: z.boolean() },
    (a) => cmd(a.deskId, 'setNoteDone', { id: a.noteId, done: a.done }));
```

Bewusst NICHT registrieren: `empty_trash`, `shred`, marks- oder tape-Tools (Spec).

- [ ] **Step 3: Grün + Suite + Commit**

Run: `npx vitest run packages/mcp/src/tools-write.test.ts && npx vitest run` → PASS.

```bash
git add packages/mcp/src/server.ts packages/mcp/src/tools-write.test.ts
git commit -m "feat: MCP-Schreib-Tools — Stempel, Fahnen, Heften, Klammern, Korb (reversibel), To-do"
```

---

### Task 7: UAT-Sammelliste — Block A12 + C′-Erweiterung

**Files:**
- Modify: `docs/uat/2026-07-18-uat-sammelliste.md`

- [ ] **Step 1: Zählung**

Kopfzeile: `**118 Punkte** … (A mit 95` → `**126 Punkte** … (A mit 100`; `C′ mit 9` → `C′ mit 12`. Block-A-Überschrift `95 Punkte` → `100 Punkte`; C′-Überschrift `9 Prüfungen` → `12 Prüfungen`.

- [ ] **Step 2: Block A12 nach A11 einfügen**

```markdown
### A12 — Quickwin-Runde: Gedankenobjekte komplett & Schredder (NEU)

- [ ] A12.1 „＋ Zettel": Typwahl ist zweispaltig mit 12 Typen; die 6 neuen Farben/Badges (Behauptung sand, Beweisziel petrol, Idee rosa, To-do grau, Argument türkis, Rechtsfrage violett) gefallen?
- [ ] A12.2 „Eigener…": Bezeichnung eingeben (z. B. „Zeugenfrage") → Zettel trägt das eigene Badge; Reload erhält es.
- [ ] A12.3 To-do: Abhak-Kreis anklicken/antippen → Haken, Text durchgestrichen, Zettel gedimmt; Zweitfenster folgt live; erneuter Klick hebt es auf; Abhaken löst kein Ziehen/Bearbeiten aus.
- [ ] A12.4 Korb-Panel: „Schreddern…" bei einem Eintrag → Bestätigungsdialog, Eintrag verschwindet endgültig (kein Wiederherstellen); andere Einträge bleiben.
- [ ] A12.5 j-lawyer-Modus: Schreddern-Dialog erklärt den Abgleich (Dokument kommt als frische Karte zurück); Verhalten stimmt.
```

- [ ] **Step 3: C′-Block um drei Punkte ergänzen (nach C′.9)**

```markdown
- [ ] C′.10 **Werkzeugkasten lesen (NEU):** „Was liegt auf dem Tisch?" → Antwort nennt Stempel, Fahnen, Konvolute, Klammern und Korb-Inhalt (Freitexte anonymisiert; `deanonymize` liefert Klartext).
- [ ] C′.11 **Werkzeugkasten schreiben (NEU):** „Stemple EINGANG auf Seite 1 von X", „setze eine rote Fahne auf Seite 3", „hefte den Stapel" → alles erscheint live in der UI; Stempel sitzt oben rechts und trägt das Tagesdatum.
- [ ] C′.12 **Reversibel & Grenzen (NEU):** „Lege X in den Papierkorb" + „hole es zurück" funktionieren; „leere den Papierkorb" wird von der KI mangels Tool NICHT ausgeführt.
```

- [ ] **Step 4: Commit**

```bash
git add docs/uat/2026-07-18-uat-sammelliste.md
git commit -m "docs: UAT A12 Quickwin-Runde (5 Punkte) + C′-Werkzeugkasten (3 Punkte), Zählung 126 aktiv"
```

---

### Task 8: End-to-End-Sichtprüfung

**Files:** keine (Verifikation). MCP-Teil ist durch die Testsuiten abgedeckt; hier nur die UI.

- [ ] **Step 1: App anfahren (Projekt-Skill `verify`) und prüfen**

1. „＋ Zettel" → zweispaltige Typwahl, alle 12 Einträge sichtbar.
2. Rechtsfrage-Zettel anlegen → violett mit Badge „Rechtsfrage".
3. „Eigener…" → Eingabefeld, „Zeugenfrage" eingeben → Zettel mit Badge „Zeugenfrage".
4. To-do-Zettel: Abhak-Kreis klicken → ✓, durchgestrichen, gedimmt; Reload erhält den Zustand; erneut klicken → aufgehoben.
5. Karte in den Korb ziehen, Panel öffnen → „Schreddern…" → confirm → Eintrag weg, Badge zählt runter; ein zweiter Eintrag bleibt wiederherstellbar.
6. Konsole ohne Fehler. Mindestens 2 Screenshots nach `.superpowers/sdd/` (z. B. `task-8-typwahl.png`, `task-8-todo-erledigt.png`).

- [ ] **Step 2: Befund festhalten**

Auffälligkeiten als `fix:`-Commits; sonst ist die Runde bereit für UAT A12/C′.
