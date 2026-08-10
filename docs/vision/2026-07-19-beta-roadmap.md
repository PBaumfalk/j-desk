# Beta-Roadmap J-Desk

> Stand 2026-07-19. Konsolidiert die Nordstern-Dokumente gegen den Ist-Stand des Codes:
> - `2026-07-18-digitaldesk-vision.md` (Produktvision, .jdesk, Bridge, agentische KI)
> - `2026-07-18-spike-dom-vs-canvas.md` + `docs/architecture/canvas-decision.md` (entschieden: Evolution auf Svelte)
> - `2026-07-19-juristische-arbeitsebene.md` (30 Handlungsfelder + Beta-Priorisierung — **maßgeblich für den Beta-Schnitt**)

**Beta-Definition:** Eine externe Kanzlei arbeitet mit echtem j-lawyer und mehreren Nutzern
produktiv an echten Mandaten — ohne dass Daten verloren gehen, Herkunft unklar wird oder
interne Notizen versehentlich nach außen gelangen.

## Ist-Stand in einer Zeile

Ausbreiten, Bearbeiten, Werkzeuge, Live-Sync, j-lawyer-Anbindung, MCP (lesend/kuratiert),
Glass-UI, Setup-Dialog, API-Doku: **fertig.** Was fehlt, ist die Belastbarkeits-Schicht.

## Beta-Wellen

### Welle 1 — Provenienz-Fundament *(zeitkritisch: jedes neue Objekt ohne Metadaten vergrößert das Altdaten-Problem)*

Deckt Punkte 1, 10, Kern von 12 der Beta-Liste.

| Baustein | Ist | Aufwand |
|---|---|---|
| `createdBy`/`createdAt` auf allen Objekten (Commands tragen Autor; Server kennt ihn aus der Session) | fehlt komplett | 1 Runde |
| Command-Journal (append-only, Server): Wer hat wann was getan; Basis für Historie-UI und Stand-Wiederherstellung | fehlt | in derselben Runde |
| „Zur Originalstelle springen": Klick auf Ausschnitt/Markierung/Fundstelle → Viewer öffnet Dokument an exakt der Stelle, hervorgehoben | Struktur (fileId/Seite/Rect) ✓, Sprung fehlt | 1 Runde |
| Text-Snapshot beim Ausschneiden/Markieren (ursprünglicher Text als Metadatum) + optional Datei-Hash | fehlt (Textextraktion existiert serverseitig) | in derselben Runde |

### Welle 2 — Verlässlichkeit (Punkte 2, 4, 6-Grundlagen, 8)

