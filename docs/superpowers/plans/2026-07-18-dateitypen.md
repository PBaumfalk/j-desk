# Dateitypen-Runde Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bilder nativ darstellen, ODT/DOCX & Co. als Vorschau-PDF via Euro-Office DocumentServer, alle übrigen Typen als generische Karten — Upload wird generisch („＋"-Menü).

**Architecture:** `kind`-Klassifizierung serverseitig (Magic-Bytes), Vorschau-PDF-Konvertierung in gekapseltem `convert.ts` (OnlyOffice-kompatible ConvertService-API, JWT, Einmal-Ticket-Quell-URL, Platten-Cache), Client verzweigt in DocCard/DocViewer nach `kind`; die gesamte Werkzeug-Pipeline arbeitet unverändert auf der Vorschau.

**Tech Stack:** TypeScript strict, Vitest, Fastify, node:crypto (HS256-JWT selbst, KEINE neue Dependency), SvelteKit + Svelte 5, pdfjs-dist.

**Spec:** `docs/superpowers/specs/2026-07-18-dateitypen-design.md` — bei Widerspruch gilt der Spec.

## Global Constraints

- UI-Texte/Fehlermeldungen Deutsch, Bezeichner Englisch. Kein `Date.now()`/`Math.random()` im Core.
- Alte States laden unverändert: `Doc.kind` ist optional, Default-Semantik `'pdf'`.
- Original bleibt unangetastet (nicht destruktiv): `GET /files/:id` liefert weiterhin die Originalbytes; die Vorschau ist ein eigener Endpoint.
- Ohne `EUROOFFICE_URL`/`EUROOFFICE_JWT_SECRET` ist Konvertierung deaktiviert — `convertible` verhält sich wie `other`, nichts bricht.
- Keine neuen npm-Dependencies (JWT via node:crypto; Fake-DocumentServer via node:http nach dem Muster `testJLawyer.ts`).
- Kein Bearbeiten — reine Vorschau.
- Verifikation pro Task: `npm test` (Wurzel), bei UI-Tasks zusätzlich `npm run check` (0 Errors) und `npm run build`.
- Commits deutsch mit `feat:`/`fix:`/`test:`/`docs:`.

---

### Task 1: Core — `FileKind` und `Doc.kind`

**Files:**
- Modify: `packages/core/src/model.ts`, `packages/core/src/documents.ts` (addDoc), `packages/core/src/commands.ts` (addDoc-Handler), `packages/core/src/model.test.ts`, `packages/core/src/documents.test.ts`

**Interfaces:**
- Produces: `export type FileKind = 'pdf' | 'image' | 'convertible' | 'other';` (model.ts); `Doc.kind?: FileKind` (fehlend = `'pdf'`, Alt-State-Kompatibilität); `addDoc(s, fileId, name, position, id?, kind?)` — `kind` wird durchgereicht, ungültige Werte werfen `Unbekannte Datei-Art: …`; Command-Payload `addDoc { fileId, name, position, id?, kind? }`.

- [ ] **Step 1: Failing Tests** — in `documents.test.ts` ergänzen (bestehende Helfer der Datei nutzen):

```ts
it('addDoc übernimmt die Datei-Art; ungültige Art wirft', () => {
  const s = addDoc(emptyState(), 'f1', 'foto.jpg', { x: 0, y: 0 }, 'd1', 'image');
  expect(s.docs[0].kind).toBe('image');
  const ohne = addDoc(emptyState(), 'f2', 'a.pdf', { x: 0, y: 0 }, 'd2');
  expect(ohne.docs[0].kind).toBeUndefined(); // fehlend = pdf (Alt-State-Semantik)
  expect(() => addDoc(emptyState(), 'f3', 'x', { x: 0, y: 0 }, 'd3', 'exe' as never)).toThrow('Datei-Art');
});

it('addDoc-Command reicht kind durch', () => {
  const s = applyCommand(emptyState(), { type: 'addDoc', payload: { fileId: 'f1', name: 'foto.jpg', position: { x: 0, y: 0 }, id: 'd1', kind: 'image' } });
  expect(s.docs[0].kind).toBe('image');
});
```

Run: `npm test -w packages/core -- documents` → FAIL

- [ ] **Step 2: Implementierung**

`model.ts`:

```ts
/** Datei-Art einer Karte: bestimmt Darstellung und Vorschau-Weg. Fehlt in Alt-States (= pdf). */
export type FileKind = 'pdf' | 'image' | 'convertible' | 'other';
export const FILE_KINDS: readonly FileKind[] = ['pdf', 'image', 'convertible', 'other'];
```

`Doc` bekommt `kind?: FileKind;`. `documents.ts`:

```ts
export function addDoc(
  s: DesktopState, fileId: string, name: string, position: Vec2,
  id: string = uid(), kind?: FileKind,
): DesktopState {
  if (kind !== undefined && !FILE_KINDS.includes(kind)) throw new Error(`Unbekannte Datei-Art: ${String(kind)}`);
  if (s.docs.some((d) => d.fileId === fileId)) return s;
  const doc = { id, fileId, name, position, rotation: rotationFor(id), zIndex: maxZ(s) + 1, ...(kind !== undefined ? { kind } : {}) };
  return { ...s, docs: [...s.docs, doc] };
}
```

`commands.ts` addDoc-Handler: `addDoc(s, id(p.fileId, 'fileId'), text(p.name, 'name'), vec(p.position, 'position'), optId(p.id), p.kind as FileKind | undefined)` + `FileKind`-Typ-Import. `isValidState` braucht KEINE Änderung (kind ist optionales Feld auf Doc).

- [ ] **Step 3: Grün + Commit**

Run: `npm test -w packages/core` → PASS

```bash
git add packages/core/src
git commit -m "feat: Datei-Art (kind) am Dokument — pdf/image/convertible/other"
```

---

### Task 2: Server — Klassifizierung & generischer Upload

**Files:**
- Modify: `packages/server/src/files.ts`, `packages/server/src/db.ts` (Migration: Spalte `kind` in `files`), `packages/server/src/app.ts` (Upload-Routen liefern kind; addDoc mit kind)
- Test: `packages/server/src/files.test.ts` (erweitern), `packages/server/src/app.test.ts` (Upload-Antwort)

**Interfaces:**
- Produces: `export function classify(bytes: Buffer, name: string): FileKind` (files.ts) — Magic-Bytes zuerst (`%PDF-`→pdf; JPEG `FF D8 FF`, PNG `89 50 4E 47`, GIF `GIF8`, WebP `RIFF….WEBP` → image; ZIP `PK\x03\x04` → per Endung entschieden: .odt/.ods/.odp/.docx/.xlsx/.pptx → convertible, sonst other; sonst Endung: .rtf/.txt/.csv/.html/.htm/.eml → convertible; alles andere → other). `FileMeta` bekommt `kind: FileKind`. `storeFile` lehnt NUR leer/Größenlimit ab (PDF-Zwang entfällt), speichert unter `<sha256>.bin`-neutralem Namen? NEIN — Bestandsdateien liegen als `<sha256>.pdf`; NEUE Dateien werden als `<sha256>.<ext-aus-kind>`? Einfachste rückwärtskompatible Lösung: Dateiname bleibt `<sha256>.pdf`-Schema NUR für pdf; für andere `<sha256>.bin`; `getFilePath` probiert beide Suffixe. Die DB-Spalte `kind` (Migration, Default 'pdf' für Bestand) ist die Wahrheit.
- Upload-Antworten: `POST /files` → `{ fileId, kind }`; ApiClient-Anpassung kommt in Task 6.
- `app.ts`: der Standalone-Upload-Pfad übergibt beim `addDoc`-Command (Client sendet ihn — hier nur Doku); der j-lawyer-Upload (`POST /cases/:id/documents`) legt die Karte serverseitig an → dort `addDoc(state, …, kind)` mit `classify`-Ergebnis.

- [ ] **Step 1: Failing Tests** — `files.test.ts`:

