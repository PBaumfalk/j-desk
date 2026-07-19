# J-Desk Rebranding & Glass-UI — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das Projekt „Digital Desktop" vollständig zu **J-Desk** umbenennen und dem UI-Chrome ein Glass-Design mit den CI-Markenfarben geben (Spec: `docs/superpowers/specs/2026-07-19-j-desk-rebranding-design.md`).

**Architecture:** Zentrale Design-Tokens in einer neuen globalen `src/app.css` (Markenfarben, Inter-Font, vier Glass-Stufen als CSS-Variablen + Utility-Klassen). Chrome-Komponenten nutzen die Tokens in ihren scoped Styles; Papier-Elemente (DocCard, NoteCard, StackCard, CutoutCard) bleiben unberührt. Umschaltung helles/dunkles Glas über die bestehende `.hell`-Klasse auf `.desk`.

**Tech Stack:** SvelteKit (SPA, adapter-static), Svelte 5 Runes, npm workspaces, Vitest, `@fontsource-variable/inter`.

## Global Constraints

- UI-Texte auf Deutsch, Code-Kommentare auf Deutsch (Bestandsmuster).
- macOS: `sed -i ''` (BSD-Syntax), Pfade mit Leerzeichen quoten.
- Svelte 5 Runes (`$state`, `$derived`, `$props`); scoped Styles pro Komponente (kein Tailwind).
- Markenfarben exakt: Navy `#081F39`, Blau `#1372D3`, Grün `#90BD28`, Rot `#EE181E`.
- Papier-Elemente (`DocCard`, `NoteCard`, `StackCard`, `CutoutCard`, Seiten, Stempel, Marker, Flags, Ink) werden NICHT angefasst.
- `KonvolutViewer.svelte` dupliziert das CSS von `DocViewer.svelte` bewusst 1:1 — Änderungen immer in beiden Dateien identisch.
- Nach jedem Task: `npm test` und `npm run check` müssen grün sein, dann committen.
- Branch: `feature/j-desk` (existiert bereits, Spec ist committet).

---

### Task 1: Design-Tokens & globales Stylesheet

**Files:**
- Create: `src/app.css`
- Create: `src/routes/+layout.svelte`
- Modify: `package.json` (Dependency)

**Interfaces:**
- Consumes: `.hell`-Klasse, die `Desktop.svelte:287` bereits auf `.desk` setzt (`class:hell={isLight(hintergrund.themeId)}`).
- Produces: CSS-Variablen für alle Folge-Tasks: `--brand-navy`, `--brand-navy-hover`, `--brand-blue`, `--brand-blue-soft`, `--brand-green`, `--brand-red`, `--brand-red-soft`, `--font-ui`, `--glass-input-bg`, `--glass-card-bg`, `--glass-panel-bg`, `--glass-elevated-bg`, `--glass-border`, `--glass-separator`, `--glass-shadow`, `--glass-shadow-lg`, `--glass-text`, `--glass-text-secondary`, `--glass-hover`, `--glass-active`, `--glass-blur-input`, `--glass-blur-card`, `--glass-blur-panel`, `--glass-blur-elevated`. Utility-Klassen: `.glass-input`, `.glass-card`, `.glass-panel`, `.glass-elevated`, `.bg-mesh`.

- [ ] **Step 1: Inter installieren**

```bash
cd "/Users/patrickbaumfalk/Projekte/Digital Desktop"
npm install @fontsource-variable/inter
```

Expected: `added 1 package` (o.ä.), exit 0.

- [ ] **Step 2: `src/app.css` anlegen**