| Baustein | Ist | Aufwand |
|---|---|---|
| j-lawyer-Referenzstatus: Zustandsmodell (verfügbar/ersetzt/umbenannt/nicht erreichbar/gelöscht/Recht entzogen/archiviert) + verständliche Karten-Zustände statt Leere; jl-Versionskompatibilitäts-Check | Abgleich + Platten-Cache ✓, Status-UI fehlt | 1–2 Runden |
| Desk-Export/-Import als portables Paket (= .jdesk-Kern aus der Produktvision: Struktur, Annotationen, Verknüpfungen, Verweise — ohne Originale) **inkl. automatischer Sicherung des Pakets IN die j-lawyer-Akte** (via `document/create`; Server-DB bleibt Live-Wahrheit, aber der Arbeitsstand reist mit der Akte — „kein Schatten-DMS"-Prinzip der Produktvision) | fehlt | 2 Runden |
| Backup-Restore-Test + dokumentierte Backup-Strategie; Update-/Rollback-Prozess (Migrationen v1/v2 existieren als Muster) | Rotation ✓, Rest fehlt | 1 Runde |
| Konflikt-Grundlagen: sichtbare Bearbeitungspräsenz, Offline-Warteschlange mit Wiederanlauf, Konflikthinweis statt stillem Last-Write-Wins | Runde 1/2 ✓: Objektversionen, `erwartet`-Vorbedingung, 409-Konflikthinweis statt stillem LWW, Client-Reaktion (Wiederholen bei ortsgebundenen Commands, sonst Rückfrage) — Bearbeitungspräsenz und Offline-Warteschlange (Runde 2) fehlen noch | 1 Runde (Rest) |
| Historie-Stand-Wiederherstellung (aus dem Journal von Welle 1) + Aktivitätsansicht | Journal aus W1 | 1 Runde |

### Welle 3 — Arbeitsergebnis (Punkte 5, 7)

| Baustein | Ist | Aufwand |
|---|---|---|
| Export-Grundschicht: annotierte PDF-Kopie + Fundstellen-PDF; von Anfang an mit Intern/Extern-Kennzeichnung pro Annotation (Vorgriff auf Ebenen) | fehlt | 2 Runden |
| Volltextsuche über Dokumente + Annotationen + Zettel + Stempel (SQLite FTS5; Textextraktion existiert), Treffer heben Karten auf dem Tisch hervor | Kartensuche ✓ | 1–2 Runden |
| OCR für Scans (Stufe 2, ggf. nach Beta-Start nachlieferbar) | fehlt | 1–2 Runden |

### Welle 4 — Team (Punkt 3, Rest von 6)

| Baustein | Ist | Aufwand |
|---|---|---|
| Ebenen-Modell (privat/Kanzlei/KI/Export) mit Sichtbarkeit + Exportfreigabe | fehlt | 2 Runden |
| Rollen: Eigentümer/Bearbeiter/Kommentator/Lesend (im jl-Modus mit j-lawyer-Rollen verzahnt); gefährliche Aktionen (Schreddern, Export, KI) rollengebunden | Desk-Teilung grob ✓ (TP3-Vorarbeit archiviert) | 2–3 Runden |
| Papierkorb-Kommunikation schärfen (drei Vorgänge sauber benannt, Punkt 20) | Logik ✓, UI-Kommunikation teilweise | in Rollen-Runde |

### Welle 5 — Betrieb & Härtetest (Punkte 9, 30-Minimum)

| Baustein | Ist | Aufwand |
|---|---|---|
| Lasttest mit realistisch großer Akte (hunderte Dokumente/Objekte), Befunde fixen (LOD/Culling-Backlog) | Culling ✓ | 1–2 Runden |
| Betriebs-Minimum: Diagnose-Seite (Verbindungen, Speicher, Backupstatus), verständliche Fehlerberichte, Admin-Antwort auf „Warum sieht X Dokument Y nicht?", Installations-/Update-Doku | Setup-Dialog ✓, Rest fehlt | 2 Runden |
| Beta-Begleitmaterial: Kurzanleitung, bekannte Grenzen, Feedback-Kanal | API-Doku ✓ | 1 Runde |

**Summe grob: 18–22 Runden** im bewährten Format (Spec → Plan → SDD → E2E → Merge).

## Bewusst NICHT in der Beta (Differenzierungs-Schiene danach)

Chronologie, Versionsvergleich/Synchronsicht, Sitzungsmodus, Anlagen-/Konvolutbau,
Mandats-Vorlagen, Tabellenobjekte, Spracheingabe, externe Inhalte, Benachrichtigungen,
Command Palette, Mobile-Differenzierung, Bridge-App (.jdesk-Dateityp/digitaldesk://-Protokoll — die Akten-Ablage des Pakets ist dagegen in Welle 2 enthalten), Aufräumfunktion, Minimap/Zonen —
sowie **schreibende KI mit Approval-Gates** (der MCP bleibt in der Beta lesend/kuratiert
wie heute; die Gates kommen mit der Differenzierungs-Schiene, wie in der Priorisierung
vom 2026-07-19 festgelegt — das ersetzt die frühere Phasenreihenfolge der Produktvision).

**Günstige Vorzieher, wenn Kapazität da ist:** typisierte Verknüpfungen und juristische
Objekttypen sind kleine Modellerweiterungen (Links haben ein Notiz-Feld, Zetteltypen sind
erweiterbar) — sie können als schnelle Runden zwischengeschoben werden, sobald das
Provenienz-Fundament steht, damit Beta-Nutzer früh mit auswertbaren Strukturen arbeiten.

## Offene Punkte außerhalb der Wellen

Lokale Ordner-Umbenennung (Nutzer), packages/mcp/README-Tooltabelle veraltet.

Erledigt am 20.07.2026: Konvolut-pagePoint-Fix (Zeigerumrechnung nun als gemeinsames
`pagePointIn` in `src/lib/inkMath.ts` — die Duplikation war die Ursache, dass der Zoom-Fix
aus 3eb4707 den Konvolut nie erreichte) und Setup-TOCTOU (Betriebsmodus und Erst-Konto
werden jetzt atomar beansprucht, statt nach dem Await blind zu schreiben; beide Fenster
sind durch parallele Doppel-POST-Tests abgedeckt).