```ts
it('klassifiziert nach Magic-Bytes und Endung', () => {
  expect(classify(Buffer.from('%PDF-1.4 x'), 'a.pdf')).toBe('pdf');
  expect(classify(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'foto.jpg')).toBe('image');
  expect(classify(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'bild.png')).toBe('image');
  expect(classify(Buffer.concat([Buffer.from('RIFF1234'), Buffer.from('WEBP')]), 'x.webp')).toBe('image');
  expect(classify(Buffer.from('PK\x03\x04rest'), 'brief.odt')).toBe('convertible');
  expect(classify(Buffer.from('PK\x03\x04rest'), 'tabelle.xlsx')).toBe('convertible');
  expect(classify(Buffer.from('PK\x03\x04rest'), 'archiv.zip')).toBe('other');
  expect(classify(Buffer.from('nur text'), 'notiz.txt')).toBe('convertible');
  expect(classify(Buffer.from('MZ…'), 'tool.exe')).toBe('other');
});

it('storeFile akzeptiert Nicht-PDFs und liefert kind; getFilePath findet sie', () => {
  const meta = storeFile(db, dataDir, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'foto.jpg');
  expect(meta.kind).toBe('image');
  expect(getFilePath(db, dataDir, meta.id)).toBeTruthy();
});

it('leere Datei und Größenlimit werfen weiterhin', () => { /* bestehende Fälle bleiben */ });
```

(Bestehende Tests, die die PDF-Ablehnung von Nicht-PDFs prüfen, werden zu Klassifizierungs-Erwartungen umgebaut — nicht gelöscht, sondern angepasst: aus „wirft" wird „kind === 'other'/'image'".) In `app.test.ts`: Upload-Route-Test erwartet `{ fileId, kind }`.

Run: `npm test -w packages/server -- files` → FAIL

- [ ] **Step 2: Implementierung**

`db.ts`: Migration im bestehenden `PRAGMA user_version`-Muster: `ALTER TABLE files ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf'`. `files.ts`: `classify` wie oben (Konstanten-Tabellen, keine Regex-Magie); `storeFile` ohne Endungs-/Magic-Zwang (nur leer/Größe), `kind = classify(bytes, originalName)`, Ablage `<sha256>.pdf` bei pdf, sonst `<sha256>.bin`; INSERT mit kind; Dedup-SELECT liefert kind mit. `getFilePath`: SELECT kind mit, Pfad je kind (`.pdf`/`.bin`), Fallback: wenn Datei fehlt, anderen Suffix probieren (Bestand). Neue Exporte: `classify`, `getFileMeta(db, fileId): FileMeta | null`.

`app.ts`: `POST /files`-Handler antwortet `{ fileId: meta.id, kind: meta.kind }`; j-lawyer-Upload-Pfad ruft nach erfolgreichem `createDocument` das `addDoc` mit `classify(bytes, filename)`-Ergebnis auf.

- [ ] **Step 3: Grün + Commit**

Run: `npm test -w packages/server` → PASS (Achtung: bestehende Tests, die PDF-Ablehnung erwarten, wurden in Step 1 angepasst)

```bash
git add packages/server/src
git commit -m "feat: generischer Upload mit Datei-Klassifizierung (Magic-Bytes + Endung)"
```

---

### Task 3: Server — Einmal-Ticket-Quelle für den Konverter

**Files:**
- Modify: `packages/server/src/auth.ts` (Ticket-Fabrik verallgemeinern ODER zweite Instanz), `packages/server/src/app.ts` (öffentliche Route + Hook-Ausnahme)
- Test: `packages/server/src/app.test.ts`

**Interfaces:**
- Produces: `createFileTickets()` — gleiche Mechanik wie `createWsTickets()` (60 s TTL, einmalig; Implementierung: die bestehende Fabrik in auth.ts parametrisieren oder kopieren — Muster der Datei folgen, Werte identisch bis auf TTL 60 s), Ticket trägt `{ fileId }`. Route `GET /api/v1/convert-source/:ticket` (KEINE Auth — Ticket IST die Auth): konsumiert das Ticket, streamt die Originalbytes der hinterlegten Datei (Standalone: `getFilePath`; j-lawyer: wird in Task 5 erweitert — hier nur Standalone), 404 bei ungültigem/verbrauchtem Ticket. Hook-Ausnahme: `path.startsWith('/api/v1/convert-source/')` → durchlassen (analog PUBLIC_PATHS; Kommentar: Ticket ersetzt Auth, einmalig + kurzlebig).
- Consumes (Task 4): `fileTickets.issue({ fileId })` → Ticket-String; `fileTickets.consume(t)` → `{ fileId } | null`.

- [ ] **Step 1: Failing Test** — `app.test.ts` (bestehende Upload-/Auth-Helfer nutzen):