```css
/* J-Desk Design-Tokens — zentrale Markenwerte (Spec 2026-07-19).
   Zwei Glas-Sätze: helles Glas über dunklen Tischflächen (Standard),
   dunkles Glas über hellen Tischflächen (.hell auf .desk, via isLight()). */
:root {
  /* Markenfarben aus CI/j-desk-icon-master.png */
  --brand-navy: #081F39;
  --brand-navy-hover: #123256;
  --brand-blue: #1372D3;
  --brand-blue-soft: rgba(19, 114, 211, .12);
  --brand-green: #90BD28;
  --brand-red: #EE181E;
  --brand-red-soft: rgba(238, 24, 30, .12);

  --font-ui: 'Inter Variable', ui-sans-serif, system-ui, -apple-system, sans-serif;

  /* Blur-Stufen (aus AI-Lawyer portiert) */
  --glass-blur-input: blur(8px) saturate(1.3);
  --glass-blur-card: blur(16px) saturate(1.4);
  --glass-blur-panel: blur(24px) saturate(1.5);
  --glass-blur-elevated: blur(40px) saturate(1.6);

  /* Helles Glas — Standard über dunklen Tischflächen */
  --glass-input-bg: rgba(255, 255, 255, .55);
  --glass-card-bg: rgba(255, 255, 255, .62);
  --glass-panel-bg: rgba(255, 255, 255, .72);
  --glass-elevated-bg: rgba(255, 255, 255, .84);
  --glass-border: rgba(255, 255, 255, .55);
  --glass-separator: rgba(8, 31, 57, .12);
  --glass-shadow: 0 4px 24px rgba(0, 0, 0, .18);
  --glass-shadow-lg: 0 8px 48px rgba(0, 0, 0, .30);
  --glass-text: #081F39;
  --glass-text-secondary: rgba(8, 31, 57, .62);
  --glass-hover: rgba(19, 114, 211, .10);
  --glass-active: rgba(19, 114, 211, .18);
}

/* Dunkles Glas über hellen Tischflächen (dark_white, ivory).
   Desktop.svelte setzt class:hell auf .desk; alle Chrome-Elemente sind DOM-Kinder. */
.hell {
  --glass-input-bg: rgba(8, 31, 57, .50);
  --glass-card-bg: rgba(8, 31, 57, .55);
  --glass-panel-bg: rgba(10, 34, 60, .68);
  --glass-elevated-bg: rgba(8, 28, 50, .80);
  --glass-border: rgba(255, 255, 255, .18);
  --glass-separator: rgba(255, 255, 255, .14);
  --glass-shadow: 0 4px 24px rgba(0, 0, 0, .22);
  --glass-shadow-lg: 0 8px 48px rgba(0, 0, 0, .34);
  --glass-text: #F4F7FB;
  --glass-text-secondary: rgba(244, 247, 251, .65);
  --glass-hover: rgba(255, 255, 255, .12);
  --glass-active: rgba(255, 255, 255, .20);
}

body { font-family: var(--font-ui); }
/* Formularelemente erben die UI-Schrift (Browser-Default wäre Systemschrift). */
button, input, textarea, select { font-family: inherit; }

/* ── Glass-Stufen als Utility-Klassen ── */
.glass-input, .glass-card, .glass-panel, .glass-elevated {
  border: 1px solid var(--glass-border);
  color: var(--glass-text);
}
.glass-input {
  background: var(--glass-input-bg);
  backdrop-filter: var(--glass-blur-input);
  -webkit-backdrop-filter: var(--glass-blur-input);
  box-shadow: var(--glass-shadow);
}
.glass-card {
  background: var(--glass-card-bg);
  backdrop-filter: var(--glass-blur-card);
  -webkit-backdrop-filter: var(--glass-blur-card);
  box-shadow: var(--glass-shadow);
}
.glass-panel {
  background: var(--glass-panel-bg);
  backdrop-filter: var(--glass-blur-panel);
  -webkit-backdrop-filter: var(--glass-blur-panel);
  box-shadow: var(--glass-shadow-lg);
}
.glass-elevated {
  background: var(--glass-elevated-bg);
  backdrop-filter: var(--glass-blur-elevated);
  -webkit-backdrop-filter: var(--glass-blur-elevated);
  box-shadow: var(--glass-shadow-lg);
}

/* Mesh-Hintergrund in J-Desk-Tönen — nur Login-Screen */
.bg-mesh {
  background:
    radial-gradient(80% 60% at 15% 20%, rgba(19, 114, 211, .30), transparent),
    radial-gradient(55% 55% at 85% 25%, rgba(144, 189, 40, .16), transparent),
    radial-gradient(70% 50% at 50% 85%, rgba(8, 31, 57, .38), transparent),
    #E9EEF5;
}
```

- [ ] **Step 3: `src/routes/+layout.svelte` anlegen** (lädt Font + Stylesheet global; das bestehende `+layout.ts` mit `ssr = false` bleibt unverändert daneben bestehen)

```svelte
<script lang="ts">
  import '@fontsource-variable/inter';
  import '../app.css';
  let { children } = $props();
</script>

{@render children()}
```

- [ ] **Step 4: Prüfen**

```bash
npm test && npm run check
```

Expected: Beide grün (bestehende Tests unverändert; app.css bricht nichts, da nur Tokens/Utilities hinzukommen).

- [ ] **Step 5: Commit**

```bash
git add src/app.css src/routes/+layout.svelte package.json package-lock.json
git commit -m "feat: J-Desk Design-Tokens, Inter und Glass-Stufen als globales Stylesheet"
```

