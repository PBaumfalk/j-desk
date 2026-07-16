# Benutzerverwaltung & Teilen (Teilprojekt 3) — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mehrere Benutzerkonten (Admin + Einladungscodes), echte Rechteprüfung pro Schreibtisch und Teilen von Schreibtischen mit voll bearbeitenden Mitgliedern.

**Architecture:** Server zuerst: SQLite-Migration v1 (`is_admin`, `uploader_id`, `invites`), zentrale Guards (`requireDeskAccess`/`requireDeskOwner`/`requireAdmin`) + globaler Fastify-Error-Handler, neue Module `guards.ts`/`users.ts`/`invites.ts`, Broadcast-Registry mit userId und Close-Codes 4001/4003. Danach Client: API-Erweiterung, Store-Recovery (Close-Codes, 403, 401→Login), Konto-Menü, Admin-Dialog, Teilen-Dialog, Einladungs-Modus in der Login-Maske.

**Tech Stack:** Fastify + better-sqlite3 + argon2 (Server), Svelte 5 Runes + Tauri-Plugins (Client), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-benutzer-teilen-design.md` — bei Widerspruch gilt die Spec.
- Alle UI-Texte und Fehlermeldungen deutsch; Client-Fehler als Toasts (`showToast`); Offline-Guard-Muster wie im Bestand (`status !== 'online'` → Toast „Offline — Aktion nicht möglich").
- Kein `window.prompt`/`window.confirm`/`window.alert` (blockiert die Webview) — Eingaben in Menüs/Dialog-Komponenten, Bestätigungen via `ask()` aus `@tauri-apps/plugin-dialog`.
- `DeskInfo` existiert doppelt (`packages/server/src/deskStore.ts` und `src/lib/api.ts`) — beide Definitionen synchron halten: `{ id, name, ownerId, ownerName, isOwner }`.
- Rechteprüfung NUR über die Guards aus `guards.ts` am Routen-Anfang, keine verstreuten Einzelprüfungen. Fehlerabbildung über den globalen Error-Handler (Task 2), neue Routen brauchen KEIN eigenes try/catch für bekannte Fehlerklassen.
- Gates pro Task: `npm test` alle grün (Sollzahlen stehen je Task; maßgeblich ist „alle grün") und bei Client-Tasks `npx svelte-check 2>&1 | tail -3` (0 neue Errors; bekannter pre-existing Error in vite.config.js „Unused @ts-expect-error" bleibt).
- Baseline vor Task 1: 84 Tests grün.
- Jeder Commit endet mit `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Arbeitsbranch: `feature/benutzer-teilen` (Task 1 legt ihn an).

---

### Task 1: Migration v1 (Schema) & createUser mit Admin-Flag

**Files:**
- Modify: `packages/server/src/db.ts`, `packages/server/src/db.test.ts`, `packages/server/src/auth.ts`, `packages/server/src/auth.test.ts`, `packages/server/src/app.ts` (nur Setup-Route), `packages/server/src/testUtils.ts`

**Interfaces:**
- Produces: Tabellen-Spalten `users.is_admin` (0/1), `files.uploader_id` (TEXT NULL, FK users ON DELETE SET NULL), Tabelle `invites (token PK, created_by FK users CASCADE, desk_id FK desks CASCADE NULL, created_at, expires_at)`; `createUser(db, username, password, isAdmin = false): Promise<string>` (wirft `AuthError` auch bei vergebenem Benutzernamen); `createSession(db, userId): string` (aus `login` extrahiert); `addUser(db, username): Promise<{ userId, token, authHeaders }>` in testUtils.

- [ ] **Step 0: Branch anlegen**

```bash
git checkout -b feature/benutzer-teilen
```

- [ ] **Step 1: Failing Tests schreiben**

In `packages/server/src/db.test.ts` ergänzen (Imports oben erweitern um `createUser` aus `./auth` falls nötig — die Tests arbeiten direkt mit SQL, kein auth-Import nötig):

```ts
describe('Migration v1', () => {
  it('frische DB steht auf user_version 1 und hat die invites-Tabelle mit FKs', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'p', 'h', 0);
    db.prepare('INSERT INTO invites (token, created_by, desk_id, created_at, expires_at) VALUES (?, ?, NULL, 0, 9)').run('t1', 'u1');
    db.prepare('DELETE FROM users WHERE id = ?').run('u1');
    expect(db.prepare('SELECT 1 FROM invites').get()).toBeUndefined(); // created_by CASCADE
  });
});
```

**Bestands-DB-Test:** Der End-zu-End-Beweis „v0-Datei → openDb → v1" braucht eine Datei-DB. Zusätzlich in `db.test.ts` (mit `mkdtempSync` aus `node:fs`, `tmpdir` aus `node:os`, `join` aus `node:path`, `Database` default-Import aus `better-sqlite3`):

```ts
  it('migriert eine echte v0-Datei-DB beim Öffnen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-mig-'));
    const path = join(dir, 'alt.sqlite');
    const alt = new Database(path);
    alt.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
      CREATE TABLE desks (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE desk_members (desk_id TEXT NOT NULL REFERENCES desks(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (desk_id, user_id));
      CREATE TABLE files (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users VALUES ('u1', 'patrick', 'h', 0);
      INSERT INTO files VALUES ('f1', 's', 'a.pdf', 1, 0);
    `);
    alt.close();
    const db = openDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect((db.prepare('SELECT is_admin AS a FROM users').get() as { a: number }).a).toBe(1);
    expect((db.prepare('SELECT uploader_id AS u FROM files').get() as { u: string }).u).toBe('u1');
    db.close();
  });
```

In `packages/server/src/auth.test.ts` ergänzen:

```ts
  it('verweigert doppelten Benutzernamen', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'patrick', 'geheim-genug');
    await expect(createUser(db, 'patrick', 'anderes-passwort')).rejects.toThrow(AuthError);
  });

  it('setzt das Admin-Flag, wenn isAdmin übergeben wird', async () => {
    const db = openDb(':memory:');
    await createUser(db, 'chef', 'geheim-genug', true);
    await createUser(db, 'normal', 'geheim-genug');
    expect((db.prepare("SELECT is_admin AS a FROM users WHERE username = 'chef'").get() as { a: number }).a).toBe(1);
    expect((db.prepare("SELECT is_admin AS a FROM users WHERE username = 'normal'").get() as { a: number }).a).toBe(0);
  });
```

Run: `npm test` → Expected: FAIL (user_version 0, `is_admin` existiert nicht).

- [ ] **Step 2: Migration in db.ts implementieren**

`packages/server/src/db.ts` — nach dem bestehenden `db.exec(...)`-Block in `openDb` einen Aufruf `migrate(db);` vor `return db;` einfügen und am Dateiende ergänzen:

```ts
/** Hebt das Schema schrittweise an; user_version markiert den Stand. */
function migrate(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE files ADD COLUMN uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL;
        CREATE TABLE invites (
          token TEXT PRIMARY KEY,
          created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          desk_id TEXT REFERENCES desks(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        UPDATE users SET is_admin = 1;
        UPDATE files SET uploader_id = (SELECT id FROM users ORDER BY created_at LIMIT 1);
      `);
      db.pragma('user_version = 1');
    })();
  }
}
```

(Frische DBs durchlaufen dieselbe Migration; die UPDATEs sind dort No-Ops. Das Setup-Konto wird ab jetzt explizit als Admin angelegt — Step 3.)

- [ ] **Step 3: auth.ts — isAdmin, Duplikat-Check, createSession**

`packages/server/src/auth.ts` — `createUser` ersetzen durch:

```ts
export async function createUser(db: Db, username: string, password: string, isAdmin = false): Promise<string> {
  const name = username.trim();
  if (name === '') throw new AuthError('Benutzername darf nicht leer sein');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) {
    throw new AuthError('Benutzername bereits vergeben');
  }
  if (password.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const userId = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)').run(
    userId, name, hash, isAdmin ? 1 : 0, Date.now(),
  );
  return userId;
}
```

In `login` die Token-Erzeugung (die Zeilen `const token = randomBytes(32)...` bis zum `INSERT INTO sessions`-run) durch `return createSession(db, user.id);` ersetzen und neue Funktion ergänzen:

```ts
/** Legt eine Sitzung an und gibt das Token zurück (Login und Einladungs-Einlösung). */
export function createSession(db: Db, userId: string): string {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)').run(
    token, userId, Date.now(), Date.now(),
  );
  return token;
}
```

`packages/server/src/app.ts`, Setup-Route: `await createUser(db, String(username ?? ''), String(password ?? ''));` → `await createUser(db, String(username ?? ''), String(password ?? ''), true);`

`packages/server/src/testUtils.ts`: `await createUser(db, 'test', 'test-passwort');` → `await createUser(db, 'test', 'test-passwort', true);` (der Standard-Testbenutzer spiegelt das Setup-Konto = Admin). Zusätzlich am Dateiende:

```ts
/** Legt einen weiteren (Nicht-Admin-)Benutzer an und loggt ihn ein. */
export async function addUser(db: Db, username: string): Promise<{ userId: string; token: string; authHeaders: { authorization: string } }> {
  const userId = await createUser(db, username, 'test-passwort');
  const token = (await login(db, username, 'test-passwort'))!;
  return { userId, token, authHeaders: { authorization: `Bearer ${token}` } };
}
```

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` → PASS (88 erwartet: 84 + 4).

```bash
git add packages/server
git commit -m "feat: Schema-Migration v1 (is_admin, uploader_id, invites), createUser mit Admin-Flag" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Guards, Rechte auf Desk-/Datei-/WS-Routen, /auth/me

**Files:**
- Create: `packages/server/src/guards.ts`, `packages/server/src/access.test.ts`
- Modify: `packages/server/src/app.ts`, `packages/server/src/deskStore.ts`, `packages/server/src/files.ts`, `packages/server/src/deskStore.test.ts`, `packages/server/src/files.test.ts`, `packages/server/src/ws.test.ts`, `packages/server/src/app.test.ts` (nur falls Assertions auf DeskInfo-Form brechen)

**Interfaces:**
- Consumes: Task 1 (`is_admin`, `uploader_id`, `addUser` aus testUtils).
- Produces: `guards.ts` mit `ForbiddenError`, `requireDeskAccess(db, deskId, userId)`, `requireDeskOwner(db, deskId, userId)`, `requireAdmin(db, userId)`, `isAdminUser(db, userId): boolean`, `canReadFile(db, userId, fileId): boolean`; `listDesks(db, userId): DeskInfo[]` (gefiltert); `DeskInfo { id, name, ownerId, ownerName, isOwner }`; `storeFile(db, dataDir, bytes, originalName, uploaderId: string | null)`; globaler Error-Handler (ForbiddenError→403, DeskNotFoundError→404, AuthError/CommandError/InvalidStateError/FileError→400); Route `GET /api/v1/auth/me → { id, username, isAdmin }`; Helfer `userIdOf(req)` in app.ts; WS-Route schließt bei fehlendem Zugriff mit 4003 (bzw. 4001 wenn Desk fehlt).

- [ ] **Step 1: Failing Tests schreiben**

Neue Datei `packages/server/src/access.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { createTestApp, addUser } from './testUtils';
import { storeFile } from './files';

const pdf = (inhalt: string) => Buffer.from(`%PDF-1.4\n${inhalt}`);

describe('Rechteprüfung pro Schreibtisch', () => {
  it('GET /desks zeigt nur eigene und geteilte Schreibtische mit ownerName/isOwner', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const eigener = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Meiner' } })).json();
    const fremd = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const geteilt = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Geteilt' } })).json();
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(geteilt.id, me.id);

    const liste = (await app.inject({ method: 'GET', url: '/api/v1/desks', headers: authHeaders })).json();
    expect(liste.map((d: { id: string }) => d.id).sort()).toEqual([eigener.id, geteilt.id].sort());
    const eintragGeteilt = liste.find((d: { id: string }) => d.id === geteilt.id);
    expect(eintragGeteilt).toMatchObject({ ownerName: 'bob', isOwner: false });
    expect(liste.find((d: { id: string }) => d.id === eigener.id)).toMatchObject({ ownerName: 'test', isOwner: true });
    expect(liste.some((d: { id: string }) => d.id === fremd.id)).toBe(false);
  });

  it('Fremde erhalten 403 auf state/commands/put/rename/delete', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const leer = { docs: [], links: [], stacks: [] };
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: bob.authHeaders, payload: { type: 'bringToFront', payload: { id: 'x' } } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders, payload: leer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/desks/gibtsnicht/state', headers: bob.authHeaders })).statusCode).toBe(404);
  });

  it('Mitglied darf lesen und Kommandos senden, aber nicht umbenennen/löschen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: bob.authHeaders, payload: { type: 'bringToFront', payload: { id: 'x' } } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('GET /auth/me liefert Identität und Admin-Flag', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json()).toMatchObject({ username: 'test', isAdmin: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).json()).toMatchObject({ username: 'bob', isAdmin: false });
  });
});

describe('Datei-Zugriff', () => {
  it('Uploader ja, Desk-Mitglied ja, Fremder 403', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    const meta = storeFile(db, dataDir, pdf('eins'), 'a.pdf', me.id);
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    await app.inject({
      method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders,
      payload: { type: 'addDoc', payload: { fileId: meta.id, name: 'a.pdf', position: { x: 0, y: 0 }, id: 'doc-1' } },
    });
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);

    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: bob.authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${meta.id}`, headers: carol.authHeaders })).statusCode).toBe(403);
  });

  it('Dedup-Upload überschreibt den Uploader nicht', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    const a = storeFile(db, dataDir, pdf('gleich'), 'a.pdf', me.id);
    const b = storeFile(db, dataDir, pdf('gleich'), 'b.pdf', bob.userId);
    expect(b.id).toBe(a.id);
    expect((db.prepare('SELECT uploader_id AS u FROM files WHERE id = ?').get(a.id) as { u: string }).u).toBe(me.id);
  });
});

