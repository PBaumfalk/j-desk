# Installation

*Für die Person, die die Technik der Kanzlei betreut. Vorkenntnisse in Docker sind hilfreich, aber
nicht zwingend — der Weg ist so beschrieben, dass er auch ohne funktioniert.*

## Vorab: die eine Entscheidung

Bevor Sie anfangen, klären Sie eine Frage, denn sie bestimmt alles Weitere:

> **Soll J-DESK an Ihr j-lawyer angebunden werden?**

**Ja (Normalfall).** Ihre Leute melden sich mit ihren j-lawyer-Zugangsdaten an, Akten und
Dokumente kommen aus j-lawyer. Es gibt keine zweite Benutzerverwaltung, die Sie pflegen müssten.
Sie brauchen dafür: die Adresse Ihres j-lawyer-Servers.

**Nein.** J-DESK arbeitet eigenständig mit eigenen Konten. Beim ersten Aufruf im Browser
erscheint eine Einrichtungsmaske, in der Sie das erste Konto anlegen. Gut zum Ausprobieren.

Umgeschaltet wird über eine einzige Einstellung (`JLAWYER_URL`). Sie können später wechseln.

## Was Sie brauchen

| | Mindestens | Empfohlen |
|---|---|---|
| Arbeitsspeicher | 2 GB | 4 GB |
| Festplatte | 10 GB | 50 GB und mehr, je nach Aktenmenge |
| Prozessor | 2 Kerne | 4 Kerne |
| Betriebssystem | alles, worauf Docker läuft | Debian 12 oder Ubuntu 24.04 |

Wenn Sie zusätzlich die **Office-Vorschau** wollen (Word- und Excel-Dateien direkt im Browser),
rechnen Sie **4 GB Arbeitsspeicher und 2 Prozessorkerne obendrauf**. Das ist kein Richtwert nach
Gefühl: Auf einem knapp bemessenen Rechner wird dieser Dienst vom Betriebssystem abgeschossen
(Fehlercode 137). Im Zweifel zunächst weglassen — J-DESK funktioniert vollständig ohne ihn, nur
werden Office-Dateien dann zum Herunterladen angeboten statt angezeigt.

---

## Weg 1: Mit Docker (empfohlen)

Dies ist der Weg, den wir empfehlen und der am wenigsten Pflege verlangt. Sie bauen nichts
selbst — Sie laden ein fertiges, geprüftes Abbild.

### Schritt 1 — Docker einrichten

Falls noch nicht vorhanden, auf Debian oder Ubuntu:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Prüfen, ob es läuft:

```bash
docker --version
```

### Schritt 2 — Dateien ablegen

```bash
sudo mkdir -p /opt/j-desk && cd /opt/j-desk
curl -fsSLO https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/compose.yaml
curl -fsSL https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/.env.beispiel -o .env
```

### Schritt 3 — Einstellungen anpassen

Öffnen Sie die Datei `.env` in einem Texteditor (`nano .env`). Sie ist ausführlich kommentiert.
Für die Anbindung an j-lawyer ist genau eine Zeile entscheidend:

```
JLAWYER_URL=http://kanzlei-server:8080/j-lawyer-io
```

**Drei Stolpersteine, die erfahrungsgemäß Zeit kosten:**

1. **Das `/j-lawyer-io` am Ende gehört dazu.** Ohne diesen Pfad findet J-DESK die Schnittstelle
   nicht.
2. **Schreiben Sie nicht `localhost`.** Aus Sicht des Containers wäre das der Container selbst.
   Läuft j-lawyer auf *demselben* Rechner, verwenden Sie stattdessen:
   ```
   JLAWYER_URL=http://host.docker.internal:8080/j-lawyer-io
   ```
3. **Die Portnummer ist die von j-lawyer**, nicht die von J-DESK.

Wenn Sie J-DESK ohne j-lawyer betreiben wollen, lassen Sie die Zeile einfach leer.

### Schritt 4 — Starten

```bash
sudo docker compose up -d
```

Beim ersten Mal wird das Abbild geladen, das dauert je nach Leitung einige Minuten.

### Schritt 5 — Nachsehen, ob es läuft

```bash
sudo docker compose ps
```

In der Spalte `STATUS` sollte nach etwa einer Minute `healthy` stehen. Steht dort `unhealthy`
oder `restarting`, schauen Sie ins Protokoll:

```bash
sudo docker compose logs -f
```

