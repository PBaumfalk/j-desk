# Design: Gestaltungsrunde — Schreibtisch-Erscheinungsbild (Vision Block 2, voll)

Datum: 2026-07-19 · Branch: `feature/inline-viewer` · Status: vom Auftraggeber freigegeben

## Ziel & Kontext

Die begonnene Gestaltungs-Funktion (Farbe + Material, uncommitted auf dem Branch)
wird auf den vollen Umfang von Vision Block 2 gebracht: zusätzlich **Helligkeit**,
**Strukturintensität** und **Vignette**. Entschieden wurde:

- **Umfang:** voll nach Vision (Farbe, Material, Helligkeit, Struktur, Vignette).
- **Geltung: pro Schreibtisch, geteilt.** Die Gestaltung ist Teil des Desk-Zustands;
  im j-lawyer-Modus sehen alle Kanzlei-Nutzer dieselbe Oberfläche (Änderung synct live).
- **Ansatz A:** das bestehende „Gestaltung…"-Untermenü im DeskSwitcher wird erweitert
  (kein eigener Dialog, keine Stufen-Knöpfe).

## Bereits vorhanden (Zwischenstand, wird übernommen)

- `packages/core/src/background.ts`: `DeskThemeId` (8 Themen), `DeskMaterial` (5),
  `DeskBackground { themeId, material }`, `deskBackground()`-Fallback, `setBackground()`
  mit Validierung; Command `setBackground`; `isValidState`-Toleranz; Tests.
- `src/lib/deskThemes.ts`: Labels, 3-Ton-Paletten, SVG-Noise-Texturen je Material,
  `deskCss()`, `themeSwatch()`, `isLight()`.
- UI: „Gestaltung…"-Untermenü (Farb-Swatches, Materialliste) im DeskSwitcher;
  `Desktop.svelte` wendet den Stil auf Tischfläche und Lupe an; helle Themes
  (`dark_white`, `ivory`) geben Karten/Stapeln/Ausschnitten Kontur + kräftigeren Schatten.

## 1. Datenmodell (packages/core)

`DeskBackground` wächst um drei Felder:

| Feld | Typ | Bereich | Standard |
|---|---|---|---|
| `brightness` | number | 0,75 – 1,25 | 1 |
| `textureIntensity` | number | 0 – 1 | 0,25 |
| `vignette` | boolean | — | `true` |

- `deskBackground(state)` füllt fehlende Felder mit den Standards auf. Damit bleiben
  Alt-States (ganz ohne `background`) **und** Zwischenstände (nur `themeId`/`material`)
  gültig — kein Migrationsschritt.
- `setBackground()` validiert: bekanntes Thema/Material (wie bisher), `brightness` und
  `textureIntensity` endliche Zahlen im Bereich (sonst Fehler, kein stilles Clampen),
  `vignette` boolean. Gespeichert wird immer das vollständige Objekt (5 Felder).
- `commands.ts` (`backgroundPayload`): prüft die neuen Felder entsprechend
  (Zahl/Boolean, aussagekräftige Fehlermeldungen wie bisher).
- `isValidState`: `background` optional; wenn vorhanden, `themeId`/`material` Strings,
  neue Felder optional (Zahl/Zahl/Boolean, wenn gesetzt).

## 2. Darstellung (src/lib/deskThemes.ts)

`deskCss(bg)` rechnet die drei Werte ein:

- **Helligkeit:** skaliert die drei Farbtöne des Themas in JS (RGB-Kanäle
  multiplizieren, auf 0–255 gedeckelt). Bewusst **kein** CSS-`filter: brightness()` —
  der würde die Kind-Elemente (Papiere) mit abdunkeln und verletzt die Vision-Regel
  „Hintergrund verändert nie die echten Farben von Dokumenten/Annotationen".
- **Struktur:** skaliert das Textur-Alpha des Materials linear: bei 0,25 exakt der
  heutige Look (Faktor `intensity / 0.25` auf das bisherige Basis-Alpha), bei 0 entfällt
  die Texturschicht ganz, nach oben gedeckelt (max. Alpha ≈ 0,85), damit die
  Lesbarkeit gewahrt bleibt. `smooth` bleibt in jeder Intensität texturlos.
- **Vignette:** `true` = heutiger Radialverlauf (Lichtzentrum 40 %/30 % → Mittelton →
  Randabdunklung); `false` = gleichmäßige Fläche im (helligkeits-skalierten) Mittelton.