describe('WS-Zugriff', () => {
  it('Fremder wird beim Verbinden mit Code 4003 geschlossen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${desk.id}/ws?token=${bob.token}`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => resolve(-1));
    });
    expect(code).toBe(4003);
    await app.close();
  });
});
```

Run: `npm test` → Expected: FAIL (kein `/auth/me`, `storeFile` hat 4 Parameter, keine 403er).

- [ ] **Step 2: guards.ts anlegen**

```ts
import type { Db } from './db';
import { DeskNotFoundError } from './deskStore';

export class ForbiddenError extends Error {}

function deskOwnerId(db: Db, deskId: string): string {
  const row = db.prepare('SELECT owner_id AS ownerId FROM desks WHERE id = ?').get(deskId) as
    | { ownerId: string }
    | undefined;
  if (!row) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
  return row.ownerId;
}

function isMember(db: Db, deskId: string, userId: string): boolean {
  return db.prepare('SELECT 1 FROM desk_members WHERE desk_id = ? AND user_id = ?').get(deskId, userId) !== undefined;
}

/** Besitzer oder Mitglied — sonst ForbiddenError (bzw. DeskNotFoundError, wenn der Desk fehlt). */
export function requireDeskAccess(db: Db, deskId: string, userId: string): void {
  if (deskOwnerId(db, deskId) !== userId && !isMember(db, deskId, userId)) {
    throw new ForbiddenError('Kein Zugriff auf diesen Schreibtisch');
  }
}

export function requireDeskOwner(db: Db, deskId: string, userId: string): void {
  if (deskOwnerId(db, deskId) !== userId) throw new ForbiddenError('Nur der Besitzer darf das');
}

export function isAdminUser(db: Db, userId: string): boolean {
  const row = db.prepare('SELECT is_admin AS isAdmin FROM users WHERE id = ?').get(userId) as
    | { isAdmin: number }
    | undefined;
  return row?.isAdmin === 1;
}

export function requireAdmin(db: Db, userId: string): void {
  if (!isAdminUser(db, userId)) throw new ForbiddenError('Nur der Admin darf das');
}

/** Datei lesbar, wenn selbst hochgeladen oder in einem zugänglichen Schreibtisch referenziert. */
export function canReadFile(db: Db, userId: string, fileId: string): boolean {
  const row = db.prepare('SELECT uploader_id AS uploaderId FROM files WHERE id = ?').get(fileId) as
    | { uploaderId: string | null }
    | undefined;
  if (!row) return false;
  if (row.uploaderId === userId) return true;
  // LIKE als Vorfilter (fileId ist eine UUID), JSON-Parse als Beweis
  const kandidaten = db.prepare(
    `SELECT state FROM desks
     WHERE (owner_id = ? OR id IN (SELECT desk_id FROM desk_members WHERE user_id = ?)) AND state LIKE ?`,
  ).all(userId, userId, `%${fileId}%`) as { state: string }[];
  return kandidaten.some((k) =>
    (JSON.parse(k.state) as { docs: { fileId: string }[] }).docs.some((d) => d.fileId === fileId),
  );
}
```

- [ ] **Step 3: deskStore.ts & files.ts anpassen**

`packages/server/src/deskStore.ts` — `DeskInfo`, `createDesk`, `listDesks` ersetzen:

```ts
export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
}

export function createDesk(db: Db, ownerId: string, name: string): DeskInfo {
  const id = randomUUID();
  db.prepare('INSERT INTO desks (id, name, owner_id, state, rev, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(
    id, name, ownerId, JSON.stringify(emptyState()), Date.now(),
  );
  const ownerName = (db.prepare('SELECT username FROM users WHERE id = ?').get(ownerId) as { username: string }).username;
  return { id, name, ownerId, ownerName, isOwner: true };
}

/** Nur Schreibtische, die userId besitzt oder als Mitglied teilt. */
export function listDesks(db: Db, userId: string): DeskInfo[] {
  const rows = db.prepare(
    `SELECT d.id, d.name, d.owner_id AS ownerId, u.username AS ownerName, (d.owner_id = ?) AS isOwner
     FROM desks d JOIN users u ON u.id = d.owner_id
     WHERE d.owner_id = ? OR d.id IN (SELECT desk_id FROM desk_members WHERE user_id = ?)
     ORDER BY d.created_at`,
  ).all(userId, userId, userId) as (Omit<DeskInfo, 'isOwner'> & { isOwner: 0 | 1 })[];
  return rows.map((r) => ({ ...r, isOwner: r.isOwner === 1 }));
}
```

`packages/server/src/files.ts` — `storeFile` bekommt den Uploader (Signatur + INSERT ändern; Dedup-Rückgabe bleibt unverändert, der ursprüngliche Uploader bleibt bestehen):

```ts
export function storeFile(db: Db, dataDir: string, bytes: Buffer, originalName: string, uploaderId: string | null): FileMeta {
```

und der INSERT am Ende:

```ts
  db.prepare('INSERT INTO files (id, sha256, original_name, size, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, sha256, originalName, bytes.length, uploaderId, Date.now(),
  );
```

- [ ] **Step 4: app.ts — Error-Handler, userIdOf, Guards, /auth/me, WS-Check**

Imports in `packages/server/src/app.ts` erweitern:

```ts
import { AuthError, needsSetup, createUser, login, logout, validateToken } from './auth';
import { ForbiddenError, requireDeskAccess, requireDeskOwner, canReadFile } from './guards';
```

Nach `const app = Fastify();` und den `register`-Aufrufen den globalen Error-Handler setzen:

```ts
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.message });
    if (err instanceof DeskNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof AuthError || err instanceof CommandError || err instanceof InvalidStateError || err instanceof FileError) {
      return reply.code(400).send({ error: err.message });
    }
    return reply.send(err);
  });
```

Helfer über `buildApp` hinaus nutzbar in der Datei (unter `bearerToken`):

```ts
function userIdOf(req: FastifyRequest): string {
  return (req as FastifyRequest & { userId: string }).userId;
}
```

Routen umbauen (lokale try/catch-Blöcke für DeskNotFoundError/CommandError/InvalidStateError/FileError/AuthError entfallen — der Error-Handler übernimmt):

```ts
  app.get('/api/v1/auth/me', async (req) => {
    const row = db.prepare('SELECT id, username, is_admin AS isAdmin FROM users WHERE id = ?').get(userIdOf(req)) as
      { id: string; username: string; isAdmin: number };
    return { id: row.id, username: row.username, isAdmin: row.isAdmin === 1 };
  });

  app.get('/api/v1/desks', async (req) => listDesks(db, userIdOf(req)));

  app.patch('/api/v1/desks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskOwner(db, id, userIdOf(req));
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Feld "name" fehlt oder ist leer' });
    }
    renameDesk(db, id, name.trim());
    return { ok: true };
  });

  app.delete('/api/v1/desks/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireDeskOwner(db, id, userIdOf(req));
    deleteDesk(db, id);
    return { ok: true };
  });

  app.get('/api/v1/desks/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    const result = getDeskState(db, id);
    if (!result) return reply.code(404).send({ error: 'Schreibtisch nicht gefunden' });
    return result;
  });

  app.post('/api/v1/desks/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    const cmd = (req.body ?? {}) as Command;
    if (cmd.type === 'addDoc' && !fileExists(db, String((cmd.payload as { fileId?: unknown })?.fileId ?? ''))) {
      return reply.code(400).send({ error: 'Unbekannte fileId' });
    }
    const result = applyDeskCommand(db, id, cmd);
    broadcast(id, result);
    return result;
  });

  app.put('/api/v1/desks/:id/state', async (req) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    const result = putDeskState(db, id, req.body);
    broadcast(id, result);
    return result;
  });
```

Datei-Routen:

```ts
  app.post('/api/v1/files', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Keine Datei im Request' });
    const bytes = await part.toBuffer();
    const meta = storeFile(db, dataDir, bytes, part.filename, userIdOf(req));
    reply.code(201);
    return { fileId: meta.id, name: meta.originalName };
  });

  app.get('/api/v1/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = getFilePath(db, dataDir, id);
    if (!path) return reply.code(404).send({ error: 'Datei nicht gefunden' });
    if (!canReadFile(db, userIdOf(req), id)) return reply.code(403).send({ error: 'Kein Zugriff auf diese Datei' });
    reply.header('content-type', 'application/pdf');
    return readFileSync(path);
  });
```

WS-Route:

```ts
  app.get('/api/v1/desks/:id/ws', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    try {
      requireDeskAccess(db, id, userIdOf(req));
    } catch (e) {
      socket.close(e instanceof ForbiddenError ? 4003 : 4001, e instanceof ForbiddenError ? 'access-revoked' : 'desk-deleted');
      return;
    }
    register(id, socket);
    socket.on('close', () => unregister(id, socket));
  });
