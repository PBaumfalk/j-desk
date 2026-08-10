# Backup-Strategie und Wiederherstellung (SAFE-03)

> Stand: Phase 05 (Autosave, Backup & Katastrophenschutz). Quelle für alle hier genannten
> Umgebungsvariablen, Standardwerte und Verhaltensweisen: `packages/server/src/backup.ts`,
> `packages/server/src/migrateSafely.ts`, `packages/server/src/autoArchive.ts`,
> `packages/server/src/main.ts`.

Dieses Dokument beschreibt, was J-DESK sichert, wann und wie, und — am wichtigsten — wie ein
Betriebsverantwortlicher im Ernstfall einen Datenbestand wiederherstellt. Der Wiederherstellungs-
Abschnitt ist kein Papierversprechen: er bildet exakt den Ablauf ab, den
`packages/server/src/restoreRunbook.test.ts` bei jedem Testlauf der Suite ausführt und beweist
(D-24). Weicht dieses Dokument jemals vom Testverhalten ab, gilt der Test — bitte melden.

## 1. Was gesichert wird

Die SQLite-Datenbank unter `DATA_DIR/desktop.sqlite` enthält den gesamten Server-Zustand: alle
Schreibtische (Dokumente, Notizen, Verknüpfungen, Ebenen, Papierkorb), Benutzerkonten und Rollen,
das Command-Journal (Historie/Herkunft) sowie die Metadaten der hochgeladenen Dateien
(Dateihashes, Größen, Dateiart). Die Dateiinhalte selbst liegen als separate Objekte im
Datenverzeichnis; beide — Datenbank und Dateiablage — müssen als zusammengehörige Einheit
gesichert und wiederhergestellt werden.

Ein Backup ist eine vollständige, unprojizierte Kopie dieser Datenbank. Es enthält also
**dieselben Daten mit derselben Vertraulichkeitsstufe wie die produktive Datenbank** — keine
Ebenen-Filterung, keine Schwärzung. Ein Backup braucht denselben Zugriffsschutz wie
`desktop.sqlite` selbst (siehe Abschnitt 8).

## 2. Wann gesichert wird

Zwei unabhängige Auslöser:

- **Beim Serverstart**, nach dem Öffnen der Datenbank (roh, ohne Migration) und **vor** dem
  Migrationslauf (`packages/server/src/main.ts`: `openDbRaw` → `rotateBackup` → `migrateSafely`).
  Dieses Boot-Backup erfasst den letzten konsistenten Vorzustand, bevor irgendeine
  Schema-Änderung greift — **schlägt genau dieser Rotationslauf fehl** (z. B. kurzzeitiger
  Plattendruck), wird das protokolliert, der Start läuft aber ohne dieses eine frische Backup
  weiter (WR-04, dieselbe Toleranz wie der periodische Takt unten): die Stände der letzten
  Rotation liegen weiterhin auf der Platte, ein einzelner Fehlschlag hier ist für sich kein
  Datenverlust. Das unmittelbar anschliessende, SICHERHEITSKRITISCHE Pre-Migration-Backup in
  `migrateSafely()` ist davon ausdrücklich NICHT betroffen und bleibt fail-fast (Abschnitt 6).
- **Im laufenden Betrieb**, im Takt von `BACKUP_INTERVAL_HOURS` (Standardwert **6**, siehe
  `packages/server/src/main.ts`: `parseHours('BACKUP_INTERVAL_HOURS', ..., 6)` — ein
  nicht-numerischer Wert wird protokolliert und fällt auf den Standardwert zurück, WR-02). Der
  Wert `0` schaltet den periodischen Takt vollständig ab — es bleibt dann ausschließlich beim
  Boot-Backup. Der Takt läuft prozessintern (kein externer Cron, kein zusätzlicher Dienst) und
  hält den Serverprozess nicht künstlich am Leben.

## 3. Wie gesichert wird

Ein Backup entsteht über die **Online-Backup-Schnittstelle** der bereits geöffneten
Datenbankverbindung (`better-sqlite3`s `db.backup()` in `packages/server/src/backup.ts`,
Funktion `backupTo()`), **nicht** über einen rohen Dateikopiervorgang (`cp`/`copyFileSync`).

Begründung: Die Datenbank läuft im WAL-Modus (Write-Ahead Logging). Ein Commit kann bestätigt
sein, ohne dass er bereits in die Hauptdatei `desktop.sqlite` eingerechnet wurde — er steht dann
noch (auch) in der Seitendatei `desktop.sqlite-wal`. Ein roher Kopiervorgang der Hauptdatei allein
würde einen solchen, bereits bestätigten Commit verfehlen. Die Online-Backup-Schnittstelle liest
konsistent über beide Dateien hinweg und schließt diese Lücke.

