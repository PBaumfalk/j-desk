# Design: Schreibtisch-Navigation & Touch-Bedienung

Datum: 2026-07-18. Anlass: In der UAT des Inline-Viewers zeigten sich echte
Bedien-Lücken. Systematische Diagnose (Wurzelursachen unten) und mit dem
Auftraggeber abgestimmtes Bedienkonzept.

## Wurzelursachen (aus systematischer Diagnose, im Code belegt)

Die Eingabe-Schicht des Schreibtischs wurde für Maus-mit-Modifikator gebaut:

1. **Karten nicht per Touch verschiebbar.** (a) Nirgends `touch-action: none`
   (kein Treffer in `src/`) → Safari reklamiert die Touch-Geste (natives
   Scroll/Zoom), liefert keine verlässlichen `pointermove`. (b) Das Verschieben
   rechnet mit `e.movementX/movementY` (`DocCard.svelte`, `StackCard.svelte`,
   Desk-Pan in `Desktop.svelte`), das auf Safari-Touch unzuverlässig (oft 0)
   ist — deshalb geht es an der Maus, aber nicht am iPad.
2. **Zoom kaum auslösbar — auch am Desktop.** Einziger Zoom-Weg heute:
   `Strg`/`Cmd` + Mausrad bzw. Trackpad-Pinch. Normales Mausrad schwenkt nur,
   keine sichtbaren Zoom-Bedienelemente, für Touch-Pinch kein Handler. Die
   Zoom-Mathematik (`zoomAt` in `viewport.ts`) ist korrekt — es fehlt der
   Auslöser.
3. **Kontextmenü am iPad nicht erreichbar.** Nur `oncontextmenu` (Rechtsklick);
   kein Lang-Druck.

## Entscheidungen (mit Auftraggeber geklärt)

| Frage | Entscheidung |
|---|---|
| Zoom-Bedienung Desktop | Mausrad zoomt zum Cursor + sichtbare Knöpfe |
| Bedienfeld | Unten schwebend: `−` `+` `Übersicht` + Vier-Wege-Pfeilpad |
| Pfeilpad | Alle vier Richtungen (↑ ↓ ← →) |
| Tastatur-Pfeile | Bleiben beim aufgeschlagenen Dokument (Seiten-Blättern) |
| crypto.randomUUID-Fallback | Ja, gleich mit (iPad-Upload über HTTP) |

## Umfang

**Enthalten:**
- **Bedienfeld unten** (schwebend, über dem Schreibtisch): `−` / `+` (Zoom zum
  Sichtbereich-Mittelpunkt), `Übersicht` (bestehendes `zoomToFit`, wandert
  hierher), und ein Vier-Wege-Pfeilpad (↑ ↓ ← →) zum Schwenken per Klick/Tipp
  um einen festen Schritt.
- **Maus/Trackpad:** Mausrad zoomt zum Cursor (statt zu schwenken). Ziehen auf
  freier Fläche schwenkt weiter.
- **Touch/iPad:** Ein-Finger schwenkt bzw. zieht Karten; Zwei-Finger-Pinch
  zoomt (Mittelpunkt-erhaltend) und schwenkt; `touch-action: none` auf
  Schreibtisch und Karten, damit der Browser Gesten nicht abfängt.
- **Ziehen robust:** Verschieben von Karten/Stapeln und Desk-Schwenk rechnen
  aus `clientX/clientY`-Deltas (letzte Position gemerkt) statt aus
  `movementX/movementY`. Funktioniert auf Maus UND Touch.
- **Lang-Druck** (~500 ms ohne nennenswerte Bewegung) öffnet das Kontextmenü an
  der Position — auf Touch-Ersatz für den Rechtsklick; Rechtsklick bleibt am
  Desktop.
- **`uid()`-Fallback:** neuer Client-Helfer statt `crypto.randomUUID()` an den
  vier Aufrufstellen; nutzt `crypto.randomUUID` im sicheren Kontext, sonst
  `crypto.getRandomValues` (überall verfügbar) → v4-UUID. Ermöglicht
  Hinzufügen/Verknüpfen/Stapeln vom iPad über `http://192.168…`.

**Nicht enthalten:** Freihand/Pencil-Zeichnen (eigenes späteres Teilprojekt);
Tastatur-Pfeile fürs Schwenken (bleiben beim Viewer).

## Datenmodell / reine Logik

Kein neues Zustandsfeld. In `packages/core/src/viewport.ts` kommt eine reine,
testbare Hilfsfunktion hinzu:

- `panBy(vp: Viewport, dx: number, dy: number): Viewport` — `{ ...vp, x: vp.x + dx, y: vp.y + dy }`.

Zoomen nutzt das bestehende `zoomAt(vp, screenPt, factor)` (korrekt, unverändert):
`−`/`+`/Pinch rufen es mit dem passenden Punkt (Sichtbereich-Mitte bzw.
Pinch-Mittelpunkt) und Faktor auf. Konstanten (Zoom-Schrittfaktor, Pan-Schritt)
liegen in der UI.

## Client-Komponenten

- **`src/lib/uid.ts`** (neu) — `uid(): string`, sicher-kontext-tauglicher
  UUID-Generator mit `getRandomValues`-Fallback. Ersetzt `crypto.randomUUID()`
  in `Desktop.svelte`, `DocCard.svelte`, `StackCard.svelte`.
- **`src/lib/components/DeskControls.svelte`** (neu) — das schwebende Bedienfeld
  unten (`−` `+` `Übersicht`, Pfeilpad). Bekommt Callbacks bzw. wirkt über ein
  kleines gemeinsames Viewport-Interface auf `Desktop.svelte` (Props:
  `onzoom(factor)`, `onpan(dx,dy)`, `onfit()`).
- **`Desktop.svelte`** (geändert) — Eingabe-Umbau: Mausrad-Zoom;
  Pointer-Tracking mit `clientX/Y`-Deltas; Zwei-Finger-Pinch/Pan über eine
  Pointer-Map; `touch-action: none`; bindet `DeskControls` ein; „Übersicht"
  wandert aus der alten Toolbar ins Bedienfeld.
- **`DocCard.svelte`, `StackCard.svelte`** (geändert) — Ziehen auf
  `clientX/Y`-Delta umstellen; `touch-action: none` auf der Karte; Lang-Druck
  → Kontextmenü.

## Interaktion (Kurzreferenz)

| Geste | Wirkung |
|---|---|
| Mausrad | Zoom zum Cursor |
| Ziehen auf freier Fläche (Maus/1 Finger) | Schwenken |
| Ziehen auf Karte | Karte verschieben |
| Zwei Finger (iPad/Trackpad-Touch) | Pinch-Zoom + Schwenken |
| `−`/`+`/Übersicht (Bedienfeld) | Zoom raus/rein / alles einpassen |
| Pfeilpad ↑↓←→ | Schwenken um festen Schritt |
| Rechtsklick (Desktop) / Lang-Druck (Touch) | Kontextmenü |
| Doppelklick/Doppel-Tipp auf Karte | Aufschlagen (bestehend) |

## Fehler-/Randfälle

- **Lang-Druck vs. Ziehen:** pointerdown armt beides; überschreitet die
  Bewegung eine Schwelle (z. B. 8 px) vor Ablauf des Timers → es ist ein Ziehen,
  Lang-Druck abbrechen. Läuft der Timer bei ruhigem Finger ab → Kontextmenü,
  Ziehen unterdrücken.
- **Pinch-Robustheit:** feste Pointer-ID-Paare (gegen Ghost-Pointer), Abbruch
  bei `pointercancel`; unter zwei Pointern zurück auf Ein-Finger-Schwenk.
- **Zoomgrenzen:** `zoomAt` klemmt bereits auf `[0.15, 3]`.
- **`uid()`-Fallback:** liefert ein gültiges v4-UUID-Format auch ohne sicheren
  Kontext; im sicheren Kontext unverändert `crypto.randomUUID`.

## Tests

- **`packages/core`:** `panBy`-Unit-Tests (Delta addiert, Skala unverändert).
- **Client:** `uid()`-Test (Formatprüfung v4-UUID; Fallback-Pfad mit gemocktem
  fehlenden `crypto.randomUUID`).
- **Manuelle UAT (Mac + iPad):** Mausrad-Zoom; `−`/`+`/Übersicht/Pfeilpad;
  Karte ziehen (Maus UND iPad-Finger); Zwei-Finger-Pinch am iPad; Lang-Druck →
  Kontextmenü; PDF vom iPad über HTTP hinzufügen (uid-Fallback).

## Folgearbeiten

- Freihand/Textmarker mit Pencil (eigene Annotationsebene, Teilprojekt danach).
- Optionale Politur: Zoom-Prozentanzeige im Bedienfeld; Tastatur-Schwenk, wenn
  kein Dokument aufgeschlagen.
