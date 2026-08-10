# Update-Runbook (OPS-01)

> Stand: Phase 14 (Betriebsreife & Produktisierung). Quelle für alle hier genannten
> Umgebungsvariablen, Standardwerte und Verhaltensweisen: `packages/server/src/migrateSafely.ts`,
> `packages/server/src/db.ts`, `packages/server/src/main.ts`, `packages/server/src/backup.ts`.

Dieses Dokument beschreibt, wie eine Betreiberin J-DESK auf einen neuen Stand aktualisiert — von
der Prüfung des aktuellen Stands über das Einspielen bis zur Bestätigung, dass Migration und
Datenbestand danach unversehrt sind. Der Update-Abschnitt ist kein Papierversprechen: er bildet
exakt den Ablauf ab, den `packages/server/src/update.runbook.test.ts` bei jedem Testlauf der Suite
ausführt und beweist. Weicht dieses Dokument jemals vom Testverhalten ab, gilt der Test — bitte
melden.

Für die Wiederherstellung nach einem fehlgeschlagenen Update (Rollback) gilt
`docs/deployment/backup-strategy.md` Abschnitt 5 unverändert — es gibt hier bewusst keinen
zweiten, konkurrierenden Wiederherstellungs-Ablauf (Abschnitt 5 unten).

## 1. Vor dem Update

**Aktuellen Stand prüfen.** Der Eigentümer öffnet die Systemdiagnose (🩺-Toolbar-Button,
`SystemdiagnoseOverlay.svelte`, Abschnitt SYSTEM) und liest dort die laufende App-Version, die
Schemaversion (`PRAGMA user_version` derselben Datenbank) und die aktive Node-Laufzeit ab
(`GET /api/v1/desks/:id/diagnose`, Plan 14-01) — ohne SQL-Zugriff und ohne Serverkonsole. Diese
drei Werte sind der Vergleichspunkt für Schritt 6 unten: nach dem Update müssen App- und
Schemaversion den erwarteten neuen Stand zeigen.

**Datenverzeichnis und Sicherungslage.** `DATA_DIR` (Standard: `./data`, siehe
`packages/server/src/main.ts`) enthält die Datenbank `desktop.sqlite` und das Backup-Verzeichnis
`DATA_DIR/backup/`. Vor einem geplanten Update lohnt ein Blick in dieses Verzeichnis
(`docs/deployment/backup-strategy.md` Abschnitt 4) — der Update-Vorgang selbst zieht beim
nächsten Serverstart ohnehin automatisch ein frisches Pre-Migration-Backup (Abschnitt 4 unten),
ersetzt aber keine externe, betreiberseitige Sicherung des gesamten `DATA_DIR`
(`backup-strategy.md` Abschnitt 8).

**Node-Zielversion.** J-DESK ist auf genau eine Node-Hauptversion festgelegt: **Node 22**
(`packages/server/Dockerfile`, `FROM node:22-slim` — die einzige Stelle im Bestand mit
Festlegungscharakter; siehe `packages/server/src/nodeVersion.test.ts`). Diese eine Version steht
an vier Stellen konsistent — `engines.node` in der Root-`package.json`, `.nvmrc` und
`.node-version` (zwei Dateien, weil `fnm`/`nvm` und andere Versionsmanager unterschiedliche
Dateinamen lesen) sowie das Dockerfile-Basisimage. Ein Wächtertest bricht bei jedem Suite-Lauf,
sobald eine dieser Stellen ausschert. Bewusst **nicht** gesetzt ist `engine-strict`: eine
Installation unter einer abweichenden Node-Version soll warnen, aber nicht abbrechen — eine harte
Sperre würde Bestandsumgebungen und parallel laufende Arbeitsbäume beim ersten `npm install`
schlagartig unbenutzbar machen. Der Grund, warum die Version überhaupt wichtig ist: `npm ci`/
`npm install` baut native Module (`better-sqlite3`) gegen die gerade aktive Node-Version — ein
Update unter einer anderen Version als der zuvor verwendeten führt sonst zu einem ABI-Fehler beim
nächsten Datenbankzugriff, nicht schon beim Installieren.

## 2. Update (Runbook)

Direkter Betrieb (Node-Prozess ohne Container):

1. **Server stoppen.** Kein Prozess darf während des Updates auf `DATA_DIR` schreiben — dieselbe
   Voraussetzung wie bei einer Wiederherstellung (`backup-strategy.md` Abschnitt 5, Schritt 1).
2. **Neuen Stand einspielen.** Den neuen Code-Stand an die Stelle des alten bringen (z. B.
   `git pull`/Deployment-Artefakt entpacken). `DATA_DIR` bleibt davon unberührt — der neue Stand
   und das Datenverzeichnis sind getrennte Dinge.
