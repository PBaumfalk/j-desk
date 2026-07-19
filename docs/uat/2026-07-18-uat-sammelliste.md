# UAT-Sammelliste — alle offenen manuellen Tests (Stand 2026-07-18)

Konsolidiert alle „pending user verification"-Punkte. **132 Punkte in drei aktiven Blöcken**
(A mit 106, C′ mit 12, D mit 14) — jeder Block hat ein eigenes Setup, innerhalb eines Blocks
kann in einer Sitzung durchgetestet werden.

**Empfohlene Reihenfolge:** Block A (aktueller Branch, enthält jetzt auch Zettel A7 und
MCP-Portierung C′) → Block D (j-lawyer-Modus, braucht deine Instanz).

> **TP3/TP4-Entscheidung ist gefallen (2026-07-18):** Beide wurden in den Rework überführt.
> Der MCP läuft jetzt portiert auf `feature/inline-viewer` (Block C′ ersetzt Block C);
> TP3s Kontenverwaltung entfällt zugunsten des j-lawyer-Logins (Block D). **Die alten
> Blöcke B und C auf den TP3-/TP4-Branches müssen damit NICHT mehr getestet werden** —
> sie bleiben unten nur als Referenz stehen, die Branches werden nicht gemergt.

---

## Block A — Browser-App (Branch `feature/inline-viewer`, 106 Punkte)

**Setup:**

```bash
git checkout feature/inline-viewer
npm run build
DATA_DIR=/tmp/dd-uat npm run server        # frische Daten, Port 4810
```

Mac: `http://localhost:4810` · iPad: `http://<LAN-IP>:4810` (HTTP reicht, uid-Fallback ist drin).
Für A2 ein **mehrseitiges** PDF bereithalten.

### A1 — Browser-Grundfunktionen (TP-A)

- [ ] A1.1 Ersteinrichtung: Konto anlegen → Schreibtisch erscheint.
- [ ] A1.2 „＋ PDF": zwei PDFs wählen → Karten mit Miniaturen erscheinen.
- [ ] A1.3 PDF per Drag-and-drop aus dem Finder auf den Schreibtisch → Karte an der Maus-Position.
- [ ] A1.4 Kontextmenü „In neuem Tab öffnen" → PDF öffnet in neuem Tab.
- [ ] A1.5 „Herunterladen…" → Datei landet im Download-Ordner.
- [ ] A1.6 Seite neu laden → Sitzung bleibt, Schreibtisch wie zuvor; zweites Neuladen → Miniaturen aus IndexedDB (Netzwerk-Tab: keine `files/`-Abrufe).
- [ ] A1.7 Zweites Browser-Fenster (gleiches Konto): Karte in Fenster A verschieben → Fenster B folgt live.
- [ ] A1.8 Server stoppen → Banner „Verbindung getrennt", Aktionen gesperrt; Server starten → verbindet selbst neu.
- [ ] A1.9 Abmelden, Schreibtisch anlegen/umbenennen/löschen (confirm-Dialog) funktionieren.
- [x] A1.10 Docker: `docker build -f packages/server/Dockerfile -t dd-test . && docker run --rm -p 4811:4810 dd-test` → `http://localhost:4811` zeigt die App. *(maschinell verifiziert 2026-07-18: Build ok, API antwortet, App wird ausgeliefert — eigener Testlauf optional)*

### A2 — Inline-Viewer (PDF „aufschlagen")

- [ ] A2.1 Mehrseitiges PDF hinzufügen; Doppelklick auf die Karte → schlägt an ihrer Position zu großer Karte auf, Seite 1 sichtbar.
- [ ] A2.2 Blättern per ‹/› → Seite wechselt, „Seite / Gesamt" stimmt; ‹ bei Seite 1 und › bei letzter Seite sind gesperrt.
- [ ] A2.3 Blättern per Pfeiltasten (Viewer fokussiert/angeklickt) → Seite wechselt.
- [ ] A2.4 Blättern per Wischen (iPad) → Seite wechselt.
- [ ] A2.5 Größe am Anfasser unten rechts ziehen → Karte wird größer/kleiner, Seite skaliert mit.
- [ ] A2.6 Kopfzeile ziehen → Karte verschiebt sich (Maus **und** Finger).
- [ ] A2.7 Zweites PDF ebenfalls aufschlagen → beide gleichzeitig offen.
- [ ] A2.8 ✕ → zurück zur Miniatur; erneut aufschlagen → gleiche Seite/Größe wie zuvor.
- [ ] A2.9 Seite neu laden → aufgeschlagene Karten liegen wie zuvor da (Seite/Größe erhalten).
- [ ] A2.10 Zweites Fenster: Aufschlagen und Blättern in Fenster A → Fenster B folgt live.
- [ ] A2.11 Server stoppen → Banner, Aktionen gesperrt; gecachte Seiten bleiben sichtbar.