```ts
it('convert-source: Einmal-Ticket liefert Originalbytes genau einmal, ohne Auth-Header', async () => {
  const fileId = await ladeTestPdfHoch(); // bestehendes Muster der Datei
  const ticket = app.fileTickets.issue({ fileId }); // Export für Tests: siehe Step 2
  const res1 = await app.inject({ method: 'GET', url: `/api/v1/convert-source/${ticket}` });
  expect(res1.statusCode).toBe(200);
  expect(res1.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  const res2 = await app.inject({ method: 'GET', url: `/api/v1/convert-source/${ticket}` });
  expect(res2.statusCode).toBe(404); // verbraucht
  const res3 = await app.inject({ method: 'GET', url: '/api/v1/convert-source/quatsch' });
  expect(res3.statusCode).toBe(404);
});
```

(Für den Testzugriff: `buildApp` hängt die Ticket-Fabrik als `app.decorate('fileTickets', fileTickets)` an — sauberer Fastify-Weg, auch von Task 4 genutzt.)

Run: `npm test -w packages/server -- app` → FAIL

- [ ] **Step 2: Implementierung** (auth.ts-Fabrik-Muster übernehmen; decorate; Route + Hook-Ausnahme wie oben)

- [ ] **Step 3: Grün + Commit**

```bash
git add packages/server/src
git commit -m "feat: Einmal-Ticket-Quelle für den Dokument-Konverter (convert-source)"
```

---

### Task 4: Server — `convert.ts` gegen Fake-DocumentServer

**Files:**
- Create: `packages/server/src/convert.ts`, `packages/server/src/testConvertServer.ts`
- Test: `packages/server/src/convert.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ConvertConfig { url: string; jwtSecret: string; }
export interface ConvertDeps {
  config: ConvertConfig | null;                    // null = deaktiviert
  /** Liefert eine vom DocumentServer erreichbare Quell-URL (Einmal-Ticket). */
  sourceUrl: (fileId: string) => string;
  dataDir: string;
}
export class ConvertError extends Error { constructor(message: string, readonly reason: 'disabled' | 'unavailable' | 'failed') { super(message); } }
export function createConverter(deps: ConvertDeps): {
  enabled(): boolean;
  /** Vorschau-PDF-Pfad; konvertiert beim ersten Aufruf (gecacht, In-Flight-dedupliziert). */
  ensurePreview(fileId: string, cacheKey: string, sourceName: string): Promise<string>;
};
export function signJwtHS256(payload: Record<string, unknown>, secret: string): string;  // node:crypto, base64url
```

- Ablauf `ensurePreview`: Cache-Pfad `join(dataDir, 'convcache', `${cacheKey}.pdf`)` — existiert → zurück. Sonst (In-Flight-Map pro cacheKey): POST `${config.url}/ConvertService.ashx`, JSON-Body `{ async: true, filetype: <ext aus sourceName>, outputtype: 'pdf', key: cacheKey, title: sourceName, url: sourceUrl(fileId), token: signJwtHS256(body ohne token, secret) }` UND Header `Authorization: Bearer ${signJwtHS256({ payload: body }, secret)}`, `Accept: application/json` — beide Signaturwege für OnlyOffice-Kompatibilität. Antwort `{ endConvert, percent, fileUrl?, error? }`; solange `!endConvert`: 500 ms warten, erneut (gleicher key; frisches Ticket via sourceUrl pro Versuch ist ok — der DS lädt die Quelle nur beim ersten Request), max. 60 s → `ConvertError('Konvertierung dauert zu lange', 'failed')`. `error`-Feld gesetzt → `ConvertError('Konvertierung fehlgeschlagen (Code …)', 'failed')`. `fileUrl` → herunterladen, atomar in den Cache schreiben (tmp+rename, Muster files.ts), Pfad zurück. HTTP-/Netzwerkfehler → `ConvertError('Vorschau-Dienst nicht erreichbar', 'unavailable')`. `config === null` → `ConvertError('Vorschau-Dienst nicht konfiguriert', 'disabled')`.
- `testConvertServer.ts` (node:http, Muster testJLawyer.ts): nimmt POSTs auf `/ConvertService.ashx` an, prüft JWT (verifiziert `token` mit dem Test-Secret; bei Fehlsignatur HTTP 403), antwortet konfigurierbar: sofort fertig / erst nach N Polls fertig / error-Code / gar nicht erreichbar; stellt `GET /result.pdf` (Mini-PDF-Bytes) und zeichnet die von uns übergebene Quell-URL auf, lädt sie einmal ab (damit der Ticket-Weg end-to-end läuft).

