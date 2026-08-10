<img src="docs/bilder/j-desk-logo.png" width="72" alt="J-DESK">

# J-DESK

[![CI](https://github.com/PBaumfalk/j-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/PBaumfalk/j-desk/actions/workflows/ci.yml)
[![Lizenz: AGPL v3](https://img.shields.io/badge/Lizenz-AGPL_v3-blue.svg)](LICENSE)
[![Docker-Image](https://img.shields.io/badge/ghcr.io-pbaumfalk%2Fj--desk-blue?logo=docker)](https://ghcr.io/pbaumfalk/j-desk)
[![Tests](https://img.shields.io/badge/Tests-2652-brightgreen.svg)](#für-entwickler)

**Die Dokumente einer Akte ausbreiten, Behauptungen mit den Fundstellen verknüpfen,
die sie belegen, und Streitiges von Unstreitigem trennen — im Browser.** J-DESK ist
der digitale Schreibtisch für juristische Arbeit: ein unbegrenzt großer Tisch, auf dem
Sie Schriftsätze, Verträge und Anlagen nebeneinanderlegen, Linien zwischen Behauptung
und Beleg ziehen und jederzeit sehen, was trägt, was bestritten ist und was noch offen ist.

Ihre Akten bleiben dabei **in j-lawyer** — J-DESK verweist auf die Dokumente, es legt
keine zweite Ablage an. Und was Sie intern notieren, bleibt intern: nichts wandert
ungefragt in einen Export.

> **English abstract** — Visual case-work surface for German legal practice: spread out
> the documents of a case file on an unbounded canvas, link assertions to the exact
> evidence supporting them (eleven typed relations: *proves*, *contradicts*, *refutes*,
> *disputed* …), and keep internal annotations provably out of exports. Integrates with
> [j-lawyer](https://www.j-lawyer.org/) as the system of record. Self-hosted
> (Node + SQLite), Docker image provided. UI and documentation are in German.

![Schreibtisch mit Behauptung, Beleg und Gegenposition](docs/bilder/schreibtisch-gross.png)

*Grün belegt, rot widerspricht, gestrichelt ist offen — und an der Linie steht, wo genau
die Fundstelle sitzt.*

## 📖 Handbuch

Die vollständige Dokumentation — getrennt für die beiden Zielgruppen, für Nicht-Techniker
verständlich — steht im **[Handbuch](docs/handbuch/README.md)**:

| Für Anwältinnen und Anwälte | Für die Technikbetreuung |
|---|---|
| [Was ist J-DESK?](docs/handbuch/anwender/was-ist-j-desk.md) | [Installation](docs/handbuch/technik/installation.md) |
| [Der erste Schreibtisch](docs/handbuch/anwender/erster-schreibtisch.md) | [Betrieb, Sicherung, Update](docs/handbuch/technik/betrieb.md) |
| [Vertraulichkeit](docs/handbuch/anwender/vertraulichkeit.md) | [Störungssuche](docs/handbuch/technik/stoerungssuche.md) |

## Installation

<details>
<summary><strong>🖥️ Auf einem Server mit Docker</strong> (empfohlen — eine Adresse für die ganze Kanzlei)</summary>

```bash
sudo mkdir -p /opt/j-desk && cd /opt/j-desk
curl -fsSLO https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/compose.yaml
curl -fsSL https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/.env.beispiel -o .env
nano .env          # JLAWYER_URL eintragen
sudo docker compose up -d
```

Danach `http://<server>:4810` im Browser. Es wird ein fertiges Abbild geladen — Sie
brauchen weder Node noch eine Entwicklungsumgebung auf dem Server.

Die drei häufigsten Stolpersteine beim Eintragen von `JLAWYER_URL`: Das `/j-lawyer-io`
am Ende gehört dazu; `localhost` funktioniert im Container nicht (dort heißt es
`host.docker.internal`); und die Portnummer ist die von j-lawyer, nicht die von J-DESK.

Ausführlich: [Handbuch, Installation](docs/handbuch/technik/installation.md).
</details>

<details>
<summary><strong>🐧 Auf einem Linux-Server ohne Docker</strong> (systemd-Dienst)</summary>

```bash
curl -fsSLO https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/j-desk-installieren.sh
sudo bash j-desk-installieren.sh
```

Richtet Node 22, einen eigenen Dienstbenutzer ohne Anmelderecht, das Datenverzeichnis
unter `/var/lib/j-desk` und einen systemd-Dienst ein. Das Skript fragt vor jedem
verändernden Schritt nach.

Einstellungen danach in `/etc/j-desk.env`, dann `sudo systemctl restart j-desk`.
</details>

<details>
<summary><strong>🧪 Nur ausprobieren</strong> (mit einem Test-j-lawyer, ohne Ihre echten Daten anzufassen)</summary>

```bash
git clone https://github.com/PBaumfalk/j-desk.git && cd j-desk
docker compose -p jl-docker -f docs/deployment/jlawyer-test-compose.yaml up -d
npm install && npm run build
JLAWYER_URL=http://localhost:8000/j-lawyer-io npm run server
```

Der Test-j-lawyer läuft auf Port 8000 (Anmeldung `admin` / `a`), J-DESK auf 4810.
Nur zum Ausprobieren — die Zugangsdaten sind allgemein bekannt.
</details>

## Was J-DESK kann

| Ordnen und verknüpfen | Vertraulichkeit steuern |
| --- | --- |
| ![Kontextmenü eines Dokuments](docs/bilder/kontextmenue.jpg) | ![Ebenen mit Sichtbarkeiten](docs/bilder/ebenen.png) |

- **Ausbreiten statt blättern** — beliebig viele Dokumente nebeneinander auf einer
  unbegrenzten Fläche, stapeln, aufschlagen, Ausschnitte herauslösen —
  [Der erste Schreibtisch](docs/handbuch/anwender/erster-schreibtisch.md)
- **Elf juristische Beziehungsarten** — *belegt*, *bestätigt*, *widerspricht*,
  *widerlegt*, *entkräftet*, *streitig*, *offene Frage* und weitere, nach Familien
  eingefärbt: grün trägt, rot bestreitet, gestrichelt ist offen
- **Behauptungen als eigene Objekte** — eigene Behauptung, Behauptung der Gegenseite,
  Tatsache, Beweismittel und neun weitere Typen, jeweils sichtbar unterschieden
- **Echte Schwärzung** — der Text wird beim Export aus der PDF-Datei **entfernt**, nicht
  übermalt, mit anschließender Nachprüfung; bei ungewöhnlich aufgebauten Dateien bricht
  der Export lieber ab, als heimlich falsch zu schwärzen —
  [Vertraulichkeit](docs/handbuch/anwender/vertraulichkeit.md)
- **Drei Freigabestufen** — *intern*, *mandant*, *export*, mit fail-closed-Voreinstellung:
  Was nicht ausdrücklich freigegeben ist, gilt als vertraulich. Vertraulichkeit schlägt
  Vollständigkeit
- **j-lawyer als führendes System** — Anmeldung mit den j-lawyer-Zugangsdaten, Akten und
  Dokumente von dort, mit Versionsverträglichkeitsprüfung. Kein Schatten-Dokumentenmanagement
- **Zusammenarbeit in Echtzeit** — mehrere Personen am selben Schreibtisch; bei
  gleichzeitiger Änderung derselben Sache fragt J-DESK nach, statt still zu überschreiben
- **KI auf Veranlassung** — Vorschläge zur Prüfung statt automatischer Übernahme, über MCP
  angebunden, protokolliert, mit eigener Ebene „nur via Übernahme"
- **Betriebsreif** — automatische Sicherungen, geprüfte Wiederherstellung, Systemdiagnose,
  Aktivitätsprotokoll — [Betrieb](docs/handbuch/technik/betrieb.md)

## Für Entwickler

Ein TypeScript-Monorepo ohne exotische Abhängigkeiten:

- **`packages/core`** — reine Zustandslogik, **ohne jede Fremdabhängigkeit**. Jede Änderung
  ist ein Kommando, das unveränderlich angewandt wird; von Server, Client und MCP gemeinsam genutzt
- **`packages/server`** — Fastify, SQLite (WAL), Dateiablage, WebSocket, j-lawyer-Anbindung
- **`packages/mcp`** — Anbindung für KI-Werkzeuge
- **Wurzel** — Web-Client mit Svelte 5 und SvelteKit, statisch gebaut

```bash
npm install
npm run server     # Server auf http://localhost:4810
npm run dev        # Client mit Weiterleitung (zweites Fenster)
npm test           # 2652 Tests
npm run check      # Typprüfung
```

Node 22 ist verbindlich und an vier Stellen festgeschrieben; ein Wächtertest schlägt fehl,
sobald eine davon ausschert. Der Quelltext ist deutschsprachig — das ist Absicht, die
Fachsprache dieses Programms ist die juristische. Details: [CONTRIBUTING.md](CONTRIBUTING.md),
[Schnittstellen](docs/api/README.md).

Eine Besonderheit: Die Betriebsdokumente zu
[Sicherung](docs/deployment/backup-strategy.md) und [Update](docs/deployment/update-runbook.md)
werden bei jedem Testlauf gegen das tatsächliche Programmverhalten geprüft. Weicht die
Beschreibung ab, schlägt ein Test fehl.

## Mitmachen

Fehler und Wünsche gern über die [Issues](https://github.com/PBaumfalk/j-desk/issues).
Sicherheitslücken bitte **nicht** öffentlich, sondern vertraulich gemäß
[SECURITY.md](SECURITY.md) — J-DESK verarbeitet Mandatsdaten.

## Lizenz

[AGPL-3.0](LICENSE) — © 2026 Patrick Baumfalk.

Sie dürfen J-DESK einsetzen, verändern und weitergeben. Wer es verändert und als Dienst
anbietet, muss seine Änderungen unter derselben Lizenz offenlegen. Für Kanzleien, die
J-DESK schlicht betreiben, entstehen daraus keine Pflichten.

## Haftungsausschluss

J-DESK dient der technischen Unterstützung bei der Aufbereitung von Akten und ersetzt
keine Rechtsberatung. Die fachliche Bewertung, welche Fundstelle welche Behauptung trägt,
trifft ausschließlich die Anwältin oder der Anwalt — J-DESK hält fest, was Sie feststellen.
Für die Vollständigkeit von Exporten und Schwärzungen bleibt die abschließende Prüfung
vor der Weitergabe unverzichtbar.