---

### Task 2: Rebranding — Icons, app.html, Manifest, README

**Files:**
- Modify: `src/app.html`
- Create: `static/favicon.ico`, `static/favicon-16x16.png`, `static/favicon-32x32.png`, `static/apple-touch-icon.png`, `static/j-desk-icon-256.png`, `static/j-desk-icon-512.png`, `static/site.webmanifest` (kopiert aus `CI/`)
- Delete: `static/favicon.png`
- Modify: `README.md`

**Interfaces:**
- Consumes: nichts aus anderen Tasks.
- Produces: `static/j-desk-icon-256.png` — wird in Task 3 als Login-Logo referenziert (`<img src="/j-desk-icon-256.png">`).

- [ ] **Step 1: Icons kopieren, altes Favicon entfernen**

```bash
cd "/Users/patrickbaumfalk/Projekte/Digital Desktop"
cp CI/j-desk.ico static/favicon.ico
cp CI/favicon-16x16.png CI/favicon-32x32.png CI/apple-touch-icon.png static/
cp CI/png/j-desk-icon-256.png CI/png/j-desk-icon-512.png static/
git rm static/favicon.png
```

- [ ] **Step 2: `static/site.webmanifest` anlegen** (CI-Version mit korrigierten Icon-Pfaden; theme/background wie von der CI geliefert)

```json
{
  "name": "J-Desk",
  "short_name": "J-Desk",
  "icons": [
    { "src": "/j-desk-icon-256.png", "sizes": "256x256", "type": "image/png" },
    { "src": "/j-desk-icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#FFFFFF",
  "background_color": "#FFFFFF",
  "display": "standalone"
}
```

- [ ] **Step 3: `src/app.html` aktualisieren** — kompletter neuer Inhalt:

```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="%sveltekit.assets%/favicon.ico" sizes="48x48" />
    <link rel="icon" type="image/png" sizes="32x32" href="%sveltekit.assets%/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="%sveltekit.assets%/favicon-16x16.png" />
    <link rel="apple-touch-icon" href="%sveltekit.assets%/apple-touch-icon.png" />
    <link rel="manifest" href="%sveltekit.assets%/site.webmanifest" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>J-Desk</title>
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
```

(`lang="de"` — die App ist durchgehend deutsch.)

- [ ] **Step 4: README-Titel** — in `README.md` die Überschrift und Produktnennungen von „Digital Desktop" auf „J-Desk" ändern (nur Produktname; technische Befehle wie Pfade erst in Task 7/9):

```bash
sed -i '' 's/# Digital Desktop/# J-Desk/; s/Digital Desktop/J-Desk/g' README.md
```

Danach `git diff README.md` lesen und prüfen, dass keine Pfad-Angabe (z.B. Ordnername in einer Anleitung) fälschlich ersetzt wurde — falls doch, dort manuell zurückkorrigieren (Ordner-Umbenennung kommt erst in Task 9).

- [ ] **Step 5: Prüfen & Commit**

```bash
npm test && npm run check
git add -A static src/app.html README.md
git commit -m "feat: Rebranding zu J-Desk — Favicons, Manifest, Titel, README"
```

---

### Task 3: Login-Screen — Glass-Card, Logo, Mesh

**Files:**
- Modify: `src/lib/components/LoginScreen.svelte`

**Interfaces:**
- Consumes: `.bg-mesh`, `.glass-elevated`, Tokens aus Task 1; `static/j-desk-icon-256.png` aus Task 2.
- Produces: nichts für andere Tasks.

- [ ] **Step 1: Markup ändern** — in `LoginScreen.svelte` den `<div class="wrap">`-Block ersetzen (Script bleibt unverändert):

```svelte
<div class="wrap bg-mesh">
  <form class="card glass-elevated" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <img class="logo" src="/j-desk-icon-256.png" alt="" width="72" height="72" />
    <h1>J-Desk</h1>
    {#if needsSetup}<p class="hint">Ersteinrichtung: Lege das erste Konto an (Passwort min. 8 Zeichen).</p>{/if}
    <label>Benutzername <input bind:value={username} autocomplete="username" /></label>
    <label>Passwort <input type="password" bind:value={password} autocomplete="current-password" /></label>
    {#if error}<p class="error">{error}</p>{/if}
    <button disabled={busy || !username || !password}>
      {needsSetup ? 'Konto anlegen' : 'Anmelden'}
    </button>
  </form>
</div>
```

- [ ] **Step 2: Styles ersetzen** — kompletter neuer `<style>`-Block:

```css
  .wrap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .card { display: flex; flex-direction: column; gap: 12px; width: 320px; padding: 32px 28px;
          border-radius: 18px; }
  .logo { align-self: center; margin-bottom: 2px; }
  h1 { margin: 0 0 4px; font-size: 22px; text-align: center; color: var(--brand-navy);
       letter-spacing: -0.01em; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--glass-text); }
  input { padding: 8px 10px; border: 1px solid var(--glass-separator); border-radius: 8px;
          background: rgba(255, 255, 255, .7); font: inherit; }
  input:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 0; }
  .hint { margin: 0; font-size: 12px; color: var(--brand-blue); }
  .error { margin: 0; font-size: 12px; color: var(--brand-red); }
  button { padding: 9px; border: none; border-radius: 9px; background: var(--brand-navy); color: #fff;
           font-size: 14px; cursor: pointer; }
  button:hover:enabled { background: var(--brand-navy-hover); }
  button:disabled { opacity: .5; cursor: default; }
```

Hinweis: Der Login liegt außerhalb von `.desk`, es gelten also immer die `:root`-Tokens (helles Glas) — passt zum hellen Mesh.

- [ ] **Step 3: Prüfen & Commit**

```bash
npm test && npm run check
git add src/lib/components/LoginScreen.svelte
git commit -m "feat: Login-Screen im Glass-Design mit J-Desk-Logo und Mesh-Hintergrund"
```

---

### Task 4: Desk-Chrome — Toolbar, Suche-Panel, DeskSwitcher

**Files:**
- Modify: `src/lib/components/Desktop.svelte` (nur `<style>`, Zeilen 405–428)
- Modify: `src/lib/components/DeskSwitcher.svelte` (nur `<style>`)

**Interfaces:**
- Consumes: Tokens aus Task 1.
- Produces: nichts für andere Tasks.

- [ ] **Step 1: `Desktop.svelte`-Styles anpassen.** Ersetze die Regeln `.suche-panel`, `.suche-feld`, `.suche-feld::placeholder`, `.treffer`, `.treffer:hover`, `.treffer .art`, `.keine`, `.toolbar button`, `.hint` durch:

```css
  .suche-panel { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 9600;
                 width: min(420px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 6px;
                 background: var(--glass-panel-bg); border: 1px solid var(--glass-border);
                 backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
                 border-radius: 12px; padding: 10px; box-shadow: var(--glass-shadow-lg); }
  .suche-feld { border: 1px solid var(--glass-separator); border-radius: 8px; padding: 8px 10px;
                background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 14px; }
  .suche-feld::placeholder { color: var(--glass-text-secondary); }
  .suche-feld:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 0; }
  .treffer { display: flex; gap: 8px; align-items: baseline; text-align: left; border: none;
             background: none; color: var(--glass-text); padding: 7px 8px; border-radius: 8px;
             cursor: pointer; font-size: 13px; }
  .treffer:hover { background: var(--glass-hover); }
  .treffer .art { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
                  background: var(--brand-blue-soft); border-radius: 5px; padding: 2px 6px; }
  .keine { padding: 8px; font-size: 12px; color: var(--glass-text-secondary); }
  .toolbar button { font-size: 13px; padding: 6px 12px; border-radius: 8px;
                    border: 1px solid var(--glass-border);
                    background: var(--glass-card-bg); color: var(--glass-text);
                    backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
                    cursor: pointer; box-shadow: var(--glass-shadow); }
  .toolbar button:hover { background: var(--glass-elevated-bg); }
  .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px;
          border-radius: 999px; background: rgba(8, 31, 57, .88); color: #fff; font-size: 13px; z-index: 9999; }
```

Unverändert bleiben: `.desk`-Hintergrund/Verläufe, `.puls`, `.lupe` (Creme-Akzente gehören zur Tisch-Metapher), `.banner`, `.blocker`, `.toast`, `.suche-liste`, `.treffer .name`, `.world`, `.lupenwelt`, `.toolbar` (Container).

- [ ] **Step 2: `DeskSwitcher.svelte`-Styles anpassen.** Kompletter neuer `<style>`-Block:

```css
  .switcher { position: fixed; top: 12px; left: 12px; z-index: 9000; }
  .current { font-size: 13px; padding: 6px 12px; border-radius: 8px;
             border: 1px solid var(--glass-border);
             background: var(--glass-card-bg); color: var(--glass-text);
             backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
             cursor: pointer; box-shadow: var(--glass-shadow); }
  .current:hover { background: var(--glass-elevated-bg); }
  .backdrop { position: fixed; inset: 0; z-index: 9001; }
  .suche { margin: 2px; padding: 6px 8px; border: 1px solid var(--glass-separator); border-radius: 7px;
           background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 13px; }
  .items { max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; }
  .leer { padding: 8px 10px; font-size: 12px; color: var(--glass-text-secondary); }
  .menu { position: absolute; top: 36px; left: 0; z-index: 9002; min-width: 230px; padding: 4px;
          border-radius: 10px; background: var(--glass-elevated-bg); color: var(--glass-text);
          border: 1px solid var(--glass-border);
          backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
          box-shadow: var(--glass-shadow-lg);
          display: flex; flex-direction: column; gap: 2px;
          max-height: calc(100vh - 56px); overflow-y: auto; }
  /* Regler: volle Menübreite, touch-freundlich; touch-action verhindert Scrollen beim Ziehen. */
  .regler { width: calc(100% - 20px); margin: 2px 10px 8px; accent-color: var(--brand-blue); touch-action: none; }
  .haken { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .item { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
          font-size: 13px; color: inherit; cursor: pointer; }
  .item:hover { background: var(--glass-hover); }
  .item.gefahr { color: var(--brand-red); }
  hr { border: none; border-top: 1px solid var(--glass-separator); margin: 4px 0; }
  .abschnitt { padding: 6px 10px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
               color: var(--glass-text-secondary); }
  .farben { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding: 4px 10px 6px; }
  .farbe { width: 34px; height: 34px; border-radius: 50%; border: 2px solid var(--glass-separator);
           cursor: pointer; padding: 0; }
  .farbe:hover { transform: scale(1.08); }
  .farbe.aktiv { border-color: var(--brand-blue); box-shadow: 0 0 0 2px var(--glass-active); }
  input { margin: 6px; padding: 6px 8px; border: 1px solid var(--glass-separator); border-radius: 6px;
          background: var(--glass-input-bg); color: var(--glass-text); font: inherit; font-size: 13px; }
  .row { display: flex; justify-content: flex-end; gap: 4px; padding: 0 6px 6px; }
```

(`.item.gefahr` im dunklen Glas: `#EE181E` auf dunklem Grund bleibt lesbar — kräftiges Rot.)

- [ ] **Step 3: Prüfen & Commit**

```bash
npm test && npm run check
git add src/lib/components/Desktop.svelte src/lib/components/DeskSwitcher.svelte
git commit -m "feat: Desk-Chrome (Toolbar, Suche, DeskSwitcher) auf Glass-Tokens umgestellt"
```

---

### Task 5: Bedienpanels — DeskControls, TrashCan

**Files:**
- Modify: `src/lib/components/DeskControls.svelte` (nur `<style>`)
- Modify: `src/lib/components/TrashCan.svelte` (nur `<style>`)

**Interfaces:**
- Consumes: Tokens aus Task 1.
- Produces: nichts für andere Tasks.

- [ ] **Step 1: `DeskControls.svelte`-Styles ersetzen** — kompletter neuer `<style>`-Block (der Leder-Look weicht dem Glass-Panel; Layout-Regeln unverändert):

```css
  /* Instrumenten-Panel am Tischrand: Glass-Panel mit Navy-Symbolen (J-Desk Glass-Design). */
  .controls { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 9000;
    display: flex; gap: 10px; align-items: center; padding: 8px 12px;
    background: var(--glass-panel-bg);
    border: 1px solid var(--glass-border); border-radius: 16px;
    box-shadow: var(--glass-shadow-lg);
    backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel); }
  .pad { display: grid; grid-template-columns: repeat(3, 38px); grid-template-rows: repeat(2, 32px);
    gap: 2px; }
  .pad .up { grid-column: 2; grid-row: 1; }
  .pad .left { grid-column: 1; grid-row: 2; }
  .pad .down { grid-column: 2; grid-row: 2; }
  .pad .right { grid-column: 3; grid-row: 2; }
  .divider { width: 1px; align-self: stretch; margin: 4px 0;
    background: linear-gradient(180deg, transparent, var(--glass-separator), transparent); }
  .zoom { display: flex; gap: 2px; align-items: center; }
  button { border: none; background: transparent; color: var(--glass-text); border-radius: 10px; cursor: pointer;
    width: 38px; height: 32px; font-size: 16px; line-height: 1; padding: 0;
    transition: background .12s ease; }
  .zoom button { height: 38px; }
  .zoom .fit { font-size: 18px; }
  button:hover { background: var(--glass-hover); }
  button:active { background: var(--glass-active); transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 1px; }
  button.on { background: var(--glass-active); }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
    button:active { transform: none; }
  }
```

