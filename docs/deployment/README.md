# Betriebsdokumentation: Einstieg

> Stand: Phase 14 (Betriebsreife & Produktisierung), Plan 14-08. Dieses Dokument führt die
> Betriebsdokumente dieses Verzeichnisses zusammen und benennt für jede Betriebsfrage das
> zuständige Dokument.

| Frage | Dokument | Wofür gedacht |
|---|---|---|
| Wie und wann sichert J-DESK meine Daten, und wie stelle ich einen Datenbestand nach einem Ausfall wieder her? | [`backup-strategy.md`](./backup-strategy.md) | Sicherung und Wiederherstellung: was gesichert wird, wann, wie, und der ausführbare Runbook-Ablauf für den Ernstfall. |
| Wie aktualisiere ich J-DESK auf einen neuen Stand, und was ist vor/nach dem Update zu prüfen? | [`update-runbook.md`](./update-runbook.md) | Update und Migration: Vorprüfung, Ablauf, Node-Zielversion, Bestätigung nach dem Update. |
| Ist J-DESK auch mit einer realistisch großen Akte (hunderte Dokumente/Objekte) noch schnell genug? | [`lasttest-befunde.md`](./lasttest-befunde.md) | Lasttest-Befunde: gemessene Werte, Schwellen und wie mit ihnen umzugehen ist. |
| Welche Daten verlassen J-DESK über externe Anbindungen (j-lawyer, Euro-Office, Anymize, Cloud-Spracherkennung), und welche § 43e-BRAO-Prüfpunkte hat die Kanzlei selbst zu klären? | [`betriebssicherheit-brao.md`](./betriebssicherheit-brao.md) | Sicherheitskonzept: technische Zusicherungen je Anbindung, getrennt von den vertraglichen Prüfpunkten — mit ausdrücklichem rechtlichem Hinweis, dass die BRAO-Einordnung juristisch zu bestätigen ist. |

Weitere Dokumente in diesem Verzeichnis (`eurooffice-compose.yaml`, `jlawyer-test-compose.yaml`,
`jlawyer-aufgabenuebergabe.md`) sind Beispiel-/Betriebshilfsmittel für einzelne Anbindungen, keine
eigenständigen Betriebsdokumente im obigen Sinn.
