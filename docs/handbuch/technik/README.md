# Teil 2: Installation und Betrieb

Für die Person, die die Technik der Kanzlei betreut.

## Kapitel

1. **[Installation](installation.md)** — beide Wege, Schritt für Schritt. Fangen Sie hier an.
2. **[Betrieb, Sicherung und Update](betrieb.md)** — was laufend zu tun ist.
3. **[Störungssuche](stoerungssuche.md)** — wenn etwas klemmt.

## In aller Kürze

Wenn Sie Docker haben und wissen, was Sie tun:

```bash
sudo mkdir -p /opt/j-desk && cd /opt/j-desk
curl -fsSLO https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/compose.yaml
curl -fsSL https://raw.githubusercontent.com/PBaumfalk/j-desk/main/install/.env.beispiel -o .env
nano .env          # JLAWYER_URL eintragen
sudo docker compose up -d
```

Dann `http://<server>:4810` im Browser.

## Die drei Dinge, die man vorher wissen sollte

**1. Eine Einstellung entscheidet über alles.** `JLAWYER_URL` gesetzt = Anmeldung und Akten über
j-lawyer (Normalfall). Leer = eigenständiger Betrieb mit eigener Benutzerverwaltung. Ein Wechsel
ist später möglich.

**2. `localhost` funktioniert im Container nicht.** Läuft j-lawyer auf demselben Rechner, lautet
die Adresse `host.docker.internal`, nicht `localhost`. Das kostet erfahrungsgemäß die meiste Zeit
bei der Einrichtung.

**3. Die Office-Vorschau ist freiwillig und teuer.** Sie braucht 4 GB Arbeitsspeicher für sich
allein. Auf knapp bemessenen Servern wird sie vom System abgeschossen (Fehlercode 137). J-DESK
funktioniert ohne sie vollständig.

## Weiterführende Dokumente

Diese richten sich an Leser mit technischem Hintergrund und sind detaillierter als das Handbuch:

- [Sicherung und Wiederherstellung](../../deployment/backup-strategy.md) — gegen das
  Programmverhalten getestet
- [Update-Ablauf](../../deployment/update-runbook.md) — ebenfalls getestet
- [Betriebssicherheit und BRAO](../../deployment/betriebssicherheit-brao.md)
- [Schnittstellen](../../api/README.md) — REST, WebSocket, MCP

---

**Übersicht:** [Handbuch](../README.md)