## 4. Wo die Sicherungen liegen und wie lange

**Reguläre Backups:** `DATA_DIR/backup/desktop-<zeitstempel>.sqlite`. Es werden immer die
**letzten 5** Stände aufbewahrt (`rotateBackup()`, Parameter `keep`, Standardwert `5`); ältere
Stände werden bei der nächsten Rotation automatisch entfernt.

**Pre-Migration-Backup:** `DATA_DIR/backup/pre-migration-<zeitstempel>.sqlite`
(`packages/server/src/migrateSafely.ts`, `PRE_MIGRATION_PREFIX`). Dieses Backup entsteht bei
**jedem Serverstart** — `migrateSafely()` zieht es unbedingt, BEVOR geprüft wird, ob `migrate()`
überhaupt etwas zu tun hat; ein Neustart ohne jede Schema-Änderung erzeugt also denselben
vollständigen Snapshot wie ein Neustart mit Migration. Es unterliegt **ausdrücklich NICHT** der
turnusmäßigen `keep=5`-Aufräumlogik der regulären Backups — `rotateBackup()` filtert nach seinem
eigenen Namensmuster (`desktop-`) und rührt Dateien mit dem Präfix `pre-migration-` nicht an.

Eine eigene, davon unabhängige Aufräumregel gilt trotzdem (WR-01): **läuft der Migrationslauf
erfolgreich durch**, entfernt `migrateSafely()` alle ÄLTEREN `pre-migration-…`-Stände und behält
ausschliesslich den soeben gezogenen — eine Crash-Loop- oder Redeploy-Serie häuft so nicht einen
vollständigen Datenbank-Snapshot pro Neustart unbegrenzt an. **Schlägt** der Migrationslauf fehl,
bleibt der soeben gezogene Stand (der für den Rollback gebraucht wird) unangetastet liegen, bis er
manuell entfernt wird — Aufräumen findet ausschliesslich im Erfolgsfall statt. Betriebshinweis:
jedes Pre-Migration-Backup verbraucht zusätzlichen Plattenplatz in der Größenordnung der
produktiven Datenbank — dies ist eine bewusst in Kauf genommene Eigenschaft (T-05-20), kein Fehler.

## 5. Wiederherstellung (Runbook)

Dieser Ablauf ist identisch mit dem, was `packages/server/src/restoreRunbook.test.ts` bei jedem
Suite-Lauf ausführt und verifiziert (Prüfkommando siehe unten).

1. **Server stoppen.** Kein Prozess darf während der Wiederherstellung auf `DATA_DIR` schreiben.
2. **Jüngste Sicherung wählen.** Im Verzeichnis `DATA_DIR/backup/` liegen sowohl reguläre
   (`desktop-<zeitstempel>.sqlite`) als auch ggf. ein Pre-Migration-Backup
   (`pre-migration-<zeitstempel>.sqlite`). **Innerhalb eines Namenspräfix** liefert eine
   alphabetische Sortierung die jüngste Sicherung als letzten Eintrag, weil die Dateinamen den
   Zeitstempel in ISO-Reihenfolge tragen. Eine alphabetische Sortierung **über beide Präfixe
   hinweg ist nicht verlässlich**: `'desktop-' < 'pre-migration-'` lexikographisch immer, egal
   welcher eingebettete Zeitstempel jünger ist — ein `pre-migration-…`-Stand sortiert also
   scheinbar "zuletzt", selbst wenn danach längst ein neuerer `desktop-…`-Stand entstanden ist.
   Vergleiche deshalb, wenn beide Präfixe vorhanden sind, die **eingebetteten Zeitstempel** (den
   ISO-Zeitstempel-Teil nach dem Präfix) numerisch/lexikographisch gegeneinander, statt die
   vollständigen Dateinamen alphabetisch zu sortieren, und wähle den Stand mit dem jüngsten
   Zeitstempel unabhängig vom Präfix. `packages/server/src/backup.ts`s `newestBackupFile()` macht
   genau das (vergleicht nur den eingebetteten Zeitstempel, nicht den vollständigen Dateinamen) —
   und ist über ein kleines CLI-Werkzeug direkt nutzbar, statt diesen Vergleich während eines
   laufenden Vorfalls von Hand nachzuvollziehen (IN-01):

   ```bash
   fnm exec --using=20 npx tsx packages/server/src/scripts/newestBackup.ts "$DATA_DIR/backup"
   ```

   Die Ausgabe ist der Dateiname (ohne Verzeichnis) der jüngsten Sicherung.