### A3 — Navigation & Touch

Mac:

- [ ] A3.1 Mausrad über dem Schreibtisch → zoomt zum Cursor (rein/raus).
- [ ] A3.2 Bedienfeld unten: `−`/`＋` zoomen, `⤢` passt alles ein, Pfeilpad ↑↓←→ schwenkt.
- [ ] A3.3 Karte mit der Maus ziehen → folgt sauber; Loslassen speichert die Position (Reload prüfen).
- [ ] A3.4 Rechtsklick auf Karte → Kontextmenü.

iPad:

- [ ] A3.5 Ein Finger auf freier Fläche → schwenkt; auf einer Karte → verschiebt die Karte.
- [ ] A3.6 Zwei Finger → Pinch-Zoom + Schwenken.
- [ ] A3.7 Lang-Druck auf eine Karte → Kontextmenü (ohne dass beim Loslassen sofort ein Eintrag auslöst).
- [ ] A3.8 Über HTTP (`http://<LAN-IP>:4810`): PDF hinzufügen → erscheint, kein Fehler.

### A4 — Nachzügler-Fixes vom 2026-07-18

- [ ] A4.1 **iPad, der Karten-Blockade-Fix:** Karte per Lang-Druck aufschlagen und den Finger dabei **liegen lassen** (Menü erscheint unter dem Finger, „Aufschlagen" antippen), Viewer mit ✕ schließen → die Karte lässt sich danach **weiterhin verschieben**.
- [ ] A4.2 **iPad:** Während ein Finger eine Karte zieht, mit einem zweiten Finger auf dieselbe Karte tippen/ziehen → die Karte folgt nur dem ersten Finger, keine Sprünge (auch nach Loslassen).
- [ ] A4.3 **Mac:** Pfeiltasten ↑↓←→ schwenken den Schreibtisch (gleiche Schrittweite wie das Pfeilpad).
- [ ] A4.4 **Mac:** Viewer aufschlagen und fokussieren → ←/→ blättern (Schreibtisch schwenkt **nicht**); Stapel-Namensfeld fokussieren → Pfeiltasten bewegen den Cursor, kein Schwenken.
- [ ] A4.5 **Optik:** Bedienfeld unten wirkt als zusammenhängendes dunkles Panel im Tisch-Stil (Creme-Symbole, Trennlinie) — gefällt es auf Mac **und** iPad?

### A5 — Backlog-Runde vom 2026-07-18 (automatisiert in Chrome vorgeprüft; auf echten Geräten bestätigen, besonders iPad/Safari)

- [ ] A5.1 „Abmelden" (Toolbar oben rechts) → Login-Maske; Neuladen landet wieder auf der Login-Maske (Session gelöscht).
- [ ] A5.2 Im Viewer schnell mehrfach blättern (‹/› oder Pfeiltasten) → flüssig ohne Ruckeln; nach Neuladen stimmt die zuletzt gesehene Seite.
- [ ] A5.3 Karte aufschlagen → Pfeiltasten blättern **sofort**, ohne dass man den Viewer erst anklicken muss.
- [ ] A5.4 Viewer groß ziehen, dann „⤢ Übersicht" → der ganze Viewer ist im Bild (nicht nur die Miniatur-Fläche).
- [ ] A5.5 Karte verknüpfen und aufschlagen → die Schnur ankert in der Mitte des offenen Viewers.
- [ ] A5.6 Miniatur-Karte auf einen offenen Viewer ziehen → es entsteht **kein** Stapel (offene Papiere sind kein Stapelziel).
- [ ] A5.7 **Verhaltensänderung bestätigen:** Klick auf einen Eintrag im aufgefächerten Stapel zieht das Papier neben den Stapel und schlägt es auf (vorher: neuer Browser-Tab). Einverstanden?
- [ ] A5.8 **iPad:** Ein Finger auf dem Filz, zweiter Finger auf einer Karte → Pinch zoomt den Tisch (die Karte wird nicht verschoben).
- [ ] A5.9 **iPad:** Lang-Druck mit leicht zitterndem Finger → Karte bleibt exakt liegen, Menü erscheint leicht versetzt; auch nach **langem** Halten löst das Loslassen keinen Menüeintrag aus.
- [ ] A5.10 Server währenddessen stoppen: Aktionen melden „Offline — Aktion nicht möglich"; direkt nach Server-Neustart kurz „Verbindung wird aufgebaut".

### A6 — Pencil-Zeichnen: Stift & Marker auf PDF-Seiten (NEU, automatisiert in Chrome vorgeprüft)

- [ ] A6.1 Karte aufschlagen, „✎" (Stift) aktivieren, mit Maus/Finger zeichnen → dunkelblauer Strich liegt auf der Seite.
- [ ] A6.2 Marker-Knopf (gelbes Quadrat) → breiter halbtransparenter gelber Strich, Text darunter bleibt lesbar.
- [ ] A6.3 Blättern (‹/›) → Striche bleiben bei ihrer Seite; andere Seiten sind sauber.
- [ ] A6.4 Viewer am Anfasser größer/kleiner ziehen → Striche skalieren exakt mit der Seite.
- [ ] A6.5 „⌫" (Radierer): über einen Strich tippen/streichen → genau dieser Strich verschwindet.
- [ ] A6.6 Werkzeug abschalten (erneuter Klick) → normales Verhalten: Wischen blättert, Kopf zieht den Viewer.
- [ ] A6.7 Neuladen → Striche noch da; zweites Fenster (gleiches Konto) sieht neue Striche live.
- [ ] A6.8 **iPad, Apple Pencil:** Zeichnen ist flüssig und ohne spürbare Verzögerung; Handballen löst nichts aus, solange kein Werkzeug aktiv ist.
- [ ] A6.9 **Produktentscheidungen bestätigen:** feste Farben (blau/gelb) ohne Farbwahl ok? Strichweiser Radierer ok? Werkzeug nur explizit aktivieren (kein Auto-Pencil-Modus) ok?

### A7 — Notizzettel & Gedankenobjekte (NEU, automatisiert in Chrome vorgeprüft)

- [ ] A7.1 „＋ Zettel" → Typwahl (Notiz/Frage/These/Angriffspunkt/Risiko) → Zettel erscheint in der Mitte und ist sofort beschreibbar; Speichern per Klick daneben oder Cmd/Ctrl+Enter.
- [ ] A7.2 Farben/Badges der fünf Typen gefallen? (gelb/blau/grün/orange/rot, Typ-Label außer bei „Notiz")
- [ ] A7.3 Zettel verschieben (Maus **und** iPad-Finger); Doppelklick/Doppeltipp bearbeitet.
- [ ] A7.4 Zettel per Kontextmenü (Rechtsklick/Lang-Druck) „Verknüpfen…" mit Karte oder Stapel → Schnur; „Mit allen Verknüpften öffnen" von der Karte aus berücksichtigt sie normal.
- [ ] A7.5 Neuladen → Zettel, Texte und Schnüre unverändert; zweites Fenster sieht Änderungen live.
- [ ] A7.6 Zettel entfernen → Schnur verschwindet mit.

### A8 — Vision-Werkzeuge: Enthefter, Schere, Lichttisch, Lupe (NEU, automatisiert in Chrome vorgeprüft)

- [ ] A8.1 **Enthefter (⧉ im Viewer-Kopf):** löst die aktuelle Seite als eigene Karte neben den Viewer; das Original bleibt unverändert (nicht destruktiv).
- [ ] A8.2 Herausgelöste Seitenkarte: Miniatur zeigt die richtige Seite; aufgeschlagen zeigt sie „S. n" fest, ohne Blättern.
- [ ] A8.3 **Schere (✄ im Viewer-Kopf):** Rechteck auf der Seite aufziehen → Ausschnitt landet in Originalgröße neben dem Viewer; verschieb- und verknüpfbar, übersteht Neuladen.
- [ ] A8.4 **Lichttisch (◐ im Viewer-Kopf):** Viewer wird durchscheinend — zwei aufgeschlagene Seiten übereinandergeschoben lassen sich vergleichen. Wirkung/Deckungsgrad ok?
- [ ] A8.5 **Lupe (🔍 im Bedienfeld):** runder 2,5-fach-Ausschnitt folgt Maus bzw. Finger; offene Viewer erscheinen darin bewusst nicht. Auf dem iPad brauchbar?
- [ ] A8.6 **Produktfrage:** Werkzeug-Inventar-Rest der Vision (Lineal, Notizfahne, Stempel, Schwärzung, Tipp-Ex, Klebeband, Büroklammer, Locher, Kopierer/Scanner/Schredder) — Priorisierung fürs nächste Teilprojekt?

### A9 — Werkzeugkasten-Runde (NEU; Command-Kette per HTTP-Smoke maschinell vorverifiziert, Chrome-UI-Vorprüfung entfiel — Extension nicht verbunden, UI-Punkte sind hier Erstkontakt)

- [ ] A9.1 Bleistift (grau) und Kugelschreiber (dunkelblau) zeichnen; Radierer entfernt beide.
- [ ] A9.2 Lineal: Ziehen ergibt eine exakte Gerade (Vorschau schon während des Ziehens gerade).
- [ ] A9.3 Tipp-Ex deckt weiß, Schwärzung schwarz; Radierer lässt beide stehen; Ablösen nur per Klick im jeweiligen Werkzeugmodus. Beim ersten Schwärzen erscheint der Hinweis „Text bleibt im PDF" (nur einmal).
- [ ] A9.4 Stempel: EINGANG trägt das Tagesdatum; Freitext-Stempel funktioniert; Stempel auf Seite 1 erscheint auf der Miniatur-Karte; im Stempelmodus entfernt ein Klick den Abdruck.
- [ ] A9.5 Notizfahne: Farbe wählen, an den Seitenrand setzen → Lasche an Karte und im Viewer; Klick auf Lasche springt zur Seite; im Fahnenmodus entfernt der Klick sie.
- [ ] A9.6 Hefter: Stapel heften → Karte zeigt 📎, kein Auffächern mehr; Doppelklick blättert als Konvolut über ALLE Mitglieder (Seitenzahl „g / G" stimmt); Zeichnen/Stempeln auf einer Konvolut-Seite bleibt nach Entheften beim richtigen Dokument.
- [ ] A9.7 Büroklammer: „Anklammern an…" → beide Objekte ziehen gemeinsam (Abstände bleiben); „Klammer entfernen" löst die Gruppe.
- [ ] A9.8 Klebeband: „Festkleben" sperrt das Ziehen (Maus und Finger), Klebestreifen sichtbar; „Band abziehen" gibt frei — auch auf dem iPad per Lang-Druck-Menü (Review-Fix: Menü bleibt bei festgeklebten Objekten erreichbar).
- [ ] A9.9 Kopierer: „Kopieren" auf Karte mit Stempel/Strichen → Duplikat samt Annotationen liegt versetzt daneben; Kopie eines Zettels und eines Ausschnitts.
- [ ] A9.10 Papierkorb: Karte hineinziehen ODER „In den Papierkorb" → Badge zählt; Panel zeigt Art/Name/Zeit; Wiederherstellen legt zurück (Schnüre sind weg — ok?); „Korb leeren…" fragt nach und löscht endgültig.
- [ ] A9.11 j-lawyer-Modus: Akten-Karte in den Korb → Abgleich legt KEINE neue Karte an (maschinell getestet); nach „Leeren" kommt das Dokument beim nächsten Abgleich als frische Karte (gewollt — im Dialog erklärt).
- [ ] A9.12 Reload + Zweitfenster: Marks, Stempel, Fahnen, Konvolut-Zustand, Klammern, Klebeband und Korb-Inhalt überleben ein Neuladen und erscheinen im Zweitfenster live.
- [ ] A9.13 **Produktentscheidungen bestätigen:** Fahne = eine pro Aktivierung ok? Stempel-Optik/Sortiment ok? Konvolut ohne Enthefter/Schere im Kopf ok (nur am Einzeldokument)?

### A10 — Dateitypen-Runde (NEU; Klassifizierung/Preview-Semantik per HTTP-Smoke + 3 Testsuiten maschinell vorverifiziert, Chrome-UI-Vorprüfung entfiel — UI-Punkte sind Erstkontakt. Für A10.3/A10.4/A10.6 den Euro-Office-Container starten: `docker compose -f docs/deployment/eurooffice-compose.yaml up -d` + Env laut README)

- [ ] A10.1 „＋"-Menü: Datei…/Zettel… — Mehrfachauswahl beliebiger Typen; Drag-and-drop ebenso.
- [ ] A10.2 Bild (JPG/PNG) hochladen → Karte zeigt das Foto (Polaroid-Optik); aufschlagen → Bildansicht, Kopf zeigt „Bild"; Stempel/Zeichnen/Schere funktionieren auf dem Bild (Scheren-Ausschnitt zeigt den Bildausschnitt!); Reload erhält alles.
- [ ] A10.3 ODT hochladen (Euro-Office-Container läuft) → Karte „Vorschau wird erstellt…", dann Miniatur; aufschlagen → blättert wie ein PDF; Werkzeuge funktionieren. **Gegenprobe echte Instanz:** ConvertService-Pfad/JWT_ENABLED-Annahme (Compose-Kommentar) bestätigen.
- [ ] A10.4 DOCX/XLSX aus der j-lawyer-Akte → gleiches Verhalten; Original bleibt unverändert in der Akte (Stichprobe: „Herunterladen" liefert das Original, nicht das Vorschau-PDF).
- [ ] A10.5 ZIP hochladen → generische Karte mit Typ-Kürzel; kein „Aufschlagen" im Menü; Herunterladen liefert die Datei.
- [ ] A10.6 Euro-Office-Container stoppen → ODT-Aufschlag-Versuch meldet „Vorschau-Dienst nicht erreichbar"; Container starten → nächster Versuch konvertiert.
- [ ] A10.7 Ohne EUROOFFICE_URL-Konfiguration: konvertierbare Typen verhalten sich wie generische Karten mit Hinweis; PDFs/Bilder normal (maschinell vorverifiziert).
- [ ] A10.8 MCP: „Lies Dokument X" auf einer ODT → Zusammenfassung über die Vorschau (anonymisiert wie PDFs); auf einem Bild → klare Fehlermeldung.
- [ ] A10.9 Zweitfenster/Reload: kind-abhängige Darstellung überall konsistent (Bild bleibt Bild, other bleibt other; bekannte Grenze: extern geänderte j-lawyer-Dokumente können bis zum Cache-Leeren eine veraltete Vorschau zeigen).
- [ ] A10.10 **Produktentscheidungen bestätigen:** Bild-Karte als „Polaroid" ok? Generisches Karten-Design ok? Lazy-Konvertierung (erst beim Anschauen) ok?

### A11 — Gestaltungsrunde: Erscheinungsbild des Schreibtischs (NEU)

- [ ] A11.1 DeskSwitcher → „Gestaltung…": Farbe wechseln → Tisch färbt sofort um, Menü bleibt offen; Zweitfenster folgt live.
- [ ] A11.2 Materialien durchschalten (Glatt/Filz/Leder/Holz/Pergament) → Struktur sichtbar verschieden, Papiere bleiben klar lesbar.
- [ ] A11.3 Helligkeits-Regler ziehen → Tisch folgt flüssig schon beim Ziehen; erst beim Loslassen übernimmt das Zweitfenster den Wert.
- [ ] A11.4 Struktur-Regler: 0 = ganz glatt, hoch = deutlich kräftiger; Lesbarkeit bleibt in jeder Stellung.
- [ ] A11.5 „Randabdunklung" abhaken → gleichmäßige Fläche ohne Lichtzentrum; wieder anhaken → Verlauf zurück.
- [ ] A11.6 Helles Thema (Altweiß/Elfenbein): Papiere setzen sich per Kontur/Schatten ab; Reload erhält alle Einstellungen; „Zurücksetzen" stellt Dunkelgrün/Filz/Standardregler wieder her.
- [ ] A11.7 j-lawyer-Modus: Gestaltung einer Akte ändern → zweiter Nutzer sieht sie live (kanzlei-weit geteilt, gewollt); iPad: Regler und Haken per Finger bedienbar, Ziehen am Regler scrollt das Menü nicht.

### A12 — Quickwin-Runde: Gedankenobjekte komplett & Schredder (NEU)

- [ ] A12.1 „＋ Zettel": Typwahl ist zweispaltig mit 12 Typen; die 6 neuen Farben/Badges (Behauptung sand, Beweisziel petrol, Idee rosa, To-do grau, Argument türkis, Rechtsfrage violett) gefallen?
- [ ] A12.2 „Eigener…": Bezeichnung eingeben (z. B. „Zeugenfrage") → Zettel trägt das eigene Badge; Reload erhält es.
- [ ] A12.3 To-do: Abhak-Kreis anklicken/antippen → Haken, Text durchgestrichen, Zettel gedimmt; Zweitfenster folgt live; erneuter Klick hebt es auf; Abhaken löst kein Ziehen/Bearbeiten aus.
- [ ] A12.4 Korb-Panel: „Schreddern…" bei einem Eintrag → Bestätigungsdialog, Eintrag verschwindet endgültig (kein Wiederherstellen); andere Einträge bleiben.
- [ ] A12.5 j-lawyer-Modus: Schreddern-Dialog erklärt den Abgleich (Dokument kommt als frische Karte zurück); Verhalten stimmt.

### A13 — Wunsch-Runde: Viewer-Kontextmenü, Seiten-Miniatur, Lupe (NEU; E2E vorverifiziert)

- [ ] A13.1 Rechtsklick (Mac) bzw. Lang-Druck auf die Kopfzeile (iPad) eines AUFGESCHLAGENEN Dokuments → Kontextmenü mit „Zuklappen" zuoberst; „Verknüpfen…" funktioniert vom Viewer aus UND eine wartende Verknüpfung lässt sich durch Klick auf den Viewer vervollständigen (Schnur ankert am Viewer).
- [ ] A13.2 Im Viewer auf eine andere Seite blättern, zuklappen → die Karten-Miniatur zeigt die zuletzt gesehene Seite (nicht mehr stur Seite 1); Reload erhält das.
- [ ] A13.3 Lupe (🔍) über einem aufgeschlagenen Dokument → das Abbild (Kopfzeile + Seite samt Strichen/Stempeln) erscheint vergrößert in der Lupe.

### A14 — Filz-Doppelklick & Karten-Suche (NEU; E2E vorverifiziert)

- [ ] A14.1 Doppelklick (Mac) / Doppeltipp (iPad) auf freie Tischfläche → Notizzettel entsteht genau dort und ist sofort beschreibbar; Doppelklick auf Karten/Zettel/Viewer legt KEINEN neuen an.
- [ ] A14.2 🔎 im Bedienfeld oder ⌘F → Suchfeld oben; tippen → Live-Treffer (Karten, Stapel, Zettel inkl. Badges); Klick/Enter springt hin, Ziel pulst ~2 s; Escape schließt.
- [ ] A14.3 Suche bei niedrigem Zoom (weit rausgezoomt) → Sprung hebt den Zoom auf lesbare Stufe an; im Akten-Modus funktioniert die Suche genauso.

### C′ — MCP auf dem Rework-Strang (ersetzt Block C; 12 Prüfungen, neues Setup)

**Setup:** anymize-Key in `.env.local`; ZDR im anymize-Account AUS — **alles auf `feature/inline-viewer`:**

```bash
npm run server                              # Terminal 1
npm run mcp:token                           # Token erzeugen (Login mit deinem Konto)
npm run mcp                                 # Terminal 2
# Token in Claude Code eintragen: claude mcp add …
```

- [ ] C′.1 Token via `npm run mcp:token` → funktioniert.
- [ ] C′.2 „Welche Schreibtische habe ich?" → anonymisierte Desk-Namen.
- [ ] C′.3 „Lies Dokument X und fasse zusammen" → Platzhalter; `deanonymize` liefert Klartext.
- [ ] C′.4 „Staple die Rechnungen, benenne nach Absender" → Stapel in Klartext, in der UI sichtbar.
- [ ] C′.5 anymize-Key absichtlich falsch → Lese-Tools verweigern, `move_document` geht weiter.
- [ ] C′.6 Reales anymize-Platzhalterformat matcht `PLACEHOLDER_RE` (nie live geprüft).
- [ ] C′.7 **Zettel via KI (NEU):** „Lege einen Notizzettel ‚Frist prüfen' an" → `add_note`-Zettel erscheint in der UI in Klartext; „Welche Zettel liegen auf dem Tisch?" → `get_desk` nennt sie (anonymisiert in der KI-Antwort, `deanonymize` liefert Klartext).
- [ ] C′.8 **Zettel ändern/entfernen (NEU):** Text per KI ändern → UI folgt live; Zettel per KI entfernen → seine Schnüre verschwinden mit.
- [ ] C′.9 **Enthefter & Schnüre via KI (NEU):** „Löse Seite 2 von Dokument X heraus" → `extract_page` legt die Seitenkarte neben das Original (nicht destruktiv); „Verbinde den Zettel mit der Karte" → `link_documents` zieht die Schnur, in der UI sichtbar.
- [ ] C′.10 **Werkzeugkasten lesen (NEU):** „Was liegt auf dem Tisch?" → Antwort nennt Stempel, Fahnen, Konvolute, Klammern und Korb-Inhalt (Freitexte anonymisiert; `deanonymize` liefert Klartext).
- [ ] C′.11 **Werkzeugkasten schreiben (NEU):** „Stemple EINGANG auf Seite 1 von X", „setze eine rote Fahne auf Seite 3", „hefte den Stapel" → alles erscheint live in der UI; Stempel sitzt oben rechts und trägt das Tagesdatum.
- [ ] C′.12 **Reversibel & Grenzen (NEU):** „Lege X in den Papierkorb" + „hole es zurück" funktionieren; „leere den Papierkorb" wird von der KI mangels Tool NICHT ausgeführt.

---

## Block D — j-lawyer-Modus komplett: TP-B + TP-C (braucht deine j-lawyer-Test-Instanz, 14 Punkte)

**Setup** (auf `feature/inline-viewer`). **NEU: bereits gegen einen ECHTEN j-lawyer
(offizielle Docker-Images, admin/a) maschinell verifiziert** — Login, Aktenliste,
Eingangskarten, Base64-PDF, Upload, Abgleich ohne Duplikate. Dabei gefunden und
gefixt: /rest-Pfadpräfix und das [UTC]-Datumsformat. Deine Tests hier sind damit
Bestätigung auf DEINER Instanz/Version statt erster Kontakt.

```bash
# Test-j-lawyer per Docker (falls keine eigene Instanz):
docker compose -f docs/deployment/jlawyer-test-compose.yaml up -d   # Login admin/a, Port 8000
npm run build
JLAWYER_URL=http://localhost:8000/j-lawyer-io DATA_DIR=/tmp/dd-jl npm run server
```

> Docker-Eigenheit: Bei Akten, die NUR per REST erstellt wurden, muss der Ordner
> `archivefiles/<caseId>` im j-lawyer-Datenvolume existieren, sonst schlägt der
> Upload fehl (HTTP 500) — der j-lawyer-Desktop-Client legt ihn normal an.

- [ ] D1 Login-Maske zeigt **keine** Ersteinrichtung; Anmeldung mit j-lawyer-Benutzername/-Passwort klappt.
- [ ] D2 Falsches Passwort → „Benutzername oder Passwort falsch".
- [ ] D3 j-lawyer gestoppt → Login meldet „j-lawyer ist nicht erreichbar" (kein Hänger, ~10 s Timeout).
- [ ] D4 Nach Login öffnet sich die erste Akte; die Kopfzeile links zeigt Aktenzeichen + Rubrum, das Dropdown listet deine Akten **mit Suchfeld** (keine Anlegen/Umbenennen/Löschen-Einträge).
- [ ] D5 Beim Öffnen einer Akte liegen deren j-lawyer-Dokumente als Karten im „Eingang" (links oben gestaffelt).
- [ ] D6 Karte aufschlagen → das echte PDF rendert (Inhalt kommt Base64-dekodiert aus j-lawyer, serverseitig gecacht — zweites Öffnen spürbar schneller).
- [ ] D7 PDF per „＋ PDF" oder Drag-and-drop hochladen → Dokument liegt danach **in j-lawyer in der Akte**; die Karte erscheint erst nach Bestätigung.
- [ ] D8 Dokument in j-lawyer löschen, Akte neu öffnen/neu laden → die Karte verschwindet.
- [ ] D9 Karten/Zettel/Zeichnen/Stapeln funktionieren auf dem Akten-Desk wie gewohnt; zweites Fenster (auch anderer j-lawyer-Nutzer) sieht dieselbe Akte live (kanzlei-weit geteilt).
- [ ] D10 Server neu starten → nächster Aktenzugriff verlangt Neuanmeldung (Credentials leben nur im RAM); Neuanmeldung klappt.
- [ ] D11 `npm run mcp:token` mit j-lawyer-Zugangsdaten → MCP funktioniert im j-lawyer-Modus.
- [ ] D12 **Feldnamen-Gegenprobe an der echten Instanz:** Aktenzeichen/Rubrum/„wegen" erscheinen korrekt (Quellcode-Stand 2026-07-18; ältere j-lawyer-Versionen könnten abweichen).
- [ ] D13 **Datumsformat-Gegenprobe:** Nach zweimaligem Öffnen derselben Akte entstehen keine doppelten Karten (changeDate-Parsing; tolerant für Millis und ISO-Strings gebaut).
- [ ] D14 Große PDFs (> 10 MB) aus der Akte öffnen und hochladen → funktioniert in akzeptabler Zeit (Base64-Overhead).

---

## ~~Block B — Benutzerverwaltung & Teilen, TP3~~ (OBSOLET — durch j-lawyer-Login ersetzt, Branch wird nicht gemergt; nur Referenz)

**Setup** (noch Tauri-Client!):

```bash
git checkout feature/benutzer-teilen
npm run server          # Terminal 1
npm run tauri dev       # Terminal 2
```

Für die Teilen-Tests: zwei Konten und zwei Fenster/Instanzen.

### B1 — Konto-Menü

- [ ] B1.1 Oben rechts erscheint der eigene Benutzername; Menü öffnet/schließt.
- [ ] B1.2 Passwort ändern mit falschem alten Passwort → Toast „Aktuelles Passwort ist falsch"; mit richtigem → „Passwort geändert", erneutes Anmelden mit neuem Passwort klappt.
- [ ] B1.3 Abmelden → Login-Maske; App-Neustart landet ebenfalls auf der Login-Maske (Session gelöscht).

### B2 — Benutzerverwaltung (Admin-Dialog)

- [ ] B2.1 Menüeintrag „Benutzerverwaltung…" nur beim Admin sichtbar.
- [ ] B2.2 Konto anlegen → erscheint in der Liste; damit anmelden klappt (zweites Fenster/zweiter Login).
- [ ] B2.3 Umbenennen und Passwort-Reset wirken (Reset loggt den Betroffenen aus).
- [ ] B2.4 Löschen zeigt die Schreibtische des Benutzers im Bestätigungsdialog und entfernt das Konto.
- [ ] B2.5 Einladung erstellen → Code erscheint und lässt sich kopieren; Widerrufen entfernt ihn.

### B3 — Teilen-Dialog & DeskSwitcher (zwei Konten, zwei Fenster)

- [ ] B3.1 Besitzer: „Teilen…" → Mitglied hinzufügen; beim Mitglied erscheint der Desk mit „von …".
- [ ] B3.2 Mitglied bearbeitet Karten live; „Umbenennen/Löschen/Teilen" fehlen dort, stattdessen „Verlassen…".
- [ ] B3.3 Besitzer entfernt das Mitglied, während es den Desk offen hat → Toast „Zugriff wurde entzogen", Wechsel zum eigenen Schreibtisch.
- [ ] B3.4 Besitzer löscht den geteilten Desk, während das Mitglied ihn offen hat → Toast „Schreibtisch wurde gelöscht", Ausweichen.
- [ ] B3.5 Desk-Einladung erstellen → Code kopierbar; Widerruf entfernt ihn.

### B4 — Login-Maske: Einladung einlösen

- [ ] B4.1 „Ich habe einen Einladungscode" → Code einfügen (aus B2/B3) → Hinweis erscheint (mit Desk-Name bei Desk-Einladung).
- [ ] B4.2 Benutzername + Passwort → direkt eingeloggt; bei Desk-Einladung ist der geteilte Schreibtisch in der Liste.
- [ ] B4.3 Denselben Code erneut einlösen → „Einladung ist ungültig oder abgelaufen".
- [ ] B4.4 Ungültiger Code → Fehlermeldung, kein Konto entstanden.

---

## ~~Block C — MCP-Server mit anymize, TP4~~ (OBSOLET — portiert; stattdessen Block C′ oben testen)

**Setup:** anymize-API-Key in `.env.local` ablegen; **ZDR im anymize-Account AUS**.

```bash
git checkout feature/mcp-server
npm run server                              # Terminal 1
npm run mcp:token                           # Token erzeugen
# Token in Claude Code eintragen: claude mcp add …
```

- [ ] C1 Server + MCP mit echtem anymize-Key starten; Token via `npm run mcp:token` → Token funktioniert.
- [ ] C2 Prompt „Welche Schreibtische habe ich?" → anonymisierte Desk-Namen erscheinen.
- [ ] C3 „Lies das Dokument X und fasse es zusammen" → Zusammenfassung mit Platzhaltern; `deanonymize`-Tool liefert Klartext.
- [ ] C4 „Staple die Rechnungen zusammen und nenne den Stapel nach dem Absender" → Stapel entsteht in Klartext, in der UI sichtbar.
- [ ] C5 anymize-Key absichtlich falsch setzen → Lese-Tools verweigern; `move_document` geht weiter (keine Anonymisierung nötig).
- [ ] C6 Reales anymize-Platzhalterformat stichprobenartig prüfen (matcht `PLACEHOLDER_RE`) — konnte ohne Key nie live verifiziert werden.

---

## Nach dem Testen

- Befunde je Punkt kurz notieren (Nummer + was passiert ist) — Fixes laufen dann als einzelne `fix:`-Commits.
- Merge-Reihenfolge, falls B/C bestehen: `feature/benutzer-teilen` → `feature/mcp-server`; Block A merged unabhängig davon (`feature/browser-jlawyer-rework` → `feature/inline-viewer`).