```

- [ ] **Step 5: Bestehende Tests anpassen**

- `packages/server/src/deskStore.test.ts`: `listDesks(db)` → `listDesks(db, 'u1')`; das erwartete Objekt in Zeile 18 wird zu `{ id: desk.id, name: 'Schreibtisch 1', ownerId: 'u1', ownerName: 'p', isOwner: true }`.
- `packages/server/src/files.test.ts`: alle `storeFile(db, dataDir, …)`-Aufrufe bekommen als fünften Parameter `null`.
- `packages/server/src/ws.test.ts` und `packages/server/src/app.test.ts`: `storeFile(...)`-Aufrufe ebenfalls mit fünftem Parameter `null`. Achtung im Datei-Download-Test von app.test.ts (falls vorhanden): mit `uploaderId null` und ohne Desk-Referenz liefert `GET /files/:id` jetzt 403 — solche Tests so anpassen, dass die Datei vorher per `addDoc` in einen Desk des Test-Users gelegt wird ODER der Upload über die API (`POST /files`) läuft, die den Uploader setzt.

Run: `npm test` → PASS (95 erwartet: 88 + 7; Bestands-Assertions angepasst, keine entfernt).

- [ ] **Step 6: Committen**

```bash
git add packages/server
git commit -m "feat: Rechteprüfung pro Schreibtisch — Guards, gefilterte Desk-Liste, desk-gebundene Datei-Downloads, /auth/me" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Benutzer-Verwaltung (users.ts + Routen + /auth/password)

**Files:**
- Create: `packages/server/src/users.ts`, `packages/server/src/users.test.ts`
- Modify: `packages/server/src/app.ts`

**Interfaces:**
- Consumes: Task 1 (`createUser`, `createSession`), Task 2 (Guards, Error-Handler, `userIdOf`, testUtils `addUser`).
- Produces: `users.ts` mit `UserNotFoundError`, `UserInfo { id, username, isAdmin }`, `listUsers(db)`, `renameUser(db, userId, username)`, `resetPassword(db, userId, password)` (async, löscht Sessions), `changeOwnPassword(db, userId, oldPassword, newPassword)` (async, Sessions bleiben), `getUserDesks(db, userId): {id, name}[]`, `deleteUserCascade(db, userId): string[]` (gibt IDs der gelöschten eigenen Desks zurück). Routen: `GET /users`, `POST /users` (Admin, 201), `PATCH /users/:id` (Admin), `POST /users/:id/password` (Admin), `DELETE /users/:id` (Admin, eigenes Konto → 400), `GET /users/:id/desks` (Admin), `POST /auth/password` (selbst). Error-Handler um `UserNotFoundError → 404` erweitert.

- [ ] **Step 1: Failing Tests schreiben**

Neue Datei `packages/server/src/users.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestApp, addUser } from './testUtils';
import { login } from './auth';

describe('Benutzer-Routen', () => {
  it('GET /users listet alle Konten mit isAdmin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const liste = (await app.inject({ method: 'GET', url: '/api/v1/users', headers: bob.authHeaders })).json();
    expect(liste).toEqual([
      expect.objectContaining({ username: 'test', isAdmin: true }),
      expect.objectContaining({ username: 'bob', isAdmin: false }),
    ]);
  });

  it('POST /users legt Konten an — nur als Admin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const res = await app.inject({ method: 'POST', url: '/api/v1/users', headers: authHeaders, payload: { username: 'carol', password: 'geheim-genug' } });
    expect(res.statusCode).toBe(201);
    expect(await login(db, 'carol', 'geheim-genug')).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: bob.authHeaders, payload: { username: 'dan', password: 'geheim-genug' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: authHeaders, payload: { username: 'bob', password: 'geheim-genug' } })).statusCode).toBe(400);
  });

  it('PATCH /users/:id benennt um; Duplikat 400, unbekannt 404, Nicht-Admin 403', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/users/${bob.userId}`, headers: authHeaders, payload: { username: 'bobby' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).json().username).toBe('bobby');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/users/${bob.userId}`, headers: authHeaders, payload: { username: 'test' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/users/gibtsnicht', headers: authHeaders, payload: { username: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/users/${bob.userId}`, headers: bob.authHeaders, payload: { username: 'b2' } })).statusCode).toBe(403);
  });

  it('POST /users/:id/password setzt neu und löscht die Sessions des Betroffenen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'POST', url: `/api/v1/users/${bob.userId}/password`, headers: authHeaders, payload: { password: 'nagelneu-8' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).statusCode).toBe(401);
    expect(await login(db, 'bob', 'nagelneu-8')).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: `/api/v1/users/${bob.userId}/password`, headers: authHeaders, payload: { password: 'kurz' } })).statusCode).toBe(400);
  });

  it('POST /auth/password wechselt das eigene Passwort; falsches altes → 400; Session bleibt', async () => {
    const { app, db } = await createTestApp();
    const bob = await addUser(db, 'bob');
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: bob.authHeaders, payload: { oldPassword: 'falsch', newPassword: 'nagelneu-8' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: bob.authHeaders, payload: { oldPassword: 'test-passwort', newPassword: 'nagelneu-8' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bob.authHeaders })).statusCode).toBe(200);
    expect(await login(db, 'bob', 'nagelneu-8')).toBeTruthy();
  });

  it('GET /users/:id/desks liefert die eigenen Schreibtische des Benutzers — nur für Admin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/users/${bob.userId}/desks`, headers: authHeaders });
    expect(res.json()).toEqual([expect.objectContaining({ name: 'Bobs' })]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/users/${bob.userId}/desks`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('DELETE /users/:id löscht Konto samt eigener Desks, Mitgliedschaften und Sessions; uploader wird NULL', async () => {
    const { app, db, dataDir, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const bobsDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const meinDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Meiner' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(meinDesk.id, bob.userId);
    const { storeFile } = await import('./files');
    const meta = storeFile(db, dataDir, Buffer.from('%PDF-1.4\nbob'), 'b.pdf', bob.userId);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/users/${bob.userId}`, headers: authHeaders })).statusCode).toBe(200);
    expect(db.prepare('SELECT 1 FROM desks WHERE id = ?').get(bobsDesk.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM desk_members WHERE user_id = ?').get(bob.userId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM sessions WHERE user_id = ?').get(bob.userId)).toBeUndefined();
    expect((db.prepare('SELECT uploader_id AS u FROM files WHERE id = ?').get(meta.id) as { u: string | null }).u).toBeNull();
  });

  it('DELETE des eigenen Kontos → 400; als Nicht-Admin → 403', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/users/${me.id}`, headers: authHeaders })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/users/${me.id}`, headers: bob.authHeaders })).statusCode).toBe(403);
  });
});
```

Run: `npm test` → Expected: FAIL (Routen existieren nicht).

- [ ] **Step 2: users.ts anlegen**

```ts
import argon2 from 'argon2';
import type { Db } from './db';
import { AuthError } from './auth';

export class UserNotFoundError extends Error {}

export interface UserInfo {
  id: string;
  username: string;
  isAdmin: boolean;
}

export function listUsers(db: Db): UserInfo[] {
  const rows = db.prepare('SELECT id, username, is_admin AS isAdmin FROM users ORDER BY created_at').all() as
    { id: string; username: string; isAdmin: number }[];
  return rows.map((r) => ({ ...r, isAdmin: r.isAdmin === 1 }));
}

export function renameUser(db: Db, userId: string, username: string): void {
  const name = username.trim();
  if (name === '') throw new AuthError('Benutzername darf nicht leer sein');
  const belegt = db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: string } | undefined;
  if (belegt && belegt.id !== userId) throw new AuthError('Benutzername bereits vergeben');
  const result = db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, userId);
  if (result.changes === 0) throw new UserNotFoundError('Benutzer nicht gefunden');
}

/** Admin-Reset: neues Passwort setzen und alle Sitzungen des Betroffenen beenden. */
export async function resetPassword(db: Db, userId: string, password: string): Promise<void> {
  if (password.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  if (result.changes === 0) throw new UserNotFoundError('Benutzer nicht gefunden');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Eigenes Passwort wechseln; bestehende Sitzungen bleiben gültig. */
export async function changeOwnPassword(db: Db, userId: string, oldPassword: string, newPassword: string): Promise<void> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row) throw new UserNotFoundError('Benutzer nicht gefunden');
  if (!(await argon2.verify(row.password_hash, oldPassword))) throw new AuthError('Aktuelles Passwort ist falsch');
  if (newPassword.length < 8) throw new AuthError('Passwort muss mindestens 8 Zeichen haben');
  const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

export function getUserDesks(db: Db, userId: string): { id: string; name: string }[] {
  return db.prepare('SELECT id, name FROM desks WHERE owner_id = ? ORDER BY created_at').all(userId) as
    { id: string; name: string }[];
}

/** Löscht das Konto samt eigener Schreibtische; gibt deren IDs zurück (für WS-Closes). */
export function deleteUserCascade(db: Db, userId: string): string[] {
  const txn = db.transaction((): string[] => {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) {
      throw new UserNotFoundError('Benutzer nicht gefunden');
    }
    const eigene = (db.prepare('SELECT id FROM desks WHERE owner_id = ?').all(userId) as { id: string }[]).map((r) => r.id);
    db.prepare('DELETE FROM desks WHERE owner_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return eigene;
  });
  return txn();
}
```

- [ ] **Step 3: Routen in app.ts + Error-Handler-Erweiterung**

Import ergänzen:

```ts
import { listUsers, renameUser, resetPassword, changeOwnPassword, getUserDesks, deleteUserCascade, UserNotFoundError } from './users';
import { requireAdmin } from './guards';   // zum bestehenden guards-Import dazunehmen
```

Im Error-Handler die 404-Zeile erweitern:

```ts
    if (err instanceof DeskNotFoundError || err instanceof UserNotFoundError) return reply.code(404).send({ error: err.message });
```

Neue Routen (nach den Auth-Routen):

```ts
  // ---- Benutzer ----
  app.get('/api/v1/users', async () => listUsers(db));

  app.post('/api/v1/users', async (req, reply) => {
    requireAdmin(db, userIdOf(req));
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const id = await createUser(db, String(username ?? ''), String(password ?? ''));
    reply.code(201);
    return { id, username: String(username).trim(), isAdmin: false };
  });

  app.patch('/api/v1/users/:id', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    const { username } = (req.body ?? {}) as { username?: string };
    renameUser(db, id, String(username ?? ''));
    return { ok: true };
  });

  app.post('/api/v1/users/:id/password', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    await resetPassword(db, id, String(password ?? ''));
    return { ok: true };
  });

  app.get('/api/v1/users/:id/desks', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    return getUserDesks(db, id);
  });

  app.delete('/api/v1/users/:id', async (req) => {
    requireAdmin(db, userIdOf(req));
    const { id } = req.params as { id: string };
    if (id === userIdOf(req)) throw new AuthError('Eigenes Konto kann nicht gelöscht werden');
    deleteUserCascade(db, id);
    return { ok: true };
  });

  app.post('/api/v1/auth/password', async (req) => {
    const { oldPassword, newPassword } = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
    await changeOwnPassword(db, userIdOf(req), String(oldPassword ?? ''), String(newPassword ?? ''));
    return { ok: true };
  });
```

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` → PASS (103 erwartet: 95 + 8).

```bash
git add packages/server
git commit -m "feat: Benutzer-Verwaltung — Admin-Routen (anlegen, umbenennen, Reset, Kaskaden-Löschung) und eigener Passwortwechsel" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mitglieder-Routen (Teilen mit bestehenden Konten)

**Files:**
- Create: `packages/server/src/members.test.ts`
- Modify: `packages/server/src/deskStore.ts`, `packages/server/src/app.ts`

**Interfaces:**
- Consumes: Task 2 (Guards, `userIdOf`, Error-Handler).
- Produces: in deskStore.ts `MemberError`, `MemberInfo { id, username }`, `listMembers(db, deskId)`, `addMember(db, deskId, username): MemberInfo`, `removeMember(db, deskId, userId)`. Routen: `GET /desks/:id/members` (Besitzer + Mitglieder), `POST /desks/:id/members {username}` (Besitzer, 201), `DELETE /desks/:id/members/:userId` (Besitzer oder selbst). Error-Handler: `MemberError → 400`.

- [ ] **Step 1: Failing Tests schreiben**

Neue Datei `packages/server/src/members.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestApp, addUser } from './testUtils';