- [ ] **Step 1: Failing Tests** — `convert.test.ts` (Fake starten wie testJLawyer-Nutzung in jlawyer.test.ts):

```ts
it('konvertiert beim ersten Aufruf, cacht danach (kein zweiter DS-Kontakt)', …);
it('dedupliziert parallele ensurePreview-Aufrufe (ein DS-Request)', …);
it('pollt bei async-Antworten bis endConvert', …);
it('signiert mit JWT; der Fake lehnt falsche Signatur ab → unavailable/failed', …);
it('deaktiviert (config null) wirft ConvertError disabled', …);
it('DS nicht erreichbar wirft unavailable', …);
it('lädt die Quelle über die übergebene sourceUrl (Fake hat sie abgerufen)', …);
```

(Die `…`-Körper schreibt der Implementierer konkret nach dem Vertragsmuster oben — Assertions je Fall: Rückgabepfad existiert + ist PDF; Fake-Request-Zähler; ConvertError.reason.)

Run: `npm test -w packages/server -- convert` → FAIL (Modul fehlt)

- [ ] **Step 2: Implementierung wie im Vertrag; Step 3: Grün + Commit**

```bash
git add packages/server/src
git commit -m "feat: Euro-Office-Konvertierung (convert.ts) — JWT, Polling, Cache, Fake-DocumentServer"
```

---

### Task 5: Server — Preview-Route + j-lawyer-Integration

**Files:**
- Modify: `packages/server/src/app.ts` (Route `GET /api/v1/files/:id/preview` in BEIDEN Modi; Konverter-Verdrahtung; j-lawyer-Abgleich setzt kind; convert-source liefert im jl-Modus Akteninhalt)
- Modify: `packages/server/src/main.ts` (Env `EUROOFFICE_URL`/`EUROOFFICE_JWT_SECRET` → ConvertConfig)
- Test: `packages/server/src/app.test.ts`, `packages/server/src/jlawyer.test.ts`

**Interfaces:**
- `buildApp`-Options: `convert?: ConvertConfig | null`. Konverter-Instanz: `createConverter({ config, sourceUrl: (fileId) => `${eigeneBasisUrl}/api/v1/convert-source/${fileTickets.issue({ fileId })}`, dataDir })`. Eigene Basis-URL: neue Option `publicUrl?: string` (Default `http://localhost:${PORT}` in main.ts; im Docker-Netz per Env `PUBLIC_URL` überschreibbar — der DS muss unseren Server erreichen).
- Routen-Semantik `GET /files/:id/preview` (Auth + Berechtigung EXAKT wie `GET /files/:id` im jeweiligen Modus):
  - kind `pdf` → 200, Originalbytes (gleicher Auslieferungsweg wie /files/:id).
  - kind `image`/`other` → 404 `{ error: 'Keine Vorschau für diese Datei-Art' }`.
  - kind `convertible`, Konvertierung fertig im Cache → 200 PDF-Bytes.
  - Cache leer → Konvertierung IM HINTERGRUND anstoßen (`void converter.ensurePreview(...)` mit Fehler-Merker pro cacheKey) und sofort 202 `{ status: 'converting' }`; Folgeaufrufe während der Konvertierung ebenfalls 202; nach Fehler 409 `{ error: <ConvertError.message>, reason }` (Fehler-Merker wird beim nächsten Aufruf zurückgesetzt → erneuter Versuch).
  - Konverter disabled → 409 `{ error: 'Vorschau-Dienst nicht konfiguriert', reason: 'disabled' }`.
- j-lawyer-Modus: cacheKey = `${docId}-${changeDate}` (Muster jlcache); `convert-source` muss im jl-Modus Akteninhalte liefern können → Ticket trägt zusätzlich optional `{ jl: { docId, username, password } }` (RAM-only wie jlCreds; Ticket kurzlebig+einmalig — dokumentierter Kompromiss im Code-Kommentar). Abgleich (`syncCaseDesk`): `addDoc(state, d.id, d.name, eingang(n))` bekommt kind aus dem Dateinamen: `classifyName(d.name)` — neue schlanke Export-Variante von `classify` nur nach Endung (Magic-Bytes erst beim Inhaltsabruf verfügbar; bewusst gut genug).
- Tests: je kind ein Routen-Fall (Standalone via Upload-Fixtures); 202→Poll→200-Sequenz mit Fake-DS; 409 bei disabled; jl-Modus: Abgleich setzt kind (odt→convertible, jpg→image), Preview eines jl-Dokuments konvertiert über den Fake-DS (Fake-j-lawyer liefert die Bytes; convert-source-Ticket mit jl-Payload).