3. **Vorhandene Datenbankdatei und ihre Seitendateien entfernen:** `desktop.sqlite`,
   `desktop.sqlite-wal`, `desktop.sqlite-shm` aus `DATA_DIR` löschen (sofern vorhanden). Dieser
   Schritt ist notwendig, weil ein zurückbleibender WAL-/SHM-Seitenspeicher der (möglicherweise
   defekten) alten Fassung beim nächsten Öffnen fälschlich in die frisch zurückgespielte Datei
   eingerechnet würde — die Wiederherstellung wäre dann nicht sauber, sondern eine Mischung aus
   altem und neuem Stand.
4. **Die gewählte Sicherung auf `desktop.sqlite` kopieren** (im Code: `restoreDbFile()` in
   `packages/server/src/backup.ts` — entfernt intern zuerst die Seitendateien aus Schritt 3 und
   kopiert danach die Backup-Datei an die Zielposition).
5. **Server starten.** Der reguläre Boot-Ablauf öffnet die wiederhergestellte Datenbank und führt
   den Migrationslauf regulär aus (Migrationen sind additiv und idempotent — ein bereits
   migrierter Stand bleibt unverändert, ein älterer wird auf das aktuelle Schema gehoben).

**Ausführbarer Nachweis:** `packages/server/src/restoreRunbook.test.ts` bildet genau diese fünf
Schritte end-to-end nach — inklusive eines simulierten Totalverlusts (Datenbankdatei und beide
Seitendateien werden entfernt, bevor wiederhergestellt wird) und eines Vergleichs von
Schreibtischanzahl, Revisionsstand und Zustands-Prüfsumme jedes Schreibtischs vor und nach der
Wiederherstellung. Prüfkommando:

```bash
fnm exec --using=20 npx vitest run packages/server/src/restoreRunbook.test.ts
```

## 6. Fehlgeschlagene Migration

Vor jedem Migrationslauf zieht der Server automatisch ein Pre-Migration-Backup (Abschnitt 4) und
führt die Migration dann über `migrateSafely()` aus (`packages/server/src/migrateSafely.ts`).

- **Gelingt die Migration:** Es wird nichts zurückgespielt. Die migrierte Datenbank bleibt in
  Betrieb, das Pre-Migration-Backup bleibt zusätzlich als Rückfallstand auf der Platte liegen.
- **Schlägt ein Migrationsschritt fehl:** Die Datenbankverbindung wird geschlossen, der
  Vorzustand aus dem soeben gezogenen Pre-Migration-Backup zurückgespielt (inklusive Entfernen der
  verwaisten WAL-/SHM-Seitendateien der defekten Fassung), die Ursache wird **zweimal
  protokolliert** (einmal beim Erkennen des Fehlers, einmal nach abgeschlossenem Rückspielen), und
  der Serverstart **bricht mit Exit-Code ungleich 0 ab** — der Prozess läuft niemals mit einem
  halb migrierten Schema weiter.

Nach einem solchen Abbruch darf der Betrieb **nicht** einfach neu gestartet werden, ohne vorher
die protokollierte Fehlerursache zu klären: ein erneuter Start würde denselben Migrationsschritt
erneut versuchen und erneut fehlschlagen. Die Datenbank selbst ist unversehrt (Vorzustand wurde
zurückgespielt) — es besteht kein Zeitdruck, die Ursache in Ruhe zu untersuchen, bevor ein
erneuter Start versucht wird.

**Bekannte Grenze (residual, WR-10):** Die Aufräumregel aus Abschnitt 4 (`WR-01`) entfernt ältere
Pre-Migration-Backups ausschliesslich im ERFOLGSFALL eines Migrationslaufs — absichtlich, damit
der für den Rollback gebrauchte Stand niemals unter einem laufenden Fehlschlag entfernt wird.
Wird die oben beschriebene Betriebsvorgabe (kein blindes Neu-Starten) missachtet und ein defekter
Migrationsschritt über einen Orchestrator (z. B. eine Neustart-Richtlinie eines Containers)
wiederholt automatisch neu gestartet, zieht **jeder** dieser Neustartversuche ein weiteres
vollständiges Pre-Migration-Backup, ohne dass der Fehlerpfad je aufräumt — der Plattenverbrauch
wächst dann unbegrenzt mit der Anzahl der Neustartversuche. Ein Betriebsverantwortlicher, der
Plattenverbrauch während eines länger andauernden Vorfalls beobachtet, sollte dieses Wachstum
erwarten und es als zusätzliches Signal werten, dass eine Crash-Loop vorliegt, statt es als
Leck misszuverstehen.