async function deskMit(app: Awaited<ReturnType<typeof createTestApp>>['app'], headers: { authorization: string }, name = 'D') {
  return (await app.inject({ method: 'POST', url: '/api/v1/desks', headers, payload: { name } })).json() as { id: string };
}

describe('Mitglieder', () => {
  it('Besitzer fügt hinzu, alle Beteiligten sehen die Liste, Besitzer entfernt', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = await deskMit(app, authHeaders);
    const res = await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'bob' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'bob' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/members`, headers: bob.authHeaders })).json()).toEqual([
      expect.objectContaining({ username: 'bob' }),
    ]);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('addMember validiert: unbekannt, Besitzer, Duplikat → 400', async () => {
    const { app, db, authHeaders } = await createTestApp();
    await addUser(db, 'bob');
    const desk = await deskMit(app, authHeaders);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'niemand' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'test' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'bob' } });
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: authHeaders, payload: { username: 'bob' } })).statusCode).toBe(400);
  });

  it('nur der Besitzer fügt hinzu; Mitglieder und Fremde nicht', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const desk = await deskMit(app, authHeaders);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: bob.authHeaders, payload: { username: 'carol' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/members`, headers: carol.authHeaders, payload: { username: 'carol' } })).statusCode).toBe(403);
  });

  it('Mitglied darf sich selbst entfernen (verlassen), aber keinen anderen', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const desk = await deskMit(app, authHeaders);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, carol.userId);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${carol.userId}`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: bob.authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: bob.authHeaders })).statusCode).toBe(403);
  });

  it('Fremde sehen die Mitgliederliste nicht; Entfernen eines Nicht-Mitglieds → 400', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = await deskMit(app, authHeaders);
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/members`, headers: bob.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: authHeaders })).statusCode).toBe(400);
  });
});
```

Run: `npm test` → Expected: FAIL (Routen existieren nicht).

- [ ] **Step 2: deskStore.ts — Mitglieder-Funktionen**

Am Ende von `packages/server/src/deskStore.ts` ergänzen:

```ts
export class MemberError extends Error {}

export interface MemberInfo {
  id: string;
  username: string;
}

export function listMembers(db: Db, deskId: string): MemberInfo[] {
  return db.prepare(
    'SELECT u.id, u.username FROM desk_members m JOIN users u ON u.id = m.user_id WHERE m.desk_id = ? ORDER BY u.username',
  ).all(deskId) as MemberInfo[];
}

export function addMember(db: Db, deskId: string, username: string): MemberInfo {
  const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username.trim()) as
    | MemberInfo
    | undefined;
  if (!user) throw new MemberError('Benutzer nicht gefunden');
  const desk = db.prepare('SELECT owner_id AS ownerId FROM desks WHERE id = ?').get(deskId) as
    | { ownerId: string }
    | undefined;
  if (!desk) throw new DeskNotFoundError('Schreibtisch nicht gefunden');
  if (desk.ownerId === user.id) throw new MemberError('Der Besitzer ist bereits dabei');
  if (db.prepare('SELECT 1 FROM desk_members WHERE desk_id = ? AND user_id = ?').get(deskId, user.id)) {
    throw new MemberError('Benutzer ist bereits Mitglied');
  }
  db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(deskId, user.id);
  return user;
}

export function removeMember(db: Db, deskId: string, userId: string): void {
  const result = db.prepare('DELETE FROM desk_members WHERE desk_id = ? AND user_id = ?').run(deskId, userId);
  if (result.changes === 0) throw new MemberError('Kein Mitglied dieses Schreibtischs');
}
```

- [ ] **Step 3: Routen in app.ts**

Imports erweitern (`listMembers, addMember, removeMember, MemberError` aus `./deskStore`; `ForbiddenError` ist schon importiert). Error-Handler: in der 400-Zeile `err instanceof MemberError ||` ergänzen.

```ts
  // ---- Mitglieder ----
  app.get('/api/v1/desks/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    requireDeskAccess(db, id, userIdOf(req));
    return listMembers(db, id);
  });

  app.post('/api/v1/desks/:id/members', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireDeskOwner(db, id, userIdOf(req));
    const { username } = (req.body ?? {}) as { username?: string };
    const member = addMember(db, id, String(username ?? ''));
    reply.code(201);
    return member;
  });

  app.delete('/api/v1/desks/:id/members/:userId', async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    if (userId !== userIdOf(req)) requireDeskOwner(db, id, userIdOf(req));
    else requireDeskAccess(db, id, userIdOf(req));
    removeMember(db, id, userId);
    return { ok: true };
  });
```

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` → PASS (108 erwartet: 103 + 5).

```bash
git add packages/server
git commit -m "feat: Mitglieder-Routen — Teilen pro Schreibtisch mit bestehenden Konten, selbst verlassen" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Einladungen (invites.ts + Routen + öffentliche Einlösung)

**Files:**
- Create: `packages/server/src/invites.ts`, `packages/server/src/invites.test.ts`
- Modify: `packages/server/src/app.ts` (Routen, PUBLIC_PATHS)

**Interfaces:**
- Consumes: Task 1 (`createUser`, `createSession`), Task 2 (Guards), Task 4 (Fehlerklassen-Muster).
- Produces: `invites.ts` mit `InviteError`, `InviteInfo { token, deskId, deskName, createdBy, expiresAt }`, `createInvite(db, creatorId, deskId: string | null): { token, expiresAt }` (TTL 14 Tage), `listInvites(db, userId, all: boolean)`, `getInvite(db, token): { deskId, deskName } | null` (filtert Abgelaufene), `revokeInvite(db, token, userId, admin: boolean)`, `redeemInvite(db, token, username, password): Promise<string>` (Session-Token). Routen: `POST /invites` (201), `GET /invites`, `DELETE /invites/:token`, öffentlich `GET /auth/invite/:token` und `POST /auth/redeem`. Error-Handler: `InviteError → 400`.

- [ ] **Step 1: Failing Tests schreiben**

Neue Datei `packages/server/src/invites.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestApp, addUser } from './testUtils';

