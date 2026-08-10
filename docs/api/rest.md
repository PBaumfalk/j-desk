# REST-Referenz

> Stand: Commit `4c47b3b` — bei API-Änderungen mitpflegen.

Quelle für alle Angaben dieser Seite: `packages/server/src/app.ts` (vollständig gelesen,
beide Modus-Zweige), ergänzt um `packages/server/src/auth.ts`, `deskStore.ts`, `files.ts`,
`convert.ts`, `jlawyer.ts` und `journal.ts` für Fehlerbilder und Antwortformen, sowie
`packages/core/src/stempel.ts` und `konflikt.ts` für die Konflikterkennung.

**Konventionen:** Basis `http://localhost:4810`, alle Pfade relativ zu `/api/v1`. Beispiel-
Werte: Token `<TOKEN>`, Desk-Id `<DESK_ID>`, Datei-Id `<FILE_ID>`. Bearer-Token immer im
`authorization`-Header (`Bearer <TOKEN>`), nie als Query-Parameter — Ausnahmen sind explizit
als „Einmal-Ticket" markiert.

**Fehlerformat:** Fehlerantworten sind durchgängig `{ "error": string }` mit deutschem
Klartext. Wo der Server zusätzliche Maschinenlesbarkeit braucht (Vorschau-Fehler,
`CommandError`), stehen weitere Felder dabei — bei der jeweiligen Route vermerkt.

**j-lawyer-Fehler:** Alle Routen, die intern j-lawyer aufrufen, können `JLawyerError` werfen
(`packages/server/src/jlawyer.ts`) und geben dessen `status`/`message` unverändert weiter —
außer `GET /cases` und `GET /cases/:id/desk`, die beide abweichen (siehe dort). Welche Fehlerklasse (`JLawyerError.art`)
vorliegt, entscheidet auch über die Session-Wirkung (`jlFehler` in `app.ts`): Nur eine
**echte** abgelaufene/ungültige Sitzung — `401` „j-lawyer-Anmeldung abgelaufen" (`art: 'auth'`)
— löscht serverseitig die Sitzung und erzwingt eine Neuanmeldung. `403` „j-lawyer verweigert
den Zugriff" (`art: 'verboten'`) tut das **nicht**: Die Sitzung bleibt gültig, nur die
jeweilige Aktion ist untersagt. Sonstige Fehler kommen als `502` zurück: „j-lawyer ist nicht
erreichbar" (Netzfehler/Timeout, `art: 'nichtErreichbar'`), „j-lawyer kennt diese Ressource
nicht" (j-lawyer antwortete mit 404, `art: 'fehlt'`) oder „j-lawyer antwortet mit HTTP …"
(sonstiger Fehlerstatus, `art: 'server'`). Das ist bei jeder betroffenen Route unter „Fehler"
vermerkt, statt es dort jedes Mal vollständig auszubuchstabieren.

---

## Auth & Setup

### GET /api/v1/auth/status

Liefert Betriebsmodus und Ersteinrichtungsstatus. Öffentlich, damit der Login-Screen weiß,
was er anzeigen soll, bevor überhaupt ein Token existiert.

| | |
|---|---|
| Auth | keine |
| Modus | beide |

**Response 200**
```json
{ "needsSetup": true, "mode": "standalone", "needsModeChoice": true }
```

`mode` ist `"jlawyer"`, sobald eine j-lawyer-URL konfiguriert ist (Env oder Setup), sonst
`"standalone"`. `needsSetup` ist im jlawyer-Modus immer `false` (es gibt kein lokales Konto
anzulegen). `needsModeChoice` ist nur `true`, wenn weder ein lokales Konto existiert noch
jemals eine j-lawyer-URL gespeichert wurde — dann zeigt der Login-Screen die Moduswahl.

**Fehler:** keine.

### POST /api/v1/auth/setup

Legt im Standalone-Modus das erste (und einzige) lokale Benutzerkonto an und meldet es
gleich an.

| | |
|---|---|
| Auth | keine |
| Modus | nur standalone (`403` im jlawyer-Modus) |

**Request**
```json
{ "username": "anna", "password": "geheim-123" }
```

**Response 200**
```json
{ "token": "<TOKEN>" }
```

**Fehler:** `403` Anmeldung erfolgt mit dem j-lawyer-Konto (jlawyer-Modus) · `403` es
existiert bereits ein Konto · `400` Benutzername darf nicht leer sein · `400` Passwort muss
mindestens 8 Zeichen haben.

### POST /api/v1/auth/login

Meldet einen Nutzer an und liefert das Sitzungs-Token.

| | |
|---|---|
| Auth | keine |
| Modus | beide (im jlawyer-Modus Prüfung gegen j-lawyer statt gegen die lokale Datenbank) |

**Request**
```json
{ "username": "anna", "password": "geheim-123" }
```

**Response 200**
```json
{ "token": "<TOKEN>" }
```

**Fehler:** `401` Benutzername oder Passwort falsch · j-lawyer-Fehler (siehe oben, praktisch
`502` j-lawyer nicht erreichbar).

