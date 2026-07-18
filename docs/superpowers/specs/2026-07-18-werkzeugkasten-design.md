# Design: Werkzeugkasten-Runde — 11 Vision-Werkzeuge (2026-07-18)

Branch: `feature/inline-viewer` · Vorbild-Muster: notes/cutouts/ink (Core-Modul +
Commands + Tests, generische Command-Route, Svelte-Komponente).
Vision-Quelle: `docs/vision/2026-07-18-digitaldesk-vision.md` (Werkzeug-Inventar Block 1).

## Umfang

**Gebaut werden 11 Werkzeuge:** Hefter, Büroklammer, Lineal, Kugelschreiber,
Tipp-Ex, Schwärzung, Notizfahne, Klebeband, Stempel, Kopierer, Papierkorb.

**Zurückgestellt (bewusst, mit Begründung):**

- **Scanner** — echtes Einscannen braucht Kamera/Hardware; im Browser bliebe nur
  Foto-Import, der ein eigenes Bild-Objektmodell verlangt. Später.
- **Locher** — lochen setzt ein Abheft-/Ordner-System voraus, das es noch nicht
  gibt. Später zusammen mit einem Ordner-Objekttyp.
- **Schredder** — endgültiges Vernichten kollidiert im j-lawyer-Modus mit
  „Originale nie zerstören". Der Papierkorb deckt das Entfernen ab; „Leeren"
  übernimmt das endgültige Löschen von Tisch-Objekten.

**Ausdrücklich NICHT in dieser Runde:** MCP-Anbindung der neuen Objekte
(`get_desk` liefert sie noch nicht; eigene Folgerunde), forensische Schwärzung,
Bild-/Foto-Objekte, Ordner.

## Entschiedene Abgrenzungen (Nutzer-Entscheidungen)

1. **Hefter/Büroklammer/Klebeband nach Papier-Logik:**
   - **Hefter** macht aus einem Stapel ein festes **Konvolut**: eine Karte,
     feste Reihenfolge, nicht auffächerbar, als Ganzes durchblätterbar,
     wieder entheftbar.
   - **Büroklammer** bildet eine **lose Gruppe**: Objekte bleiben einzeln
     sichtbar/versetzt liegen, werden aber gemeinsam verschoben; Klammer
     abnehmbar.
   - **Klebeband** klebt **ein** Objekt am Tisch fest: Drag gesperrt, bis das
     Band abgezogen wird.
2. **Stempel:** festes Kanzlei-Set **plus Freitext-Stempel**. Set: ERLEDIGT,
   WICHTIG, FRIST!, GEPRÜFT, EINGANG (mit Tagesdatum), ENTWURF, KOPIE.
3. **Papierkorb:** echter Korb mit Inhalt — hineingelegte Objekte sind vom
   Tisch, aber wiederherstellbar; „Leeren" löscht endgültig (mit Bestätigung).
4. **Radierer entfernt Tipp-Ex/Schwärzung NICHT** — Abdeckungen werden nur über
   das jeweilige Werkzeug wieder abgelöst (Klick auf die Fläche im
   Werkzeugmodus).

## Datenmodell (packages/core)

Alle Koordinaten seitenverankerter Objekte in Basiskoordinaten der Seite
(gleiche Konvention wie Strokes). Neue optionale Felder im `DesktopState` —
Leerzustände bleiben abwärtskompatibel (wie beim `cutouts`-Feld).

- **`marks: Mark[]`** — `{ id, docId, page, x, y, w, h, kind: 'redact' | 'tippex' }`.
  Schwärzung rendert deckend schwarz, Tipp-Ex deckend weiß (Papierweiß).
  Commands: `addMark`, `removeMark`. `removeDoc`/Konsorten räumen Marks mit ab.
- **`stamps: Stamp[]`** — `{ id, docId, page, x, y, angle, text, color: 'red' | 'blue', date? }`.
  `date` (ISO-Tag) wird beim EINGANG-Stempel gesetzt und mitgerendert.
  Freitext: `text` frei, gleiche Optik. Commands: `addStamp`, `removeStamp`.