- [ ] **Step 1: Failing Tests, Step 2: Implementierung, Step 3: Grün + Commit**

```bash
git add packages/server/src
git commit -m "feat: Vorschau-Route je Datei-Art — konvertiert lazy, cacht, degradiert sauber"
```

---

### Task 6: Client — API/Caches/PageRenderer mit Preview-Quelle

**Files:**
- Modify: `src/lib/api.ts` (uploadFile generisch + kind in Antwort; `fetchPreview(fileId)` mit 202/409-Unterscheidung), `src/lib/fileCache.ts` + `src/lib/idb.ts` (Preview-Bytes unter eigenem Schlüssel `preview:<fileId>`), `src/lib/components/PageRenderer.svelte` (Prop `source?: 'original' | 'preview'`), `src/lib/pageCounts.ts` (source-Parameter), `src/lib/thumbnails.ts` (source-Parameter; image-Kurzweg kommt in Task 7)
- Test: `src/lib/api.test.ts` (fetchPreview-Fälle, bestehendes Mock-Muster)

**Interfaces:**
- `api.uploadFile(bytes, name, mime?)` → `{ fileId, kind }` (Aufrufer in Desktop.svelte anpassen; Blob-Typ = übergebener mime statt hart application/pdf). `api.fetchPreview(fileId): Promise<{ status: 'ready'; bytes: Uint8Array } | { status: 'converting' } | { status: 'error'; message: string }>` — mappt 200/202/409.
- `PageRenderer` + `pageCounts` + `thumbnails`: `source==='preview'` → `bytesFor` nutzt `fetchPreview` mit Poll (alle 1,5 s, max. 90 s; bei 'error' → Fehlerzustand der Komponente mit der Meldung) und IDB-Schlüssel `preview:<fileId>`; Default `'original'` unverändert.

- [ ] **Steps: TDD für api.fetchPreview (Mock-fetch-Muster der Datei), dann Durchreichung; `npm test`/`check`/`build`; Commit**

```bash
git add src/lib
git commit -m "feat: Vorschau-Quelle im Client — fetchPreview mit Poll, Renderer/Caches source-bewusst"
```

---

### Task 7: Client — „＋"-Menü, generischer Upload, DocCard nach kind

**Files:**
- Modify: `src/lib/components/Desktop.svelte` („＋"-Menü Datei/Zettel; accept-Attribut weg; addPdfFile → addFile mit kind aus Upload-Antwort und addDoc-kind), `src/lib/components/DocCard.svelte` (Verzweigung), `src/lib/menus.ts` (other: kein „Aufschlagen", kein Enthefter-Kontext), `src/lib/thumbnails.ts` (image: Bytes direkt als Bild-URL, kein pdfjs)
- Test: keine Komponententests (Muster) — check/build.

**Interfaces:**
- Desktop-Toolbar: EIN Knopf „＋" → `ui.menu` mit „Datei…" (fileInput.click(), `multiple`, ohne accept-Filter) und „Zettel…" (bisheriges Typwahl-Untermenü). Drag-and-drop: Filter auf PDF entfällt.
- DocCard: `kind = doc.kind ?? 'pdf'`. `image` → `<img>` aus `getFileUrl` (object-fit contain, weißer Rand wie Polaroid); `convertible` → Thumbnail über preview-Quelle; solange `fetchPreview` 'converting' liefert → Platzhalter „Vorschau wird erstellt…" (Sanduhr-Glyph, Poll über thumbnails-Weg); `other` → generische Karte: großes Endungs-Kürzel (aus doc.name), Blatt-Symbol, gedeckte Farbe; `ondblclick` nur bei kind !== 'other'.
- menus.ts `showDocMenuAt`: bei `other` ohne „Aufschlagen"; „In neuem Tab öffnen"/„Herunterladen"/Werkzeug-Einträge bleiben.