Tischfläche und Lupe nutzen weiterhin denselben Stil (`deskCss`-Ergebnis an beiden
Stellen). `themeSwatch()` und die helle-Themes-Kontur bleiben unverändert.

## 3. Bedienung (DeskSwitcher, „Gestaltung…")

Unter den bestehenden Abschnitten Farbe und Material kommen hinzu:

- Schieberegler **„Helligkeit"** (`input type="range"`, 0,75–1,25, Schritt 0,01).
- Schieberegler **„Struktur"** (0–1, Schritt 0,01).
- Haken **„Randabdunklung"** (Vignette).
- Eintrag **„Zurücksetzen"**: setzt alle fünf Werte auf den Standard
  (`dark_green`/`felt`/1/0,25/an) — ein `setBackground`-Command.

Interaktion:

- Beim **Ziehen** eines Reglers aktualisiert eine lokale Vorschau den Tisch sofort
  (lokaler Override des berechneten Stils); das `setBackground`-Command geht erst beim
  **Loslassen** (`change`-Event) raus. Kein Command-/Sync-Spam; Zweitfenster und
  Kanzlei-Kollegen sehen den Wert beim Loslassen.
- Farbe/Material wirken weiter sofort per Klick (wie im Zwischenstand), Menü bleibt offen.
- Das Untermenü bekommt `max-height` (bezogen aufs Fenster) und `overflow-y: auto`,
  damit es auf kleinen Bildschirmen scrollt. Regler sind per Finger bedienbar
  (native Range-Inputs, ausreichende Höhe der Touch-Ziele).

## 4. Fehlerbehandlung & Kompatibilität

- Ungültige Commands (Bereich verletzt, falscher Typ) werden serverseitig-neutral im
  Core abgewiesen (`CommandError`), UI kann sie nicht erzeugen (Regler sind begrenzt).
- Offline: `setBackground` verhält sich wie jedes Command („Offline — Aktion nicht
  möglich"); die lokale Vorschau wird beim Fehlschlag auf den Zustand zurückgesetzt.
- Server und MCP bleiben unverändert (generischer Zustand; kein neues MCP-Tool).

## 5. Tests

- `packages/core/src/background.test.ts` erweitern: Default-Auffüllung alter/teiliger
  Zustände, Bereichs-Validierung (brightness/textureIntensity/vignette), Command-Parsing
  (fehlende/kaputte Felder), `isValidState` mit neuen Feldern.
- Neu `src/lib/deskThemes.test.ts`: Helligkeitsrechnung (1 = unverändert, Deckelung),
  Struktur 0 → keine Texturschicht, 0,25 → heutiges Alpha, Deckelung oben,
  Vignette aus → flacher Hintergrund ohne Radialverlauf.

## 6. UAT

Die Sammelliste (`docs/uat/2026-07-18-uat-sammelliste.md`) bekommt Block
**A11 — Gestaltungsrunde** (7 Punkte, Zählung anpassen):

1. „Gestaltung…" öffnen, Farbe wechseln → Tisch färbt sofort um; Zweitfenster folgt live.
2. Materialien durchschalten → Struktur sichtbar verschieden (Filz/Leder/Holz/Pergament), Papiere bleiben klar lesbar.
3. Helligkeits-Regler ziehen → Vorschau folgt flüssig beim Ziehen; Loslassen synct (Zweitfenster).
4. Struktur-Regler: 0 = glatt, hoch = kräftig, Lesbarkeit bleibt.
5. Randabdunklung aus → gleichmäßige Fläche; an → Lichtzentrum/Randabdunklung zurück.
6. Helles Thema (Altweiß/Elfenbein) → Papiere setzen sich per Kontur/Schatten ab; Reload erhält alles; „Zurücksetzen" stellt den Standard her.
7. j-lawyer-Modus: Gestaltung der Akte ändern → zweiter Nutzer sieht sie live (geteilt, gewollt); iPad: Regler und Haken per Finger bedienbar.

Vorab Chrome-Vorprüfung der UI-Punkte, sofern die Extension verbunden ist.

## Nicht in dieser Runde

- Kein eigener Gestaltungs-Dialog (Ansatz B verworfen), keine Stufen-Knöpfe (C verworfen).
- Keine Benutzer-persönliche Gestaltung im j-lawyer-Modus (Hybrid verworfen).
- Kein MCP-Tool für die Gestaltung.