### POST /api/v1/auth/logout

Beendet die aktuelle Sitzung (löscht das Token serverseitig).

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Response 200**
```json
{ "ok": true }
```

**Fehler:** keine (auch mit bereits ungültigem Token — der Auth-Hook weist das aber schon vorher mit `401` ab).

### POST /api/v1/setup/jlawyer-test

Testet eine j-lawyer-URL auf Erreichbarkeit, **ohne** sie zu speichern (kleinster lesender
Abruf gegen die Aktenliste).

| | |
|---|---|
| Auth | keine |
| Modus | nur solange der Betriebsmodus noch nicht konfiguriert ist |

**Request**
```json
{ "url": "http://kanzlei-server:8080/j-lawyer-io" }
```

**Response 200**
```json
{ "ok": true, "message": "j-lawyer erreichbar" }
```

**Fehler:** `403` der Betriebsmodus ist bereits konfiguriert · `400` URL fehlt. Nicht-
Erreichbarkeit ist **kein** HTTP-Fehler — sie kommt als `{ "ok": false, "message": "…" }` mit
Status 200 zurück (die Route liefert `probeJLawyer(url)` unverändert durch).

### POST /api/v1/setup/jlawyer

Speichert die j-lawyer-URL als Betriebsmodus und stößt intern einen Server-Neuaufbau an
(Routen sind modusabhängig registriert — danach existieren z. B. die `/cases`-Routen).

| | |
|---|---|
| Auth | keine |
| Modus | nur solange der Betriebsmodus noch nicht konfiguriert ist |

**Request**
```json
{ "url": "http://kanzlei-server:8080/j-lawyer-io" }
```

**Response 200**
```json
{ "ok": true }
```

**Fehler:** `403` der Betriebsmodus ist bereits konfiguriert · `400` URL fehlt · `400` Probe-
Nachricht, wenn j-lawyer unter der URL nicht erreichbar ist.

---

## Schreibtische & Zustand

### GET /api/v1/desks

Listet alle Schreibtische (unabhängig vom Eigentümer — es gibt keine Zugriffsbeschränkung
pro Nutzer).

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Response 200**
```json
[{ "id": "<DESK_ID>", "name": "Mandat Müller", "ownerId": "u1" }]
```

**Fehler:** keine.

### POST /api/v1/desks

Legt einen neuen, leeren Schreibtisch an.

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Request**
```json
{ "name": "Mandat Müller" }
```

**Response 201**
```json
{ "id": "<DESK_ID>", "name": "Mandat Müller", "ownerId": "u1" }
```

**Fehler:** `400` Feld "name" fehlt oder ist leer.

### PATCH /api/v1/desks/:id

Benennt einen Schreibtisch um.

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Request**
```json
{ "name": "Mandat Müller — neu" }
```

**Response 200**
```json
{ "ok": true }
```

**Fehler:** `400` Feld "name" fehlt oder ist leer · `404` Schreibtisch nicht gefunden.

### DELETE /api/v1/desks/:id

Löscht einen Schreibtisch endgültig.

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Response 200**
```json
{ "ok": true }
```

**Fehler:** `404` Schreibtisch nicht gefunden.

### GET /api/v1/desks/:id/state

Liest den aktuellen Zustand eines Schreibtischs.

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Response 200**
```json
{ "rev": 12, "state": { "docs": [], "stacks": [], "notes": [] } }
```

`state` ist die vollständige `DesktopState`-Struktur (siehe `@j-desk/core`); `rev` zählt bei
jeder Änderung (Command oder direktes `PUT`) um eins hoch.

**Provenienz:** Docs, Links, Stapel, Zettel, Ausschnitte, Striche, Abdeckflächen, Stempel,
Fahnen und Klammern tragen — sofern nach Einführung dieses Felds erzeugt — `createdBy`
(Benutzername-Snapshot zum Erzeugungszeitpunkt) und `createdAt` (ISO-8601-UTC, Serverzeit);
Papierkorb-Einträge (`trash[]`) zusätzlich `trashedBy`. Alle drei Felder sind **optional** —
Bestandsobjekte aus der Zeit vor diesem Feature haben sie nicht. Der Server setzt sie beim
Erzeugen aus der Session (`actorFromRequest` in `app.ts`); ein Client-geliefertes
`createdBy`/`createdAt` im Command-Payload wird dabei ignoriert (Details in
[commands.md](commands.md)).

