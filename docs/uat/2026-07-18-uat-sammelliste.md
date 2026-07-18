# UAT-Sammelliste — alle offenen manuellen Tests (Stand 2026-07-18)

Konsolidiert alle „pending user verification"-Punkte aus TP-A (Browser-Port), Inline-Viewer,
Schreibtisch-Navigation/Touch (inkl. der drei Nachzügler-Fixes), TP3 (Benutzerverwaltung & Teilen)
und TP4 (MCP-Server mit anymize). **57 Punkte in drei Blöcken** — jeder Block hat ein eigenes
Setup, innerhalb eines Blocks kann in einer Sitzung durchgetestet werden.

**Empfohlene Reihenfolge:** Block A (aktueller Branch) → Block B → Block C (Branch von B enthält TP3).

> **Strategischer Hinweis zu B und C:** Der j-lawyer-Rework ersetzt die eigene Kontenverwaltung
> perspektivisch. Ob TP3/TP4 noch gemergt werden, ist offen — deren UAT lohnt nur, wenn der
> Merge weiterhin geplant ist. Block A ist davon unberührt.

---

## Block A — Browser-App (Branch `feature/inline-viewer`, 34 Punkte)

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
- [ ] A1.10 Docker: `docker build -f packages/server/Dockerfile -t dd-test . && docker run --rm -p 4811:4810 dd-test` → `http://localhost:4811` zeigt die App. *(bisher nie lokal getestet)*

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

---

## Block B — Benutzerverwaltung & Teilen, TP3 (Branch `feature/benutzer-teilen`, 17 Punkte)

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

## Block C — MCP-Server mit anymize, TP4 (Branch `feature/mcp-server`, 6 Punkte)

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