- [ ] **Step 2: `TrashCan.svelte`-Styles ersetzen** — kompletter neuer `<style>`-Block:

```css
  /* Papierkorb im Glass-Design wie DeskControls. */
  .korb { position: fixed; right: 16px; bottom: 16px; z-index: 9000; }
  .eimer { position: relative; width: 52px; height: 52px; border-radius: 12px; cursor: pointer;
           border: 1px solid var(--glass-border);
           background: var(--glass-card-bg); color: var(--glass-text); font-size: 24px;
           backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
           box-shadow: var(--glass-shadow); }
  .eimer:hover { background: var(--glass-elevated-bg); }
  .badge { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; border-radius: 10px;
           background: var(--brand-red); color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; padding: 0 4px; }
  .panel { position: fixed; right: 16px; bottom: 76px; z-index: 9400; width: 320px; max-height: 50vh; overflow: auto;
           background: var(--glass-panel-bg); color: var(--glass-text);
           border: 1px solid var(--glass-border); border-radius: 12px; padding: 10px;
           backdrop-filter: var(--glass-blur-panel); -webkit-backdrop-filter: var(--glass-blur-panel);
           box-shadow: var(--glass-shadow-lg); font-size: 12px; }
  .leer { padding: 10px; color: var(--glass-text-secondary); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li { display: grid; grid-template-columns: auto 1fr auto auto auto; gap: 8px; align-items: center;
       background: var(--glass-hover); border-radius: 8px; padding: 6px 8px; }
  .art { color: var(--glass-text-secondary); }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wann { color: var(--glass-text-secondary); font-variant-numeric: tabular-nums; }
  li button, .leeren { border: none; border-radius: 6px; background: var(--glass-active); color: var(--glass-text);
                       cursor: pointer; font-size: 11px; padding: 4px 8px; }
  li button:hover, .leeren:hover { background: var(--brand-blue-soft); }
  li button.schreddern { background: var(--brand-red-soft); color: var(--brand-red); }
  li button.schreddern:hover { background: rgba(238, 24, 30, .28); }
  .leeren { margin-top: 8px; width: 100%; }
```

- [ ] **Step 3: Prüfen & Commit**

```bash
npm test && npm run check
git add src/lib/components/DeskControls.svelte src/lib/components/TrashCan.svelte
git commit -m "feat: DeskControls und Papierkorb im Glass-Design"
```

---

### Task 6: Menüs & Viewer-Chrome — ContextMenu, StampPopover, DocViewer, KonvolutViewer

**Files:**
- Modify: `src/lib/components/ContextMenu.svelte` (nur `<style>`)
- Modify: `src/lib/components/StampPopover.svelte` (nur `<style>`)
- Modify: `src/lib/components/DocViewer.svelte` (nur `<style>`, gezielte Regeln)
- Modify: `src/lib/components/KonvolutViewer.svelte` (identische Regeln wie DocViewer)

**Interfaces:**
- Consumes: Tokens aus Task 1.
- Produces: nichts für andere Tasks.

- [ ] **Step 1: `ContextMenu.svelte`-Styles ersetzen** — kompletter neuer `<style>`-Block:

```css
  .backdrop { position: fixed; inset: 0; z-index: 99998; }
  .menu { position: fixed; z-index: 99999; min-width: 220px; padding: 4px; border-radius: 10px;
          background: var(--glass-elevated-bg); color: var(--glass-text);
          border: 1px solid var(--glass-border);
          backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
          box-shadow: var(--glass-shadow-lg);
          display: flex; flex-direction: column; }
  .menu.zweispaltig { display: grid; grid-template-columns: 1fr 1fr; }
  .menu input { margin: 4px; padding: 6px 8px; border: 1px solid var(--glass-separator); border-radius: 6px;
                background: var(--glass-input-bg); color: var(--glass-text);
                font: inherit; font-size: 13px; grid-column: 1 / -1; }
  .menu button { text-align: left; padding: 7px 10px; border: none; background: none; border-radius: 6px;
                 font-size: 13px; color: inherit; cursor: pointer; }
  .menu button:hover { background: var(--glass-hover); }
```

- [ ] **Step 2: `StampPopover.svelte`-Styles anpassen.** Nur Container und Frei-Eingabe; die Stempel-Buttons behalten ihren Papier-Look (weißer Grund, rote/blaue Stempelfarbe = Inhalt, kein Chrome). Neuer `<style>`-Block:

```css
  .backdrop { position: fixed; inset: 0; z-index: 9600; }
  .pop { position: absolute; top: 34px; right: 8px; z-index: 9700; display: flex; flex-direction: column; gap: 4px;
         background: var(--glass-elevated-bg); border: 1px solid var(--glass-border);
         backdrop-filter: var(--glass-blur-elevated); -webkit-backdrop-filter: var(--glass-blur-elevated);
         border-radius: 8px; box-shadow: var(--glass-shadow-lg); padding: 8px; min-width: 170px; }
  .pop > button { border: 2px solid #b3261e; color: #b3261e; background: #fff; border-radius: 4px;
                  font-weight: 700; letter-spacing: .08em; font-size: 12px; padding: 4px 8px; cursor: pointer; }
  .pop > button.blau { border-color: #1d4ed8; color: #1d4ed8; }
  .pop > button:hover { background: #f6f7fa; }
  .frei { display: flex; gap: 4px; margin-top: 4px; }
  .frei input { flex: 1; min-width: 0; font-size: 12px; padding: 4px 6px;
                border: 1px solid var(--glass-separator); border-radius: 4px;
                background: var(--glass-input-bg); color: var(--glass-text); }
  .frei button { font-size: 12px; border: none; background: var(--glass-active); color: var(--glass-text);
                 border-radius: 4px; cursor: pointer; padding: 4px 8px; }
  .frei button:disabled { opacity: .4; cursor: default; }
```

- [ ] **Step 3: `DocViewer.svelte` — gezielte Regel-Änderungen im `<style>`-Block** (Viewer-Fenster bleibt weiß — sein Innenraum ist Papier; nur Kopfleiste und Akzente):

Ersetze diese drei Regeln:

```css
  .viewer:focus { outline: 2px solid var(--brand-blue); }
  .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
          background: rgba(255, 255, 255, .78);
          backdrop-filter: var(--glass-blur-card); -webkit-backdrop-filter: var(--glass-blur-card);
          border-bottom: 1px solid rgba(8, 31, 57, .10); cursor: grab; user-select: none; }
  .tools button.on { background: var(--brand-navy); color: #fff; }
```

(Alle übrigen Regeln — `.viewer`, `.licht`, `.tools button`, `.pager`, `.body`, `.grip` usw. — bleiben unverändert. Die Kopfleiste liegt am oberen Fensterrand, ihr Blur zeigt die dahinterliegende Tischfläche.)

- [ ] **Step 4: `KonvolutViewer.svelte` — exakt dieselben drei Regel-Änderungen** wie Step 3 (bewusste CSS-Duplikation ist Bestandsmuster, Kommentar im Datei-Kopf des Style-Blocks bleibt stehen).

- [ ] **Step 5: Prüfen & Commit**

```bash
npm test && npm run check
git add src/lib/components/ContextMenu.svelte src/lib/components/StampPopover.svelte \
        src/lib/components/DocViewer.svelte src/lib/components/KonvolutViewer.svelte
git commit -m "feat: Menüs, Stempel-Popover und Viewer-Kopfleisten im Glass-Design"
```

---

### Task 7: Technische Umbenennung — Pakete `@j-desk/*`, MCP-Name

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm install`)
- Modify: `packages/core/package.json`, `packages/mcp/package.json`, `packages/server/package.json`
- Modify: alle 35 Dateien mit `@digital-desktop/`-Importen (sed)
- Modify: `packages/mcp/src/server.ts:39` (Servername)

**Interfaces:**
- Consumes: nichts aus anderen Tasks.
- Produces: Paketnamen `@j-desk/core`, `@j-desk/mcp`, `@j-desk/server`; MCP-Servername `j-desk`; Root-Paket `j-desk`.

- [ ] **Step 1: Vorprüfung — wo überall referenziert?**

```bash
cd "/Users/patrickbaumfalk/Projekte/Digital Desktop"
grep -rln '@digital-desktop/' --include='*.ts' --include='*.svelte' --include='*.js' --include='*.json' \
  package.json src packages vite.config.js svelte.config.js tsconfig.json vitest.config.ts 2>/dev/null | grep -v node_modules
```

Expected: Liste der Quell- und Config-Dateien (ca. 35+). `docs/` absichtlich NICHT umschreiben (historische Pläne bleiben authentisch).

- [ ] **Step 2: Scope-Umbenennung per sed**

```bash
grep -rln '@digital-desktop/' --include='*.ts' --include='*.svelte' --include='*.js' --include='*.json' \
  package.json src packages vite.config.js svelte.config.js tsconfig.json vitest.config.ts 2>/dev/null \
  | grep -v node_modules | xargs sed -i '' 's|@digital-desktop/|@j-desk/|g'