- **`flags: Flag[]`** — `{ id, docId, page, offset (0..1 am rechten Rand), color, label? }`.
  Commands: `addFlag`, `removeFlag`.
- **`trash: TrashedItem[]`** — `{ id, kind: 'doc' | 'note' | 'cutout' | 'stack', payload, trashedAt }`.
  `payload` ist das vollständige serialisierte Objekt inkl. zugehöriger
  Strokes/Marks/Stamps/Flags (bei Stapeln: alle Mitglieder). Commands:
  `trashObject` (kappt Schnüre wie das heutige Entfernen), `restoreObject`
  (legt zurück, ohne Schnüre — dokumentiert), `emptyTrash`.
- **Stacks:** neues Feld `stapled?: boolean`. Commands: `stapleStack`,
  `unstapleStack`. Ein gehefteter Stapel ist nicht auffächerbar und kein
  Ziel für „Karte herausnehmen"; `dissolveStack` verlangt vorheriges Entheften.
- **`clips: Clip[]`** — `{ id, memberIds: string[] }` (Objekt-IDs beliebiger
  Tischobjekte). Commands: `addClip`, `removeClip`. Verschieben eines Mitglieds
  verschiebt alle (Client-Drag wendet die Delta-Bewegung auf alle Mitglieder an;
  persistiert wird pro Mitglied über die bestehenden move-Commands als Gruppe).
  Entfernte Objekte verlassen ihre Clip-Gruppe automatisch; Gruppen < 2
  Mitglieder lösen sich auf.
- **Objekte:** neues Feld `taped?: boolean` auf Karten, Zetteln, Ausschnitten
  und Stapeln. Commands: `tapeObject`, `untapeObject`.

## Werkzeuge ohne neues Modell

- **Kugelschreiber/Bleistift:** Der bisherige ✎-Stift (dunkelblau, dünn) heißt
  jetzt **Kugelschreiber**; neu: **Bleistift** (grau, dünner). Beide nutzen die
  bestehende Stroke-Infrastruktur, Radierer wirkt auf beide.
- **Lineal:** Zeichenmodus; beim Loslassen wird der Strich zur Geraden
  begradigt und als normaler 2-Punkt-Stroke gespeichert (Kugelschreiber-Optik).
  Radierer/Skalierung/Sync funktionieren dadurch ohne Sonderpfad.
- **Kopierer:** Kontextmenü „Kopieren" auf Karte, Seitenkarte, Ausschnitt und
  Zettel. Dupliziert das Objekt mit neuen IDs inkl. seiner Strokes/Marks/
  Stamps/Flags, leicht versetzt. Gleiche Datei-Referenz (`fileId`), keine
  Datei-Duplizierung, kein j-lawyer-Schreibvorgang. Stapel werden nicht
  kopiert (später bei Bedarf).

## Konvolut-Viewer (Hefter)

Doppelklick auf ein Konvolut schlägt es als Ganzes auf: ein Viewer blättert
über die verketteten Seiten aller Mitglieder in Stapelreihenfolge. Globaler
Seitenindex → (Mitglieds-Dokument, lokale Seite). Seitenzahlen der Mitglieder
werden beim ersten Laden über pdfjs ermittelt und im Client gecacht
(Seitenkarten zählen als 1 Seite). Kopfzeile zeigt „Konvolut · Seite g/G".
Annotationen (Stift/Marker/Marks/Stempel) auf Konvolut-Seiten schreiben auf
das jeweilige Mitglieds-Dokument und dessen lokale Seite — sie bleiben nach dem
Entheften beim richtigen Dokument.

## UI

- **Viewer-Kopf in Gruppen mit Trennern:** Zeichnen (Bleistift · Kugelschreiber ·
  Marker · Lineal · Radierer) | Abdecken (Tipp-Ex · Schwärzung) | Stempel
  (ein Knopf, Auswahl-Popover mit Set + Freitext-Eingabe) | Fahne | Enthefter ·
  Schere · Lichttisch. Auf schmalen Viewern scrollt die Leiste horizontal.