3. **Abhängigkeiten unter der Zielversion installieren:** `npm ci` unter Node 22 ausführen (siehe
   Abschnitt 1 — `.nvmrc`/`.node-version` machen die Zielversion für Versionsmanager
   auffindbar). Dieser Schritt baut native Module (`better-sqlite3`) gegen die gerade aktive
   Node-Version neu — **genau daraus entsteht die Drift**, wenn eine abweichende Version aktiv
   ist: der Server startet dann scheinbar, scheitert aber beim ersten Datenbankzugriff mit einem
   ABI-Fehler statt beim Installieren selbst.
4. **Server starten:** `npx tsx packages/server/src/main.ts` (bzw. der konfigurierte Prozess-
   Supervisor). Der reguläre Boot-Ablauf öffnet die Datenbank, sichert und migriert automatisch
   (Abschnitt 3 unten, `packages/server/src/main.ts`).
5. **Startmeldung prüfen.** Der Server protokolliert beim erfolgreichen Hochfahren eine Zeile nach
   dem Muster `Digital-Desktop-Server läuft auf Port <port> …` (`packages/server/src/main.ts`,
   `startApp()`) — erscheint diese Zeile nicht, ist der Start fehlgeschlagen (siehe Abschnitt 5).
6. **In der Systemdiagnose gegenprüfen.** Dieselbe Stelle wie in Abschnitt 1: App-Version und
   Schemaversion müssen jetzt den erwarteten neuen Stand zeigen (`GET /api/v1/desks/:id/diagnose`,
   Abschnitt SYSTEM). Zeigt die Schemaversion nach einem erwarteten Migrationsschritt weiterhin
   den alten Wert, ist etwas schiefgelaufen — vor dem nächsten Neustart die Serverlogs prüfen
   (Abschnitt 5).

Container-Betrieb (Docker, `packages/server/Dockerfile`): dieselben Schritte, komprimiert auf den
Image-Wechsel — Container mit dem neuen Image-Tag starten (`docker run`/`docker compose up`), das
Datenvolumen (`VOLUME /data`, `DATA_DIR=/data` im Dockerfile) bleibt am selben Ort bestehen und
wird unverändert weiterverwendet. Die native-Modul-Drift aus Schritt 3 entsteht hier nicht: der
Build (`RUN npm ci`) läuft bereits innerhalb des `node:22-slim`-Basisimages, also stets unter der
Zielversion.

## 3. Was beim Start automatisch passiert

Kein Teil davon ist neu für dieses Runbook — es ist derselbe Ablauf, den
`docs/deployment/backup-strategy.md` bereits für die reguläre Sicherung beschreibt, hier auf den
Update-Fall bezogen:

- **Sicherung vor der Migration.** `packages/server/src/main.ts` öffnet die Datenbank ohne
  Migration (`openDbRaw`), zieht ein reguläres Boot-Backup (`rotateBackup`, toleranter Fehlerpfad
  — Abschnitt 2 in `backup-strategy.md`) und ruft danach `migrateSafely()`
  (`packages/server/src/migrateSafely.ts`). `migrateSafely()` zieht **vor jedem** Migrationslauf
  zusätzlich ein eigenes, sicherheitskritisches Pre-Migration-Backup
  (`DATA_DIR/backup/pre-migration-<zeitstempel>.sqlite`) — unbedingt, auch wenn ein Update am Ende
  keine Schema-Änderung enthält.
- **Spaltenbasierte Schemaprüfung statt Versionszähler.** `migrate()` (`packages/server/src/db.ts`)
  prüft additive Änderungen über `PRAGMA table_info(...)` (Spalten-/Tabellenbestand), nicht mehr
  ausschließlich über `PRAGMA user_version`: Bestands-Datenbanken aus nie gemergten Zweigen können
  eine Versionsnummer tragen, die nichts mehr über den tatsächlichen Spaltenbestand aussagt (Lehre
  aus dem `user_version`-Vorfall e410538, Kommentar am Kopf von `migrate()`). Der Versionszähler
  bleibt für die drei ältesten, bereits bekannten additiven Schritte in Gebrauch; alle neueren
  Änderungen prüfen den Spaltenbestand direkt — beides läuft bei jedem Start unbedingt und
  idempotent.
- **Erfolgspfad.** Gelingt die Migration, wird nichts zurückgespielt; das Pre-Migration-Backup
  bleibt als Rückfallstand liegen, ältere Pre-Migration-Backups werden aufgeräumt (behält
  ausschließlich den soeben gezogenen Stand — WR-01 in `migrateSafely.ts`).
