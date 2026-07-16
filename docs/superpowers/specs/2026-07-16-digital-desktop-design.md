# Digital Desktop — Design

**Datum:** 2026-07-16
**Status:** Vom Nutzer freigegeben

## Ziel

Eine Mac-Desktop-App, die einen grafischen Schreibtisch für PDF-Dateien bereitstellt: PDFs per Drag & Drop ablegen, frei verschieben, per Doppelklick in Vorschau öffnen und untereinander verknüpfen — wie beim Arbeiten an einem echten Schreibtisch.

## Anforderungen (geklärt)

- **Plattform:** macOS-Desktop-App
- **Öffnen:** Doppelklick öffnet das PDF in der macOS-Standard-App (Vorschau); kein integrierter Viewer
- **Verknüpfungen:** sichtbare Verbindungslinien mit optionaler Notiz, Gruppen/Stapel, „Mit allen Verknüpften öffnen"
- **Dateiablage:** PDFs werden nur referenziert (Pfad), nie kopiert
- **Arbeitsfläche:** große Fläche mit Zoom & Pan (wie Miro/Freeform)
- **Darstellung:** Miniatur der ersten PDF-Seite plus Dateiname
- **Umfang:** persönliches Werkzeug, typischerweise bis ~50 Dokumente gleichzeitig

## Architektur

**Stack:** Tauri 2 (Rust-Shell, nur Standard-Plugins, kein eigener Rust-Code) + Svelte-Frontend + pdf.js für Miniaturen + Vitest für Tests.

Aufgabenteilung:

- **Frontend (Svelte):** gesamte Schreibtisch-Oberfläche — Zoom/Pan-Fläche, Dokumentkarten, Verbindungslinien, Stapel. Rendert PDF-Miniaturen mit pdf.js.
- **Tauri (Standard-Plugins):** Dateizugriff (PDF-Bytes lesen), Drag & Drop aus dem Finder (liefert echte Dateipfade), Öffnen in Vorschau (`opener`-Plugin), Dateiauswahl-Dialog (`dialog`-Plugin), Speichern/Laden des Zustands (`fs`-Plugin).

Begründung der Stack-Wahl: Das Herzstück ist die grafische Canvas-Oberfläche, die in Web-Technologie am schnellsten und flexibelsten entsteht; Tauri liefert dazu eine schlanke native Mac-App (~10 MB) mit echtem Dateisystem-Zugriff. Alternativen (Electron: deutlich schwerer; natives SwiftUI: Canvas-Interaktionen erheblich aufwendiger) wurden verworfen.

## Datenmodell & Persistenz

Der komplette Zustand liegt in einer JSON-Datei: `~/Library/Application Support/digital-desktop/desktop.json`.

```
Dokument:     id, dateipfad, position {x, y}, rotation (leichte feste
              Zufallsdrehung für Schreibtisch-Optik), zIndex
Verknüpfung:  id, vonId, zuId, notiz (optional)
Stapel:       id, name (optional), dokumentIds (geordnet), position {x, y}
```

Regeln:

- Ein Dokument liegt entweder frei auf der Fläche **oder** in genau einem Stapel.
- Verknüpfungen können zwischen Dokumenten sowie zu/von Stapeln bestehen (Endpunkt ist Dokument- oder Stapel-id).
- Wandert ein verknüpftes Dokument in einen Stapel, bleibt die Verknüpfung am Dokument bestehen; die Linie endet visuell am Stapel, solange das Dokument darin liegt. Beim Herausziehen endet sie wieder am Dokument.
- Beim Entfernen eines Dokuments/Stapels werden alle daran hängenden Verknüpfungen mit entfernt.
- Miniaturen werden beim ersten Laden erzeugt und als PNG im App-Datenordner gecacht (Schlüssel: Dokument-id).

**Speichern:** automatisch bei jeder Änderung (debounced), kein Speichern-Knopf. Vor jedem Schreiben wird die vorherige Version als `desktop.json.bak` behalten; ist `desktop.json` beim Start beschädigt, wird das Backup geladen.