- **Stempeln:** Stempel im Popover wählen → Klick auf die Seite setzt ihn
  (leichte Zufallsdrehung ±6°, Stempeloptik: Konturschrift, Farbe rot/blau).
  Stempel auf Seite 1 erscheinen auch auf der zugeklappten Karte
  (DOM-Overlay über der Miniatur, mitskaliert).
- **Notizfahnen:** Fahnen-Werkzeug aktiv → Klick an den rechten Seitenrand
  setzt eine Lasche (Farbwahl im Popover: gelb/rot/blau/grün). Laschen ragen
  an der zugeklappten Karte rechts heraus; im Viewer springt ein Klick auf
  eine Lasche zur jeweiligen Seite. Entfernen: Fahnen-Werkzeug aktiv, Klick
  auf die Lasche.
- **Papierkorb:** fester Korb unten rechts am Tischrand (Tisch-Stil wie
  DeskControls), Badge mit Anzahl. Objekte per Kontextmenü „In den Papierkorb"
  oder Hineinziehen (Drop-Zone). Klick öffnet ein Panel: Inhalt mit Name/Art/
  Zeitpunkt, je „Wiederherstellen", unten „Korb leeren…" mit confirm-Dialog.
  Das bisherige Kontextmenü „Entfernen" wird zu „In den Papierkorb";
  endgültiges Löschen gibt es nur noch über „Korb leeren".
- **Kontextmenüs:** Stapel: „Heften"/„Entheften". Objekte: „Festkleben"/
  „Band abziehen", „Anklammern an…" (Verknüpfen-Muster: Zielobjekt anklicken;
  existiert bereits eine Clip-Gruppe eines der beiden, wird erweitert),
  „Klammer entfernen", „Kopieren".
- **Optik:** Klebeband = halbtransparenter Klebestreifen schräg über der
  oberen Ecke; Büroklammer = Klammer-Icon am obersten Gruppenmitglied;
  Konvolut = Heftklammer-Icon statt Fächer-Symbol.

## Sync, j-lawyer, Grenzen

- Alle Änderungen laufen über die bestehende Command-Route → Persistenz und
  Live-Sync ins Zweitfenster ohne Sonderbehandlung.
- **j-lawyer-Abgleich:** Dokumente im Papierkorb gelten beim Eingangs-Abgleich
  als vorhanden — sie werden nicht erneut als Karte angelegt. In j-lawyer wird
  durch Korb/Leeren **nie** etwas gelöscht; „Leeren" entfernt nur Tisch-Objekte
  (bei j-lawyer-Karten: nur die Karte samt Annotationen, das Dokument bleibt
  in der Akte und käme bei erneutem Abgleich als frische Karte zurück — das
  ist gewollt und wird im Leeren-Dialog erwähnt).
- **Schwärzung ist rein visuell:** Der Text bleibt im PDF (kein forensisches
  Schwärzen). Beim ersten Benutzen erscheint ein einmaliger Hinweis.
- Abwärtskompatibilität: alte States ohne die neuen Felder laden unverändert
  (Leerzustand-Semantik wie bei `cutouts`).

## Tests

- Core: je Modul Vitest-Tests nach bestehendem Muster (marks, stamps, flags,
  trash, clips, staple/tape, copy; inkl. Aufräum-Kaskaden bei removeDoc/
  removeStack und Clip-Selbstauflösung).
- Konvolut-Seitenmapping als reine Funktion mit Tests (globaler Index ↔
  Mitglied/lokale Seite, Seitenkarten = 1 Seite).
- Automatisierte Chrome-E2E-Vorprüfung wie bei A5–A8 (zeichnen, stempeln,
  Fahne, Korb-Roundtrip, Konvolut blättern, Klammer-Gruppenzug, Klebeband
  sperrt Drag, Live-Sync im Zweitfenster).
- Danach neuer UAT-Block A9 in `docs/uat/2026-07-18-uat-sammelliste.md`.
