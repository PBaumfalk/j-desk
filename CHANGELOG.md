# Änderungsverlauf

Alle nennenswerten Änderungen an J-DESK. Das Format folgt lose
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung
[Semantic Versioning](https://semver.org/lang/de/).

## [Unveröffentlicht]

### Hinzugefügt

- **Installationswege für Kanzleien** — `install/compose.yaml` mit kommentierter
  `.env.beispiel` für den Docker-Weg, `install/j-desk-installieren.sh` für Linux-Server ohne
  Docker (Node 22, eigener Dienstbenutzer, systemd-Einheit).
- **Handbuch** (`docs/handbuch/`) in zwei Teilen: einer für Anwältinnen und Anwälte ohne
  Technikbezug, einer für die Technikbetreuung.
- **CI mit GitHub Actions** — Tests, Typprüfung, Bauvorgang und ein Probelauf des Docker-Abbilds
  bei jedem Pull Request.
- **Release-Workflow** — veröffentlicht bei Versions-Tags ein Docker-Abbild nach ghcr.io, gebaut
  für amd64 **und** arm64.
- **AGPL-3.0** als Lizenz, dazu `SECURITY.md`, `CONTRIBUTING.md` sowie Vorlagen für Issues und
  Pull Requests.

### Behoben

- **Das Docker-Abbild startete überhaupt nicht.** `pdfjs-dist` war nur in der obersten
  `package.json` deklariert, wird aber von `packages/server/src/export/raster.ts` benötigt. Da das
  Dockerfile ohne die Abhängigkeiten des Wurzelpakets installiert, fehlte es im Abbild —
  Modulfehler, dann Neustartschleife. Lokal fiel das nie auf, weil npm-Workspaces alle Pakete
  gemeinsam auflösen, und Tests decken es nicht ab, weil sie nicht im Container laufen.
- **Verknüpfungs- und Zeitleisten-Fenster** waren undurchsichtig weiß statt im Glass-Stil der
  übrigen Oberfläche; die Bedienelemente darin fielen auf die Standarddarstellung des Browsers
  zurück.
- **Kontextmenüs** trugen bei 2 von 93 Einträgen ein Symbol und wirkten dadurch unaufgeräumt —
  jetzt durchgehend textbasiert.

## [1.0] — 2026-08-10

Erster vollständiger Meilenstein: 14 Phasen, 116 Pläne, 71 Anforderungen.

### Enthalten

- **Schreibtisch** — unbegrenzte Fläche, Karten frei anordnen, stapeln, aufschlagen
- **Verknüpfungen** mit elf juristischen Beziehungsarten, nach Familien eingefärbt, dazu
  Versionsketten zwischen Dokumentfassungen
- **Annotationen** — Notizen, Markierungen, Stempel, Ausschnitte, Zeitleisten, Tabellen
- **Ebenen und Freigabestufen** — dreistufig (*intern*, *mandant*, *export*) mit
  fail-closed-Voreinstellung
- **Export** — Anlagenpakete und Übergaben; Schwärzungen entfernen Text wirklich aus der
  PDF-Datei statt ihn zu übermalen, mit anschließender Nachprüfung
- **j-lawyer-Anbindung** — Anmeldung, Akten und Dokumente aus dem führenden System, mit
  Versionsverträglichkeitsprüfung
- **Zusammenarbeit** — Live-Abgleich über WebSocket, Konflikterkennung statt stillem
  Überschreiben
- **KI-Anbindung** über MCP, mit Freigaben und Protokollierung
- **Betrieb** — automatische Sicherungen, geprüfte Wiederherstellung, Systemdiagnose

[Unveröffentlicht]: https://github.com/PBaumfalk/j-desk/compare/v1.0...HEAD
[1.0]: https://github.com/PBaumfalk/j-desk/releases/tag/v1.0