## Oberfläche & Interaktionen

**Fläche:** ca. 10.000 × 10.000 px, dezente Schreibtisch-Textur. Zoom per Trackpad-Pinch oder Cmd+Scrollen; Pan per Zwei-Finger-Scrollen oder Leertaste+Ziehen. „Übersicht"-Taste zoomt auf alle Dokumente.

**Dokumentkarten:** Miniatur der ersten Seite, leichter Schatten, minimale Drehung, Dateiname darunter. Ziehen verschiebt; zuletzt angefasste Karte liegt oben (zIndex).

**Ablegen:** Drag & Drop aus dem Finder an die Wurfstelle; zusätzlich „+"-Knopf mit Dateiauswahl-Dialog. Nur PDF-Dateien werden akzeptiert.

**Verknüpfen:** Rechtsklick → „Verknüpfen…", dann Klick auf das Ziel. Geschwungene Linie zwischen beiden. Klick auf die Linie öffnet ein Popover: Notiz eingeben/lesen, Verknüpfung lösen. Vorhandene Notizen erscheinen als kleines Etikett an der Linienmitte.

**Stapel:** Dokument auf ein anderes ziehen und loslassen → Stapel entsteht (leicht versetzte Karten, Anzahl-Badge). Klick fächert den Stapel auf; einzelne Dokumente lassen sich herausziehen oder anklicken. Stapel sind als Ganzes verschiebbar und optional benennbar. Wird das vorletzte Dokument entnommen, löst sich der Stapel auf.

**Öffnen:** Doppelklick → PDF in Vorschau (macOS-Standard-App).

**Kontextmenü (Dokument):** Öffnen · Mit allen Verknüpften öffnen · Verknüpfen… · Im Finder zeigen · Vom Schreibtisch entfernen (löscht nie die Datei, nur die Karte).

**Kontextmenü (Stapel):** Auffächern · Benennen… · Verknüpfen… · Stapel auflösen (Dokumente liegen danach einzeln daneben) · Vom Schreibtisch entfernen (entfernt alle enthaltenen Karten, löscht nie Dateien).

## Fehlerbehandlung

- **Fehlende Datei:** Karte bleibt liegen, ausgegraut mit Warnsymbol. Kontextmenü: „Datei neu verknüpfen…" (Dateiauswahl; Verknüpfungen und Stapelzugehörigkeit bleiben erhalten) oder „Vom Schreibtisch entfernen".
- **Defektes/passwortgeschütztes PDF:** generisches PDF-Symbol statt Miniatur; alle übrigen Funktionen normal.
- **Beschädigte Zustandsdatei:** Backup (`desktop.json.bak`) wird geladen statt leer zu starten.

## Testen

- **Vitest (automatisiert):** die gesamte Zustandslogik als reine TypeScript-Funktionen ohne UI-Abhängigkeit — Dokumente hinzufügen/entfernen, Verknüpfungen anlegen/lösen, Stapel bilden/auffächern/auflösen, Aufräumen hängender Verknüpfungen, Laden/Migration der Zustandsdatei inkl. Backup-Fallback.
- **Manuell:** Canvas-Interaktionen (Ziehen, Zoomen, Pan, Drag & Drop aus dem Finder) in der laufenden App.

## Bekannte Einschränkungen (v1)

- Beenden über das Dock-Menü, Abmelden oder Herunterfahren läuft auf macOS über `terminate:` direkt am System vorbei am App-Menü — dabei kann das letzte Autosave-Fenster (≤400 ms bzw. eine ununterbrochene Tipp-Serie) verloren gehen. Alle normalen Wege (Cmd+Q, Cmd+W, roter Schließen-Knopf) speichern vorher zuverlässig. Ohne eigenen Rust-Code (bewusst ausgeschlossen) ist dieser Pfad nicht abfangbar.

## Nicht im Umfang (v1)

- Integrierter PDF-Viewer
- Andere Dateitypen als PDF
- Mehrere Schreibtische / Boards
- Volltextsuche in PDFs
- Synchronisation / Multi-Device