Dann rufen Sie im Browser auf:

```
http://<name-oder-adresse-des-servers>:4810
```

Bei Anbindung an j-lawyer erscheint sofort die Anmeldemaske — melden Sie sich mit einem
j-lawyer-Konto an. Ohne Anbindung erscheint stattdessen die Einrichtungsmaske für das erste Konto.

**Fertig.**

---

## Weg 2: Direkt auf einem Linux-Server, ohne Docker

Für Umgebungen, in denen Docker nicht in Frage kommt. Etwas mehr Pflegeaufwand — Node-Updates
liegen dann bei Ihnen.

```bash
curl -fsSLO https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/j-desk-installieren.sh
sudo bash j-desk-installieren.sh
```

Das Skript fragt vor jedem verändernden Schritt nach und richtet ein:

- Node 22 (aus der offiziellen Paketquelle, falls nicht vorhanden)
- das Programm unter `/opt/j-desk`
- einen eigenen Dienstbenutzer ohne Anmelderecht
- die Daten unter `/var/lib/j-desk`
- einen systemd-Dienst, der beim Serverstart mitläuft

Danach die Einstellungen anpassen und den Dienst neu starten:

```bash
sudo nano /etc/j-desk.env
sudo systemctl restart j-desk
```

Zustand und Protokoll:

```bash
systemctl status j-desk
journalctl -u j-desk -f
```

---

## Nach der Installation

### Erreichbarkeit im Kanzleinetz

J-DESK hört auf Port 4810. Damit Ihre Leute es erreichen, muss dieser Port im Kanzleinetz
offenstehen. **Ins Internet gehört er nicht** — J-DESK ist für den Betrieb im eigenen Netz
gedacht.

Soll von außen zugegriffen werden, setzen Sie einen Zugang über VPN oder stellen Sie einen
Vermittlungsdienst mit gültigem Zertifikat davor (etwa Caddy oder nginx). Ohne Verschlüsselung
gehören Mandatsdaten nicht über fremde Netze.

### Datensicherung einrichten

**Das ist kein optionaler Schritt.** Alle Daten liegen an einer Stelle:

- Docker-Weg: im Datenträger `j_desk_daten` (`docker volume inspect j-desk-pruefung_j_desk_daten`
  zeigt den Pfad)
- Direktinstallation: unter `/var/lib/j-desk`

Wie Sie sichern und — wichtiger — wie Sie prüfen, dass sich die Sicherung auch zurückspielen
lässt, steht in [Betrieb und Sicherung](betrieb.md).

### Office-Vorschau nachrüsten

Falls gewünscht: In `compose.yaml` den Abschnitt `eurooffice` entkommentieren, in der `.env`
`EUROOFFICE_URL` und `EUROOFFICE_JWT_SECRET` setzen (dasselbe Geheimnis an beiden Stellen), dann
`docker compose up -d`.

Ein Geheimnis erzeugen Sie mit:

```bash
openssl rand -hex 32
```

---

## Hinweise für besondere Umgebungen

### ARM-Server und Apple-Silicon-Rechner

Das J-DESK-Abbild wird für beide gängigen Architekturen gebaut (amd64 und arm64) und läuft auf
ARM-Servern nativ.

**Die j-lawyer-Abbilder tun das nicht.** Sie gibt es nur für amd64. Betreiben Sie j-lawyer selbst
in Docker auf einem ARM-Rechner, läuft es über Emulation — merklich langsamer und
speicherhungriger. Für einen Testaufbau ist das hinnehmbar; für den Kanzleibetrieb sollte
j-lawyer auf einem amd64-Rechner laufen.

### Testumgebung mit j-lawyer zum Ausprobieren

Wenn Sie J-DESK erst einmal gefahrlos ansehen wollen, ohne Ihr echtes j-lawyer anzufassen, liegt
im Projekt eine fertige Testumgebung:

```bash
docker compose -p jl-docker -f docs/deployment/jlawyer-test-compose.yaml up -d
```

Das startet ein j-lawyer samt Datenbank auf Port 8000 (Anmeldung `admin` / `a`). In der `.env`
von J-DESK tragen Sie dann ein:

```
JLAWYER_URL=http://host.docker.internal:8000/j-lawyer-io
```

Bitte nur zum Ausprobieren — die Zugangsdaten sind allgemein bekannt.

---

**Weiter:** [Betrieb und Sicherung](betrieb.md) · [Störungssuche](stoerungssuche.md)