- **Fehlerpfad.** Schlägt ein Migrationsschritt fehl, schließt `migrateSafely()` die
  Datenbankverbindung, spielt den Vorzustand aus dem soeben gezogenen Pre-Migration-Backup zurück
  und wirft `MigrationFehlgeschlagen` weiter — der Serverstart bricht mit Exit-Code ungleich 0 ab.
  Der Prozess läuft **niemals** mit einem halb migrierten Schema weiter.

## 4. Wenn das Update fehlschlägt

Bricht der Start mit `MigrationFehlgeschlagen` ab (Abschnitt 3, Fehlerpfad), liegt die Ursache
**zweimal** im Serverprotokoll: einmal als `Migration fehlgeschlagen — Vorzustand wird
wiederhergestellt: <Fehler>` beim Erkennen, einmal als `Vorzustand wiederhergestellt aus:
<Pfad>` nach abgeschlossenem Rückspielen (`packages/server/src/migrateSafely.ts`). Der Vorzustand
ist zu diesem Zeitpunkt bereits automatisch zurückgespielt — die Datenbankdatei
(`DATA_DIR/desktop.sqlite`) entspricht wieder exakt dem Stand unmittelbar vor diesem Update-
Versuch, kein manueller Rückbau nötig.

Trotzdem gilt: **nicht** einfach neu starten, ohne vorher die protokollierte Ursache zu klären —
ein erneuter Start würde denselben Migrationsschritt erneut versuchen und erneut fehlschlagen. Die
Datenbank ist unversehrt, es besteht kein Zeitdruck. Ein manuelles Zurückspielen ist nur nötig,
wenn die automatische Wiederherstellung selbst fehlgeschlagen ist (z. B. das Datenverzeichnis war
während des Updates nicht beschreibbar) — in diesem Fall gilt exakt der in
`docs/deployment/backup-strategy.md` Abschnitt 5 beschriebene Wiederherstellungs-Ablauf, mit dem
Pre-Migration-Backup (`DATA_DIR/backup/pre-migration-<zeitstempel>.sqlite`) als zu wählender
Sicherung — kein zweiter, eigenständiger Rollback-Mechanismus.

## 5. Ausführbarer Nachweis

`packages/server/src/update.runbook.test.ts` bildet den in Abschnitt 2 beschriebenen Update-Ablauf
end-to-end nach (Bestands-Datenbank mit mehreren Schreibtischen → Fingerabdruck je Schreibtisch
erfassen → Startpfad der neuen Version durchlaufen → Fingerabdruck und Schemaversion danach
vergleichen). Die nummerierten Schritt-Kommentare im Test entsprechen den Schrittnummern in
Abschnitt 2 dieses Dokuments. Prüfkommando:

```bash
fnm exec --using=22 -- npx vitest run packages/server/src/update.runbook.test.ts
```

## 6. Grenzen und Betriebsverantwortung

- **J-DESK stellt die Laufzeitumgebung nicht bereit.** Node 22 (direkter Betrieb) bzw. eine
  Container-Runtime, die das mitgelieferte Image ausführen kann (Container-Betrieb), müssen vom
  Betreiber bereitgestellt und aktuell gehalten werden.
- **Der Zugriffsschutz auf das Datenverzeichnis liegt beim Betreiber.** `DATA_DIR` enthält die
  produktive Datenbank und alle Backups unverschlüsselt (`backup-strategy.md` Abschnitt 8) — auf
  Dateisystem- und Deployment-Ebene zu schützen (z. B. Docker-Volume-Berechtigungen), nicht
  innerhalb von J-DESK selbst.
- **Die Aufbewahrungsdauer der Sicherungen ist begrenzt und automatisch geregelt**
  (`backup-strategy.md` Abschnitt 4: `keep=5` für reguläre Backups, „nur der jüngste" für
  Pre-Migration-Backups im Erfolgsfall). Eine darüber hinausgehende, langfristige Archivierung ist
  keine J-DESK-Funktion und liegt in der Verantwortung des Betreibers.
- **Die j-lawyer-Versionskompatibilität wird vor einem Update nicht automatisch geprüft.** Läuft
  J-DESK im j-lawyer-Modus, muss die Betreiberin vor einem Update selbst sicherstellen, dass die
  neue J-DESK-Version mit der eingesetzten j-lawyer-Version kompatibel ist — das Versions-
  kompatibilitätsbanner in `LoginScreen.svelte` (WR-06) prüft dies erst nach dem Anmelden, nicht
  vorab als Update-Gate.
