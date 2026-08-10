<div align="center">

# J-DESK

**Der digitale Schreibtisch für juristische Arbeit**

Dokumente einer Akte ausbreiten, Behauptungen mit Fundstellen verknüpfen,
Streitiges von Unstreitigem trennen — und daraus ein belastbares Arbeitsergebnis machen.

[![CI](https://github.com/PBaumfalk/j-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/PBaumfalk/j-desk/actions/workflows/ci.yml)
[![Lizenz: AGPL v3](https://img.shields.io/badge/Lizenz-AGPL_v3-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-2652-brightgreen.svg)](#qualität)

[Handbuch](docs/handbuch/README.md) ·
[Installation](docs/handbuch/technik/installation.md) ·
[Für Anwälte](docs/handbuch/anwender/was-ist-j-desk.md) ·
[Schnittstellen](docs/api/README.md)

</div>

---

## Das Problem

Eine Akte hat 400 Seiten. Der Schriftsatz der Gegenseite behauptet auf Seite 12 etwas, das dem
Vertrag auf Seite 213 widerspricht. Das E-Mail-Protokoll auf Seite 88 stützt Ihre Version — aber
nur zusammen mit der Rechnung auf Seite 301.

Am Bildschirm sehen Sie immer nur ein Dokument. Also drucken Sie aus und legen Papier auf den
Tisch. Das funktioniert — bis der Tisch zu klein wird oder die Kollegin den Fall übernimmt und vor
einem Stapel steht, dem man nicht ansieht, was schon geprüft wurde.

## Die Antwort

J-DESK ist dieser Tisch, nur unbegrenzt groß und mit Gedächtnis. Alles läuft auf eine Frage zu:

> **Welche Behauptung wird durch welche konkrete Fundstelle belegt, welche Gegenposition besteht,
> was ist noch offen — und welches verwertbare Arbeitsergebnis entsteht daraus?**

## Was es kann

- **Ausbreiten** — beliebig viele Dokumente nebeneinander auf einer unbegrenzten Fläche
- **Verknüpfen** — Linien zwischen Karten mit elf juristischen Beziehungsarten (*belegt*,
  *widerspricht*, *entkräftet*, *streitig* …), nach Familien eingefärbt
- **Annotieren** — Notizen, Markierungen, Stempel, Ausschnitte aus Dokumenten
- **Schwärzen** — und zwar echt: der Text wird aus der PDF-Datei **entfernt**, nicht übermalt,
  mit anschließender Nachprüfung
- **Exportieren** — Anlagenpakete und Übergaben, bei denen interne Inhalte zuverlässig
  draußen bleiben
- **Zusammenarbeiten** — mehrere Personen am selben Schreibtisch, mit Konflikterkennung statt
  stillem Überschreiben
- **KI einbeziehen** — auf Veranlassung, protokolliert, mit Vorschlägen zur Prüfung statt
  automatischer Übernahme

## Zwei Grundsätze

**j-lawyer bleibt das führende System.** J-DESK verweist auf Akten und Dokumente, es dupliziert
sie nicht. Kein Schatten-Dokumentenmanagement.

**Im Zweifel intern.** Was nicht ausdrücklich für den Export freigegeben ist, gilt als
vertraulich — nicht umgekehrt. Ein Irrtum in Export-Richtung kostet Vertraulichkeit, einer in
intern-Richtung nur eine fehlende Seite. Vertraulichkeit schlägt Vollständigkeit.

## Installation

Für Kanzleien, mit Docker:

```bash
sudo mkdir -p /opt/j-desk && cd /opt/j-desk
curl -fsSLO https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/compose.yaml
curl -fsSL https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/.env.beispiel -o .env
nano .env          # JLAWYER_URL eintragen
sudo docker compose up -d
```

Dann `http://<server>:4810` aufrufen.

Ohne Docker gibt es ein Installationsskript für Linux-Server mit systemd-Dienst. Beide Wege
ausführlich in der [Installationsanleitung](docs/handbuch/technik/installation.md).

## Handbuch

| Für wen | Wohin |
|---|---|
| Anwältinnen, Anwälte, Kanzleiteam | [Arbeiten mit J-DESK](docs/handbuch/anwender/README.md) |
| Technikbetreuung | [Installation und Betrieb](docs/handbuch/technik/README.md) |
| Entwicklung | [CONTRIBUTING.md](CONTRIBUTING.md), [Schnittstellen](docs/api/README.md) |

## Technik

Ein TypeScript-Monorepo ohne exotische Abhängigkeiten:

- **`packages/core`** — reine Zustandslogik, ohne Fremdabhängigkeiten. Jede Änderung ist ein
  Kommando, das unveränderlich angewandt wird. Von Server, Client und der MCP-Anbindung
  gemeinsam genutzt.
- **`packages/server`** — Fastify, SQLite (WAL), Dateiablage, WebSocket, j-lawyer-Anbindung
- **`packages/mcp`** — Anbindung für KI-Werkzeuge
- **Wurzel** — Web-Client mit Svelte 5 und SvelteKit, statisch gebaut

Node 22 ist verbindlich und an vier Stellen festgeschrieben; ein Wächtertest schlägt fehl, sobald
eine davon ausschert.

```bash
npm install
npm run server     # Server auf http://localhost:4810
npm run dev        # Client mit Weiterleitung (zweites Fenster)
npm test           # alle Tests
```

## Qualität

**2652 Tests** über 169 Dateien, dazu Typprüfung über 561 Dateien ohne Befund. Die
Betriebsdokumente zu [Sicherung](docs/deployment/backup-strategy.md) und
[Update](docs/deployment/update-runbook.md) sind eine Besonderheit: Sie werden bei jedem Testlauf
gegen das tatsächliche Programmverhalten geprüft. Weicht die Beschreibung ab, schlägt ein Test
fehl.

## Mitmachen

Fehler und Wünsche gern über die [Issues](https://github.com/PBaumfalk/j-desk/issues).
Sicherheitslücken bitte **nicht** öffentlich, sondern vertraulich gemäß [SECURITY.md](SECURITY.md).

Zum Mitentwickeln: [CONTRIBUTING.md](CONTRIBUTING.md). Der Quelltext ist deutschsprachig — das ist
Absicht, die Fachsprache dieses Programms ist die juristische.

## Lizenz

[AGPL-3.0](LICENSE). Sie dürfen J-DESK einsetzen, verändern und weitergeben. Wer es verändert und
als Dienst anbietet, muss seine Änderungen unter derselben Lizenz offenlegen. Für Kanzleien, die
J-DESK schlicht betreiben, entstehen daraus keine Pflichten.