**Objektversionen:** Dieselben zehn Arten (ohne `trash`, ohne `background`) tragen zusätzlich
optional `updatedRev` (integer), `updatedAt` (ISO-8601-UTC) und `updatedBy`
(Benutzername-Snapshot) — vom Server nach jedem Command zentral gestempelt, sobald sich ein
Objekt inhaltlich geändert hat oder neu entstanden ist. Grundlage der Konflikterkennung beim
Schreiben, siehe [commands.md → Objektversionen](commands.md#objektversionen-updatedrev--updatedat--updatedby)
und [commands.md → `erwartet`](commands.md#konflikterkennung-erwartet).

**Fundstellen-Metadaten:** Ausschnitte (`cutouts[]`) tragen zusätzlich optional
`textSnapshot` (Textvorschau der Fundstelle, vom Client geliefert, serverseitig auf 2000
Zeichen gekappt) und `fileSha256` (Hash der Quelldatei — **vom Server** aus der eigenen
`files`-Tabelle nachgeschlagen und in den Command-Payload eingesetzt, ein client-geliefertes
`fileSha256` wird dabei überschrieben; im jlawyer-Modus immer entfernt, da dort kein Hash zur
Verfügung steht). Abdeckflächen (`marks[]`) tragen optional nur `textSnapshot`. Details und
Kopier-Semantik in [commands.md → Provenienz](commands.md#provenienz-createdby--createdat--trashedby).

**jl-Referenzstatus:** Nur im jlawyer-Modus gesetzt, ausschließlich vom Server-Abgleich
(`GET /cases/:id/desk`) gepflegt — siehe dort für die volle Semantik. Docs tragen dann
zusätzlich optional `sourceGone` (`true`, wenn das Quelldokument in j-lawyer nicht mehr
existiert — die Karte bleibt liegen, Annotationen unangetastet), `sourceChangeDate` (Unix-
Millis, die jl-`changeDate` der Quelle zum Zeitpunkt des letzten Abgleichs) und
`sourceReplacedAt` (ISO-8601-UTC, einmalig beim ersten Erkennen einer geänderten
`changeDate` gesetzt und danach stabil, bis erneut eine andere `changeDate` auftaucht). Alle
drei Felder fehlen im Standalone-Modus vollständig.

**Fehler:** `404` Schreibtisch nicht gefunden.

### PUT /api/v1/desks/:id/state

Ersetzt den gesamten Zustand eines Schreibtischs (z. B. nach clientseitigem Undo über
mehrere Schritte). Broadcastet das Ergebnis an alle verbundenen WebSocket-Clients desselben
Schreibtischs.

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Request:** die vollständige `DesktopState`-Struktur als Body.

**Response 200**
```json
{ "rev": 13, "state": { "docs": [], "stacks": [], "notes": [] } }
```

**Fehler:** `400` ungültiger Schreibtisch-Zustand (`isValidState` schlägt fehl) · `404`
Schreibtisch nicht gefunden.

---

## Commands

### POST /api/v1/desks/:id/commands

Wendet einen einzelnen Command auf den Schreibtisch-Zustand an — der Weg, auf dem alle
Nutzeraktionen (Karte verschieben, Zettel anlegen, Stapel bilden, …) den Server erreichen.
Alle Command-Typen und ihre Payload-Felder stehen in [commands.md](commands.md).

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Request**
```json
{ "type": "addNote", "payload": { "id": "n1", "position": { "x": 100, "y": 100 }, "text": "Wiedervorlage", "kind": "notiz" } }
```

Optional zusätzlich zum Command ein Feld `erwartet` — Abbildung Objekt-Id → zuletzt gesehene
`updatedRev`, vom Client aus der `payload` abgeleitet. Fehlt es, wird die Vorbedingung
angenommen (alter, nicht neu geladener Client bricht dadurch nicht). Details, Form und
Ableitung in [commands.md → `erwartet`](commands.md#konflikterkennung-erwartet).

**Response 200**
```json
{ "rev": 14, "state": { "docs": [], "stacks": [], "notes": [] } }
```

`rev` erhöht sich um genau eins pro erfolgreichem Command; `state` ist der vollständige neue
Zustand (kein Diff). Dieselbe `{ rev, state }`-Form wird zusätzlich per WebSocket an alle
verbundenen Clients desselben Schreibtischs gebroadcastet (einschließlich des Auslösers, siehe
[websocket.md](websocket.md)).

**Fehler:** `400 { "error": "Unbekannte fileId" }` bei `addDoc` mit einer `fileId`, die nicht
in der eigenen Datei-Ablage existiert (Vorabprüfung vor der eigentlichen Command-Anwendung —
gilt unabhängig vom Betriebsmodus, da `addDoc` immer gegen die lokale `files`-Tabelle prüft) ·
`400 { "error": … }` bei jedem anderen `CommandError` (unbekannter Typ, fehlendes Pflichtfeld,
ungültige Referenz — Details in commands.md) · `404` Schreibtisch nicht gefunden · `409
{ "konflikt": { "objektId": "n1", "typ": "notes", "art": "geaendert", "von": "anna", "am": "2026-07-20T10:00:00.000Z" } }`,
wenn eine mitgeschickte `erwartet`-Vorbedingung nicht (mehr) zutrifft — die Prüfung läuft
innerhalb derselben Transaktion wie die Command-Anwendung, Zustand und Journal bleiben dabei
unberührt. Vollständiges Körperformat und Feldbedeutung in
[commands.md → `erwartet`](commands.md#konflikterkennung-erwartet).

### GET /api/v1/desks/:id/journal

Liefert die Änderungshistorie eines Schreibtischs — ein append-only Protokoll, in das jeder
angenommene Command (über diese Route sowie der interne `addDoc` aus
`POST /api/v1/cases/:id/documents`) mit dem auslösenden Nutzer (Actor) geschrieben wird
(`packages/server/src/journal.ts`, `appendJournal`/`listJournal`).

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Query-Parameter**

| Parameter | Typ | Bedeutung |
|---|---|---|
| `limit` | number | Max. Anzahl Einträge. Default `50`; wird beidseitig auf `0`–`200` geklemmt (auch ein negativer Wert liefert nicht "alle", sondern `0` Einträge). Leer (`?limit=`) oder nicht gesetzt → Default. |
| `before` | number | Keyset-Pagination: liefert nur Einträge mit `id < before` (für den nächsten, älteren Seitenabruf die kleinste `id` der vorherigen Antwort übergeben). Leer oder nicht gesetzt → ohne Untergrenze, also die neuesten Einträge. |

Ungültige/leere Werte beider Parameter werden **ignoriert** statt als Fehler abgelehnt oder als
`0` gewertet (`Number('')` wäre sonst `0` — ein geleertes Formularfeld darf aber nicht wie eine
gültige `0` wirken, siehe Kommentar in `app.ts`).

**Response 200** (verifiziert gegen einen laufenden Server: `POST /desks`, danach ein
`addNote`-Command, danach dieser Endpunkt)
```json
{
  "entries": [
    {
      "id": 2,
      "rev": 1,
      "type": "addNote",
      "payload": { "id": "n1", "position": { "x": 100, "y": 100 }, "text": "Wiedervorlage", "kind": "notiz" },
      "actorId": "f32b1f61-4354-4f16-a66a-65e6fc79cbc8",
      "actorName": "anna",
      "at": 1784497848471
    },
    {
      "id": 1,
      "rev": 0,
      "type": "deskCreated",
      "payload": { "name": "Mandat Müller" },
      "actorId": "f32b1f61-4354-4f16-a66a-65e6fc79cbc8",
      "actorName": "anna",
      "at": 1784497848441
    }
  ]
}
```

`entries` ist **neueste zuerst** sortiert (absteigend nach `id`). Pro Eintrag:

| Feld | Bedeutung |
|---|---|
| `id` | Fortlaufende, autoinkrementierte Journal-Id — Grundlage für `before`-Pagination. **Kein** Bezug zu einer Objekt-Id auf dem Tisch. |
| `rev` | Schreibtisch-Revision **nach** Anwendung dieses Eintrags (deckungsgleich mit der `rev` im gleichzeitigen WebSocket-Broadcast). |
| `type` | Der Command-Typ (`addNote`, `moveDoc`, `trashObject`, …, siehe [commands.md](commands.md)) — oder einer von vier **synthetischen** Typen: `deskCreated` (Schreibtisch angelegt, `payload: { name }`), `stateReplaced` (`PUT /desks/:id/state`), `caseSync` (j-lawyer-Abgleich über `GET /cases/:id/desk`), `snapshot` (einmaliger Baseline-Eintrag pro Bestands-Desk bei der Migration auf das Journal-Feature). |
| `payload` | Bei Command-Typen der Command-`payload` unverändert; bei `deskCreated` `{ name }`; bei `stateReplaced`/`caseSync`/`snapshot` `{ "state": "…" }` — siehe unten. `null`, wenn der Command keinen Payload hatte (z. B. `emptyTrash`). |
| `actorId` | `users.id` des Auslösers, oder `null` bei Systemereignissen ohne echten Nutzer (Migrations-Snapshot). |
| `actorName` | Benutzername-Snapshot zum Zeitpunkt des Eintrags, oder eine Systemkennung: `"Migration"` bei `snapshot`. Bei `caseSync` der auslösende Nutzer (nicht `"j-lawyer-Abgleich"` — diese Systemkennung steht nur im `createdBy` der beim Abgleich angelegten Karten, siehe [commands.md](commands.md)). |
| `at` | Unix-Millisekunden. |

**State-Kürzung:** Bei den drei state-tragenden Typen `snapshot`, `stateReplaced` und
`caseSync` enthält der volle `payload.state` den kompletten Schreibtisch-Zustand — in der
Journal-Antwort wird dieses Feld durch das Platzhalterzeichen `"…"` ersetzt (schlanke Antwort;
der volle State steht ohnehin über `GET /desks/:id/state` zur Verfügung). Beispiel:
`{ "payload": { "state": "…" } }`.

**Replay-Einschränkung:** Das Journal ist logisch vollständig, aber nicht id-deterministisch
replaybar — bei `extractPage`, `copyObject` und `trashObject` (trashId) vergibt der Server
Ids, die nicht im Journal-Payload stehen. Folge-Commands auf solche Objekte lassen sich daher
nicht rein aus dem Command-Strom rekonstruieren; siehe
[2026-07-19-provenienz-fundament-design.md](../superpowers/specs/2026-07-19-provenienz-fundament-design.md).

**Fehler:** `404` Schreibtisch nicht gefunden.

---

## Dateien

Der Server hat zwei völlig unterschiedliche Implementierungen dieser Routen — der Pfad ist
gleich, das Verhalten hängt vom Betriebsmodus ab (`app.ts` registriert je nach `jlawyerUrl`
einen anderen Handler).

### POST /api/v1/files

Lädt eine Datei in die eigene Ablage hoch (inhaltsadressiert über SHA-256 — identische Bytes
ergeben dieselbe `fileId`, egal unter welchem Dateinamen).

| | |
|---|---|
| Auth | Bearer |
| Modus | nur standalone — im jlawyer-Modus immer `400` |

**Request:** `multipart/form-data` mit der Datei als Teil.

**Response 201**
```json
{ "fileId": "<FILE_ID>", "kind": "pdf" }
```

`kind` ist eine von `pdf` \| `image` \| `convertible` \| `other`, ermittelt per Magic-Bytes
(Fallback Dateiendung).

**Fehler:** `400` keine Datei im Request · `400` Datei ist leer · **im jlawyer-Modus immer**
`400 { "error": "Uploads erfolgen in die Akte (POST /api/v1/cases/:id/documents)" }` · `413`
Datei ist größer als 100 MB (Fastify-Standard-Fehlerbody von `@fastify/multipart`, NICHT das
`{ "error": … }`-Format der übrigen Routen).

### GET /api/v1/files/:id

Liefert den Dateiinhalt.

| | |
|---|---|
| Auth | Bearer |
| Modus | beide, mit unterschiedlicher Quelle |

**Standalone:** `:id` ist die eigene Datei-Id, Inhalt kommt aus der lokalen Ablage.
**jlawyer:** `:id` ist die j-lawyer-Dokument-Id; der Server ruft die Metadaten mit den
Sitzungs-Credentials ab (das ist zugleich die Berechtigungsprüfung) und lädt den Inhalt bei
Bedarf von j-lawyer nach, gecacht auf Platte unter Dokument-Id + Änderungsdatum.

**Response 200:** Binärdaten, `content-type: application/pdf` (dieser Header wird in beiden
Modi immer gesetzt, unabhängig vom tatsächlichen Dateiformat).

**Fehler:** `404` Datei nicht gefunden (standalone) · j-lawyer-Fehler (siehe oben; u. a.
`401` „Bitte neu anmelden", wenn im jlawyer-Modus keine Sitzungs-Credentials mehr im RAM
liegen, z. B. nach einem Server-Neustart).

### GET /api/v1/files/:id/preview

Liefert eine PDF-Vorschau. Für PDFs ist das der Originalinhalt; für konvertierbare Formate
(Office-Dokumente etc.) wird asynchron über den Euro-Office-DocumentServer konvertiert.

| | |
|---|---|
| Auth | Bearer |
| Modus | beide, mit unterschiedlicher Quelle (wie bei `GET /files/:id`) |

**Response 200:** Binärdaten, `content-type: application/pdf` — `kind === 'pdf'` oder eine
bereits gecachte Konvertierung.

**Response 202**
```json
{ "status": "converting" }
```
`kind === 'convertible'` ohne Cache-Treffer: die Konvertierung wird im Hintergrund angestoßen,
der Client soll erneut pollen.

**Fehler:** `404 { "error": "Keine Vorschau für diese Datei-Art" }` bei `kind === 'image'`
oder `'other'` · `404 { "error": "Datei nicht gefunden" }` (nur standalone, unbekannte
`fileId`) · `409 { "error": "Vorschau-Dienst nicht konfiguriert", "reason": "disabled" }`,
wenn kein Euro-Office-Konverter konfiguriert ist · `409 { "error": …, "reason": "unavailable"
| "failed" }`, wenn der **vorherige** Konvertierungsversuch fehlgeschlagen ist (der Fehler
wird einmalig ausgeliefert und danach zurückgesetzt — der nächste Aufruf startet einen neuen
Versuch) · j-lawyer-Fehler im jlawyer-Modus.

### GET /api/v1/files/:id/meta

Liefert Fundstellen-Metadaten einer Datei — Grundlage für „Sprung zur Quelle" (Anzeige von
Dateiname/Art am Ausschnitt, Hash-Gegenprobe im Standalone-Modus).

| | |
|---|---|
| Auth | Bearer |
| Modus | beide, mit unterschiedlicher Quelle (wie bei `GET /files/:id`) |

**Standalone:** `:id` ist die eigene Datei-Id, Antwort aus der lokalen `files`-Tabelle.

**Response 200** (verifiziert gegen einen laufenden Server: Upload einer PDF-Datei, danach
dieser Endpunkt)
```json
{ "id": "bfcf9636-12e3-461c-b16c-d90bf1fa0ac8", "name": "Klageschrift.pdf", "kind": "pdf", "sha256": "2b39d3bb06e41a34cc4023a2fb80f16623fbe7653f70ddef4d2e59554ba9cf91" }
```

**jlawyer:** `:id` ist die j-lawyer-Dokument-Id; der Server ruft die Metadaten mit den
Sitzungs-Credentials ab (`getDocumentMeta`, zugleich Berechtigungsprüfung), `kind` wird —
anders als beim Standalone-Upload — allein anhand der Dateiendung klassifiziert
(`classifyName`, keine Magic-Bytes verfügbar), und `sha256` ist **immer `null`** (j-lawyer
liefert keinen Hash).

**Fehler:** `404 { "error": "Datei nicht gefunden" }` (nur standalone, unbekannte `fileId`) ·
j-lawyer-Fehler (siehe oben, u. a. `401 { "error": "Bitte neu anmelden" }`).

---

## j-lawyer-Modus

Diese drei Routen existieren **nur**, wenn der Server im `jlawyer`-Modus läuft — im
Standalone-Modus sind sie gar nicht registriert (`404` vom SPA-Fallback bzw. Standard-404).
Alle drei benötigen zusätzlich zum Bearer-Token Sitzungs-Credentials (Benutzername/Passwort
der j-lawyer-Anmeldung), die ausschließlich im RAM des Servers liegen und einen Server-
Neustart nicht überleben.

### GET /api/v1/cases

Listet die für den angemeldeten Nutzer sichtbaren j-lawyer-Akten.

| | |
|---|---|
| Auth | Bearer + Sitzungs-Credentials |
| Modus | nur jlawyer |

**Response 200**
```json
[{ "id": "c1", "fileNumber": "2026/123", "name": "Müller ./. Schmidt", "reason": "Kaufvertrag" }]
```

**Fehler-Fallback statt 502 (kein Login-Screen bei totem j-lawyer):** Scheitert der Abruf mit
`JLawyerError.art` **`nichtErreichbar`, `fehlt` oder `server`**, liefert diese Route trotzdem
`200` — mit den aus der `desks`-Tabelle bekannten (bereits einmal geöffneten) Akten, statt
eines Fehlers. Antwortform bleibt unverändert ein Array; pro bekanntem Desk:
```json
[{ "id": "akte-1", "name": "akte-1", "fileNumber": "", "reason": "" }]
```
`name` ist im Fallback die Akten-ID selbst (`desks.name` — im j-lawyer-Modus identisch mit der
Case-ID, siehe [`ensureDesk`](#get-apiv1casesiddesk)), **nicht** der echte Rubrum-Name; beim
nächsten erfolgreichen Abgleich ist er wieder korrekt. Ohne diesen Fallback würde ein Reload
bei nicht erreichbarem j-lawyer `store.start()` scheitern lassen und den Nutzer auf den
Login-Bildschirm werfen, obwohl seine Sitzung gültig ist — `GET /cases/:id/desk` liefert in
diesem Fall dann den bekannten `syncFehler`-Banner dazu (siehe dort).

**Fail-closed — nur selbst geöffnete Akten:** Die Liste enthält NICHT alle Desks des Servers,
sondern nur jene mit `desks.owner_id === req.userId` (gesetzt beim ersten Öffnen über
`ensureDesk`). Grund: Im j-lawyer-Modus liegt die gesamte Zugriffskontrolle bei j-lawyer — ist
j-lawyer nicht erreichbar, können wir Berechtigungen nicht prüfen und dürfen deshalb keine
fremden Akten (die z. B. nur eine Kollegin geöffnet hat) auflisten. Nebeneffekt: Im
Ausfallbetrieb sieht jeder Nutzer nur die Akten, die er selbst schon einmal geöffnet hat —
bewusst konservativ, echte objektbezogene Berechtigungen kommen mit Welle 4.

**Fehler:** `401 { "error": "Bitte neu anmelden" }`, wenn keine Sitzungs-Credentials mehr im
RAM liegen (löscht dabei die Sitzung) · `403 { "error": "j-lawyer verweigert den Zugriff" }`
ohne Fallback (`art: 'verboten'` — kein Klardaten-Leak bei entzogener Berechtigung) · sonstige
j-lawyer-Fehler siehe oben.

### GET /api/v1/cases/:id/desk

Öffnet (und legt bei Bedarf an) den Schreibtisch zu einer Akte und gleicht ihn mit dem
aktuellen Aktenstand ab, **bevor** er zurückgegeben wird.

| | |
|---|---|
| Auth | Bearer + Sitzungs-Credentials |
| Modus | nur jlawyer |

**Abgleich-Semantik (j-lawyer ist führend, aber Karten sind zäh):** Dokumente, die in
j-lawyer nicht mehr existieren, verlieren **nicht** mehr ihre Karte — sie verwaist nur
(`sourceGone: true` auf dem Doc, siehe [Doc-Felder oben](#get-apiv1desksidstate)),
Annotationen (Striche, Stempel, Fahnen, Notizzettel, Verknüpfungen, …) bleiben unangetastet.
Taucht dieselbe j-lawyer-Dokument-Id später wieder auf, verschwindet `sourceGone` wieder. Der
Kartenname folgt bei jedem Abgleich dem aktuellen jl-Namen (Umbenennung in j-lawyer schlägt
durch). Jede Karte trägt außerdem `sourceChangeDate` (jl-`changeDate`, Versionssignal);
ändert sich dieser Wert gegenüber dem zuletzt gesehenen (neue Fassung desselben Dokuments in
j-lawyer hochgeladen), setzt der Server einmalig `sourceReplacedAt` auf den aktuellen
Zeitpunkt — der Wert bleibt danach stehen, auch über weitere unveränderte Abgleiche hinweg,
bis erneut eine andere `changeDate` auftaucht. Neue Dokumente in j-lawyer bekommen automatisch
eine Karte im „Eingang" (links oben, gestaffelt), klassifiziert anhand der Dateiendung
(Magic-Bytes stehen beim Abgleich nicht zur Verfügung) — Karten im Papierkorb gelten dabei als
„noch vorhanden" (sonst käme die Karte beim nächsten Abgleich zurück). Ändert sich etwas, wird
das Ergebnis zusätzlich per WebSocket an verbundene Clients gebroadcastet.

**Fehler-Fallback statt 502 (`syncFehler`):** Scheitert der Abgleich mit j-lawyer mit
`JLawyerError.art` **`nichtErreichbar`, `fehlt` oder `server`**, liefert diese Route trotzdem
`200` mit dem **letzten bekannten Datenbankstand** statt eines Fehlers, ergänzt um das Feld
`syncFehler: string` (`syncFehlerMeldung` in `app.ts`):

| `JLawyerError.art` | `syncFehler`-Text |
|---|---|
| `nichtErreichbar` (Netzfehler/Timeout) | `j-lawyer ist derzeit nicht erreichbar — Stand vom letzten Abgleich.` |
| `fehlt` / `server` (404 bzw. sonstiger Fehlerstatus von j-lawyer) | `j-lawyer meldet einen Fehler — Stand vom letzten Abgleich.` |

War die Akte noch nie geöffnet, gibt es in diesem Fallback **keinen** `ensureDesk`-Aufruf mehr
(sonst entstünde für jede angefragte — auch falsche — Case-ID eine leere Geister-Desk-Zeile in
der DB): Existiert noch kein Schreibtisch, liefert die Route `200` mit `rev: 0` und leerem
`state` **ohne** Persistenz; der echte Schreibtisch entsteht erst beim ersten erfolgreichen
Abgleich. Ein toter j-lawyer darf den Schreibtisch trotzdem nicht unbenutzbar machen.

`verboten` (j-lawyer antwortet mit `403` — der Zugriff auf GENAU diese Akte ist entzogen)
bekommt **keinen** Fallback: Der gespeicherte Klartext-Stand würde sonst preisgegeben, obwohl
j-lawyer den Zugriff gerade verweigert. Die Route antwortet `403 { "error": "j-lawyer
verweigert den Zugriff" }` ohne `state`/`syncFehler` im Body, die Sitzung bleibt gültig (siehe
„j-lawyer-Fehler" ganz oben auf dieser Seite). Nur eine **echte** abgelaufene/ungültige Sitzung
(`art: 'auth'`) verhält sich weiterhin wie zuvor: `401 { "error": "j-lawyer-Anmeldung
abgelaufen" }`, Sitzung wird serverseitig gelöscht.

**Fail-closed — fremde Akte im Fallback = 403, kein Cross-User-Leck:** Bevor der
`nichtErreichbar`/`fehlt`/`server`-Fallback den zwischengespeicherten Stand ausliefert, prüft
die Route den Eigentümer der Desk-Zeile (`desks.owner_id`, gesetzt beim ersten Öffnen über
`ensureDesk`). Gehört die Akte einem ANDEREN Nutzer als dem anfragenden, gibt es **keinen**
Fallback — sonst könnte ein Nutzer während eines j-lawyer-Ausfalls den vollen Desk-Stand
(Karten, Zettel, Stempel, Text-Snapshots) einer fremden Akte lesen, obwohl j-lawyer im
Normalbetrieb den Zugriff verweigern würde. Die Route antwortet in diesem Fall `403
{ "error": "Kein Zugriff auf diese Akte." }` — dieselbe Semantik wie `art: 'verboten'`, ohne
die Sitzung zu zerstören. Existiert noch gar keine Desk-Zeile (Akte wurde von niemandem
geöffnet), bleibt es beim harmlosen leeren `state` ohne Persistenz (kein Leck, da leer).

**Response 200** (Abgleich erfolgreich; Beispielform aus dem Fake-j-lawyer-Testfixture
`akte-1`/`jdoc-1`/`jdoc-2`, `packages/server/src/testJLawyer.ts`)
```json
{
  "rev": 1,
  "state": {
    "docs": [
      { "id": "<DOC_ID_1>", "fileId": "jdoc-1", "name": "Klageschrift.pdf", "kind": "pdf", "sourceChangeDate": 1750000000000 },
      { "id": "<DOC_ID_2>", "fileId": "jdoc-2", "name": "Kaufvertrag.pdf", "kind": "pdf", "sourceChangeDate": 1750000100000 }
    ],
    "stacks": [],
    "notes": []
  }
}
```

**Response 200** (mit `syncFehler`; Feldwerte aus `jlawyer.test.ts` „Fake-j-lawyer nicht
erreichbar (Server gestoppt) -> Route liefert 200 + syncFehler + letzten Stand")
```json
{
  "rev": 1,
  "state": { "docs": [ … ], "stacks": [], "notes": [] },
  "syncFehler": "j-lawyer ist derzeit nicht erreichbar — Stand vom letzten Abgleich."
}
```

**Response 200** (verwaiste Karte; Auszug aus `state.docs` — die Antwort trägt wie üblich die
`{rev,state}`-Hülle; Feldwerte aus `jlawyer.test.ts` „extern entferntes Dokument: Karte
bleibt liegen (sourceGone), Annotationen unversehrt")
```json
{ "id": "<DOC_ID>", "fileId": "jdoc-verwaisen", "name": "Original.pdf", "sourceGone": true, "sourceChangeDate": 1751000000000 }
```

**Fehler:** `401` Bitte neu anmelden (echte abgelaufene Sitzung, `art: 'auth'`) · `403`
`j-lawyer verweigert den Zugriff` (`art: 'verboten'`, kein Fallback — Sitzung bleibt gültig) ·
`403 { "error": "Kein Zugriff auf diese Akte." }` (Fallback auf eine Desk-Zeile eines ANDEREN
Nutzers, fail-closed — Sitzung bleibt ebenfalls gültig) — alle anderen j-lawyer-Fehler
(`nichtErreichbar`/`fehlt`/`server`) auf **eigenen** Akten liefern stattdessen `200` +
`syncFehler`, siehe oben.

### POST /api/v1/cases/:id/documents

Lädt eine Datei als neues Dokument in die j-lawyer-Akte hoch und legt danach — nicht vorher —
die zugehörige Karte auf dem Schreibtisch an (kein Optimismus: erst muss j-lawyer bestätigen).

| | |
|---|---|
| Auth | Bearer + Sitzungs-Credentials |
| Modus | nur jlawyer |

**Request:** `multipart/form-data` mit der Datei als Teil.

**Response 201**
```json
{ "rev": 4, "state": { "docs": [], "stacks": [], "notes": [] } }
```

Antwortform entspricht `POST /desks/:id/commands` (intern wird ein `addDoc`-Command auf den
Aktenschreibtisch angewendet); das Ergebnis wird ebenfalls per WebSocket gebroadcastet.

**Fehler:** `400` keine Datei im Request · `401` Bitte neu anmelden · j-lawyer-Fehler.

---

## Sitzung & Tickets

### POST /api/v1/ws-ticket

Stellt ein Einmal-Ticket für den WebSocket-Verbindungsaufbau aus (Browser-WebSockets können
keine Header setzen, daher kein Bearer-Token für die eigentliche Verbindung).

| | |
|---|---|
| Auth | Bearer |
| Modus | beide |

**Response 200**
```json
{ "ticket": "<TICKET>" }
```

Das Ticket ist einmalig gültig und läuft nach 30 Sekunden ab (`createWsTickets`, Default-TTL
in `packages/server/src/auth.ts`). Details zur Verwendung in [websocket.md](websocket.md).

**Fehler:** keine.

### GET /api/v1/desks/:id/ws

WebSocket-Upgrade für Live-Updates eines Schreibtischs. Kein regulärer REST-Endpunkt —
vollständig beschrieben in [websocket.md](websocket.md).

| | |
|---|---|
| Auth | Einmal-Ticket als Query-Parameter (`?ticket=…`, ausgestellt von `POST /ws-ticket`) statt Bearer |
| Modus | beide |

**Fehler:** `401 { "error": "Nicht angemeldet" }` beim HTTP-Upgrade, wenn `ticket` fehlt,
unbekannt oder abgelaufen ist (geprüft im globalen Auth-Hook, bevor der WebSocket-Handler
überhaupt läuft).

### GET /api/v1/convert-source/:ticket

Interner Endpunkt, den der Euro-Office-DocumentServer aufruft, um die Rohbytes einer zu
konvertierenden Datei zu holen. Das Ticket in der URL ersetzt die Authentifizierung
vollständig (`CONVERT_SOURCE_PREFIX` ist öffentlich) — ausgestellt von den `preview`-Routen,
nie direkt vom Client angefordert.

| | |
|---|---|
| Auth | Einmal-Ticket in der URL (kein Bearer) |
| Modus | beide, je nach Ticket-Payload |

**Response 200:** Binärdaten, `content-type: application/octet-stream`. Standalone-Payloads
liefern die lokal abgelegte Datei; j-lawyer-Payloads (`payload.jl` gesetzt) rufen den
Akteninhalt live über die im Ticket enthaltenen Sitzungs-Credentials ab.

**Fehler:** `404` Ticket ungültig oder abgelaufen · `404` Datei nicht gefunden (Standalone-
Zweig) · j-lawyer-Fehler (jlawyer-Zweig).
