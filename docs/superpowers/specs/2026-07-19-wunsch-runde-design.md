# Design: Wunsch-Runde — Viewer-Kontextmenü, Seiten-Miniatur, Lupe über Viewern

Datum: 2026-07-19 · Branch: `feature/inline-viewer` · Status: Features vom Auftraggeber in der
UAT-Rückmeldung freigegeben (A2.8, A3.4, A5.5, A8.5); Umsetzung autonom während seiner Abwesenheit.

## 1. Viewer-Kontextmenü + Verknüpfen am offenen Viewer (A3.4, A5.5)

- Neues `showViewerMenuAt(x, y, doc)` in `menus.ts`: wie das Karten-Menü, aber ohne
  „Aufschlagen" und mit **„Zuklappen"** als erstem Eintrag (collapseDoc). Übrige Einträge
  identisch (In neuem Tab, Mit allen Verknüpften öffnen, Verknüpfen…, Kopieren,
  Herunterladen…, Befestigung, Papierkorb).
- `DocViewer`: Rechtsklick (`oncontextmenu`, preventDefault) auf den ganzen Viewer öffnet es;
  **Lang-Druck (500 ms) auf die Kopfzeile** ebenso (Touch; Muster DocCard: >8 px Bewegung
  bricht ab, versetztes Öffnen +16/+12).
- **Verknüpfen/Anklammern ZUM offenen Viewer:** Kopf- und Body-Pointerdown vervollständigen
  wartende `ui.linkingFromId`/`ui.clippingFromId` wie die Karten (addLink/addClip, Toast bei
  Fehler) — damit funktioniert „Verknüpfen…" in beide Richtungen auch bei aufgeschlagenen
  Dokumenten.

## 2. Miniatur zeigt die zuletzt aufgeschlagene Seite (A2.8)

- `thumbnails.ts`: Seite = `doc.pageOnly ?? doc.page ?? 1` (Cache-Keys sind bereits
  seitenbewusst `fileId:seite`).
- `DocCard`: Thumbnail-Effect reagiert zusätzlich auf `doc.page`; die Stempel-Overlays der
  Karte nutzen dieselbe Seite.
- `doc.page` bleibt beim Zuklappen erhalten (bestehendes Verhalten) — die Karte zeigt also
  die zuletzt gesehene Seite; Dokumente, die nie geblättert wurden, zeigen wie bisher Seite 1.

## 3. Lupe erfasst offene Viewer (A8.5)

- Der Lupen-Ausschluss offener Dokumente in `Desktop.svelte` entfällt.
- In der Lupe rendert ein **statisches Abbild** (`ViewerAbbild.svelte`): Rahmen + Kopfzeile
  (Titel, „S. x / y") + Seite (PageRenderer) + Striche/Abdeckungen/Stempel (Ink-/Mark-/
  StampLayer, inaktiv) — bewusst OHNE den vollen `DocViewer` (keine doppelten Effekte/
  Commands, keine Interaktion; die Lupe ist ohnehin pointer-events: none).

## Tests & Verifikation

Reine Client-Features (keine Core-Änderung) → Gate: `npx vitest run` + `npm run check` +
`npm run build` grün; End-to-End-Sichtprüfung per verify-Skill (Kontextmenü am Viewer,
Verknüpfen zum Viewer, Miniatur nach Blättern+Zuklappen, Lupe über offenem Viewer).

## UAT

Sammelliste + Runde-2-Checkliste um **A13 (3 Punkte)** ergänzen; Zählung 126 → 129 (A 103).

## Nicht in dieser Runde

Radial-Werkzeugmenü + Farbwahl (eigene Design-Runde mit dem Auftraggeber); j-lawyer-
Konfigurations-Dialog (Produktfrage offen).