sed -i '' 's|"name": "digital-desktop"|"name": "j-desk"|' package.json
sed -i '' "s|name: 'digital-desktop'|name: 'j-desk'|" packages/mcp/src/server.ts
```

- [ ] **Step 3: Lockfile und Workspace-Links erneuern**

```bash
npm install
```

Expected: exit 0; `package-lock.json` enthält jetzt `@j-desk/*`.

- [ ] **Step 4: Verifizieren — keine Reste**

```bash
grep -rn 'digital-desktop' --include='*.ts' --include='*.svelte' --include='*.js' --include='*.json' \
  package.json src packages vite.config.js svelte.config.js 2>/dev/null | grep -v node_modules; echo "Exit: $?"
```

Expected: keine Treffer (`Exit: 1`).

- [ ] **Step 5: Tests**

```bash
npm test && npm run check && npm run build
```

Expected: alles grün — beweist, dass Workspace-Auflösung und Importe funktionieren.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: Pakete und MCP-Server von digital-desktop auf j-desk umbenannt"
```

---

### Task 8: Verifikation — Tests, App anfahren, Screenshots

**Files:** keine Änderungen (nur Prüfung; gefundene Fehler werden als Fixup im jeweiligen Task-Bereich behoben).

**Interfaces:**
- Consumes: alle vorherigen Tasks.
- Produces: Screenshots zur Abnahme durch den Nutzer.

- [ ] **Step 1: Gesamtprüfung**

```bash
npm test && npm run check && npm run build
```

Expected: grün.

- [ ] **Step 2: App per `verify`-Skill anfahren** (eigene Serverinstanz mit frischen Daten, Playwright-Login) und visuell prüfen:
  - Login-Screen: Mesh-Hintergrund, Glass-Card, Logo, Titel „J-Desk", Browser-Tab zeigt Favicon + „J-Desk"
  - Desk mit dunklem Theme (z.B. Dunkelgrün): helles Glas auf DeskSwitcher, Toolbar, DeskControls, Papierkorb
  - Desk mit hellem Theme (Elfenbein, über Gestaltung… umstellen): dunkles Glas — Umschaltung via `.hell` greift
  - Kontextmenü (Rechtsklick auf Karte), Suche-Panel (⌘F), Viewer öffnen (Kopfleiste, aktiver Werkzeug-Button in Navy)
  - Dokumente/Notizen/Stapel unverändert „Papier"

- [ ] **Step 3: Screenshots dem Nutzer zur Abnahme vorlegen.** Bei Befunden: Fix, erneut prüfen, Commit als `fix:` im betroffenen Bereich.

---

### Task 9: Repo & Ordner umbenennen (letzter Schritt)

**Files:** keine Quellcode-Änderungen; GitHub-Repo + lokaler Ordnername.

**Interfaces:**
- Consumes: alle Tasks abgeschlossen und committet.
- Produces: Repo `PBaumfalk/j-desk`; lokaler Ordner `~/Projekte/J-Desk`.

- [ ] **Step 1: Branch pushen**

```bash
cd "/Users/patrickbaumfalk/Projekte/Digital Desktop"
git push -u origin feature/j-desk
```

- [ ] **Step 2: GitHub-Repo umbenennen** (GitHub richtet automatisch eine Weiterleitung von der alten URL ein; `gh` aktualisiert die lokale Remote-URL selbst)

```bash
gh repo rename j-desk --yes
git remote -v
```

Expected: Remote zeigt auf `PBaumfalk/j-desk`.

- [ ] **Step 3: Lokalen Ordner umbenennen — NUR nach Rückfrage beim Nutzer,** weil die laufende Claude-Session und alle offenen Editoren/Terminals ihren Arbeitspfad verlieren:

```bash
cd /Users/patrickbaumfalk/Projekte && mv "Digital Desktop" "J-Desk"
```

Danach: Session/Editor im neuen Pfad `/Users/patrickbaumfalk/Projekte/J-Desk` neu öffnen. Die Skill-Datei `.claude/skills/verify/SKILL.md` referenziert ggf. den alten Pfad — nach dem Umbenennen prüfen und anpassen.

- [ ] **Step 4: Memory aktualisieren** — die Projektstand-Memory (`digital-desktop-projektstand.md`) auf neuen Namen, Pfad und Repo-URL umschreiben.