describe('Einladungen', () => {
  it('Admin erstellt Konto-Einladung; Normalnutzer 403', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const res = await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toHaveLength(64);
    expect((await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: {} })).statusCode).toBe(403);
  });

  it('Desk-Einladung nur durch den Besitzer', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    expect((await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).statusCode).toBe(201);
    // selbst der Admin darf nicht für fremde Desks einladen
    expect((await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: { deskId: desk.id } })).statusCode).toBe(403);
  });

  it('GET /auth/invite/:token ist öffentlich und liefert deskName; unbekannt → 404', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Projekt X' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).json();
    const res = await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${inv.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deskName: 'Projekt X' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/invite/unbekannt' })).statusCode).toBe(404);
  });

  it('redeem legt Konto samt Mitgliedschaft an, liefert Session-Token, Einladung verbraucht', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).json();

    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'carol', password: 'geheim-genug' } });
    expect(res.statusCode).toBe(200);
    const session = res.json().token as string;
    expect((await app.inject({ method: 'GET', url: `/api/v1/desks/${desk.id}/state`, headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(200);
    // verbraucht:
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'dan', password: 'geheim-genug' } })).statusCode).toBe(400);
  });

  it('redeem mit vergebenem Benutzernamen → 400, Einladung bleibt einlösbar', async () => {
    const { app, authHeaders } = await createTestApp();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: {} })).json();
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'test', password: 'geheim-genug' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: inv.token, username: 'neu', password: 'geheim-genug' } })).statusCode).toBe(200);
  });

  it('abgelaufene Einladung: invite 404, redeem 400, nicht in der Liste', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    db.prepare('INSERT INTO invites (token, created_by, desk_id, created_at, expires_at) VALUES (?, ?, NULL, 0, 1)').run('alt-token', me.id);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/invite/alt-token' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/redeem', payload: { token: 'alt-token', username: 'x', password: 'geheim-genug' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/invites', headers: authHeaders })).json()).toEqual([]);
  });

  it('GET /invites zeigt eigene (Admin: alle) mit deskName; Widerruf durch Ersteller oder Admin', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    const carol = await addUser(db, 'carol');
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: bob.authHeaders, payload: { deskId: desk.id } })).json();

    expect((await app.inject({ method: 'GET', url: '/api/v1/invites', headers: bob.authHeaders })).json()).toEqual([
      expect.objectContaining({ token: inv.token, deskName: 'Bobs' }),
    ]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/invites', headers: authHeaders })).json()).toHaveLength(1); // Admin sieht alle
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${inv.token}`, headers: carol.authHeaders })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${inv.token}`, headers: authHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${inv.token}`, headers: bob.authHeaders })).statusCode).toBe(400);
  });

  it('Desk-Löschung lässt zugehörige Einladungen verfallen (CASCADE)', async () => {
    const { app, db, authHeaders } = await createTestApp();
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/api/v1/invites', headers: authHeaders, payload: { deskId: desk.id } })).json();
    await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: authHeaders });
    expect((await app.inject({ method: 'GET', url: `/api/v1/auth/invite/${inv.token}` })).statusCode).toBe(404);
  });
});
```

Run: `npm test` → Expected: FAIL.

- [ ] **Step 2: invites.ts anlegen**

```ts
import { randomBytes } from 'node:crypto';
import type { Db } from './db';
import { createUser, createSession } from './auth';
import { ForbiddenError } from './guards';

export class InviteError extends Error {}

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface InviteInfo {
  token: string;
  deskId: string | null;
  deskName: string | null;
  createdBy: string;
  expiresAt: number;
}

function pruneExpired(db: Db): void {
  db.prepare('DELETE FROM invites WHERE expires_at < ?').run(Date.now());
}

export function createInvite(db: Db, creatorId: string, deskId: string | null): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + INVITE_TTL_MS;
  db.prepare('INSERT INTO invites (token, created_by, desk_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    token, creatorId, deskId, Date.now(), expiresAt,
  );
  return { token, expiresAt };
}

export function listInvites(db: Db, userId: string, all: boolean): InviteInfo[] {
  pruneExpired(db);
  const sql = `SELECT i.token, i.desk_id AS deskId, d.name AS deskName, i.created_by AS createdBy, i.expires_at AS expiresAt
               FROM invites i LEFT JOIN desks d ON d.id = i.desk_id
               ${all ? '' : 'WHERE i.created_by = ?'} ORDER BY i.created_at`;
  const stmt = db.prepare(sql);
  return (all ? stmt.all() : stmt.all(userId)) as InviteInfo[];
}

export function getInvite(db: Db, token: string): { deskId: string | null; deskName: string | null } | null {
  pruneExpired(db);
  const row = db.prepare(
    'SELECT i.desk_id AS deskId, d.name AS deskName FROM invites i LEFT JOIN desks d ON d.id = i.desk_id WHERE i.token = ?',
  ).get(token) as { deskId: string | null; deskName: string | null } | undefined;
  return row ?? null;
}

export function revokeInvite(db: Db, token: string, userId: string, admin: boolean): void {
  const row = db.prepare('SELECT created_by AS createdBy FROM invites WHERE token = ?').get(token) as
    | { createdBy: string }
    | undefined;
  if (!row) throw new InviteError('Einladung nicht gefunden');
  if (!admin && row.createdBy !== userId) throw new ForbiddenError('Nur der Ersteller oder der Admin darf widerrufen');
  db.prepare('DELETE FROM invites WHERE token = ?').run(token);
}

/** Konto anlegen, ggf. Mitgliedschaft eintragen, Einladung verbrauchen → Session-Token. */
export async function redeemInvite(db: Db, token: string, username: string, password: string): Promise<string> {
  const invite = getInvite(db, token);
  if (!invite) throw new InviteError('Einladung ist ungültig oder abgelaufen');
  const userId = await createUser(db, username, password); // validiert Name, Passwort, Duplikat
  const txn = db.transaction(() => {
    if (db.prepare('DELETE FROM invites WHERE token = ?').run(token).changes === 0) {
      throw new InviteError('Einladung ist ungültig oder abgelaufen');
    }
    if (invite.deskId) db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(invite.deskId, userId);
  });
  try {
    txn();
  } catch (e) {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId); // Konto zurücknehmen
    throw e;
  }
  return createSession(db, userId);
}
```

- [ ] **Step 3: Routen + PUBLIC_PATHS in app.ts**

Imports: `createInvite, listInvites, getInvite, revokeInvite, redeemInvite, InviteError` aus `./invites`; `isAdminUser` zum guards-Import dazu. Error-Handler-400-Zeile um `err instanceof InviteError ||` erweitern.

Den `onRequest`-Hook anpassen — vor `if (PUBLIC_PATHS.has(path)) return;` ergänzen:

```ts
    if (path.startsWith('/api/v1/auth/invite/')) return;
```

und `'/api/v1/auth/redeem'` in das `PUBLIC_PATHS`-Set aufnehmen.

Neue Routen:

```ts
  // ---- Einladungen ----
  app.post('/api/v1/invites', async (req, reply) => {
    const userId = userIdOf(req);
    const { deskId } = (req.body ?? {}) as { deskId?: string };
    if (deskId) requireDeskOwner(db, deskId, userId);
    else requireAdmin(db, userId);
    reply.code(201);
    return createInvite(db, userId, deskId ?? null);
  });

  app.get('/api/v1/invites', async (req) => {
    const userId = userIdOf(req);
    return listInvites(db, userId, isAdminUser(db, userId));
  });

  app.delete('/api/v1/invites/:token', async (req) => {
    const userId = userIdOf(req);
    const { token } = req.params as { token: string };
    revokeInvite(db, token, userId, isAdminUser(db, userId));
    return { ok: true };
  });

  app.get('/api/v1/auth/invite/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const invite = getInvite(db, token);
    if (!invite) return reply.code(404).send({ error: 'Einladung ist ungültig oder abgelaufen' });
    return { deskName: invite.deskName };
  });

  app.post('/api/v1/auth/redeem', async (req) => {
    const { token, username, password } = (req.body ?? {}) as { token?: string; username?: string; password?: string };
    return { token: await redeemInvite(db, String(token ?? ''), String(username ?? ''), String(password ?? '')) };
  });
```

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` → PASS (116 erwartet: 108 + 8).

```bash
git add packages/server
git commit -m "feat: Einladungen — erstellen, listen, widerrufen, öffentlich prüfen und einlösen (Konto + optionaler Desk)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: WS-Close-Codes 4001/4003 bei Löschung und Entzug

**Files:**
- Create: `packages/server/src/wsClose.test.ts`
- Modify: `packages/server/src/broadcast.ts`, `packages/server/src/app.ts`

**Interfaces:**
- Consumes: Task 2 (WS-Route mit Zugriffscheck), Task 3 (`deleteUserCascade`), Task 4 (Mitglieder-Routen).
- Produces: `broadcast.ts` neu mit `WsConn { send, close(code, reason) }`, `register(deskId, socket, userId)`, `unregister(deskId, socket)`, `broadcast(deskId, msg)`, `closeDesk(deskId)` (Code 4001 `desk-deleted`), `closeUserOnDesk(deskId, userId)` (Code 4003 `access-revoked`), `closeUserEverywhere(userId)` (Code 4003). Aufrufe: DELETE-Desk-Route, DELETE-Member-Route, DELETE-User-Route.

- [ ] **Step 1: Failing Tests schreiben**

Neue Datei `packages/server/src/wsClose.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import WsClient from 'ws';
import { createTestApp, addUser } from './testUtils';

async function verbinde(port: number, deskId: string, token: string): Promise<{ ws: WsClient; closed: Promise<number> }> {
  const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/desks/${deskId}/ws?token=${token}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return { ws, closed };
}

describe('WS-Close-Codes', () => {
  it('DELETE eines Desks schließt alle Sockets mit 4001', async () => {
    const { app, db, token, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    const a = await verbinde(port, desk.id, token);
    const b = await verbinde(port, desk.id, bob.token);

    await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}`, headers: authHeaders });
    expect(await a.closed).toBe(4001);
    expect(await b.closed).toBe(4001);
    await app.close();
  });

  it('Mitglied entfernen schließt nur dessen Socket mit 4003', async () => {
    const { app, db, token, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const desk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'D' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(desk.id, bob.userId);
    const besitzer = await verbinde(port, desk.id, token);
    const mitglied = await verbinde(port, desk.id, bob.token);

    await app.inject({ method: 'DELETE', url: `/api/v1/desks/${desk.id}/members/${bob.userId}`, headers: authHeaders });
    expect(await mitglied.closed).toBe(4003);

    // Besitzer-Socket lebt weiter und empfängt Broadcasts
    const nachricht = new Promise<boolean>((resolve) => besitzer.ws.on('message', () => resolve(true)));
    await app.inject({ method: 'POST', url: `/api/v1/desks/${desk.id}/commands`, headers: authHeaders, payload: { type: 'bringToFront', payload: { id: 'x' } } });
    expect(await nachricht).toBe(true);
    besitzer.ws.close();
    await app.close();
  });

  it('Konto-Löschung: eigene Desks 4001 für Mitglieder, eigene Sockets 4003', async () => {
    const { app, db, token, authHeaders } = await createTestApp();
    const bob = await addUser(db, 'bob');
    await app.listen({ port: 0 });
    const { port } = app.server.address() as { port: number };
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders })).json();
    const bobsDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: bob.authHeaders, payload: { name: 'Bobs' } })).json();
    const meinDesk = (await app.inject({ method: 'POST', url: '/api/v1/desks', headers: authHeaders, payload: { name: 'Meiner' } })).json();
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(bobsDesk.id, me.id);
    db.prepare('INSERT INTO desk_members (desk_id, user_id) VALUES (?, ?)').run(meinDesk.id, bob.userId);
    const adminAufBobs = await verbinde(port, bobsDesk.id, token);
    const bobAufMeinem = await verbinde(port, meinDesk.id, bob.token);

    await app.inject({ method: 'DELETE', url: `/api/v1/users/${bob.userId}`, headers: authHeaders });
    expect(await adminAufBobs.closed).toBe(4001); // Bobs Desk wurde mitgelöscht
    expect(await bobAufMeinem.closed).toBe(4003); // Bobs Mitgliedschaft/Konto ist weg
    await app.close();
  });
});
```

Run: `npm test` → Expected: FAIL (`register` kennt keine userId, keine Close-Aufrufe).

- [ ] **Step 2: broadcast.ts umbauen**

Komplett ersetzen:

```ts
export interface WsConn {
  send(data: string): void;
  close(code: number, reason: string): void;
}

const rooms = new Map<string, Map<WsConn, string>>();

export function register(deskId: string, socket: WsConn, userId: string): void {
  let room = rooms.get(deskId);
  if (!room) rooms.set(deskId, (room = new Map()));
  room.set(socket, userId);
}

export function unregister(deskId: string, socket: WsConn): void {
  const room = rooms.get(deskId);
  room?.delete(socket);
  if (room && room.size === 0) rooms.delete(deskId);
}

export function broadcast(deskId: string, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const socket of rooms.get(deskId)?.keys() ?? []) {
    try {
      socket.send(data);
    } catch {
      // toter Socket — wird über sein close-Event ausgetragen
    }
  }
}

function schliessen(socket: WsConn, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // bereits zu
  }
}

/** Desk wurde gelöscht — alle Clients des Desks trennen. */
export function closeDesk(deskId: string): void {
  for (const socket of rooms.get(deskId)?.keys() ?? []) schliessen(socket, 4001, 'desk-deleted');
  rooms.delete(deskId);
}

/** Zugriff eines Benutzers auf einen Desk entzogen. */
export function closeUserOnDesk(deskId: string, userId: string): void {
  const room = rooms.get(deskId);
  if (!room) return;
  for (const [socket, uid] of room) {
    if (uid === userId) schliessen(socket, 4003, 'access-revoked');
  }
}

/** Konto gelöscht — alle Sockets des Benutzers auf allen Desks trennen. */
export function closeUserEverywhere(userId: string): void {
  for (const deskId of rooms.keys()) closeUserOnDesk(deskId, userId);
}
```

- [ ] **Step 3: app.ts — register-Aufruf und Close-Aufrufe**

Imports: `closeDesk, closeUserOnDesk, closeUserEverywhere` zum broadcast-Import dazu.

WS-Route: `register(id, socket);` → `register(id, socket, userIdOf(req));`

DELETE-Desk-Route — nach `deleteDesk(db, id);` einfügen: `closeDesk(id);`

DELETE-Member-Route — nach `removeMember(db, id, userId);` einfügen: `closeUserOnDesk(id, userId);`

DELETE-User-Route — `deleteUserCascade(db, id);` ersetzen durch:

```ts
    const eigeneDesks = deleteUserCascade(db, id);
    for (const deskId of eigeneDesks) closeDesk(deskId);
    closeUserEverywhere(id);
```

- [ ] **Step 4: Verifizieren & committen**

Run: `npm test` → PASS (119 erwartet: 116 + 3).

```bash
git add packages/server
git commit -m "feat: WS-Close-Codes — 4001 bei Desk-Löschung, 4003 bei Zugriffs-Entzug und Konto-Löschung" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Client — API-Erweiterung, Identität, Close-Code-/403-/401-Recovery

**Files:**
- Create: `src/lib/wsCodes.ts`, `src/lib/wsCodes.test.ts`
- Modify: `src/lib/api.ts`, `src/lib/store.svelte.ts`, `src/routes/+page.svelte`

**Interfaces:**
- Consumes: Server-Routen aus Tasks 2–6.
- Produces: `accessLossMessage(code: number): string | null` (4001 → „Schreibtisch wurde gelöscht", 4003 → „Zugriff wurde entzogen", sonst null). `ApiClient` neu: `me()`, `changePassword(old, neu)`, `listUsers()`, `createUser(username, password)`, `renameUser(id, username)`, `resetUserPassword(id, password)`, `deleteUser(id)`, `getUserDesks(id)`, `listMembers(deskId)`, `addMember(deskId, username)`, `removeMember(deskId, userId)`, `createInvite(deskId?)`, `listInvites()`, `revokeInvite(token)`, `inviteInfo(token)`, `redeem(token, username, password)` (setzt `this.token`); Typen `UserInfo`, `MemberInfo`, `InviteInfo`; `DeskInfo` um `ownerName: string; isOwner: boolean` erweitert. `desktop` neu: `get me(): UserInfo | null` (in `start` geladen), `leaveDesk(id)`; Close-Codes 4001/4003 lösen `recoverAccess` aus (kein Reconnect); HTTP-403 in `command` → `recoverAccess`; HTTP-401 → `stop()`; `deleteDesk` trennt den Socket VOR dem API-Aufruf (kein Doppel-Recovery). `+page.svelte`: `$effect` wechselt bei `status === 'loggedOut'` zur Login-Maske (Session löschen).

