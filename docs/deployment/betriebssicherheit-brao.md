# Sicherheitskonzept: externe Anbindungen und BRAO-Prüfpunkte (OPS-05)

> Stand: Phase 14 (Betriebsreife & Produktisierung), Pläne 14-08 und 14-09. Quelle für alle
> technischen Aussagen: `packages/server/src/jlawyer.ts`, `packages/server/src/convert.ts`,
> `packages/server/src/auth.ts` (`createFileTickets`), `packages/server/src/app.ts`,
> `packages/server/src/diagnosepaket.ts` + `diagnosepaket.test.ts`, `packages/mcp/src/anymize.ts`,
> `packages/mcp/src/anonymizer.ts`, `packages/mcp/src/mapping.ts`, `packages/mcp/src/config.ts`,
> `packages/server/src/transkription.ts` + `transkription.test.ts`, `src/lib/diktat.ts` +
> `diktat.test.ts` (strukturelle Gegenprobe gegen einen wiedereinziehenden Browser-
> Spracherkennungs-Pfad), `.planning/phases/13-bedienreife-erfassung/13-SECURITY.md` (R-13-02,
> abgelöst durch 14-09).

> **Rechtlicher Hinweis — bitte zuerst lesen:** Dieses Dokument **strukturiert technische
> Fakten** über vier Anbindungen, bei denen Mandatsdaten die eigene Infrastruktur verlassen
> können. Es ist **keine anwaltliche Bewertung**. Die Einordnung nach § 43a BRAO
> (Verschwiegenheitspflicht) und § 43e BRAO (Voraussetzungen der Dienstleister-Beauftragung —
> Vertrag in Textform, Verschwiegenheitsbindung mit Strafandrohungshinweis, Beschränkung der
> Kenntnisnahme auf das Erforderliche) **muss vor produktivem Einsatz bei einer externen Kanzlei
> von einer Juristin/einem Anwalt bestätigt werden.** Die Grundlage dieses Dokuments ist eine
> Recherche ohne anwaltliche Prüfung (`14-RESEARCH.md`, Annahme A3, ausdrücklich als **hohes
> Risiko** markiert) — der zugehörige Prüfpunkt ist blockierend geführt (siehe Task 2 des Plans
> 14-08 bzw. Punkt „Juristische Bestätigung" in `14-UAT.md`) und gilt erst nach ausdrücklicher
> Freigabe durch die Nutzerin als erledigt, unabhängig davon, wie vollständig dieses Dokument ist.

## 1. Wohin Daten J-DESK verlassen

Vier externe Anbindungen lassen Mandatsdaten die eigene J-DESK-Instanz verlassen (die Tabelle
führt Anymize wegen der unterschiedlichen Inhaltsart — Text vs. Audio — in zwei Zeilen; es ist
derselbe Dienstleister und derselbe Vertragsprüfpunkt). Eine fünfte, ehemals datenabführende
Anbindung ist seit Phase 14 (Plan 14-09) geschlossen und nur der Vollständigkeit halber
mitgeführt. Je Zeile stehen drei getrennte Spalten: welche Daten fließen, was J-DESK
**technisch** zusichert (mit Codefundstelle), und welcher Prüfpunkt **vertraglich** beim
Betreiber/der Kanzlei liegt. Diese beiden letzten Spalten werden bewusst nie vermischt — eine
technische Zusicherung ersetzt keinen Vertrag, und ein Vertrag ersetzt keine technische Maßnahme.

| Anbindung | Welche Daten fließen | Technische Zusicherung (Code, in dieser Session nachgeprüft) | Vertraglicher Prüfpunkt (§ 43e BRAO) |
|---|---|---|---|
| **j-lawyer** (REST) | Dokument-Metadaten, synthetisierte PDFs, Sitzungs-Zugangsdaten (Benutzername/Passwort im Basic-Auth-Fluss) | Die Sitzungs-Zugangsdaten leben ausschließlich im Arbeitsspeicher des Serverprozesses (`jlCreds`-Map, `packages/server/src/app.ts:444`) — Kommentar im Code: „Basic-Credentials der Sitzungen leben ausschließlich im RAM (nie persistiert; nach Server-Neustart melden sich alle neu an)". Sie werden nie in die Datenbank geschrieben und beim Logout aktiv gelöscht (`app.ts:608`, `:666`). Transportverschlüsselung (TLS) ist Konfigurationssache der `JLAWYER_URL` — siehe Abschnitt 6. | Siehe Abschnitt 2 — hängt davon ab, ob j-lawyer selbst betrieben oder bei einem fremden Anbieter (SaaS) läuft. |
| **Euro-Office-DocumentServer** (Vorschau-Konvertierung) | Dateiinhalt der zu konvertierenden Dokumente (Office-Formate → PDF-Vorschau) | Der DocumentServer erhält die Quelldatei ausschließlich über ein JWT-signiertes Einmal-Ticket (`packages/server/src/convert.ts:92`, `signJwtHS256(...)` mit `config.jwtSecret`) — der eigentliche Datei-Abruf läuft über `createFileTickets()` (`packages/server/src/auth.ts:161`): ein zufälliges 32-Byte-Ticket, gültig **60 Sekunden**, und beim ersten Abruf sofort verbraucht (`consume()`, Kommentar im Code: „Einmal-Nutzung"). Ein abgefangenes Ticket ist außerhalb dieses engen Zeitfensters wertlos. | Siehe Abschnitt 2 — abhängig davon, ob der DocumentServer selbst betrieben oder bei einem fremden Betreiber läuft. |
| **Anymize** (Anonymisierung, über die MCP-Anbindung) | Mandatsinhalte im Klartext: Namen zur Anonymisierung (`anonNames()`, `packages/mcp/src/anonymizer.ts:14`) und vollständige Dokumentinhalte/PDF-Text (`anonFileText()`/`anonText()`, `anonymizer.ts:33`/`:48`) — beides wird über `AnymizeClient` per HTTPS an `ANYMIZE_API_URL` (Standard `https://app.anymize.ai`, `packages/mcp/src/config.ts:18`) mit `ANYMIZE_API_KEY` im Bearer-Header übertragen (`packages/mcp/src/anymize.ts:33-35`). | Anymize ist ein **externer SaaS-Dienstleister** — anders als bei j-lawyer/Euro-Office gibt es hier keine „selbst betrieben"-Alternative, die den Vertragsprüfpunkt entfallen ließe. Die Zuordnung Klartext↔Platzhalter (`MappingStore`, `packages/mcp/src/mapping.ts:6`) bleibt ausschließlich **prozessintern im Arbeitsspeicher des MCP-Servers** (kein Datei-/DB-Schreibvorgang im gelesenen Code) und geht bei einem Neustart verloren — das ist eine technische Beobachtung, keine Aussage darüber, was Anymize selbst mit den empfangenen Inhalten serverseitig tut. |
| **Anymize-Transkription** (Diktat: Audioaufnahme diktierter Mandatsinhalte) | Die Audioaufnahme selbst, danach der zurückkommende Transkripttext | Die Aufnahme geht ausschließlich an eine eigene, authentifizierte J-DESK-Server-Route, die als Vermittler zu Anymize auftritt (`packages/server/src/transkription.ts`) — der Anymize-Schlüssel wird ausschließlich im Serverprozess gelesen (`main.ts`) und erreicht den Browser nie; die Anymize-Job-Kennung verlässt den Server nicht, das Warten auf das Ergebnis läuft vollständig serverintern innerhalb derselben Anfrage; die Aufnahme wird nirgends abgelegt (kein Dateisystem-, Datenbank- oder Zwischenspeicherpfad, Quellenassertion in `transkription.test.ts`); eine Größenkappe (25 MiB) greift vor jedem Außenaufruf. | Derselbe wie in Abschnitt 3 (Anymize) — es ist derselbe Dienstleister, siehe dort. |
| **Cloud-Spracherkennung des Browsers** (vormals Web Speech API, Chrome — bis Phase 13) | Keine — der Weg existiert nicht mehr | Der Pfad zur herstellerseitigen Spracherkennung ist strukturell entfernt, nicht nur abgeschaltet: er ist nicht mehr vorhanden, und eine Gegenprobe über `src/` und `packages/` (`diktat.test.ts`) hält das fest — sie wird rot, sobald der Pfad wieder einzieht. | Entfällt — es gibt keinen Datenfluss mehr, den es zu prüfen gäbe. |

*Anmerkung zur Anymize-Zeile: `14-RESEARCH.md` hatte diesen Punkt ausdrücklich **nicht** am Code
verifiziert (Recherche stützte sich nur auf die Umgebungsvariablen-Konfiguration). Die obige
Zeile wurde für diesen Plan direkt gegen `packages/mcp/src/anymize.ts`, `anonymizer.ts`,
`mapping.ts` und `config.ts` nachgeprüft. Eine Abweichung zur Recherche ergab sich dabei nicht
inhaltlich, sondern nur im Detailgrad: die Recherche wusste noch nicht, dass sowohl **Namen** als
auch **vollständige Dokumenttexte/PDF-Inhalte** über denselben Client laufen, und dass die
Klartext-Zuordnung rein im Arbeitsspeicher bleibt (siehe SUMMARY dieses Plans).*

## 2. Vertragsprüfpunkt: j-lawyer und Euro-Office-DocumentServer

Für j-lawyer und den Euro-Office-DocumentServer gilt derselbe Prüfpunkt, weil beide je nach
Betriebsform unterschiedlich einzuordnen sind:

**Prüffrage an die Kanzlei:** Läuft die jeweilige Instanz auf **eigener, selbst betriebener**
Infrastruktur der Kanzlei (oder eines mit der Kanzlei rechtlich identischen Betreibers), oder wird
sie als **Software-as-a-Service bei einem fremden Anbieter** bezogen?

- Bei **selbst betriebener** Infrastruktur ist regelmäßig kein zusätzlicher, externer
  Dienstleister im Sinne § 43e BRAO beteiligt — die Daten verlassen dann keinen fremden
  Verantwortungsbereich.
- Bei einem **fremden Betreiber** (SaaS-j-lawyer, gehosteter DocumentServer) ist zu prüfen, ob
  ein Vertrag in Textform vorliegt, der (a) den Anbieter zur Verschwiegenheit verpflichtet — mit
  Hinweis auf die strafbewehrte Verschwiegenheitspflicht nach § 203 StGB, soweit einschlägig —
  und (b) die Kenntnisnahme des Anbieters auf das für die Leistungserbringung Erforderliche
  beschränkt.

Diese Einordnung ist eine Kanzleientscheidung auf Basis der tatsächlichen Betriebsform, keine
technische Feststellung dieses Dokuments.

## 3. Vertragsprüfpunkt: Anymize

**Prüffrage an die Kanzlei:** Liegt mit Anymize ein Vertrag in Textform vor, der die
Verschwiegenheitsbindung und die Beschränkung der Kenntnisnahme auf das Erforderliche regelt?
Anders als bei j-lawyer/Euro-Office entfällt hier die Alternative „selbst betrieben" — Anymize
ist in jedem Fall ein externer SaaS-Dienstleister, sobald die MCP-Anbindung mit einem gültigen
`ANYMIZE_API_KEY` aktiv ist. Der Vertragsprüfpunkt ist hier also nicht bedingt, sondern
grundsätzlich zu klären, sobald die Anbindung genutzt wird.

**Erweiterung durch Plan 14-09 — Audioaufnahmen zählen jetzt ausdrücklich dazu.** Anymize
empfängt seit 14-09 zusätzlich zu Namen und Dokumenttexten auch die Audioaufnahmen diktierter
Mandatsinhalte für die Transkription (`packages/server/src/transkription.ts`, Abschnitt 1 dieser
Tabelle). Der
Prüfpunkt selbst bleibt derselbe — es ist derselbe Vertragspartner —, aber seine **Tragweite
wächst**: eine Freigabe, die nur Text im Blick hatte, deckt Audio nicht automatisch mit ab; das
gehört ausdrücklich benannt, nicht stillschweigend unter „Inhalte" subsumiert. Zusätzlich zur
Vertragsfrage aus Abschnitt 3: was Anymize mit einer empfangenen Aufnahme tut — insbesondere ob
und wie lange sie dort gespeichert bleibt —, ist eine **Vertrags- und Kontoeinstellungsfrage**
(Stichwort Zero Data Retention, das im Bestandscode bereits für die Textanonymisierung eine
Rolle spielt, `AnymizeError`-Art `'zdr'` in `packages/mcp/src/anymize.ts`), keine technische
Feststellung dieses Dokuments — J-DESK kann nur zusichern, was auf dem eigenen Weg zu Anymize
passiert (siehe Abschnitt 1), nicht was danach dort geschieht.

## 4. Was sich gegenüber dem Vorzustand geändert hat (Diktat)

Bis Phase 13 lief die Spracheingabe über die Spracherkennung des Browsers (Web Speech API). Bei
bestimmten Browsern (insbesondere Chrome) bedeutete das: die aufgenommene Audiospur ging an ein
serverseitiges Erkennungs-Backend des Browser-Anbieters — diktierte Mandatsinhalte verließen in
diesem Fall das Gerät der Anwenderin, bevor sie als Text in J-DESK ankamen. Dieser Zustand wurde
in Phase 13 bewusst als **browserabhängige Grenze akzeptiert** (`13-SECURITY.md`, R-13-02:
„accept+transfer") — es gab dafür keinen benennbaren Vertragspartner und keinen § 43e-Prüfpunkt,
nur eine geräteinterne Verarbeitungs-Präferenz, der ohne belastbare Zusicherung zu trauen war.

**Mit Plan 14-09 ist dieser Weg geschlossen** — nicht abgeschaltet, sondern strukturell entfernt
und durch eine Gegenprobe gegen Wiedereinzug gesichert (Abschnitt 1). An seine Stelle tritt die
Transkription über Anymize (Abschnitt 1, Zeile „Anymize-Transkription"). Damit gibt es für diesen
Datenfluss **erstmals einen benennbaren Vertragspartner und einen § 43e-Prüfpunkt** — genau den
aus Abschnitt 3, jetzt ausdrücklich um Audio erweitert.

**Was sich dabei NICHT verbessert hat:** Audio verlässt die Instanz weiterhin — nur an eine
andere Stelle (Anymize statt eines Browser-Herstellers) und unter einem prüfbaren Vertrag statt
einer bloß akzeptierten Grenze. Wer Diktat für Mandatsinhalte grundsätzlich vermeiden will, kann
weiterhin Text eintippen; anders als zuvor gibt es dafür jetzt aber einen Prüfpunkt statt nur
einer Geräte-/Browserwahl (siehe Abnahmepunkte in `14-UAT.md`).

## 5. Diagnosepaket: was zugesichert wird

Das Diagnosepaket (`GET /api/v1/desks/:id/diagnosepaket`, Eigentümer-Gate, aufgebaut in
`packages/server/src/diagnosepaket.ts`) ist ein Support-Bundle für Fehlerdiagnosen. Es enthält
**ausschließlich**: Versions- und Laufzeitangaben (App-Version, Schemaversion, Node-Version,
Plattform/Architektur, Laufzeit in Sekunden), den Betriebsmodus (eigenständig/j-lawyer),
Verbindungszustände als reine Statuswerte ohne die konfigurierte Adresse, Speicher-/
Sicherungskennzahlen (Bytes, Anzahl, Zeitpunkt) und reine Zählwerte über die Betriebstabellen
(Anzahl Schreibtische/Dateien/Journalzeilen/Nutzer — `COUNT(*)`, keine Namen). Es enthält
**ausdrücklich nicht**: Mandantsnamen, Dateinamen oder -inhalte, Zugangsdaten oder ein
gemeinsames Geheimnis (z. B. das `EUROOFFICE_JWT_SECRET`), und keine Protokolldateien.

Diese Zusicherung beruht nicht auf einer bloßen Beschreibung des Codes, sondern auf einer
Gegenprobe, die bei jedem Testlauf mitläuft: `packages/server/src/diagnosepaket.test.ts`,
Abschnitt „Geheimnis-Gegenprobe", schleust ein Convert-JWT-Secret, eine Konvertierungs-Adresse,
Dateiname und -inhalt sowie Nutzername/Passwort-Hash gezielt in eine Testinstanz ein und prüft,
dass **keiner** dieser Werte im erzeugten Paket als Zeichenkette vorkommt. Formuliert wird hier
ausschließlich, was dieser Test tatsächlich absichert — keine weitergehende Zusage.

## 6. Grenzen und Betriebsverantwortung

Im Ton der bestehenden Betriebsdokumentation (`docs/deployment/backup-strategy.md` Abschnitt 8):
J-DESK sichert die oben beschriebenen technischen Maßnahmen zu, aber nicht alles, was für einen
sicheren Betrieb nötig ist. Folgendes liegt **nicht** in J-DESKs Hand:

- **Transportverschlüsselung der konfigurierten Adressen.** Ob `JLAWYER_URL`, `EUROOFFICE_URL`
  und `ANYMIZE_API_URL` tatsächlich `https://` verwenden und mit einem gültigen Zertifikat
  erreichbar sind, ist eine Konfigurationsentscheidung des Betreibers — J-DESK erzwingt kein
  Protokoll auf diesen frei konfigurierbaren Adressen.
- **Zugriffsschutz auf Datenverzeichnis und Sicherungen.** `DATA_DIR` (Datenbank, Dateien,
  Backups) enthält den unprojizierten, vollständigen Datenbestand — Dateisystem- und
  Deployment-Berechtigungen (z. B. Docker-Volume-Zugriff) sind Betreiberverantwortung
  (`backup-strategy.md` Abschnitt 8).
- **Aufbewahrungsfristen.** Wie lange Backups, Diagnosepakete oder exportierte `.jdesk`-Pakete
  aufbewahrt werden, entscheidet der Betreiber; J-DESK selbst rotiert nur die instanzweite
  `backup/`-Sicherung nach einer festen Anzahl Stände (siehe `backup-strategy.md` Abschnitt 4).
- **Verträge mit den Dienstleistern.** Ob mit j-lawyer (falls SaaS), dem
  Euro-Office-DocumentServer-Betreiber (falls fremd) und Anymize die in den Abschnitten 2–3
  beschriebenen § 43e-Vertragspflichten erfüllt sind, ist ausschließlich Sache der Kanzlei bzw.
  des Betreibers — J-DESK kann diese vertragliche Ebene nicht technisch herstellen.
- **Mikrofonrecht und Opt-in-Entscheidung des Betreibers.** Das Mikrofonrecht im Browser erteilt
  die einzelne Anwenderin selbst (kein Automatismus). Ob die Kanzlei die Anymize-Transkription
  überhaupt einrichtet, ist ein bewusstes Opt-in des Betreibers: ohne konfigurierten
  `ANYMIZE_API_KEY` erscheint der Diktat-Einstieg an keiner der drei Karten gar nicht erst
  (kein Knopf, der ins Leere führt, kein stiller Ausweichpfad zu einer fremden
  Spracherkennung) — die Anbindung ist damit nie eine unbemerkte Voreinstellung.
