<!-- GSD:project-start source:PROJECT.md -->

## Project

**J-DESK**

J-DESK ist die visuelle juristische Arbeitsebene zwischen Akte, Anwalt und KI: ein digitaler Schreibtisch, auf dem Juristen Dokumente aus j-lawyer ausbreiten, annotieren, verknüpfen und zu belastbaren Arbeitsergebnissen verdichten. Bisher mit Superpowers-Workflow gebaut (Fundament fertig: Ausbreiten, Bearbeiten, Werkzeuge, Live-Sync, j-lawyer-Anbindung, MCP lesend, Glass-UI); dieses GSD-Projekt führt es zur technischen Produktreife, damit Dritte (externe Kanzleien) produktiv damit arbeiten können.

**Core Value:** J-DESK muss jederzeit beantworten können: **Welche Behauptung wird durch welche konkrete Fundstelle belegt, welche Gegenposition besteht, was ist noch offen und welches verwertbare Arbeitsergebnis entsteht daraus?** — ohne dass Daten verloren gehen, Herkunft unklar wird oder interne Notizen versehentlich nach außen gelangen.

### Constraints

- **Tech stack**: Svelte 5 / SvelteKit + Fastify + SQLite + TypeScript-Monorepo — Evolution statt Rewrite (Canvas-Entscheidung `docs/architecture/canvas-decision.md`)
- **Dependencies**: j-lawyer bleibt führendes System für Akten und Originaldokumente; J-DESK referenziert, dupliziert nicht („kein Schatten-DMS")
- **Security**: Vertraulichkeit ist fachlich kritisch — interne Annotationen dürfen nie ungewollt in Exporte oder an andere Nutzer gelangen; Schwärzungen müssen echt schwärzen
- **Compatibility**: j-lawyer-Versionskompatibilität muss geprüft und kommuniziert werden; bestehende SQLite-Datenbanken müssen migrierbar bleiben (Lehre aus dem user_version-Vorfall e410538)
- **Quality**: Bewährtes Verifikationsniveau halten (Unit + E2E + UAT); aktuell 558 Tests grün

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript ~5.6.2 - Core language for all packages and client code
- JavaScript - Configuration files and dynamic imports
- Node.js 22 (specified in `packages/server/Dockerfile`) - Server runtime
- Browser (modern, ES2020+) - Client runtime

## Runtime

- Node.js 22 (multi-stage Docker build: Node 22-slim)
- npm - Workspace-based monorepo (root + 3 packages)
- Lockfile: `package-lock.json` (present)

## Frameworks

- SvelteKit 2.9.0 - Full-stack web framework (root, compiles to static SPA)
- Svelte 5.0.0 - Component framework (reactive, `.svelte` files)
- Fastify 5.0.0 - HTTP server framework (`packages/server`)
- @fastify/cors 10.0.0 - CORS handling
- @fastify/multipart 9.0.0 - Multipart form data (file uploads)
- @fastify/websocket 11.0.0 - WebSocket support
- @fastify/static 10.1.0 - Static file serving
- @modelcontextprotocol/sdk 1.12.0 - MCP server framework (`packages/mcp`)
- express 4.21.0 - HTTP routing wrapper for MCP
- StreamableHTTPServerTransport - Stateless HTTP transport for MCP
- Vitest 4.1.10 - Unit/integration test runner (`vitest.config.ts`)
- fake-indexeddb 6.2.5 - IndexedDB polyfill for tests
- Vite 6.0.3 - Build tool and dev server
- @sveltejs/vite-plugin-svelte 5.0.0 - Svelte integration for Vite
- @sveltejs/adapter-static 3.0.6 - Static site adapter (SPA mode with index.html fallback)
- @sveltejs/kit 2.9.0 - SvelteKit framework
- tsx 4.19.0 - TypeScript runtime (used in dev scripts and Docker CMD)
- svelte-check 4.0.0 - Type-checking for Svelte components
- Not explicitly configured - No ESLint or Prettier config files detected at root level

## Key Dependencies

- better-sqlite3 11.0.0 - SQLite3 database driver (server-side, WAL mode enabled, type definitions via @types/better-sqlite3 7.6.0)
- pdfjs-dist 5.6.205 - PDF.js for client-side PDF parsing and thumbnail generation
- argon2 0.41.0 - Argon2id password hashing (async timing-safe)
- node:crypto (built-in) - UUID generation, HMAC-SHA256 for JWT signing, secure random token generation
- fflate 0.8.3 - Fast Gzip/Deflate compression (used for `.jdesk` export format)
- zod 3.25.0 - TypeScript-first schema validation (MCP config)
- @j-desk/core 0.1.0 - Shared state logic (used by server, client, and MCP)
- @types/better-sqlite3 7.6.0 - Type definitions
- @types/express 4.17.21 - Type definitions
- @types/ws 8.5.0 - WebSocket type definitions
- ws 8.18.0 - WebSocket client (dev dependency for testing)
- typescript ~5.6.2 - TypeScript compiler
- svelte-check 4.0.0 - Svelte type checker
- vitest 4.1.10 - Test runner
- fake-indexeddb 6.2.5 - IndexedDB mock for testing

## Build Output

- Built to `build/` directory (static SPA)
- Served by Fastify under `/` (via @fastify/static after index.html routing)
- Entry: `build/index.html` (SPA fallback)
- Runs from `packages/server/src/main.ts` (tsx runtime)
- Compiles/loads TypeScript on-demand (tsx watches and recompiles)

## Configuration

- `PORT` (default: 4810) - HTTP server port
- `DATA_DIR` (default: `./data`) - SQLite database and file storage
- `WEB_DIR` (default: `build/`) - Path to static web app
- `EUROOFFICE_URL` - Euro-Office DocumentServer base URL (optional, enables preview conversion)
- `EUROOFFICE_JWT_SECRET` - Shared JWT secret for DocumentServer (optional, required if EUROOFFICE_URL set)
- `PUBLIC_URL` (default: `http://localhost:4810`) - Base URL for DocumentServer to reach this server
- `JLAWYER_URL` (optional) - j-lawyer REST API base URL (activates j-lawyer mode)
- `ANYMIZE_API_KEY` (required) - API key for Anymize anonymization service
- `ANYMIZE_API_URL` (default: `https://app.anymize.ai`) - Anymize API endpoint
- `MCP_PORT` (default: 4820) - MCP server port
- `DESK_SERVER_URL` (default: `http://localhost:4810`) - Digital Desktop server URL
- `MCP_ALLOW_DEANONYMIZE` (default: `true`) - Allow deanonymization operations
- `vite.config.js` - Vite/SvelteKit build config (SPA mode, API proxy to :4810)
- `svelte.config.js` - SvelteKit config (static adapter with index.html fallback)
- `tsconfig.json` - TypeScript compiler options (strict mode, ES modules)
- `vitest.config.ts` - Test runner config (node environment, test file globs)
- `packages/server/Dockerfile` - Multi-stage build (web build → slim runtime)
- Node 22-slim base image
- Ports: 4810 (default)
- Volume: `/data` (persistent SQLite database and files)

## Platform Requirements

- Node.js 22 (or compatible)
- npm 10+ (workspace support)
- Node.js 22 runtime (or container runtime)
- 1 GB+ RAM (typical), 5+ GB storage (data directory growth)
- Filesystem access (SQLite WAL files, PDF file storage)
- (Optional) Euro-Office DocumentServer 23+ for preview conversion
- (Optional) j-lawyer instance for case integration
- (Optional) Anymize API access for anonymization (MCP)
- For DocumentServer conversion: must be network-reachable from Digital Desktop server
- For j-lawyer integration: must be network-reachable from Digital Desktop server
- For MCP Anymize: must reach `app.anymize.ai` (configurable)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Lowercase with hyphens for multi-word names: `ink-colors.ts`, `file-cache.ts`
- Test files suffixed with `.test.ts`: `debounce.test.ts`
- Svelte stores suffixed with `.svelte.ts`: `ui.svelte.ts`, `store.svelte.ts`
- camelCase for all functions: `debounce()`, `addDoc()`, `erwartungAus()`
- Action verbs preferred: `besuche()` (visitor pattern), `reaktionFuer()`
- German names used throughout (matches domain language): `beschreibe()`, `findeObjekt()`
- camelCase: `state`, `deskId`, `reconnectTimer`
- Single-letter abbreviations for loop/temp variables: `s` (state), `d` (doc), `st` (stack), `p` (payload)
- Descriptive for longer scope: `revoked`, `objectUrlCounter`, `fetchFile`
- PascalCase for type names: `Conflict`, `DesktopState`, `Debounced<T>`
- PascalCase for interface names: `DeskInfo`, `DeskState`, `ApiError`
- Type imports use `type` keyword: `import type { Command, DesktopState } from '@j-desk/core'`
- UPPERCASE for configuration/lookup tables: `STABILO_COLORS`, `PEN_COLORS`, `CARD_W`, `CARD_H`
- UPPERCASE for static sets: `WIEDERHOLEN` (Set of command types)
- Descriptive names for record maps: `TEXTE` (text translations), `handlers` (command handler map)

## Code Style

- Spaces for indentation (2 spaces)
- No trailing commas in most cases; added for clarity in multi-line structures
- Line wrapping at reasonable lengths (observable ~100-120 characters)
- TypeScript strict mode enabled: `strict: true` in `tsconfig.json`
- Type checking enforced: `checkJs: true`
- ESLint configuration not explicitly configured (may use IDE defaults)
- Explicit return types on functions: `function erwartungAus(state: DesktopState, payload: Command['payload']): Erwartet | undefined`
- Type parameters in generics: `function debounce<T extends unknown[]>(ms: number, fn: (...a: T) => void): Debounced<T>`
- Type narrowing in conditionals: `if (typeof v === 'string')`

## Import Organization

- `@j-desk/core` — core domain logic package
- `@j-desk/server` — server package
- `@j-desk/mcp` — MCP integration package
- `$lib` — Svelte Kit alias for `src/lib`
- Named imports preferred: `import { uid } from '@j-desk/core'`
- Type-only imports: `import type { DesktopState, Vec2 } from './model'`
- Destructuring with comments for clarity: `const { idbPut, FILE_STORE } = await import('./idb')`

## Error Handling

- Custom Error subclasses for domain errors:
- Helper validators with descriptive errors: `id()`, `text()`, `vec()`, `num()`, `size()` (`packages/core/src/commands.ts:27-65`)
- Each validator throws `CommandError` with German field name and expected type
- Optional field validators return undefined: `optId()`, `optStr()`
- Wrapping pattern for exception normalization:
- Graceful degradation for non-critical operations: `try { localStorage.setItem(...) } catch { /* ... */ }` (`src/lib/inkColors.ts:24`)
- Comments explain why failure is acceptable

## Logging

- No debug logging found in application code
- Comments used instead for explaining complex logic
- Console available for browser dev tools

## Comments

- Explain the "why" not the "what": `// Queryformat: liegende Karte, gleiche Fläche (Maße getauscht)` versus repeating code
- Business rule justification: K4 pattern explanation in `konflikt.ts:51-55`
- Design decisions: `// Die letzte Position gewinnt` for position-based commands
- Backwards compatibility notes: `// Doc-Viewer-Felder (Abwärtskompatibilität)` in tests
- Used for exported functions: `/** Zuletzt gewählte Farbe des Werkzeugs; unbekannte/fremde Werte fallen auf den Default zurück. */`
- Brief one-liner descriptions
- No `@param` or `@returns` tags observed (type annotations serve this purpose)

## Function Design

- Small, focused functions: `docBox()` (~8 lines), `reaktionFuer()` (~3 lines)
- Maximum complexity ~40-50 lines for core logic functions
- Required parameters come first
- Optional parameters at end or in options object
- Type parameters for generics: `function debounce<T extends unknown[]>(...)`
- Payload/data object for command handlers: `(s: DesktopState, p: Record<string, unknown>, m?: CommandMeta)`
- Explicit return types always
- Immutable state returns: functions return new DesktopState, never mutate input
- Optional returns indicated in type: `(...): Erwartet | undefined`
- Consistent return structure in unions: `{ kind: 'doc' | 'stack'; id: string } | null`

## Module Design

- Named exports preferred: `export function addDoc(...)`
- Re-export patterns for public API: `export { uid } from '@j-desk/core'` (`src/lib/uid.ts`)
- Type exports: `export type { Debounced, ... }`
- Const exports for configuration: `export const STABILO_COLORS: readonly string[] = [...]`
- Not observed in this codebase; imports reference specific modules
- Each module exports its own types and functions
- All state transformations use spread operator: `{ ...s, docs: [...] }`
- No mutation of input objects
- Immutable arrays where appropriate: `readonly string[]`

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **Svelte Components** | Render UI, capture user interactions, display animations | `src/lib/components/*.svelte` |
| **State Store** | Maintain `DesktopState`, orchestrate command dispatch, WebSocket lifecycle | `src/lib/store.svelte.ts` |
| **API Client** | Serialize commands to JSON, manage HTTP requests, handle 409 conflicts | `src/lib/api.ts` |
| **Fastify App** | Route registration, middleware, auth enforcement, error responses | `packages/server/src/app.ts` |
| **Auth** | User creation/login/logout, token validation, session management | `packages/server/src/auth.ts` |
| **Desk Store** | Command application, state mutations, conflict detection, versioning | `packages/server/src/deskStore.ts` |
| **Core Commands** | Pure state transformations (immutable), validation | `packages/core/src/commands.ts` |
| **Model** | Type definitions for `DesktopState`, `Doc`, `Stack`, `Link`, annotations | `packages/core/src/model.ts` |
| **Database** | Schema, migrations, queries for desks/users/files/journal | `packages/server/src/db.ts` |

## Pattern Overview

- **Command sourcing**: Every state change is a discrete `Command` object (add doc, move stack, create annotation)
- **Optimistic UI**: Client applies commands locally immediately; server confirms or rejects asynchronously
- **Conflict detection**: Server version (`rev`) and per-object `updatedRev` enable 409 Conflict responses on concurrent edits
- **WebSocket broadcasting**: Clients receive peer edits in real time via WebSocket
- **Provenance tracking**: Every command/object stamped with `createdBy`/`createdAt`/`updatedBy`/`updatedAt` for audit trail
- **Immutable state snapshots**: `DesktopState` treated as value (never mutated in place; always replaced)
- **Monorepo with shared core**: `@j-desk/core` used by frontend, server, and MCP server

## Layers

- Purpose: User interface and local state orchestration
- Location: `src/`, `src/lib/`, `src/lib/components/`
- Contains: Svelte components, reactive stores, API client, session management, local caches
- Depends on: `@j-desk/core` (types and utilities)
- Used by: User (browser)
- Purpose: Orchestrate desktop state, command dispatch, WebSocket lifecycle, UI notifications
- Location: `src/lib/store.svelte.ts`, `src/lib/ui.svelte.ts`, `src/lib/session.ts`
- Contains: Reactive state (`$state`), command queuing, conflict resolution logic, desk switching
- Depends on: API client, core domain types
- Used by: Svelte components
- Purpose: HTTP/WebSocket bridge between frontend and backend
- Location: `src/lib/api.ts`
- Contains: REST methods (login, getState, applyCommand), WebSocket lifecycle, error parsing
- Depends on: Core types (`Command`, `DesktopState`, `Konflikt`)
- Used by: State store
- Purpose: Request validation, authorization, response formatting
- Location: `packages/server/src/app.ts`
- Contains: Fastify route definitions (REST + WebSocket upgrade)
- Depends on: Auth, deskStore, file management, format conversion
- Used by: API client (HTTP) and WebSocket clients
- Purpose: Apply commands to state, detect conflicts, persist to database
- Location: `packages/server/src/deskStore.ts`
- Contains: `applyDeskCommand()` (calls core engine), `putDeskState()` (persistence), conflict detection
- Depends on: Core command engine, database, journal
- Used by: App routes
- Purpose: Pure state transformation, validation, domain logic
- Location: `packages/core/src/` (53 TypeScript modules)
- Contains: `applyCommand()` (immutable state machine), model types, geometry, ink, annotations, document operations
- Depends on: Nothing (zero external deps)
- Used by: Frontend store, backend deskStore, MCP server
- Purpose: Durability, multi-user coordination
- Location: `packages/server/src/db.ts`
- Contains: SQLite schema (desks, files, users, journal entries), migrations, prepared statements
- Depends on: better-sqlite3
- Used by: deskStore, auth, file management, backup
- Purpose: Upload/download/classify documents, store originals and previews
- Location: `packages/server/src/files.ts`
- Contains: File classification (PDF, image, Office, etc.), file kind detection, storage paths
- Depends on: File system, file-type library
- Used by: App routes, preview converter
- **j-lawyer**: `packages/server/src/jlawyer.ts` — REST API sync for case/document retrieval
- **File Conversion**: `packages/server/src/convert.ts` — Bridge to Euro-Office DocumentServer for file preview
- **MCP**: `packages/mcp/src/` — Claude integration (tools for read/write desk state)

## Data Flow

### Primary Request Path (Client Command Dispatch)

- `409 Conflict`: State changed since expectation. Client UI prompts user (auto-retry or manual merge)
- `401 Unauthorized`: Token invalid or expired. Client clears session, redirects to login

### WebSocket (Real-Time Sync)

### j-lawyer Sync (Background)

### File Preview Conversion

## Key Abstractions

- Purpose: Immutable representation of a single state change
- Examples: `AddDocCommand`, `MoveDocCommand`, `CreateAnnotationCommand`
- Pattern: Tagged union (discriminated by `kind` field)
- Location: `packages/core/src/commands.ts`
- Purpose: Complete snapshot of a desk at a point in time
- Contents: docs[], links[], stacks[], strokes[], notes[], cutouts[], marks[], stamps[], flags[], clips[], trash[]
- Pattern: Immutable value type (never mutated in place)
- Location: `packages/core/src/model.ts`
- Purpose: Detect concurrent edits and present user with merge UI
- Fields: `erwartet` (snapshot before command), `aktuell` (conflicting state from server)
- Pattern: Stored in 409 response body; drives `KonfliktOverlay` component
- Location: `packages/core/src/konflikt.ts`
- Purpose: Provenance — track who made each change
- Fields: `id` (user ID), `name` (username or 'unbekannt')
- Usage: Stamped on every command, document, and journal entry
- Location: `packages/server/src/app.ts:actorFromRequest()`
- Purpose: Classify document type for display and preview
- Values: `'pdf' | 'image' | 'convertible' | 'other'`
- Usage: Determines whether preview is raw file or converted PDF
- Location: `packages/core/src/model.ts`

## Entry Points

- Location: `src/routes/+page.svelte`
- Triggers: Browser load
- Responsibilities: Load session, initialize API client, start WebSocket, render LoginScreen or Desktop
- Location: `packages/server/src/main.ts`
- Triggers: `npm run dev -w @j-desk/server` or Docker start
- Responsibilities: Open database, initialize Fastify app, listen on port, handle setup rebuild
- Location: `packages/mcp/src/main.ts`
- Triggers: `npm run dev -w @j-desk/mcp`
- Responsibilities: Establish stdio channel, register MCP tools for desk read/write

## Architectural Constraints

- **Threading:** Single-threaded Node.js event loop (Fastify). No worker threads. SQLite transactions serialized by `better-sqlite3`.
- **Global state:** WebSocket ticket map (`wsTickets`), file ticket map (`fileTickets`), conversion error cache (`previewErrors`), j-lawyer credential cache (`jlCreds`) — all in-memory on Fastify instance. Lost on server restart.
- **Circular imports:** None detected (monorepo structure and TypeScript strict mode prevent them).
- **State immutability:** `DesktopState` and `Command` objects are immutable; replacements via `$state()` in store.
- **Browser compatibility:** SPA runs in modern browsers with ES2020 support (Svelte 5, built by Vite).
- **Database:** SQLite with WAL mode for concurrent readers; single writer (lock serializes commands).

## Anti-Patterns

### Large .svelte Files

### Missing Conflict Handling in Some Flows

### Mutating Command Payload in Place

### Unhandled WebSocket Reconnection

## Error Handling

- **HTTP errors:** Parsed to `ApiError` with status code and optional `konflikt` payload (409); client checks status before retrying
- **Auth errors (401):** Logged out session cleared; user redirected to login
- **Conflict errors (409):** `KonfliktOverlay` component shown; user chooses merge strategy
- **Conversion errors:** Cached in `previewErrors` map; returned as 409 on retry; user sees toast notification
- **Database errors:** Caught by `applyDeskCommand()`, logged to console, returned as 500 (should not happen in normal operation)

## Cross-Cutting Concerns

- Frontend: Console logs for development; no persistent log
- Backend: Console logs via `console.log()` and `console.error()` (no external logger configured)
- Audit: Journal table in database (command-scoped)
- Frontend: Basic JS type checks and UI constraints (e.g., no empty desk name)
- Backend: Route handlers validate request body, command structure, desk ownership
- Core: `applyCommand()` validates state transitions (e.g., can't move non-existent doc)
- Token stored in browser localStorage (via `session.ts`)
- Token sent as Bearer header or WebSocket query param (ticket)
- Token validated against `tokens` table in database on each request
- j-lawyer mode: credentials validated against j-lawyer REST API on login; stored in `jlCreds` Map (in-memory)
- User ownership: Desk scoped to owner (or shared in j-lawyer mode)
- Public paths: `/api/v1/auth/status`, `/api/v1/auth/login`, `/api/v1/auth/setup`, `/api/v1/setup/*`, `/api/v1/convert-source/*`
- Protected paths: All other `/api/v1/*` paths require valid Bearer token
- Optimistic locking: Client sends expectations; server rejects if state changed
- Serialized writes: SQLite `better-sqlite3` blocks concurrent writers
- Read consistency: Clients see eventual consistency via WebSocket broadcasts

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