- [ ] **Step 1: Failing Tests schreiben**

Neue Datei `src/lib/wsCodes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { accessLossMessage } from './wsCodes';

describe('accessLossMessage', () => {
  it('4001 → Schreibtisch wurde gelöscht', () => {
    expect(accessLossMessage(4001)).toBe('Schreibtisch wurde gelöscht');
  });
  it('4003 → Zugriff wurde entzogen', () => {
    expect(accessLossMessage(4003)).toBe('Zugriff wurde entzogen');
  });
  it('normale Close-Codes → null (Reconnect-Pfad)', () => {
    expect(accessLossMessage(1000)).toBeNull();
    expect(accessLossMessage(1006)).toBeNull();
  });
});
```

Run: `npm test` → Expected: FAIL (Modul fehlt).

- [ ] **Step 2: wsCodes.ts anlegen**

```ts
/** Übersetzt server-seitige Zugriffsverlust-Close-Codes; null = normaler Abriss (Reconnect). */
export function accessLossMessage(code: number): string | null {
  if (code === 4001) return 'Schreibtisch wurde gelöscht';
  if (code === 4003) return 'Zugriff wurde entzogen';
  return null;
}
```

- [ ] **Step 3: api.ts erweitern**

`DeskInfo` ersetzen und Typen ergänzen (nach `DeskInfo`):

```ts
export interface DeskInfo {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
}

export interface UserInfo {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface MemberInfo {
  id: string;
  username: string;
}

export interface InviteInfo {
  token: string;
  deskId: string | null;
  deskName: string | null;
  createdBy: string;
  expiresAt: number;
}
```

Methoden am `ApiClient` (nach `logout`):

