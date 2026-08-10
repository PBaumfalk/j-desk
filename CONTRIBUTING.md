# Mitarbeit an J-DESK

Danke für Ihr Interesse. Dieses Dokument beschreibt, wie Sie beitragen können — und was Sie von
diesem Projekt erwarten dürfen.

**Sicherheitslücken gehören nicht hierher.** Für die gibt es [SECURITY.md](SECURITY.md).

## Worum es geht

J-DESK ist die visuelle juristische Arbeitsebene zwischen Akte, Anwalt und KI. Jede Änderung wird
an einer Frage gemessen:

> Welche Behauptung wird durch welche konkrete Fundstelle belegt, welche Gegenposition besteht,
> was ist noch offen, und welches verwertbare Arbeitsergebnis entsteht daraus?

Zwei Grundsätze, die nicht verhandelbar sind:

- **j-lawyer bleibt das führende System.** J-DESK verweist auf Akten und Dokumente, es dupliziert
  sie nicht. Kein Schatten-Dokumentenmanagement.
- **Vertraulichkeit ist fachlich kritisch.** Interne Annotationen dürfen nie ungewollt in Exporte
  oder zu anderen Nutzern gelangen. Schwärzungen müssen echt schwärzen.

## Voraussetzungen

- **Node 22.** Die Version ist verbindlich und an vier Stellen festgeschrieben (`engines.node`,
  `.nvmrc`, `.node-version`, `packages/server/Dockerfile`). Ein Wächtertest schlägt fehl, sobald
  eine davon ausschert — bitte alle vier gemeinsam ändern.
- Für die Arbeit an der j-lawyer-Anbindung zusätzlich Docker (Testserver, siehe unten).

```bash
npm install
npm run server     # Server auf http://localhost:4810
npm run dev        # Client mit Weiterleitung auf den Server (zweites Fenster)
npm test           # alle Tests
npm run check      # Typprüfung
```

## Vor dem Pull Request

```bash
npm test           # muss grün sein
npm run check      # 0 Fehler
```

**Zu den Tests:** Vier Tests sind zeitkritisch und schlagen unter Last gelegentlich ohne echten
Fehler fehl — `export/uebersichten`, `export/pdfExport`, `restore.perf`, `desk-volume.perf`. Bei
einem Fehlschlag in dieser Gruppe entscheidet der isolierte Zweitlauf:

```bash
npx vitest run packages/server/src/desk-volume.perf.test.ts
```

Läuft er allein durch, war es Rauschen. Bei jedem anderen Test ist ein Fehlschlag ein Fehlschlag.

## Wie wir hier arbeiten

- **Sprache:** Der Quelltext ist deutschsprachig — Bezeichner, Kommentare, Oberflächentexte. Das
  ist Absicht: die Fachsprache dieses Programms ist die juristische, und die ist deutsch. Bitte
  in dieser Sprache weiterschreiben, auch wenn es ungewohnt wirkt.
- **Kommentare erklären das Warum**, nicht das Was. Eine Zeile, die eine Geschäftsregel oder eine
  frühere Fehlentscheidung begründet, ist wertvoll; eine, die den Code nacherzählt, ist Ballast.
- **Anrede „Sie"** in allen Texten für Nutzer, durchgehend.
- **Auslassungspunkte** als „…" (U+2026), nie als drei Punkte.
- **Symbole in Menüs:** Kontextmenüs bleiben textbasiert, ohne Emoji. Schreibtisch-Menü,
  Befehlspalette und Dialog-Titel dürfen Symbole tragen. Diese Regel entstand, weil ein
  teilweise bebildertes Menü unaufgeräumt wirkt.
- **Zustandsänderungen laufen über Kommandos.** Jede Änderung am Schreibtisch ist ein
  `Command`-Objekt, das der Kern (`packages/core`) unveränderlich anwendet. Bitte nicht am
  Zustand vorbei schreiben.

## Commit-Nachrichten

Übliches Format, deutschsprachiger Betreff:

```
fix(ui): Kontextmenue-Eintraege durchgehend ohne Symbole

Erklärt, WARUM die Änderung nötig war — nicht, was der Diff ohnehin zeigt.
```

Übliche Vorsilben: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Der Betreff kommt ohne
Umlaute aus (Werkzeug-Verträglichkeit), der Rumpf darf sie gern haben.

## j-lawyer-Testserver

Für Arbeiten an der Anbindung:

```bash
docker compose -p jl-docker -f docs/deployment/jlawyer-test-compose.yaml up -d
```

Erreichbar auf Port 8000, Anmeldung `admin` / `a`. Dann J-DESK mit
`JLAWYER_URL=http://localhost:8000/j-lawyer-io` starten.

Zwei Hinweise, die Zeit sparen:

- Der Server liest `.env.local` **nicht** von selbst — es gibt kein dotenv in `main.ts`. Die
  Variablen müssen durchgereicht werden:
  `set -a && . ./.env.local && set +a && npm run server`
- Die j-lawyer-Abbilder gibt es nur für amd64. Auf ARM-Rechnern laufen sie emuliert, also
  langsam; rechnen Sie beim ersten Start mit spürbarer Wartezeit.

## Pull Requests

Klein und auf eine Sache bezogen ist besser als groß und vielseitig. Beschreiben Sie, welches
Problem Sie lösen und wie Sie geprüft haben, dass es gelöst ist. Wenn Sie eine Entscheidung
getroffen haben, die auch anders ausfallen könnte, schreiben Sie das dazu — das erspart eine
Rückfragerunde.

Bei Änderungen an der Oberfläche: bitte in der **laufenden Anwendung** ansehen, nicht nur im
Quelltext, und dabei über heller wie dunkler Tischfläche prüfen (die Glasflächen kehren ihren
Farbsatz um). Diese Bitte hat einen Grund — mehrere formale Prüfungen am Quelltext haben genau
deshalb sichtbare Fehler durchgehen lassen.

## Lizenz

Beiträge stehen unter der [AGPL-3.0](LICENSE), wie das übrige Projekt. Mit dem Einreichen eines
Pull Requests erklären Sie sich damit einverstanden, dass Ihr Beitrag unter dieser Lizenz
veröffentlicht wird.
