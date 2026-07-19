# Design: Quickwin-Runde — Gedankenobjekte komplett, Schredder, MCP-Werkzeugkasten

Datum: 2026-07-19 · Branch: `feature/inline-viewer` · Status: vom Auftraggeber freigegeben („Fang an!")

## Ziel & Entscheidungen

Drei Quickwins in einer kombinierten Runde (Ansatz A, Reihenfolge bewusst:
Zettel → Schredder → MCP zuletzt, damit das MCP die neuen Objekte direkt mitliest):

1. **Zettel-Ausbau:** alle 10 Vision-Gedankenobjekt-Typen + „Eigener…" (frei
   benennbares Badge); To-do **abhakbar** (Nutzerentscheidung).
2. **Schredder:** endgültiges Löschen **nur im Korb-Panel**, einzeln je Eintrag
   (Nutzerentscheidung).
3. **MCP:** Werkzeugkasten-Objekte **lesen + gefahrlose Schreib-Tools**
   (Nutzerentscheidung); nichts Unwiderrufliches via KI.

## 1. Zettel-Ausbau (packages/core, Client, MCP-Enum)

- `NOTE_KINDS` erweitert um: `behauptung`, `beweisziel`, `idee`, `todo`,
  `argument`, `rechtsfrage`, `eigen` — zusammen mit den bestehenden fünf
  (`notiz`, `frage`, `these`, `angriffspunkt`, `risiko`) also 12.
- `Note` bekommt zwei optionale Felder: `customLabel?: string` (Badge-Text,
  nur bei `eigen` gesetzt) und `done?: boolean` (nur bei `todo` relevant).
  Alt-States bleiben ohne Migration gültig.
- `addNote` akzeptiert `customLabel`; neues Command **`setNoteDone`**
  (noteId, done: boolean). `editNote`/`moveNote`/`removeNote` unverändert.
- **Farben/Badges** (bestehende bleiben: Notiz gelb ohne Badge, Frage blau,
  These grün, Angriffspunkt orange, Risiko rot):

  | Typ | Farbe | Badge |
  |---|---|---|
  | Behauptung | Sand/Braun | „Behauptung" |
  | Beweisziel | Petrol | „Beweisziel" |
  | Idee | Rosa | „Idee" |
  | To-do | Hellgrau | „To-do" + Abhak-Kreis |
  | Argument | Türkis | „Argument" |
  | Rechtsfrage | Violett | „Rechtsfrage" |
  | Eigener | Creme-neutral | `customLabel` |

- **To-do-Abhaken:** Abhak-Kreis oben links auf dem Zettel (Klick/Tipp toggelt
  `setNoteDone`, löst KEIN Bearbeiten/Drag aus); erledigt = Text
  durchgestrichen + Zettel abgedimmt (Opacity ≈ 0.65). Der Kreis ist nur bei
  `kind === 'todo'` sichtbar.
- **Typwahl** („＋ Zettel"): zweispaltiges Menü (12 Einträge); „Eigener…"
  klappt ein Eingabefeld im Menü auf (Muster DeskSwitcher-Umbenennen), Enter
  legt den Zettel mit `customLabel` an, Escape zurück zur Typwahl.
- MCP `add_note`: kind-Enum erweitert; `customLabel` wird wie der Zettel-Text
  behandelt (deanonymisiert vor dem Schreiben, anonymisiert beim Lesen).

## 2. Schredder (packages/core, TrashPanel)

- Core: **`shredTrashItem(s, trashId)`** entfernt genau einen Korb-Eintrag
  endgültig (kein Restore mehr möglich); Fehler bei unbekannter trashId.
  Command `shredTrashItem`.
- UI (Korb-Panel): je Eintrag neben „Wiederherstellen" ein Knopf
  **„Schreddern…"** → confirm-Dialog; im j-lawyer-Modus mit demselben Hinweis
  wie „Korb leeren" (Dokument erscheint beim nächsten Abgleich wieder als
  frische Karte).
- Server-Dateiablage bleibt unangetastet (exakt die „Leeren"-Semantik, nur pro
  Eintrag). Kein MCP-Zugriff auf Schreddern.

