# Design: Tafel-Text — weißer Filzstift-Freitext auf dem Filz

Datum: 2026-07-19 · Branch: `feature/inline-viewer` · Status: vom Auftraggeber gewünscht
(„Freitext in weiß, wie auf einer Tafel mit Filzer").

## Ansatz

Neuer Zettel-Typ **`tafel`** („Tafel-Text") statt eines eigenen Objektmodells — damit erbt er
die komplette Zettel-Infrastruktur (Ziehen, Doppelklick-Bearbeiten, Verknüpfen, Klammern,
Klebeband, Papierkorb, Live-Sync, Suche, MCP `add_note`/`get_desk`) ohne neue Integrationen.

## Verhalten & Optik

- **Anlegen:** „＋ → Zettel… → Tafel-Text" (13. Eintrag der zweispaltigen Typwahl);
  sofort im Bearbeiten-Modus. MCP `add_note` kennt den Typ ebenfalls.
- **Optik:** KEIN Papier — transparenter Hintergrund, kein Schatten/Badge; Schrift weiß
  (`#f8f6ef`) in Marker-Schrift (`'Marker Felt', 'Bradley Hand', 'Segoe Print', cursive`),
  ~26 px, mit weichem dunklem Text-Schatten, damit sie auch auf hellen Tischflächen
  (Altweiß/Elfenbein) lesbar bleibt. Bearbeiten-Textarea in derselben Optik.
- **Fläche:** größer als ein Zettel — `TAFEL_W × TAFEL_H = 300 × 160` (eigene Box in
  `noteBox`, damit Treffer-/Anker-/Culling-Geometrie stimmt).
- Klebeband-/Klammer-Indikatoren wie bei Zetteln.

## Tests & Verifikation

Core: `tafel` in `NOTE_KINDS`, `noteBox` liefert die Tafel-Maße (TDD). Client-Gate:
vitest + check + build; E2E-Sichtprüfung mit Screenshot-Kontrolle (weißer Text auf dem
Filz, bearbeitbar, verschiebbar, suchbar).

## UAT

Sammelliste + Runde-2-Checkliste um **A15 (1 Punkt)** ergänzen; Zählung 132 → 133 (A 107).