## 7. Automatische Sicherung in die j-lawyer-Akte

Zusätzlich zu den serverseitigen Backups (Abschnitte 2–6) sichert J-DESK im j-lawyer-Modus jeden
Schreibtisch opportunistisch als `.jdesk`-Paket direkt in die zugehörige j-lawyer-Akte
(`packages/server/src/autoArchive.ts`).

Ausgelöst wird dies beim nächsten erfolgreichen, **authentifizierten** Akten-Abgleich
(`GET /api/v1/cases/:id/desk`) — nicht am Boot-Zeitpunkt, weil dort weder die betroffene Akte noch
j-lawyer-Zugangsdaten bekannt sind. Das erzeugte Paket trägt im Manifest den Modus `linked` und
wird für den auslösenden Nutzer projiziert (keine synthetische Vollzugriffs-Rolle) — der
Akteninhalt enthält also nie mehr, als dieser Nutzer ohnehin ausgeliefert bekäme.

Gesteuert wird die Automatik über `JDESK_ARCHIVE_INTERVAL_HOURS` (Standardwert **24**, siehe
`packages/server/src/autoArchive.ts`: `parseHours('JDESK_ARCHIVE_INTERVAL_HOURS', ..., 24)` — ein
nicht-numerischer Wert wird protokolliert und fällt auf den Standardwert zurück, WR-02/WR-09).
Der Wert gibt den Mindestabstand zwischen zwei Automatiksicherungen desselben Schreibtischs in
Stunden an; `0` schaltet die Automatik vollständig ab. Ein Upload erfolgt nur, wenn sich der
Zustand seit der letzten Automatiksicherung tatsächlich geändert hat (Revisionsvergleich) **und**
der Mindestabstand verstrichen ist — beide Bedingungen zusammen verhindern, dass die Akte mit
nahezu identischen Paketen zugemüllt wird.

**Fehlerverhalten:** Schlägt der Upload in die Akte fehl (z. B. Netzwerkfehler, j-lawyer
nicht erreichbar), bleibt der lokale Bestand unberührt, der Fehler wird protokolliert, und der
Merker über die letzte erfolgreiche Sicherung wird **nicht** fortgeschrieben — der nächste
Akten-Abgleich versucht die Sicherung erneut.

## 8. Grenzen und Betriebsverantwortung

- **Backups liegen unverschlüsselt im Datenverzeichnis.** Sie enthalten denselben, unprojizierten
  Datenbestand wie die produktive Datenbank (Abschnitt 1) und brauchen deshalb denselben
  Zugriffsschutz — auf Dateisystem- und Deployment-Ebene (z. B. Docker-Volume-Berechtigungen),
  nicht innerhalb von J-DESK selbst.
- **Nicht übertragene Änderungen liegen im Browser-Speicher des Arbeitsplatzes.** Solange ein
  Client offline ist oder abgemeldet wurde, bevor eine Änderung den Server erreicht hat, existiert
  diese Änderung ausschließlich lokal im Browser-Speicher der jeweiligen Arbeitsstation. Weder die
  serverseitigen Backups (Abschnitte 2–6) noch die Akten-Automatik (Abschnitt 7) erfassen einen
  solchen Stand — er wird erst mit der nächsten erfolgreichen Verbindung zum Server sichtbar und
  gesichert. Diese Eigenschaft ist bewusst in Kauf genommen (SAFE-02 verlangt ausdrücklich, dass
  unsynchronisierte Änderungen einen Neustart oder eine Abmeldung überstehen — ein serverseitiges
  Löschen würde diese Anforderung aufheben).
- **Das Datenverzeichnis gehört in eine externe Sicherung des Betreibers.** J-DESK sichert
  innerhalb des Datenverzeichnisses (`DATA_DIR`), nicht darüber hinaus. Geht das gesamte Volume
  verloren (Hardware-Defekt, gelöschtes Docker-Volume, zerstörter Datenträger), sind sowohl die
  produktive Datenbank als auch alle serverseitigen Backups gleichzeitig betroffen. Eine
  regelmäßige, externe Sicherung des gesamten `DATA_DIR` (z. B. Snapshot des Docker-Volumes,
  Offsite-Backup) liegt in der Verantwortung des Betreibers und ist keine Aufgabe von J-DESK
  selbst.