## 3. MCP — Werkzeugkasten lesen + gefahrlose Schreib-Tools (packages/mcp)

**Lesen (`get_desk` zusätzlich):**

- Stempel je Dokument: id, Seite, Art bzw. Freitext (**anonymisiert**).
- Notizfahnen je Dokument: id, Seite, Farbe.
- Tipp-Ex/Schwärzungen: nur **Zähler je Dokument** (rein visuell, keine Inhalte/Koordinaten).
- Klammer-Gruppen: id + Objekt-IDs.
- Klebeband-Status (`taped`) an Objekten.
- Konvolut-Status (`stapled`) an Stapeln.
- Korb: Einträge mit Art, Name (**anonymisiert**), Zeitpunkt, trashId.
- Zettel: neue kinds, `customLabel` (**anonymisiert**), `done`.

**Schreiben (alle über bestehende Commands, reversibel):**

| Tool | Wirkung |
|---|---|
| `add_stamp` / `remove_stamp` | Stempel auf Seite (Kanzlei-Art oder Freitext, deanonymisiert); Position automatisch oben rechts |
| `add_flag` / `remove_flag` | Notizfahne (Farbe, Seite) |
| `staple_stack` / `unstaple_stack` | Stapel heften/entheften |
| `clip_objects` / `remove_clip` | Büroklammer-Gruppe bilden/lösen |
| `trash_object` / `restore_trash` | in den Korb / aus dem Korb zurück |
| `set_note_done` | To-do abhaken/aufheben |

**Bewusst NICHT:** `empty_trash`/Schreddern via KI (unwiderruflich bleibt
menschlich — Vision-Regel), keine Tipp-Ex/Schwärzungs-Schreib-Tools
(koordinatenabhängig), kein Klebeband-Tool (marginaler Nutzen).

Anonymisierungs-Regel: alle Freitexte (Stempel-Freitext, customLabel,
Korb-Namen) laufen durch denselben Anonymisierungs-Batch wie Zettel-Texte;
Schreib-Tools deanonymisieren Platzhalter vor dem Schreiben (bestehendes
Muster von `add_note`).

## 4. Fehlerbehandlung & Kompatibilität

- Alle neuen Felder optional → Alt-States gültig, kein Migrationsschritt;
  `isValidState` toleriert sie typ-geprüft.
- Unbekannte kinds/negative Eingaben werden im Core abgewiesen (CommandError-Muster).
- Server bleibt unverändert (generische Command-Route); j-lawyer-Abgleich:
  `shredTrashItem` verhält sich für `trashedFileIds` wie `emptyTrash`
  (geschredderte fileIds sind danach nicht mehr „im Korb" — Dokument kommt als
  frische Karte, im Dialog erklärt).

## 5. Tests

- Core: neue kinds inkl. `eigen`+`customLabel`, `setNoteDone` (nur bool,
  unbekannte Note), `shredTrashItem` (entfernt genau einen, Fehler bei
  unbekannt, restore danach unmöglich), isValidState-Toleranz.
- MCP: get_desk-Serialisierung der neuen Objekte inkl. Anonymisierungs-Parität
  der Freitexte; je Schreib-Tool ein Happy-Path + ein Fehlerfall; add_stamp-
  Auto-Position.

## 6. UAT

- **Block A12 (5 Punkte):** neue Typen/Farben + Badges; „Eigener…"-Badge;
  To-do abhaken (persistiert, Zweitfenster live); Schreddern einzeln (confirm,
  j-lawyer-Hinweis); Reload erhält alles.
- **C′-Erweiterung (3 Punkte):** KI beschreibt Stempel/Fahnen/Korb
  (anonymisiert); KI stempelt/heftet/klammert sichtbar in der UI;
  Freitext-Stempel/customLabel-Anonymisierung stichprobenartig.
- Zählung: A 95→100, C′ 9→12, gesamt 118→**126**.

## Nicht in dieser Runde

- Kein Schredder außerhalb des Korbs (Kontextmenü-Variante verworfen).
- Keine marks-/tape-Schreib-Tools im MCP; kein empty_trash via KI.
- Kein Locher/Scanner; kein freies Zeichnen auf dem Filz.
