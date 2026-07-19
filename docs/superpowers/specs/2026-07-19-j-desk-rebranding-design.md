# J-Desk: Rebranding & Glass-Design

**Datum:** 2026-07-19
**Status:** Abgenommen (Ansatz A)

## Ziel

Das Projekt „Digital Desktop" wird vollständig zu **J-Desk** umbenannt und erhält eine
Benutzeroberfläche im Glass-Design auf Basis der CI-Materialien in `CI/` und des
Glass-Systems aus dem AI-Lawyer-Projekt (`/Users/patrickbaumfalk/Projekte/AI-Lawyer`).

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Umfang Umbenennung | Alles: UI, Paketnamen, GitHub-Repo, lokaler Ordner |
| Glass-Umfang | Nur UI-Chrome; Dokumente/Notizen/Stapel bleiben „Papier" |
| Farbrollen | Navy primär, Blau/Grün/Rot als funktionale Akzente |
| Typografie | Inter, selbst gehostet (Variable Font, woff2) |
| Desk-Fläche | Bestehende Desk-Themes (8 Töne × 5 Materialien) bleiben; Mesh-Gradient nur Login |

## Markenfarben (aus `CI/j-desk-icon-master.png` extrahiert)

| Token | Wert | Rolle |
|---|---|---|
| `--brand-navy` | `#081F39` | Primäraktionen, aktive Zustände, Überschriften |
| `--brand-blue` | `#1372D3` | Links, Interaktion, Fokus |
| `--brand-green` | `#90BD28` | Erfolg, Erledigt |
| `--brand-red` | `#EE181E` | Löschen, destruktive Aktionen, Warnungen |

Abgeleitete Abstufungen (Hover-Töne, transparente Varianten) werden in `app.css`
als CSS-Variablen definiert — keine Hardcodierung in Komponenten.

## Abschnitt 1: Rebranding

**Sichtbar:**
- Titel „J-Desk" in `src/app.html`
- Login-Screen zeigt Logo (`CI/png/j-desk-icon-256.png`; das SVG ist nur ein
  Raster-Wrapper und bringt keinen Vorteil) + Name
- Favicons/Icons aus `CI/` nach `static/`: `j-desk.ico` → `favicon.ico`,
  `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`,
  `site.webmanifest` (Pfade angepasst), PNG-Icons in benötigten Größen
- README-Titel und -Beschreibung

**Technisch:**
- `package.json`: Name `j-desk`
- Workspace-Pakete `@digital-desktop/*` → `@j-desk/*` inkl. aller Importe
- MCP-Servername: `j-desk` (statt `desk`/`digital-desktop`, je nach aktueller Registrierung)

**Repo/Ordner (letzter Schritt, damit die Arbeitspfade stabil bleiben):**
- GitHub-Repo per `gh repo rename j-desk` (GitHub leitet alte URLs weiter)
- Lokalen Ordner `Digital Desktop` → `J-Desk` umbenennen, Remote-URL prüfen

## Abschnitt 2: Design-Tokens (`src/app.css`)

Neue globale Stylesheet-Datei, importiert im Root-Layout.

- **Markenfarben** als CSS-Variablen (siehe oben) mit Abstufungen.
- **Typografie:** Inter als selbst gehostete `@font-face` (Variable Font,
  `woff2` in `static/fonts/`), Fallback System-Stack
  (`ui-sans-serif, system-ui, -apple-system, sans-serif`).
  Der Handschrift-Font der Notizzettel (`NoteCard`) bleibt unberührt.
- **Glass-Stufen** (portiert aus AI-Lawyer `globals.css`):
  - `glass-input` — 8px Blur, minimale Flächen
  - `glass-card` — 16px Blur, Karten/Panels
  - `glass-panel` — 24px Blur, größere Panels/Drawer
  - `glass-elevated` — 40px Blur, Dialoge/Modals
  - jeweils mit `saturate()`, 1px Border, abgestuften Schatten
- **Zwei Token-Sätze:** helles Glas über dunklen Desk-Themes, dunkles Glas über
  hellen Desk-Themes (`dark_white`, `ivory`). Umschaltung per Klasse am
  Wurzelelement auf Basis des bestehenden `isLight()` aus `deskThemes.ts`.
- **Mesh-Gradient** als Utility-Klasse, nur auf dem Login-Screen; Farbtupfer in
  gedämpften J-Desk-Tönen (Navy/Blau-Basis) statt des AI-Lawyer-Violetts.

## Abschnitt 3: Anwendung auf Chrome-Komponenten

**Glass erhalten:**
`DeskControls`, `DeskSwitcher`, `ContextMenu`, `StampPopover`,
`DocViewer`-/`KonvolutViewer`-Chrome (Toolbar/Rahmen, nicht die Seiten),
`TrashCan` (Hover-Zustand), `LoginScreen` (Glass-Card auf Mesh-Hintergrund mit Logo).

**Papier bleiben:**
`DocCard`, `NoteCard`, `StackCard`, `CutoutCard`, Seiteninhalte, Stempel,
Marker, Flags, Ink-Overlay.

**Farbumstellung:** Bestehende Akzentfarben im Chrome auf Tokens umstellen
(Navy/Blau statt bisheriger Grau-/Blautöne; Rot ausschließlich destruktiv).

## Abschnitt 4: Verifikation

1. `npm test` und `npm run check` müssen grün bleiben.
2. App per `verify`-Skill anfahren; visuell prüfen: Login, Desk mit hellem und
   dunklem Theme (Glas-Umschaltung), Kontextmenü, Viewer.
3. Screenshots zur Abnahme vorlegen.

## Nicht in diesem Umfang

- Werkzeug-Design (Radial-Menü, Stabilo-Farben) — eigene Runde
- Querformat-Karten (N5), Setup-Dialog Betriebsmodus (D1), j-lawyer-API-Kartierung
- Nachzeichnen des Logos als echtes Vektor-Master (CI-README-Hinweis)
