# J-DESK für die Technikbetreuung

**Schnellhilfe.** Die Antwort steht meist in der Tabelle.

---

## Die 15 häufigsten Fragen

| Was Sie wollen | So geht's |
|---|---|
| **Installieren** | Docker: `compose.yaml` + `.env`, ein Befehl. → [Kapitel 1](01-installation.md) |
| **Ohne Docker installieren** | Skript mit systemd-Dienst. → [Kapitel 1](01-installation.md#weg-2-direkt-auf-einem-linux-server-ohne-docker) |
| **An j-lawyer anbinden** | `JLAWYER_URL` setzen — mit `/j-lawyer-io` am Ende. → [Kapitel 2](02-erste-einrichtung.md) |
| **Läuft es?** | `curl http://localhost:4810/api/v1/auth/status` → HTTP 200 |
| **Betriebsart prüfen** | Dieselbe Adresse: `"mode":"jlawyer"` oder `"standalone"`. → [Kapitel 2](02-erste-einrichtung.md) |
| **Erstes Konto anlegen** | Nur im eigenständigen Betrieb — Maske beim ersten Aufruf. → [Kapitel 2](02-erste-einrichtung.md) |
| **Daten sichern** | Ein Verzeichnis, aber **Dienst vorher anhalten**. → [Kapitel 3](03-betrieb-und-sicherung.md) |
| **Sicherung prüfen** | `sqlite3 … "PRAGMA integrity_check;"` muss `ok` sagen. → [Kapitel 3](03-betrieb-und-sicherung.md) |
| **Aktualisieren** | Vorher sichern, dann `docker compose pull && up -d`. → [Kapitel 3](03-betrieb-und-sicherung.md#update) |
| **Zurück auf alte Version** | `J_DESK_VERSION` in der `.env` festnageln. → [Kapitel 5](05-stoerungssuche.md) |
| **Benutzer anlegen** | Im j-lawyer-Betrieb: **gar nicht** — kommt aus j-lawyer. → [Kapitel 4](04-benutzer-und-rechte.md) |
| **„Warum sieht Frau Meier das nicht?"** | „Sichtbarkeit prüfen…" — ohne SQL. → [Kapitel 4](04-benutzer-und-rechte.md#warum-sieht-jemand-etwas-nicht) |
| **Container startet immer neu** | Protokoll lesen; die zwei üblichen Ursachen. → [Kapitel 5](05-stoerungssuche.md#der-container-startet-immer-wieder-neu) |
| **Anmeldung schlägt fehl** | Fast immer erreicht der Container j-lawyer nicht. → [Kapitel 5](05-stoerungssuche.md) |
| **Office-Dateien werden nicht angezeigt** | Vorschaudienst nicht eingerichtet — freiwillig. → [Kapitel 1](01-installation.md) |

---

## In 60 Sekunden

```bash
sudo mkdir -p /opt/j-desk && cd /opt/j-desk
curl -fsSLO https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/compose.yaml
curl -fsSL https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/.env.beispiel -o .env
nano .env          # JLAWYER_URL eintragen
sudo docker compose up -d
```

Dann `http://<server>:4810`.

---

## Die drei Dinge, die erfahrungsgemäß Zeit kosten

**1. `localhost` funktioniert im Container nicht.** Läuft j-lawyer auf demselben Rechner,
lautet die Adresse `host.docker.internal`, nicht `localhost`. Das ist der häufigste Fehler
überhaupt.

**2. Das `/j-lawyer-io` am Ende gehört dazu.** `http://server:8080` findet die
Schnittstelle nicht, `http://server:8080/j-lawyer-io` schon.

**3. Die Office-Vorschau braucht 4 GB für sich allein.** Auf knappen Servern wird sie vom
System abgeschossen (Fehlercode 137). Sie ist freiwillig — J-DESK läuft ohne sie
vollständig, nur werden Office-Dateien dann zum Herunterladen angeboten.

---

## Die Kapitel

1. **[Installation](01-installation.md)** — beide Wege, Schritt für Schritt
2. **[Erste Einrichtung](02-erste-einrichtung.md)** — Betriebsarten, j-lawyer, erstes Konto
3. **[Betrieb und Sicherung](03-betrieb-und-sicherung.md)** — sichern, prüfen, aktualisieren
4. **[Benutzer und Rechte](04-benutzer-und-rechte.md)** — Rollen, Ebenen, Sichtbarkeit
5. **[Störungssuche](05-stoerungssuche.md)** — echte Fälle aus dem Betrieb

## Weiterführend

Ausführlicher und technischer als dieses Handbuch — und gegen das Programmverhalten
getestet:

- [Sicherung und Wiederherstellung](../../deployment/backup-strategy.md)
- [Update-Ablauf](../../deployment/update-runbook.md)
- [Betriebssicherheit und BRAO](../../deployment/betriebssicherheit-brao.md)
- [Schnittstellen](../../api/README.md) — REST, WebSocket, MCP

---

*Zurück zur [Handbuch-Übersicht](../README.md) · [Stichwortverzeichnis](../stichwortverzeichnis.md)*