- [ ] **Steps: Umbau, check/build, Commit**

```bash
git add src/lib
git commit -m "feat: ＋-Menü und generische Karten — Bilder, Konvertier-Platzhalter, Typ-Icons"
```

---

### Task 8: Client — Bild-Viewer

**Files:**
- Create: `src/lib/components/ImagePage.svelte` (Bild als „Seite": lädt Bytes via getFileUrl, misst natürliche Maße, meldet `onbasesize`, rendert `<img>` in targetWidth)
- Modify: `src/lib/components/DocViewer.svelte` (bei `kind === 'image'`: ImagePage statt PageRenderer, Pager aus (wie seitenfix), Enthefter aus, Schere/Lichttisch/Zeichnen/Stempel/Fahnen/Abdecken AKTIV — page ist konstant 1, baseSize = Bildmaße)

**Interfaces:**
- `ImagePage`-Props: `{ api: ApiClient; fileId: string; targetWidth: number; onbasesize?: (s: Size) => void }`. Basiskoordinaten = natürliche Bildpixel (naturalWidth/Height) — damit skalieren Strokes/Marks/Stempel exakt wie bei PDF-Seiten.
- Alle Overlays (InkOverlay/MarkLayer/StampLayer + Setzflächen) bleiben unverändert eingebunden mit `page={1}`.

- [ ] **Steps: Komponente + Verzweigung, check/build, Commit**

```bash
git add src/lib
git commit -m "feat: Bild-Viewer — Fotos aufschlagen, mit allen Werkzeugen bearbeitbar"
```

---

### Task 9: MCP — kind-bewusst

**Files:**
- Modify: `packages/mcp/src/deskApi.ts` (kind in DeskDoc; get_document_text: preview-Quelle für convertible, klare Fehler für image/other), `packages/mcp/src/server.ts` (get_desk liefert kind mit)
- Test: `packages/mcp/src/tools-read.test.ts`

**Interfaces:**
- `get_desk`-Ausgabe: docs tragen `kind` (nicht anonymisiert — technisches Feld). `get_document_text`: kind `pdf` → wie bisher; `convertible` → holt `/files/:id/preview` (bei 202 kurz pollen wie der Client, max. 30 s; bei 409 Fehlermeldung des Servers durchreichen); `image`/`other` → Fehler `Für diese Datei-Art ist kein Text-Inhalt verfügbar` (Anonymisierung ist bewusst PDF-only).
- Tests gegen den bestehenden MCP-Testserver: kind erscheint; image/other-Fehlertext; convertible-Pfad mit gemocktem preview-Endpoint (Testserver-Muster der Datei).

- [ ] **Steps: TDD, Implementierung, `npm test`, Commit**

```bash
git add packages/mcp/src
git commit -m "feat: MCP kennt Datei-Arten — Volltext über die Vorschau, klare Fehler sonst"
```

---

### Task 10: Deployment-Doku

**Files:**
- Create: `docs/deployment/eurooffice-compose.yaml`, Modify: `README.md` (Abschnitt Vorschau-Dienst)

**Interfaces:** Compose mit `onlyoffice/documentserver`-kompatiblem Euro-Office-Image (Image-Name aus dem GitHub-Org-Stand: `ghcr.io/euro-office/documentserver` — der Implementierer verifiziert den exakten Namen per WebFetch auf https://github.com/euro-office/DocumentServer und nimmt sonst das dokumentierte Fallback-Image `onlyoffice/documentserver` MIT Kommentar), `JWT_SECRET`-Env beidseitig, gemeinsames Netz, `PUBLIC_URL`-Hinweis (DS muss den Digital-Desktop-Server erreichen). README: Env-Tabelle `EUROOFFICE_URL`, `EUROOFFICE_JWT_SECRET`, `PUBLIC_URL`; Hinweis „ohne Konfiguration keine Konvertier-Vorschau, alles andere läuft".

- [ ] **Steps: Dateien schreiben, Commit**

```bash
git add docs/deployment README.md
git commit -m "docs: Euro-Office-DocumentServer-Deployment (Compose + Env)"
```

---

### Task 11: E2E, UAT-Block A10, Abschluss

**Files:**
- Modify: `docs/uat/2026-07-18-uat-sammelliste.md` (Block A10, Zählung), `.superpowers/sdd/progress.md`

- [ ] **Step 1:** `npm test` / `npm run check` / `npm run build` alle grün. HTTP-Smoke: Server + Fake-DocumentServer (testConvertServer als Skript starten oder Mini-Node-Skript), ODT-Fixture hochladen → `addDoc` mit kind → `GET /files/:id/preview` 202→…→200-PDF; Bild hochladen → Karte kind image; ZIP → other; `EUROOFFICE_URL` weglassen → 409 disabled.
- [ ] **Step 2:** Chrome-E2E-Vorprüfung falls Extension verbunden (Bild aufschlagen + stempeln; ODT-Karte „Vorschau wird erstellt…" → rendert; other-Karte ohne Aufschlagen; ＋-Menü) — sonst wie in der Werkzeugkasten-Runde ehrlich als entfallen kennzeichnen.
- [ ] **Step 3:** UAT-Block A10 (Vorlage):

```markdown
### A10 — Dateitypen-Runde (NEU; <Vorprüfungsstand einsetzen>)

- [ ] A10.1 „＋"-Menü: Datei…/Zettel… — Mehrfachauswahl beliebiger Typen; Drag-and-drop ebenso.
- [ ] A10.2 Bild (JPG/PNG) hochladen → Karte zeigt das Foto; aufschlagen → Bildansicht; Stempel/Zeichnen/Schere funktionieren auf dem Bild; Reload erhält alles.
- [ ] A10.3 ODT hochladen (Euro-Office-Container läuft) → Karte „Vorschau wird erstellt…", dann Miniatur; aufschlagen → blättert wie ein PDF; Werkzeuge funktionieren.
- [ ] A10.4 DOCX/XLSX aus der j-lawyer-Akte → gleiches Verhalten; Original bleibt unverändert in der Akte (Stichprobe: Download liefert Original, nicht PDF).
- [ ] A10.5 ZIP hochladen → generische Karte mit Typ-Kürzel; kein „Aufschlagen" im Menü; Herunterladen liefert die Datei.
- [ ] A10.6 Euro-Office-Container stoppen → ODT-Aufschlag-Versuch meldet „Vorschau-Dienst nicht erreichbar"; Container starten → nächster Versuch konvertiert.
- [ ] A10.7 Ohne EUROOFFICE_URL-Konfiguration: konvertierbare Typen verhalten sich wie generische Karten, Hinweis erscheint; PDFs/Bilder normal.
- [ ] A10.8 MCP: „Lies Dokument X" auf einer ODT → Zusammenfassung über die Vorschau; auf einem Bild → klare Fehlermeldung.
- [ ] A10.9 Zweitfenster/Reload: kind-abhängige Darstellung überall konsistent (Bild bleibt Bild, other bleibt other).
- [ ] A10.10 **Produktentscheidungen bestätigen:** Bild-Karte als „Polaroid" ok? Generisches Karten-Design ok? Lazy-Konvertierung (erst beim Anschauen) ok?
```

Zählung im Kopf + Block-A-Überschrift anheben. Progress-Abschnitt „Dateitypen-Runde" im Ledger.

- [ ] **Step 4: Commit**

```bash
git add docs/uat .superpowers/sdd/progress.md
git commit -m "docs: UAT-Block A10 Dateitypen-Runde, Progress aktualisiert"
```

---

## Plan-Selbstprüfung (beim Schreiben erledigt)

- **Spec-Abdeckung:** kind-Modell (T1/T2), Konverter+Ticket (T3/T4), Preview-Route+jl (T5), Client-Quelle (T6), ＋/Karten (T7), Bild-Viewer (T8), MCP (T9), Deployment (T10), UAT (T11). Nicht in dieser Runde (Spec): Editor, HEIC/TIFF, Bild-OCR, Vorab-Konvertierung.
- **Bewusste Offenheiten:** exakter Euro-Office-Image-Name (T10 verifiziert live); ConvertService-Pfad `/ConvertService.ashx` ist der OnlyOffice-Kompatibilitätspfad — reale Instanz bei UAT gegenprüfen (A10.3).
- **Typ-Konsistenz:** `FileKind` einmal in core definiert, Server/MCP importieren es; Upload-Antwort `{ fileId, kind }` konsistent T2/T6/T7; `fetchPreview`-Statusvertrag konsistent T5/T6/T9.