```ts
  me(): Promise<UserInfo> {
    return this.request('GET', '/auth/me');
  }

  changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/auth/password', { oldPassword, newPassword });
  }

  listUsers(): Promise<UserInfo[]> {
    return this.request('GET', '/users');
  }

  createUser(username: string, password: string): Promise<UserInfo> {
    return this.request('POST', '/users', { username, password });
  }

  renameUser(userId: string, username: string): Promise<{ ok: boolean }> {
    return this.request('PATCH', `/users/${userId}`, { username });
  }

  resetUserPassword(userId: string, password: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/users/${userId}/password`, { password });
  }

  deleteUser(userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/users/${userId}`);
  }

  getUserDesks(userId: string): Promise<{ id: string; name: string }[]> {
    return this.request('GET', `/users/${userId}/desks`);
  }

  listMembers(deskId: string): Promise<MemberInfo[]> {
    return this.request('GET', `/desks/${deskId}/members`);
  }

  addMember(deskId: string, username: string): Promise<MemberInfo> {
    return this.request('POST', `/desks/${deskId}/members`, { username });
  }

  removeMember(deskId: string, userId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/desks/${deskId}/members/${userId}`);
  }

  createInvite(deskId?: string): Promise<{ token: string; expiresAt: number }> {
    return this.request('POST', '/invites', deskId ? { deskId } : {});
  }

  listInvites(): Promise<InviteInfo[]> {
    return this.request('GET', '/invites');
  }

  revokeInvite(token: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/invites/${token}`);
  }

  inviteInfo(token: string): Promise<{ deskName: string | null }> {
    return this.request('GET', `/auth/invite/${token}`);
  }

  async redeem(token: string, username: string, password: string): Promise<void> {
    const r = await this.request<{ token: string }>('POST', '/auth/redeem', { token, username, password });
    this.token = r.token;
  }
```

- [ ] **Step 4: store.svelte.ts — me, Recovery-Routinen, Close-Codes**

Imports erweitern:

```ts
import { ApiError, type ApiClient, type DeskInfo, type UserInfo } from './api';
import { accessLossMessage } from './wsCodes';
```

Neue Zustandsvariable (bei `desks`): `let me = $state<UserInfo | null>(null);` und Getter am `desktop`-Objekt:

```ts
  get me(): UserInfo | null {
    return me;
  },
```

In `start` nach `status = 'connecting';` einfügen: `me = await client.me();`
In `stop` vor `status = 'loggedOut';` einfügen: `me = null;`

`command`-catch ersetzen durch:

```ts
    } catch (e) {
      if (handleAuthLoss(e)) return;
      if (e instanceof ApiError && e.status === 403) {
        void recoverAccess('Zugriff wurde entzogen');
        return;
      }
      await this.refresh().catch(() => {});
      showToast(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
    }
```

`refresh` ersetzen durch:

```ts
  async refresh(): Promise<void> {
    if (stopped) return;
    if (!api || !deskId) return;
    try {
      const result = await api.getState(deskId);
      if (result.rev >= rev) {
        rev = result.rev;
        state = result.state;
      }
    } catch (e) {
      if (!handleAuthLoss(e)) throw e;
    }
  },
```

`deleteDesk` ersetzen (Socket VOR dem API-Aufruf trennen, damit der 4001-Close des Servers nicht die eigene Wechsel-Logik doppelt):

```ts
  async deleteDesk(id: string): Promise<void> {
    if (!api) return;
    if (status !== 'online') {
      showToast('Offline — Aktion nicht möglich');
      return;
    }
    const wechselt = id === deskId;
    try {
      if (wechselt) {
        status = 'connecting';
        await closeWs();
      }
      await api.deleteDesk(id);
      desks = await api.listDesks();
      if (wechselt) {
        if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
        try {
          await loadDesk(desks[0].id);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
          onDisconnected();
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
      if (wechselt) onDisconnected();
    }
  },
```

Neue Methode `leaveDesk` (nach `deleteDesk`, gleiche Struktur — geteilten Desk verlassen):

```ts
  async leaveDesk(id: string): Promise<void> {
    if (!api || !me) return;
    if (status !== 'online') {
      showToast('Offline — Aktion nicht möglich');
      return;
    }
    const wechselt = id === deskId;
    try {
      if (wechselt) {
        status = 'connecting';
        await closeWs();
      }
      await api.removeMember(id, me.id);
      desks = await api.listDesks();
      if (wechselt) {
        if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
        try {
          await loadDesk(desks[0].id);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
          onDisconnected();
        }
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Verlassen fehlgeschlagen');
      if (wechselt) onDisconnected();
    }
  },
```

Im WS-Listener (`connectWs`) den `Close`-Zweig ersetzen:

```ts
      } else if (msg.type === 'Close') {
        const meldung = msg.data ? accessLossMessage(msg.data.code) : null;
        if (meldung) void recoverAccess(meldung);
        else onDisconnected();
      }
```

Neue Modul-Helfer (nach `onDisconnected`):

```ts
/** 401: Sitzung ist weg (z. B. Admin-Passwort-Reset) — abmelden, +page zeigt die Login-Maske. */
function handleAuthLoss(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 401) {
    void desktop.stop();
    return true;
  }
  return false;
}

/** Zugriff verloren (Close 4001/4003 oder HTTP 403): melden, Liste neu laden, ausweichen. */
async function recoverAccess(meldung: string): Promise<void> {
  if (stopped || !api) return;
  showToast(meldung);
  wsGeneration++; // alte Listener invalidieren; der Socket ist server-seitig bereits zu
  ws = null;
  status = 'connecting';
  try {
    desks = await api.listDesks();
    if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
    await loadDesk(desks[0].id);
  } catch (e) {
    if (!handleAuthLoss(e)) onDisconnected();
  }
}
```

- [ ] **Step 5: +page.svelte — loggedOut-Effekt**

Im `<script>`-Block (nach den `$state`-Deklarationen) ergänzen:

```ts
  // Sitzung serverseitig beendet (Abmelden, Passwort-Reset durch Admin) → zurück zur Login-Maske
  $effect(() => {
    if (phase === 'desk' && desktop.status === 'loggedOut') {
      void clearSession().finally(() => {
        phase = 'login';
      });
    }
  });
```

- [ ] **Step 6: Verifizieren & committen**

Run: `npm test` → PASS (122 erwartet: 119 + 3) und `npx svelte-check 2>&1 | tail -3` (0 neue Errors).

```bash
git add src
git commit -m "feat: Client-API für Benutzer/Mitglieder/Einladungen; Recovery bei Close-Codes 4001/4003, HTTP 403 und 401" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Konto-Menü (Passwort ändern, Abmelden)

**Files:**
- Create: `src/lib/components/AccountMenu.svelte`
- Modify: `src/lib/components/Desktop.svelte` (Import + Einbindung in die Toolbar)

**Interfaces:**
- Consumes: Task 7 (`desktop.me`, `desktop.stop`, `api.changePassword`, `api.logout`, loggedOut-Effekt in +page.svelte).
- Produces: `AccountMenu.svelte` — Button mit Benutzernamen, Dropdown mit „Passwort ändern…" und „Abmelden"; Task 9 ergänzt darin „Benutzerverwaltung…".

- [ ] **Step 1: AccountMenu.svelte anlegen**

```svelte
<script lang="ts">
  import { desktop } from '../store.svelte';
  import { showToast } from '../ui.svelte';

  let open = $state(false);
  let mode = $state<'menue' | 'passwort'>('menue');
  let altesPasswort = $state('');
  let neuesPasswort = $state('');
  let busy = $state(false);

  function toggle() {
    open = !open;
    mode = 'menue';
    altesPasswort = '';
    neuesPasswort = '';
  }

  async function passwortAendern() {
    if (!desktop.api || busy) return;
    if (neuesPasswort.length < 8) {
      showToast('Passwort muss mindestens 8 Zeichen haben');
      return;
    }
    busy = true;
    try {
      await desktop.api.changePassword(altesPasswort, neuesPasswort);
      showToast('Passwort geändert');
      open = false;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ändern fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function abmelden() {
    open = false;
    await desktop.api?.logout().catch(() => {});
    await desktop.stop(); // status 'loggedOut' → +page wechselt zur Login-Maske
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="konto">
  <button class="current" onclick={toggle}>{desktop.me?.username ?? '…'} ▾</button>
  {#if open}
    <div class="backdrop" onpointerdown={(e) => { e.stopPropagation(); open = false; }}></div>
    <div class="menu" onpointerdown={(e) => e.stopPropagation()}>
      {#if mode === 'menue'}
        <button class="item" onclick={() => (mode = 'passwort')}>Passwort ändern…</button>
        <button class="item" onclick={() => void abmelden()}>Abmelden</button>
      {:else}
        <input type="password" placeholder="Aktuelles Passwort" bind:value={altesPasswort} autocomplete="current-password" />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="password"
          placeholder="Neues Passwort (min. 8 Zeichen)"
          bind:value={neuesPasswort}
          autocomplete="new-password"
          onkeydown={(e) => {
            if (e.key === 'Enter') void passwortAendern();
            if (e.key === 'Escape') {
              e.stopPropagation();
              mode = 'menue';
            }
          }}
        />
        <div class="row">
          <button class="item" onclick={() => (mode = 'menue')}>Abbrechen</button>
          <button class="item" disabled={busy} onclick={() => void passwortAendern()}>OK</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .konto { position: relative; }
  .current { font-size: 13px; padding: 6px 12px; border-radius: 8px; border: none;
             background: rgba(255, 255, 255, .92); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  .menu { position: absolute; top: 36px; right: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: rgba(255, 255, 255, .97); box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
          display: flex; flex-direction: column; gap: 2px; }
  .item { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
          font-size: 13px; cursor: pointer; }
  .item:hover { background: #e8eefc; }
  .item:disabled { opacity: .5; cursor: default; }
  input { margin: 6px 6px 0; padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 4px; padding: 6px; }
</style>
```

- [ ] **Step 2: In Desktop.svelte einbinden**

Import ergänzen: `import AccountMenu from './AccountMenu.svelte';`
In der Toolbar (`<div class="toolbar">`) nach `<button onclick={fitAll}>Übersicht</button>` einfügen: `<AccountMenu />`

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` (122 grün), `npx svelte-check 2>&1 | tail -3` (0 neue Errors). Manuell gegen laufenden Server (`npm run server` + `npm run tauri dev`), als „pending user verification" in den Report:
1. Oben rechts erscheint der eigene Benutzername; Menü öffnet/schließt.
2. Passwort ändern mit falschem alten Passwort → Toast „Aktuelles Passwort ist falsch"; mit richtigem → „Passwort geändert", erneutes Anmelden mit neuem Passwort klappt.
3. Abmelden → Login-Maske; Neustart der App landet ebenfalls auf der Login-Maske (Session gelöscht).

```bash
git add src
git commit -m "feat: Konto-Menü mit Passwort ändern und Abmelden" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Benutzerverwaltung (Admin-Dialog)

**Files:**
- Create: `src/lib/components/UserAdmin.svelte`
- Modify: `src/lib/components/AccountMenu.svelte` (Menüeintrag + Dialog-Einbindung)

**Interfaces:**
- Consumes: Task 7 (`api.listUsers/createUser/renameUser/resetUserPassword/deleteUser/getUserDesks/createInvite/listInvites/revokeInvite`, `desktop.me`), Task 8 (AccountMenu).
- Produces: `UserAdmin.svelte` mit Prop `onClose: () => void`.

- [ ] **Step 1: UserAdmin.svelte anlegen**

```svelte
<script lang="ts">
  import { ask } from '@tauri-apps/plugin-dialog';
  import { desktop } from '../store.svelte';
  import { showToast } from '../ui.svelte';
  import type { InviteInfo, UserInfo } from '../api';

  let { onClose }: { onClose: () => void } = $props();

  let users = $state<UserInfo[]>([]);
  let invites = $state<InviteInfo[]>([]);
  let neuName = $state('');
  let neuPasswort = $state('');
  let aktion = $state<{ userId: string; art: 'umbenennen' | 'passwort' } | null>(null);
  let aktionWert = $state('');
  let neuerCode = $state<string | null>(null);
  let busy = $state(false);

  async function laden() {
    if (!desktop.api) return;
    try {
      users = await desktop.api.listUsers();
      invites = (await desktop.api.listInvites()).filter((i) => i.deskId === null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Laden fehlgeschlagen');
    }
  }
  void laden();

  async function kontoAnlegen() {
    if (!desktop.api || busy || !neuName.trim() || !neuPasswort) return;
    busy = true;
    try {
      await desktop.api.createUser(neuName.trim(), neuPasswort);
      neuName = '';
      neuPasswort = '';
      showToast('Konto angelegt');
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Anlegen fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function aktionAusfuehren() {
    if (!desktop.api || !aktion || busy || !aktionWert) return;
    busy = true;
    try {
      if (aktion.art === 'umbenennen') await desktop.api.renameUser(aktion.userId, aktionWert.trim());
      else await desktop.api.resetUserPassword(aktion.userId, aktionWert);
      showToast(aktion.art === 'umbenennen' ? 'Umbenannt' : 'Passwort zurückgesetzt');
      aktion = null;
      aktionWert = '';
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function loeschen(user: UserInfo) {
    if (!desktop.api || busy) return;
    try {
      const desks = await desktop.api.getUserDesks(user.id);
      const zusatz = desks.length
        ? `Folgende Schreibtische werden mitgelöscht: ${desks.map((d) => `„${d.name}"`).join(', ')}.`
        : 'Der Benutzer besitzt keine Schreibtische.';
      const ja = await ask(`Konto „${user.username}" löschen? ${zusatz}`, { title: 'Digital Desktop', kind: 'warning' });
      if (!ja) return;
      await desktop.api.deleteUser(user.id);
      showToast('Konto gelöscht');
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
    }
  }

  async function einladungErstellen() {
    if (!desktop.api || busy) return;
    busy = true;
    try {
      neuerCode = (await desktop.api.createInvite()).token;
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Einladung fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function widerrufen(token: string) {
    if (!desktop.api) return;
    try {
      await desktop.api.revokeInvite(token);
      if (neuerCode === token) neuerCode = null;
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Widerruf fehlgeschlagen');
    }
  }

  async function kopieren(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Code kopiert');
    } catch {
      showToast('Kopieren fehlgeschlagen — Code bitte markieren und kopieren');
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop" onpointerdown={onClose}></div>
<div class="dialog" onpointerdown={(e) => e.stopPropagation()}>
  <h2>Benutzerverwaltung</h2>

  <section>
    <h3>Konten</h3>
    {#each users as user (user.id)}
      <div class="zeile">
        <span class="name">{user.username}{user.isAdmin ? ' (Admin)' : ''}</span>
        {#if aktion?.userId === user.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            type={aktion.art === 'passwort' ? 'password' : 'text'}
            placeholder={aktion.art === 'umbenennen' ? 'Neuer Name' : 'Neues Passwort (min. 8 Zeichen)'}
            bind:value={aktionWert}
            onkeydown={(e) => {
              if (e.key === 'Enter') void aktionAusfuehren();
              if (e.key === 'Escape') {
                e.stopPropagation();
                aktion = null;
              }
            }}
          />
          <button onclick={() => void aktionAusfuehren()}>OK</button>
          <button onclick={() => (aktion = null)}>✕</button>
        {:else}
          <button onclick={() => { aktion = { userId: user.id, art: 'umbenennen' }; aktionWert = user.username; }}>Umbenennen</button>
          <button onclick={() => { aktion = { userId: user.id, art: 'passwort' }; aktionWert = ''; }}>Passwort</button>
          {#if user.id !== desktop.me?.id}
            <button class="gefahr" onclick={() => void loeschen(user)}>Löschen</button>
          {/if}
        {/if}
      </div>
    {/each}
    <div class="zeile neu">
      <input placeholder="Benutzername" bind:value={neuName} />
      <input type="password" placeholder="Anfangspasswort" bind:value={neuPasswort} />
      <button disabled={busy || !neuName.trim() || !neuPasswort} onclick={() => void kontoAnlegen()}>Neues Konto</button>
    </div>
  </section>

  <section>
    <h3>Konto-Einladungen</h3>
    {#if neuerCode}
      <div class="zeile code">
        <input readonly value={neuerCode} onfocus={(e) => (e.target as HTMLInputElement).select()} />
        <button onclick={() => void kopieren(neuerCode!)}>Kopieren</button>
      </div>
    {/if}
    {#each invites as invite (invite.token)}
      <div class="zeile">
        <span class="name mono">{invite.token.slice(0, 12)}… (gültig bis {new Date(invite.expiresAt).toLocaleDateString('de-DE')})</span>
        <button onclick={() => void widerrufen(invite.token)}>Widerrufen</button>
      </div>
    {/each}
    <div class="zeile neu">
      <button disabled={busy} onclick={() => void einladungErstellen()}>Einladung erstellen</button>
    </div>
  </section>

  <div class="fuss">
    <button onclick={onClose}>Schließen</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 9100; background: rgba(0, 0, 0, .35); }
  .dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 9101;
            width: 460px; max-height: 80vh; overflow: auto; padding: 20px; border-radius: 12px;
            background: rgba(255, 255, 255, .98); box-shadow: 0 16px 50px rgba(0, 0, 0, .45);
            display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 17px; }
  h3 { margin: 0 0 6px; font-size: 13px; color: #555; }
  section { display: flex; flex-direction: column; gap: 4px; }
  .zeile { display: flex; align-items: center; gap: 6px; }
  .zeile.neu { margin-top: 6px; }
  .name { flex: 1; font-size: 13px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  input { flex: 1; padding: 5px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; min-width: 0; }
  button { font-size: 12px; padding: 5px 9px; border-radius: 6px; border: none; background: #eef1f6; cursor: pointer; }
  button:hover { background: #e8eefc; }
  button:disabled { opacity: .5; cursor: default; }
  .gefahr { color: #b02a2a; }
  .code input { background: #f6f8e8; }
  .fuss { display: flex; justify-content: flex-end; }
</style>
```

- [ ] **Step 2: AccountMenu.svelte — Eintrag + Dialog**

Import und State ergänzen:

```ts
  import UserAdmin from './UserAdmin.svelte';
  let adminOffen = $state(false);
```

Im `menue`-Zweig VOR dem Abmelden-Button einfügen:

```svelte
        {#if desktop.me?.isAdmin}
          <button class="item" onclick={() => { adminOffen = true; open = false; }}>Benutzerverwaltung…</button>
        {/if}
```

Am Ende des Markups (nach dem schließenden `</div>` von `.konto`):

```svelte
{#if adminOffen}
  <UserAdmin onClose={() => (adminOffen = false)} />
{/if}
```

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` (122 grün), `npx svelte-check 2>&1 | tail -3` (0 neue Errors). Manuell („pending user verification"):
1. Menüeintrag „Benutzerverwaltung…" nur beim Admin sichtbar.
2. Konto anlegen → erscheint in der Liste; damit anmelden klappt (zweites Fenster/zweiter Login).
3. Umbenennen und Passwort-Reset wirken (Reset loggt den Betroffenen aus).
4. Löschen zeigt die Schreibtische des Benutzers im Bestätigungsdialog und entfernt das Konto.
5. Einladung erstellen → Code erscheint und lässt sich kopieren; Widerrufen entfernt ihn.

```bash
git add src
git commit -m "feat: Benutzerverwaltung — Admin-Dialog für Konten und Konto-Einladungen" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Teilen-Dialog & DeskSwitcher-Anpassungen

**Files:**
- Create: `src/lib/components/ShareDialog.svelte`
- Modify: `src/lib/components/DeskSwitcher.svelte`

**Interfaces:**
- Consumes: Task 7 (`api.listMembers/addMember/removeMember/listUsers/createInvite/listInvites/revokeInvite`, `desktop.me`, `desktop.leaveDesk`, `DeskInfo.ownerName/isOwner`).
- Produces: `ShareDialog.svelte` mit Props `desk: DeskInfo`, `onClose: () => void`. DeskSwitcher: fremde Desks mit „von …", Besitzer-Aktionen nur bei `isOwner`, sonst „Verlassen…"; neuer Eintrag „Teilen…".

- [ ] **Step 1: ShareDialog.svelte anlegen**

```svelte
<script lang="ts">
  import { desktop } from '../store.svelte';
  import { showToast } from '../ui.svelte';
  import type { DeskInfo, InviteInfo, MemberInfo, UserInfo } from '../api';

  let { desk, onClose }: { desk: DeskInfo; onClose: () => void } = $props();

  let members = $state<MemberInfo[]>([]);
  let users = $state<UserInfo[]>([]);
  let invites = $state<InviteInfo[]>([]);
  let auswahl = $state('');
  let neuerCode = $state<string | null>(null);
  let busy = $state(false);

  const kandidaten = $derived(
    users.filter((u) => u.id !== desk.ownerId && !members.some((m) => m.id === u.id)),
  );

  async function laden() {
    if (!desktop.api) return;
    try {
      members = await desktop.api.listMembers(desk.id);
      users = await desktop.api.listUsers();
      invites = (await desktop.api.listInvites()).filter((i) => i.deskId === desk.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Laden fehlgeschlagen');
    }
  }
  void laden();

  async function hinzufuegen() {
    if (!desktop.api || busy || !auswahl) return;
    busy = true;
    try {
      await desktop.api.addMember(desk.id, auswahl);
      auswahl = '';
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Hinzufügen fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function entfernen(member: MemberInfo) {
    if (!desktop.api) return;
    try {
      await desktop.api.removeMember(desk.id, member.id);
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen');
    }
  }

  async function einladungErstellen() {
    if (!desktop.api || busy) return;
    busy = true;
    try {
      neuerCode = (await desktop.api.createInvite(desk.id)).token;
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Einladung fehlgeschlagen');
    } finally {
      busy = false;
    }
  }

  async function widerrufen(token: string) {
    if (!desktop.api) return;
    try {
      await desktop.api.revokeInvite(token);
      if (neuerCode === token) neuerCode = null;
      await laden();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Widerruf fehlgeschlagen');
    }
  }

  async function kopieren(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Code kopiert');
    } catch {
      showToast('Kopieren fehlgeschlagen — Code bitte markieren und kopieren');
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="backdrop" onpointerdown={onClose}></div>
<div class="dialog" onpointerdown={(e) => e.stopPropagation()}>
  <h2>„{desk.name}" teilen</h2>

  <section>
    <h3>Mitglieder</h3>
    {#if members.length === 0}
      <p class="leer">Noch keine Mitglieder.</p>
    {/if}
    {#each members as member (member.id)}
      <div class="zeile">
        <span class="name">{member.username}</span>
        <button onclick={() => void entfernen(member)}>✕</button>
      </div>
    {/each}
    <div class="zeile neu">
      <select bind:value={auswahl}>
        <option value="" disabled>Benutzer wählen…</option>
        {#each kandidaten as user (user.id)}
          <option value={user.username}>{user.username}</option>
        {/each}
      </select>
      <button disabled={busy || !auswahl} onclick={() => void hinzufuegen()}>Hinzufügen</button>
    </div>
  </section>

  <section>
    <h3>Einladungen für diesen Schreibtisch</h3>
    {#if neuerCode}
      <div class="zeile code">
        <input readonly value={neuerCode} onfocus={(e) => (e.target as HTMLInputElement).select()} />
        <button onclick={() => void kopieren(neuerCode!)}>Kopieren</button>
      </div>
    {/if}
    {#each invites as invite (invite.token)}
      <div class="zeile">
        <span class="name mono">{invite.token.slice(0, 12)}… (gültig bis {new Date(invite.expiresAt).toLocaleDateString('de-DE')})</span>
        <button onclick={() => void widerrufen(invite.token)}>Widerrufen</button>
      </div>
    {/each}
    <div class="zeile neu">
      <button disabled={busy} onclick={() => void einladungErstellen()}>Einladung erstellen</button>
    </div>
  </section>

  <div class="fuss">
    <button onclick={onClose}>Schließen</button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 9100; background: rgba(0, 0, 0, .35); }
  .dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 9101;
            width: 420px; max-height: 80vh; overflow: auto; padding: 20px; border-radius: 12px;
            background: rgba(255, 255, 255, .98); box-shadow: 0 16px 50px rgba(0, 0, 0, .45);
            display: flex; flex-direction: column; gap: 14px; }
  h2 { margin: 0; font-size: 17px; }
  h3 { margin: 0 0 6px; font-size: 13px; color: #555; }
  section { display: flex; flex-direction: column; gap: 4px; }
  .zeile { display: flex; align-items: center; gap: 6px; }
  .zeile.neu { margin-top: 6px; }
  .name { flex: 1; font-size: 13px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .leer { margin: 0; font-size: 12px; color: #888; }
  input, select { flex: 1; padding: 5px 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; font-size: 13px; min-width: 0; }
  button { font-size: 12px; padding: 5px 9px; border-radius: 6px; border: none; background: #eef1f6; cursor: pointer; }
  button:hover { background: #e8eefc; }
  button:disabled { opacity: .5; cursor: default; }
  .code input { background: #f6f8e8; }
  .fuss { display: flex; justify-content: flex-end; }
</style>
```

- [ ] **Step 2: DeskSwitcher.svelte anpassen**

Im `<script>`-Block: Import und State ergänzen —

```ts
  import ShareDialog from './ShareDialog.svelte';
  let teilenOffen = $state(false);
```

Neue Funktion `verlassen` (nach `loeschen`):

```ts
  async function verlassen() {
    if (!desktop.deskId || !aktiv) return;
    const ja = await ask(
      `„${aktiv.name}" verlassen? Du kannst wieder beitreten, wenn dich der Besitzer erneut hinzufügt.`,
      { title: 'Digital Desktop', kind: 'warning' },
    );
    if (ja) {
      await desktop.leaveDesk(desktop.deskId);
      open = false;
    }
  }
```

Im Markup, `liste`-Modus: die Desk-Zeile ersetzen durch

```svelte
        {#each desktop.desks as desk (desk.id)}
          <button class="item" onclick={() => { void desktop.switchDesk(desk.id); open = false; }}>
            {desk.id === desktop.deskId ? '✓ ' : ''}{desk.name}{desk.isOwner ? '' : ` · von ${desk.ownerName}`}
          </button>
        {/each}
```

und den Aktionen-Block (`Neuer Schreibtisch…`/`Umbenennen…`/`Löschen…`) ersetzen durch:

```svelte
        <hr />
        <button class="item" onclick={startNeu}>Neuer Schreibtisch…</button>
        {#if aktiv?.isOwner}
          <button class="item" onclick={startUmbenennen}>Umbenennen…</button>
          <button class="item" onclick={() => { teilenOffen = true; open = false; }}>Teilen…</button>
          <button class="item gefahr" onclick={() => void loeschen()}>Löschen…</button>
        {:else if aktiv}
          <button class="item gefahr" onclick={() => void verlassen()}>Verlassen…</button>
        {/if}
```

Am Ende des Markups (nach dem schließenden `</div>` von `.switcher`):

```svelte
{#if teilenOffen && aktiv}
  <ShareDialog desk={aktiv} onClose={() => (teilenOffen = false)} />
{/if}
```

- [ ] **Step 3: Verifizieren & committen**

Run: `npm test` (122 grün), `npx svelte-check 2>&1 | tail -3` (0 neue Errors). Manuell mit zwei Konten/zwei Fenstern („pending user verification"):
1. Besitzer: „Teilen…" → Mitglied hinzufügen; beim Mitglied erscheint der Desk in der Liste mit „von …".
2. Mitglied bearbeitet Karten live; „Umbenennen/Löschen/Teilen" fehlen dort, stattdessen „Verlassen…".
3. Besitzer entfernt das Mitglied, während es den Desk offen hat → Toast „Zugriff wurde entzogen", Wechsel zum eigenen Schreibtisch.
4. Besitzer löscht den geteilten Desk, während das Mitglied ihn offen hat → Toast „Schreibtisch wurde gelöscht", Ausweichen.
5. Desk-Einladung erstellen → Code kopierbar; Widerruf entfernt ihn.

```bash
git add src
git commit -m "feat: Teilen-Dialog und DeskSwitcher — Mitglieder, Desk-Einladungen, geteilte Desks mit Verlassen" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Login-Maske — Einladung einlösen

**Files:**
- Modify: `src/lib/components/LoginScreen.svelte`

**Interfaces:**
- Consumes: Task 7 (`api.inviteInfo`, `api.redeem`).
- Produces: dritter Modus „Einladung einlösen" (Server-URL + Code → Vorab-Prüfung mit Desk-Hinweis → Benutzername + Passwort → direkt eingeloggt).

- [ ] **Step 1: LoginScreen.svelte erweitern**

Im `<script>`-Block ergänzen:

```ts
  let modus = $state<'anmelden' | 'einladung'>('anmelden');
  let code = $state('');
  let deskName = $state<string | null>(null);
  let codeGeprueft = $state(false);

  async function codePruefen(): Promise<void> {
    error = '';
    codeGeprueft = false;
    deskName = null;
    if (!code.trim()) return;
    try {
      deskName = (await new ApiClient(serverUrl).inviteInfo(code.trim())).deskName;
      codeGeprueft = true;
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Server nicht erreichbar — URL prüfen';
    }
  }

  async function einloesen(): Promise<void> {
    busy = true;
    error = '';
    try {
      const api = new ApiClient(serverUrl);
      await api.redeem(code.trim(), username, password);
      const session = { serverUrl, token: api.token! };
      await saveSession(session);
      await onConnected(session);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Verbindung fehlgeschlagen';
    } finally {
      busy = false;
    }
  }

  function modusWechseln(neu: 'anmelden' | 'einladung'): void {
    modus = neu;
    error = '';
    codeGeprueft = false;
    deskName = null;
  }
</script>
```

Das Formular-Markup (Inhalt von `.card`) ersetzen durch:

```svelte
  <form class="card" onsubmit={(e) => { e.preventDefault(); void (modus === 'anmelden' ? submit() : einloesen()); }}>
    <h1>Digital Desktop</h1>
    <label>Server-URL
      <input bind:value={serverUrl} onblur={() => void (modus === 'anmelden' ? checkServer() : codePruefen())} placeholder="http://192.168.1.10:4810" />
    </label>
    {#if modus === 'anmelden'}
      {#if needsSetup}<p class="hint">Ersteinrichtung: Lege das erste Konto an (Passwort min. 8 Zeichen).</p>{/if}
      <label>Benutzername <input bind:value={username} autocomplete="username" /></label>
      <label>Passwort <input type="password" bind:value={password} autocomplete="current-password" /></label>
      {#if error}<p class="error">{error}</p>{/if}
      <button disabled={busy || !serverUrl || !username || !password}>
        {needsSetup ? 'Konto anlegen' : 'Anmelden'}
      </button>
      <button type="button" class="link" onclick={() => modusWechseln('einladung')}>Ich habe einen Einladungscode</button>
    {:else}
      <label>Einladungscode
        <input bind:value={code} onblur={() => void codePruefen()} placeholder="Code aus der Einladung" />
      </label>
      {#if codeGeprueft}
        <p class="hint">{deskName ? `Du wirst zu Schreibtisch „${deskName}" eingeladen.` : 'Einladung gültig — wähle Benutzername und Passwort.'}</p>
      {/if}
      <label>Wunsch-Benutzername <input bind:value={username} autocomplete="username" /></label>
      <label>Passwort (min. 8 Zeichen) <input type="password" bind:value={password} autocomplete="new-password" /></label>
      {#if error}<p class="error">{error}</p>{/if}
      <button disabled={busy || !serverUrl || !code.trim() || !username || !password}>Einladung einlösen</button>
      <button type="button" class="link" onclick={() => modusWechseln('anmelden')}>Zurück zur Anmeldung</button>
    {/if}
  </form>
```

Im `<style>`-Block ergänzen:

```css
  .link { background: none; color: #2c5aa0; font-size: 12px; padding: 2px; cursor: pointer; border: none; }
```

- [ ] **Step 2: Verifizieren & committen**

Run: `npm test` (122 grün), `npx svelte-check 2>&1 | tail -3` (0 neue Errors). Manuell („pending user verification"):
1. „Ich habe einen Einladungscode" → Code einfügen (aus Task 9/10) → Hinweis erscheint (mit Desk-Name bei Desk-Einladung).
2. Benutzername + Passwort → direkt eingeloggt; bei Desk-Einladung ist der geteilte Schreibtisch in der Liste.
3. Denselben Code erneut einlösen → Fehlermeldung „Einladung ist ungültig oder abgelaufen".
4. Ungültiger Code → Fehlermeldung, kein Konto entstanden.

```bash
git add src
git commit -m "feat: Einladungscode in der Login-Maske einlösen — Konto anlegen und direkt anmelden" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
