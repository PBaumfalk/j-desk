# Command-Referenz

> Stand: Commit `4c47b3b` — bei API-Änderungen mitpflegen.

Quelle für alle Angaben dieser Seite: `packages/core/src/commands.ts` (Registry und
Validierungs-Helfer), ergänzt um die Domänenmodule `documents.ts`, `stacks.ts`,
`konvolut.ts`, `notes.ts`, `ink.ts`, `marks.ts`, `stamps.ts`, `flags.ts`, `clips.ts`,
`tape.ts`, `links.ts`, `trash.ts`, `background.ts`, `viewer.ts`, `copy.ts`, `cutouts.ts`,
`removal.ts` und `model.ts` (Typen), außerdem `packages/server/src/deskStore.ts`
(`applyDeskCommand`) und `app.ts` (`actorFromRequest`) für die serverseitige Provenienz, sowie
`packages/core/src/stempel.ts` (Objektversionen) und `konflikt.ts` (Konfliktprüfung) für die
Konflikterkennung.

Alle Aktionen auf einem Schreibtisch laufen über einen einzigen Endpunkt — Details zur Route
selbst stehen in [rest.md → Commands](rest.md#post-apiv1desksidcommands):

```json
{ "type": "<Command-Typ>", "payload": { … } }
```
`POST /api/v1/desks/:id/commands`

**Antwort 200**
```json
{ "rev": 14, "state": { "docs": [], "links": [], "stacks": [] } }
```
`rev` erhöht sich um genau eins pro angenommenem Command — auch wenn der Command inhaltlich
ein No-Op ist (siehe die Hinweise bei den einzelnen Commands unten). `state` ist immer der
**vollständige** neue Zustand, kein Diff (`packages/server/src/deskStore.ts`,
`applyDeskCommand`).

**Fehler:** Jeder ungültige Command liefert `400` mit `{ "error": "<Meldung>" }` — eine
`CommandError` aus `packages/core/src/commands.ts` oder aus dem jeweiligen Domänenmodul
(unbekannter Command-Typ, fehlendes/falsches Pflichtfeld, ungültige Referenz auf ein
nicht existierendes Objekt). `404` bei unbekannter Schreibtisch-Id. Bei `addDoc` prüft
bereits die Route (`app.ts`) vorab, ob die `fileId` existiert — siehe rest.md.

## Basiskoordinaten

Striche (`addStroke`), Abdeckflächen (`addMark`), Stempel (`addStamp`) und Ausschnitte
(`addCutout`) liegen **nicht** in Weltkoordinaten, sondern im Basisraum der jeweiligen
PDF-Seite: dem PDF.js-Viewport bei `scale = 1`, Ursprung oben links, x nach rechts, y nach
unten (Kommentare in `packages/core/src/ink.ts`, `marks.ts`, `stamps.ts`, `cutouts.ts`;
Client-seitige Umrechnung Bildschirm ↔ Basisraum in `src/lib/inkMath.ts`). Die `position`
von Dokumenten, Stapeln, Zetteln und Ausschnitten ist dagegen eine **Weltkoordinate** des
Tisches (linke obere Ecke des Objekts, `packages/core/src/model.ts`).

## Validierungs-Helfer

Die Feld-Tabellen unten referenzieren diese Helfer aus `commands.ts`:

| Helfer | Bedeutung |
|---|---|
| `id(v, feld)` | Pflicht, nicht-leerer String |
| `optId(v)` | optional — Client kann eine eigene Id vorgeben, sonst generiert der Server eine |
| `text(v, feld)` | Pflicht, String (auch `""` ist gültig) |
| `vec(v, feld)` | Pflicht, `{ x: number, y: number }` |
| `num(v, feld)` | Pflicht, endliche Zahl |
| `size(v, feld)` | Pflicht, `{ w: number, h: number }` |
| `rect(v)` | Pflicht, `{ x, y, w, h }` (lokaler Helfer, u. a. für `addCutout` und `mark.rect`) |

## Provenienz: `createdBy` / `createdAt` / `trashedBy`

Alle Commands, die ein **neues** Objekt erzeugen — `addDoc`, `addLink`, `stackDocs` (neuer
Stapel), `addNote`, `addStroke`, `addCutout`, `addMark`, `addStamp`, `addFlag`, `addClip`,
`extractPage` (neue Seitenkarte) und `copyObject` (Kopie) — bekommen ihr Objekt vom Server mit
`createdBy` (Benutzername-Snapshot) und `createdAt` (ISO-8601-UTC-Zeitstempel, Serverzeit)
gestempelt. `trashObject` stempelt den entstehenden Korb-Eintrag entsprechend mit `trashedBy`.

**Der Server setzt diesen Stempel — nicht der Client.** Die Route
`POST /api/v1/desks/:id/commands` ermittelt den Actor aus der Session
(`actorFromRequest(db, req)` in `app.ts`) und reicht ihn als `CommandMeta` an
`applyCommand`/`applyDeskCommand` durch (`packages/server/src/deskStore.ts`); die
Payload-Parser der einzelnen Commands (`strokePayload`, `markPayload`, `stampPayload`,
`flagPayload` u. a. in `commands.ts`) lesen `createdBy`/`createdAt` **gar nicht erst** aus dem
vom Client gesendeten `payload` — ein dort mitgeschicktes Feld dieses Namens hat schlicht
keine Wirkung. Es gibt also weder eine Möglichkeit noch einen Grund, diese Felder im
Request-Payload zu setzen.

Alle drei Felder sind **optional** und fehlen bei Objekten, die vor Einführung dieses Features
angelegt wurden (`packages/core/src/model.ts`, `trash.ts`). Sonderfälle:

- **`copyObject`:** Die Kopie bekommt einen **frischen** Stempel (wer/wann kopiert hat) — die
  Provenienz des Originals wird explizit **nicht** übernommen (`packages/core/src/copy.ts`).
- **j-lawyer-Abgleich (`caseSync`):** Neue Karten aus `GET /api/v1/cases/:id/desk` bekommen
  `createdBy: "j-lawyer-Abgleich"` statt des anfragenden Nutzers — der Abgleich läuft
  automatisiert, nicht als bewusste Handlung dieses Nutzers (`syncCaseDesk` in `app.ts`).
- **`PUT /api/v1/desks/:id/state`:** Ersetzt den kompletten Zustand unverändert — hier gibt es
  keine Stempel-Logik, ein mitgelieferter State behält seine (ggf. fehlenden) Provenienz-Felder
  genau so, wie er ankam.

Journalierung dieser Commands (inkl. Actor je Eintrag) steht in
[rest.md → GET /desks/:id/journal](rest.md#get-apiv1desksidjournal).

### Fundstellen-Provenienz: `textSnapshot` / `fileSha256`

`addCutout` und `addMark` akzeptieren zusätzlich zu den unten dokumentierten Feldern zwei
optionale Inhalts-Metadaten für „Sprung zur Quelle" (`packages/core/src/cutouts.ts`,
`marks.ts`; Feld-Parsing über `optStr` in `commands.ts`):

- **`textSnapshot`** (string, optional, bei beiden Commands): Text-Vorschau der Fundstelle
  zum Zeitpunkt des Ausschneidens/Abdeckens — vom **Client** geliefert (i. d. R. aus PDF.js
  `getTextContent`). Der Server kappt ihn auf `TEXT_SNAPSHOT_MAX` = **2000 Zeichen**; ein
  leerer String (`""`) wird **weggelassen** (kein Feld im Objekt, nicht `textSnapshot: ""`);
  ein Nicht-String-Wert im Payload wird **ignoriert** (kein Fehler, `optStr` liefert dann
  `undefined`). Rein informativ — keine Validierung gegen den tatsächlichen PDF-Inhalt.
- **`fileSha256`** (string, optional, **nur** bei `addCutout`): Hash der Quelldatei. **Wird
  vom Server ersetzt, nicht vom Client übernommen** — die Route
  `POST /api/v1/desks/:id/commands` schlägt ihn serverseitig anhand der `fileId` der
  referenzierten Karte in der eigenen `files`-Tabelle nach und schreibt ihn in den
  Command-Payload, **bevor** dieser an `applyDeskCommand` weitergereicht wird
  (`packages/server/src/app.ts`); ein vom Client mitgeschicktes `fileSha256` wird dabei
  überschrieben bzw. — findet sich kein passender `files`-Eintrag — entfernt. **Nur im
  Standalone-Modus** verfügbar; im jlawyer-Modus wird das Feld immer entfernt, da dort kein
  Hash zur Verfügung steht (das Feld fehlt dann am resultierenden Ausschnitt vollständig,
  nicht `fileSha256: null`). `addMark` kennt `fileSha256` nicht — Abdeckflächen tragen nur
  `textSnapshot`.

**Kopier-Semantik (`copyObject`):** Anders als `createdBy`/`createdAt` (siehe oben, immer
frischer Stempel) sind `textSnapshot`/`fileSha256` **Inhalts-Metadaten, keine
Provenienz-Stempel** — eine Kopie eines Ausschnitts behält beide Felder unverändert vom
Original (`packages/core/src/copy.ts` streift beim Kopieren nur `taped`, `createdBy`,
`createdAt`), bekommt aber wie jedes kopierte Objekt einen neuen `createdBy`/`createdAt`-
Stempel des kopierenden Nutzers.

## Objektversionen: `updatedRev` / `updatedAt` / `updatedBy`

Objekte der zehn **versionierten Arten** — `docs`, `stacks`, `links`, `strokes`, `notes`,
`cutouts`, `marks`, `stamps`, `flags`, `clips` (`VERSIONIERTE_ARTEN` in
`packages/core/src/stempel.ts`) — tragen zusätzlich `updatedRev` (number), `updatedAt`
(ISO-8601-UTC-Zeitstempel) und `updatedBy` (Benutzername-Snapshot). `trash` ist bewusst
ausgenommen: seine Einträge sind historische Kopien entfernter Objekte, keine lebenden
Objekte, die sich noch bearbeiten ließen. `background` ist ausgenommen, weil es kein Array
von Objekten mit `id` ist — ein Hintergrundwechsel ist unstrittig und braucht keine
Konflikterkennung.

**Der Server setzt diese Felder — nicht der Client**, und zwar zentral nach jedem
Command-Aufruf (`stempeleGeaenderte` in `packages/core/src/stempel.ts`), nicht in den
rund 50 einzelnen Command-Handlern: Verglichen wird der Zustand vor und nach `applyCommand`
je versionierter Liste per Referenzgleichheit — die Domänenmodule teilen konsequent Struktur
(`s.docs.map((d) => (d.id === id ? { ...d, position } : d))`), unveränderte Objekte behalten
also ihre Objektidentität. Jedes Objekt, dessen Referenz sich geändert hat oder das neu
hinzugekommen ist, bekommt den Stempel der aktuellen Revision (`updatedRev: rev`).
Absichtlich zentral statt verteilt: Stempelt ein Handler wider Erwarten zu viele Objekte,
entstehen überzählige (meist harmlose) Konflikte; ein vergessener Stempel dagegen hieße „nie
ein Konflikt erkannt" — stilles Überschreiben. Der Wächtertest in `stempel.test.ts` prüft die
Strukturteilung über alle Command-Typen der Registry.

Alle drei Felder sind **optional** und fehlen bei Objekten, die vor Einführung dieses
Features angelegt oder seither nicht mehr bearbeitet wurden. Sie sind die Grundlage der
Konflikterkennung — siehe [`erwartet`](#konflikterkennung-erwartet) unten.

## Konflikterkennung: `erwartet`

Der Request-Body von `POST /api/v1/desks/:id/commands` akzeptiert zusätzlich zum Command
selbst ein optionales Feld `erwartet`:

```json
{ "type": "moveNote", "payload": { "id": "n1", "position": { "x": 200, "y": 150 } }, "erwartet": { "n1": 3 } }
```

**Form:** `erwartet` ist eine Abbildung Objekt-Id → erwartete `updatedRev` (`Erwartet =
Record<string, number>` in `packages/core/src/konflikt.ts`).

**Ableitung aus der `payload` (Client, `src/lib/konflikt.ts`, `erwartungAus`):** Der Client
pflegt keine eigene Liste je Command-Typ. Stattdessen durchsucht er die gesamte `payload`
(auch verschachtelt, auch in Arrays, bis Tiefe 4) nach Strings, die sich als Id eines
bekannten, versionierten Objekts auflösen lassen, und trägt für jeden Treffer dessen zuletzt
gesehene `updatedRev` ein. Das deckt laut Kommentar im Quelltext z. B. `stack.docIds`,
`link.fromId`/`toId` und `clip.memberIds` ohne Sonderbehandlung je Command ab — Kehrseite: Die
Erwartung kann gelegentlich strenger sein als nötig. Findet sich in der `payload` keine
bekannte Objekt-Id, bleibt `erwartet` ganz weg.

**Fehlt `erwartet`, wird angenommen.** Ein alter, nicht neu geladener Tab schickt Commands
ohne dieses Feld — er blockiert dadurch nicht dauerhaft. Ebenso wird angenommen, wenn ein
referenziertes Objekt selbst (noch) keine `updatedRev` trägt (Alt-Zustand vor der Migration).
Beides steht so kommentiert in `pruefeErwartung` (`packages/core/src/konflikt.ts`).

**Prüfung:** Der Server prüft `erwartet` **innerhalb der Transaktion** gegen den frisch
gelesenen Zustand, bevor irgendetwas geschrieben wird (`applyDeskCommand` in
`packages/server/src/deskStore.ts`) — bei einem Konflikt bleiben Zustand **und** Journal
unberührt.

**Antwort `409`** bei einem Konflikt:
```json
{ "konflikt": { "objektId": "n1", "typ": "notes", "art": "geaendert", "von": "anna", "am": "2026-07-20T10:00:00.000Z" } }
```

| Feld | Typ | Bedeutung |
|---|---|---|
| `objektId` | string | Die Id aus `erwartet`, an der der Konflikt auftrat |
| `typ` | string | Art des Objekts — eine der [versionierten Arten](#objektversionen-updatedrev--updatedat--updatedby) (`docs`, `stacks`, …), oder `"unbekannt"`, wenn das Objekt gar nicht mehr existiert |
| `art` | `'geaendert'` \| `'geloescht'` | `geloescht`, wenn das Objekt nicht mehr gefunden wird; sonst `geaendert` |
| `von` | string \| null | `updatedBy` des Objekts zum Konfliktzeitpunkt, `null` bei `geloescht` (und wenn `updatedBy` fehlt) |
| `am` | string \| null | `updatedAt` des Objekts zum Konfliktzeitpunkt, `null` bei `geloescht` (und wenn `updatedAt` fehlt) |

Nur der **erste** Konflikt innerhalb von `erwartet` wird gemeldet (Iterationsreihenfolge der
Objekt-Ids in `erwartet`) — die Prüfung bricht beim ersten Treffer ab.

**Client-Reaktion (`src/lib/konflikt.ts`, `reaktionFuer`):** Nicht jeder Konflikt führt zur
Rückfrage — die Entscheidung hängt ausschließlich vom Command-**Typ** ab (`art` des
Konflikts spielt dabei keine Rolle). Rein ortsgebundene Commands (`moveDoc`, `moveStack`,
`moveNote`, `moveCutout`, `bringToFront`, `resizeDoc`, `resizeStack`, `setDocLandscape`,
`setBackground`) wiederholt der Client bei einem Konflikt automatisch (nach `refresh()`, mit
neu abgeleiteter `erwartet`, höchstens zwei Versuche) — „die letzte Position gewinnt" ist hier
das erwünschte Verhalten, eine Rückfrage wäre nur lästig. Bei jedem anderen Command-Typ legt
der Client den Konflikt stattdessen der Nutzerin vor (Overlay).

---

## Dokumente

### addDoc

Legt eine hochgeladene Datei als neue Karte auf dem Tisch ab.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `fileId` | string | ja | Id der Datei (`id`-Helfer) |
| `name` | string | ja | Anzeigename (`text`-Helfer) |
| `position` | `{x,y}` | ja | Weltposition, linke obere Ecke (`vec`-Helfer) |
| `id` | string | nein | Eigene Doc-Id (`optId`); sonst generiert der Server eine |
| `kind` | `'pdf'\|'image'\|'convertible'\|'other'` | nein | Datei-Art; wird direkt durchgereicht und erst in `addDoc` gegen `FILE_KINDS` geprüft |

```json
{ "type": "addDoc", "payload": { "fileId": "<FILE_ID>", "name": "Klageschrift.pdf", "position": { "x": 120, "y": 80 } } }
```

Fehler (`400`): unbekannte `kind`. **Dedup:** Liegt bereits eine Karte mit derselben
`fileId` auf dem Tisch, ist der Command ein stiller No-Op — der Zustand bleibt unverändert
(`packages/core/src/documents.ts`), `rev` erhöht sich trotzdem um eins.

### moveDoc

Verschiebt eine Dokumentkarte.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-Id |
| `position` | `{x,y}` | ja | Neue Weltposition (linke obere Ecke) |

```json
{ "type": "moveDoc", "payload": { "id": "d1", "position": { "x": 120, "y": 80 } } }
```

**Kein Fehlerfall bei unbekannter `id`:** `moveDoc` prüft die Existenz nicht (`s.docs.map`
ohne Treffer-Check) — bei unbekannter Id bleibt der Zustand einfach unverändert, `200` mit
unverändertem `state`.

### bringToFront

Hebt ein Objekt über alle anderen (höchster `zIndex`). Funktioniert trotz der Gruppierung
hier für **Dokumente, Stapel, Zettel und Ausschnitte gleichermaßen** — die Implementierung
prüft alle vier Sammlungen mit derselben `id`.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Id eines Docs, Stapels, Zettels oder Ausschnitts |

```json
{ "type": "bringToFront", "payload": { "id": "d1" } }
```

Kein Fehlerfall bei unbekannter `id` (stiller No-Op, wie bei `moveDoc`).

### resizeDoc

Setzt die Größe der aufgeschlagenen (großen) Karte.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-Id |
| `size` | `{w,h}` | ja | Neue Größe in Weltkoordinaten (`size`-Helfer) |

```json
{ "type": "resizeDoc", "payload": { "id": "d1", "size": { "w": 600, "h": 760 } } }
```

Fehler (`400`): Doc-Id unbekannt · `w` oder `h` nicht `> 0`.

### setDocPage

Setzt die aktuell sichtbare Seite einer aufgeschlagenen Karte.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-Id |
| `page` | number | ja | Zielseite, 1-basiert (`num`-Helfer) |

```json
{ "type": "setDocPage", "payload": { "id": "d1", "page": 3 } }
```

Fehler (`400`): Doc-Id unbekannt · `page` keine ganze Zahl `>= 1`.

### expandDoc

Schlägt eine Miniatur zur großen Karte auf.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-Id |

```json
{ "type": "expandDoc", "payload": { "id": "d1" } }
```

Setzt `open: true`; `openSize` fällt auf 560×720 zurück, falls noch keine eigene Größe
gesetzt wurde (per `resizeDoc`), sonst bleibt die vorherige Größe erhalten; `page` fällt auf
1 zurück, falls noch keine gesetzt wurde. Fehler (`400`): Doc-Id unbekannt.

### collapseDoc

Klappt die große Karte wieder zur Miniatur zusammen (`open: false`; `openSize`/`page`
bleiben für das nächste `expandDoc` erhalten).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-Id |

```json
{ "type": "collapseDoc", "payload": { "id": "d1" } }
```

Fehler (`400`): Doc-Id unbekannt.

### extractPage

Enthefterzange: löst eine Einzelseite als eigene, neue Karte heraus — nicht destruktiv,
das Quelldokument bleibt unverändert liegen.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `docId` | string | ja | Quelldokument |
| `page` | number | ja | Herauszulösende Seite, 1-basiert |
| `position` | `{x,y}` | ja | Weltposition der neuen Seitenkarte |
| `id` | string | nein | Eigene Id der neuen Seitenkarte |

```json
{ "type": "extractPage", "payload": { "docId": "d1", "page": 4, "position": { "x": 300, "y": 200 } } }
```

Die neue Karte übernimmt `fileId` und `kind` des Quelldokuments und erhält `pageOnly` =
`page` (zeigt nur diese eine Seite). Fehler (`400`): Quelldokument unbekannt · `page` keine
ganze Zahl `>= 1`.

### setDocLandscape

Markiert eine Karte einmalig als Querformat (erste Seite breiter als hoch).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-Id |

```json
{ "type": "setDocLandscape", "payload": { "id": "d1" } }
```

**Idempotent, kein Fehlerfall:** unbekannte `id` → No-Op; bereits als Querformat markiert →
No-Op. Erlaubt, dass mehrere Clients dies gleichzeitig melden, ohne Fehler zu riskieren
(`packages/core/src/documents.ts`). Kein Weg zurück (`landscape` lässt sich nicht wieder
löschen).

### removeDoc

Entfernt eine Karte endgültig vom Tisch (ohne Papierkorb — für den Korb siehe
`trashObject`).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-Id |

```json
{ "type": "removeDoc", "payload": { "id": "d1" } }
```

Kein Fehlerfall bei unbekannter `id` (stiller No-Op — `removal.ts` prüft die Existenz nicht
explizit). Räumt automatisch mit auf: entfernt Verknüpfungen, Striche, Abdeckflächen,
Stempel und Fahnen dieser Karte sowie ihre Klammer-Mitgliedschaft. Bleibt in einem
gehefteten Konvolut nach dem Entfernen genau ein Mitglied übrig, wird der Stapel dabei
automatisch entheftet **und** aufgelöst (internes Aufräumen, unabhängig vom
`stapled`-Zustand).

## Stapel & Konvolut

### stackDocs

Bildet einen neuen Stapel oder legt eine Karte auf einen bestehenden.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `draggedId` | string | ja | Zu stapelnde Doc-Id |
| `targetId` | string | ja | Ziel-Doc- oder Stapel-Id |
| `id` | string | nein | Id eines neu entstehenden Stapels (ignoriert, wenn stattdessen einem bestehenden Stapel beigetreten wird) |

```json
{ "type": "stackDocs", "payload": { "draggedId": "d2", "targetId": "d1" } }
```

**No-Op-Fälle** (kein Fehler, Zustand unverändert): `draggedId === targetId` · `draggedId`
liegt bereits in einem Stapel (muss zuerst per `removeFromStack` heraus) · der Zielstapel
ist geheftet (`stapled`) · `targetId` löst sich weder zu einem Doc noch zu einem Stapel auf.
Ist `targetId` bereits Teil eines Stapels, wird `draggedId` diesem Stapel hinzugefügt
(oben); sonst entsteht ein neuer Stapel `[targetId, draggedId]` an Position/`zIndex` des
Zieldokuments.

### removeFromStack

Zieht ein Dokument aus seinem Stapel heraus.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `docId` | string | ja | Herauszuziehendes Dokument |
| `position` | `{x,y}` | ja | Neue Weltposition außerhalb des Stapels |

```json
{ "type": "removeFromStack", "payload": { "docId": "d2", "position": { "x": 400, "y": 120 } } }
```

No-Op, wenn `docId` in keinem Stapel liegt. Fehler (`400`): `"Konvolut zuerst entheften"`,
wenn der Stapel geheftet (`stapled`) ist. Bleibt danach genau ein Mitglied im Stapel übrig,
wird dieser automatisch aufgelöst (`dissolveStack`).

### dissolveStack

Löst einen Stapel vollständig auf; die Mitglieder bleiben als einzelne Karten liegen.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stackId` | string | ja | Stapel-Id |

```json
{ "type": "dissolveStack", "payload": { "stackId": "s1" } }
```

No-Op, wenn `stackId` unbekannt. Fehler (`400`): `"Konvolut zuerst entheften"`, wenn
geheftet. Verteilt die Mitglieder gestaffelt (Schritt 40×24 px) um die frühere
Stapelposition und entfernt Verknüpfungen, die auf die Stapel-Id zeigten.

### renameStack

Benennt einen Stapel um.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stackId` | string | ja | Stapel-Id |
| `name` | string | ja | Neuer Name (`text`-Helfer, auch leer erlaubt) |

```json
{ "type": "renameStack", "payload": { "stackId": "s1", "name": "Anlagenkonvolut K1" } }
```

Kein Fehlerfall bei unbekannter `stackId` (stiller No-Op).

### moveStack

Verschiebt einen Stapel als Ganzes.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stackId` | string | ja | Stapel-Id |
| `position` | `{x,y}` | ja | Neue Weltposition |

```json
{ "type": "moveStack", "payload": { "stackId": "s1", "position": { "x": 500, "y": 300 } } }
```

Kein Fehlerfall bei unbekannter `stackId` (stiller No-Op).

### removeStack

Entfernt einen Stapel **und alle seine Mitglieder** endgültig (ohne Papierkorb).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stackId` | string | ja | Stapel-Id |

```json
{ "type": "removeStack", "payload": { "stackId": "s1" } }
```

Kein Fehlerfall bei unbekannter `stackId` (stiller No-Op). Entfernt destruktiv Verknüpfungen,
Annotationen und Klammer-Mitgliedschaften der Mitgliedsdokumente mit. Legt selbst **keinen**
Korb-Eintrag an — `trashObject` ruft diese Funktion intern auf, wenn ein ganzer Stapel in
den Papierkorb wandert, und erzeugt den Eintrag dort.

### resizeStack

Setzt die Größe des aufgeschlagenen Konvolut-Viewers. **Feldname `id`, nicht `stackId`**
(Registry-Besonderheit — abweichend von den übrigen Stapel-Commands oben).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Stapel-Id |
| `size` | `{w,h}` | ja | Neue Größe in Weltkoordinaten |

```json
{ "type": "resizeStack", "payload": { "id": "s1", "size": { "w": 600, "h": 760 } } }
```

Fehler (`400`): Stapel-Id unbekannt · `w` oder `h` nicht `> 0`.

### setStackPage

Setzt die globale Konvolut-Seite (über alle Mitglieder hinweg). **Feldname `id`, nicht
`stackId`.**

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Stapel-Id |
| `page` | number | ja | Zielseite, 1-basiert |

```json
{ "type": "setStackPage", "payload": { "id": "s1", "page": 12 } }
```

Fehler (`400`): Stapel-Id unbekannt · `page` keine ganze Zahl `>= 1`.

### expandStack

Schlägt ein **geheftetes** Konvolut als Ganzes im großen Viewer auf. **Feldname `id`, nicht
`stackId`.**

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Stapel-Id |

```json
{ "type": "expandStack", "payload": { "id": "s1" } }
```

Fehler (`400`): Stapel-Id unbekannt · `"Nur ein geheftetes Konvolut lässt sich als Ganzes
aufschlagen"`, wenn der Stapel nicht geheftet (`stapled`) ist. `openSize` fällt auf 560×720
zurück, falls noch keine eigene Größe gesetzt wurde; `page` auf 1.

### collapseStack

Klappt den Konvolut-Viewer wieder zu. **Feldname `id`, nicht `stackId`.**

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Stapel-Id |

```json
{ "type": "collapseStack", "payload": { "id": "s1" } }
```

Fehler (`400`): Stapel-Id unbekannt.

### stapleStack

Heftet einen Stapel: feste Reihenfolge, als Ganzes durchblätterbar (Konvolut).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stackId` | string | ja | Stapel-Id |

```json
{ "type": "stapleStack", "payload": { "stackId": "s1" } }
```

Fehler (`400`): Stapel-Id unbekannt.

### unstapleStack

Löst die Heftung wieder.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stackId` | string | ja | Stapel-Id |

```json
{ "type": "unstapleStack", "payload": { "stackId": "s1" } }
```

Fehler (`400`): Stapel-Id unbekannt. Schließt dabei zusätzlich den Konvolut-Viewer
(`open: false`), falls er offen war.

## Zettel

### addNote

Legt einen Notizzettel an.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `kind` | `NoteKind` | ja | Denk-Rolle: `notiz`, `frage`, `these`, `angriffspunkt`, `risiko`, `behauptung`, `beweisziel`, `idee`, `todo`, `argument`, `rechtsfrage`, `eigen`, `tafel`. Wird ungeprüft durchgereicht und erst in `addNote` gegen `NOTE_KINDS` validiert (kein `commands.ts`-Helfer) |
| `text` | string | ja | Zettel-Text (`text`-Helfer, auch leer erlaubt) |
| `position` | `{x,y}` | ja | Weltposition |
| `id` | string | nein | Eigene Zettel-Id |
| `customLabel` | string | bedingt | **nur bei `kind: "eigen"`**: eigenes Badge, getrimmt, 1–24 Zeichen; bei jedem anderen `kind` **verboten** |

```json
{ "type": "addNote", "payload": { "kind": "todo", "text": "Frist prüfen", "position": { "x": 100, "y": 100 } } }
```

Fehler (`400`): unbekannter `kind` · bei `kind: "eigen"` fehlendes/leeres/zu langes
`customLabel` · `customLabel` bei jedem anderen `kind` gesetzt
(`"Badge-Text ist nur beim Typ \"eigen\" erlaubt"`).

### editNote

Ändert den Text eines Zettels.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Zettel-Id |
| `text` | string | ja | Neuer Text |

```json
{ "type": "editNote", "payload": { "id": "n1", "text": "Frist verlängert" } }
```

Fehler (`400`): Zettel-Id unbekannt.

### moveNote

Verschiebt einen Zettel.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Zettel-Id |
| `position` | `{x,y}` | ja | Neue Weltposition |

```json
{ "type": "moveNote", "payload": { "id": "n1", "position": { "x": 200, "y": 150 } } }
```

Fehler (`400`): Zettel-Id unbekannt.

### removeNote

Entfernt einen Zettel endgültig (ohne Papierkorb).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Zettel-Id |

```json
{ "type": "removeNote", "payload": { "id": "n1" } }
```

Fehler (`400`): Zettel-Id unbekannt. Räumt Verknüpfungen und Klammer-Mitgliedschaft mit auf.

### setNoteDone

Hakt einen To-do-Zettel ab oder wieder auf.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Zettel-Id |
| `done` | boolean | ja | Direkt in `commands.ts` geprüft (kein gemeinsamer Helfer) |

```json
{ "type": "setNoteDone", "payload": { "id": "n1", "done": true } }
```

Fehler (`400`): `"Feld \"done\" muss true oder false sein"`, wenn `done` fehlt/kein Boolean
· Zettel-Id unbekannt · `"Nur To-do-Zettel können abgehakt werden"`, wenn `kind !== 'todo'`.

## Zeichnen

### addStroke

Fügt einen Freihand-Strich (Stift/Marker/Bleistift) auf einer PDF-Seite hinzu.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stroke.docId` | string | ja | Dokument |
| `stroke.page` | number | ja | Seite, 1-basiert |
| `stroke.tool` | `'pen'\|'marker'\|'pencil'` | ja | Werkzeug |
| `stroke.color` | string | ja | Hex-Farbe, vom Werkzeug vorgegeben |
| `stroke.width` | number | ja | Strichbreite `> 0`, Basiskoordinaten |
| `stroke.points` | `{x,y}[]` | ja | ≥ 2 endliche Punkte, Basisraum der Seite |
| `stroke.id` | string | nein | Eigene Strich-Id |

```json
{ "type": "addStroke", "payload": { "stroke": { "docId": "d1", "page": 1, "tool": "pen", "color": "#1a1a1a", "width": 2, "points": [{ "x": 10, "y": 10 }, { "x": 40, "y": 30 }] } } }
```

Fehler (`400`): Dokument unbekannt · `page` ungültig · unbekanntes `tool` · `color` leer ·
`width` nicht `> 0` · weniger als zwei endliche Punkte.

### removeStroke

Entfernt einen Strich.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `strokeId` | string | ja | Strich-Id |

```json
{ "type": "removeStroke", "payload": { "strokeId": "sk1" } }
```

Fehler (`400`): Strich-Id unbekannt.

## Abdecken

### addMark

Fügt eine deckende Fläche (Tipp-Ex oder Schwärzung) auf einer PDF-Seite hinzu — rein
visuell, nicht forensisch sicher.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `mark.docId` | string | ja | Dokument |
| `mark.page` | number | ja | Seite, 1-basiert |
| `mark.rect` | `{x,y,w,h}` | ja | Fläche, Basiskoordinaten der Seite; `w`,`h` `> 0` |
| `mark.kind` | `'redact'\|'tippex'` | ja | Art |
| `mark.id` | string | nein | Eigene Flächen-Id |
| `mark.textSnapshot` | string | nein | Fundstellen-Textvorschau des überdeckten Textes; Server kappt auf 2000 Zeichen, `""` wird weggelassen, Nicht-String ignoriert (siehe [Fundstellen-Provenienz](#fundstellen-provenienz-textsnapshot--filesha256)) |

```json
{ "type": "addMark", "payload": { "mark": { "docId": "d1", "page": 2, "rect": { "x": 50, "y": 60, "w": 120, "h": 20 }, "kind": "redact" } } }
```

Fehler (`400`): Dokument unbekannt · `page` ungültig · unbekannte `kind` · ungültiges `rect`.

### removeMark

Entfernt eine Abdeckfläche.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `markId` | string | ja | Flächen-Id |

```json
{ "type": "removeMark", "payload": { "markId": "m1" } }
```

Fehler (`400`): Flächen-Id unbekannt.

## Stempel

### addStamp

Bringt einen Kanzlei-Stempel (Preset oder Freitext) auf einer PDF-Seite an.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stamp.docId` | string | ja | Dokument |
| `stamp.page` | number | ja | Seite, 1-basiert |
| `stamp.x` / `stamp.y` | number | ja | Stempelmitte, Basiskoordinaten |
| `stamp.angle` | number | ja | Drehwinkel in Grad |
| `stamp.text` | string | ja | Stempeltext, getrimmt, 1–40 Zeichen |
| `stamp.color` | `'red'\|'blue'` | ja | Farbe |
| `stamp.date` | string | nein | ISO-Tag — nur bei den `withDate`-Presets (z. B. EINGANG) belegt |
| `stamp.baseW` / `stamp.baseH` | number | ja | Seitengröße beim Stempeln (`> 0`), fürs Overlay auf der Miniatur |
| `stamp.id` | string | nein | Eigene Stempel-Id |

```json
{ "type": "addStamp", "payload": { "stamp": { "docId": "d1", "page": 1, "x": 300, "y": 400, "angle": -6, "text": "ERLEDIGT", "color": "red", "baseW": 595, "baseH": 842 } } }
```

Fehler (`400`): Dokument unbekannt · `page` ungültig · `text` leer oder > 40 Zeichen ·
unbekannte `color` · `angle`/`x`/`y` nicht endlich · `baseW`/`baseH` nicht `> 0`.

### removeStamp

Entfernt einen Stempel.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `stampId` | string | ja | Stempel-Id |

```json
{ "type": "removeStamp", "payload": { "stampId": "sm1" } }
```

Fehler (`400`): Stempel-Id unbekannt.

## Fahnen

### addFlag

Setzt eine farbige Notizfahne am rechten Seitenrand (auch an der zugeklappten Karte
sichtbar).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `flag.docId` | string | ja | Dokument |
| `flag.page` | number | ja | Seite, zu der die Lasche springt, 1-basiert |
| `flag.offset` | number | ja | 0–1, vertikale Position am rechten Rand |
| `flag.color` | string | ja | Muss exakt einem der vier `FLAG_COLORS` entsprechen: `#f5c518`, `#e5484d`, `#3b82f6`, `#30a46c` |
| `flag.label` | string | nein | Beschriftung |
| `flag.id` | string | nein | Eigene Fahnen-Id |

```json
{ "type": "addFlag", "payload": { "flag": { "docId": "d1", "page": 1, "offset": 0.2, "color": "#e5484d" } } }
```

Fehler (`400`): Dokument unbekannt · `page` ungültig · `offset` außerhalb 0–1 · `color`
nicht in `FLAG_COLORS`.

### removeFlag

Entfernt eine Fahne.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `flagId` | string | ja | Fahnen-Id |

```json
{ "type": "removeFlag", "payload": { "flagId": "fl1" } }
```

Fehler (`400`): Fahnen-Id unbekannt.

## Klammern & Klebeband

### addClip

Klammert zwei Objekte lose zusammen — sie bleiben einzeln liegen, werden aber gemeinsam
verschoben.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `aId` | string | ja | Erstes Objekt (Doc/Stapel/Zettel/Ausschnitt) |
| `bId` | string | ja | Zweites Objekt |
| `id` | string | nein | Id einer neu entstehenden Klammer-Gruppe |

```json
{ "type": "addClip", "payload": { "aId": "d1", "bId": "n1" } }
```

Fehler (`400`): `aId === bId` · eines der Objekte existiert nicht. **No-Op**, wenn beide
bereits in derselben Gruppe sind. Sind beide bereits (unterschiedlichen) Gruppen
zugeordnet, verschmelzen die Gruppen zu einer; ist nur eines bereits Mitglied, tritt das
andere dieser Gruppe bei; sonst entsteht eine neue Gruppe `[aId, bId]`.

### removeClip

Löst eine Klammer-Gruppe komplett.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `clipId` | string | ja | Klammer-Id |

```json
{ "type": "removeClip", "payload": { "clipId": "cl1" } }
```

Fehler (`400`): Klammer-Id unbekannt.

### tapeObject

Klebt ein Objekt am Tisch fest — Drag ist gesperrt, bis das Band wieder abgezogen wird
(`untapeObject`).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-, Stapel-, Zettel- oder Ausschnitt-Id |

```json
{ "type": "tapeObject", "payload": { "id": "d1" } }
```

Fehler (`400`): Objekt in keiner der vier Sammlungen gefunden.

### untapeObject

Löst das Klebeband wieder.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Doc-, Stapel-, Zettel- oder Ausschnitt-Id |

```json
{ "type": "untapeObject", "payload": { "id": "d1" } }
```

Fehler (`400`): Objekt nicht gefunden. (`tapeObject`/`untapeObject` rufen beide denselben
`setTaped`-Helfer mit `true`/`false` auf — Registry laut `commands.ts`, es gibt keine
eigenständigen `addTape`/`removeTape`-Namen.)

## Verknüpfungen

### addLink

Verknüpft zwei Docs oder Stapel mit einer Linie.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `fromId` | string | ja | Erste Entität |
| `toId` | string | ja | Zweite Entität |
| `id` | string | nein | Eigene Link-Id |

```json
{ "type": "addLink", "payload": { "fromId": "d1", "toId": "d2" } }
```

**No-Op-Fälle** (kein Fehler): `fromId === toId` · zwischen den beiden Ids besteht bereits
eine Verknüpfung (in beliebiger Richtung, dedupliziert). `fromId`/`toId` werden **nicht**
gegen existierende Objekte geprüft — eine Verknüpfung auf eine nicht existierende Id wird
klaglos angelegt.

### setLinkNote

Setzt den Notiztext einer Verknüpfung.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `linkId` | string | ja | Link-Id |
| `note` | string | ja | Notiztext (`text`-Helfer, auch leer erlaubt) |

```json
{ "type": "setLinkNote", "payload": { "linkId": "l1", "note": "Anlage zu Klage" } }
```

Kein Fehlerfall bei unbekannter `linkId` (stiller No-Op).

### removeLink

Entfernt eine Verknüpfung.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `linkId` | string | ja | Link-Id |

```json
{ "type": "removeLink", "payload": { "linkId": "l1" } }
```

Kein Fehlerfall bei unbekannter `linkId` (stiller No-Op).

## Ausschnitte

### addCutout

Schneidet ein Rechteck einer PDF-Seite als eigenständiges Objekt aus. **Anders als bei
`addMark`/`addStamp`/`addFlag`/`addStroke` liegen die Felder hier direkt im `payload`, nicht
unter einem verschachtelten Schlüssel.**

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `docId` | string | ja | Quelldokument |
| `page` | number | ja | Seite, 1-basiert |
| `rect` | `{x,y,w,h}` | ja | Ausschnitt, Basiskoordinaten der Seite; `w`,`h` `> 0` |
| `position` | `{x,y}` | ja | Weltposition des Ausschnitts auf dem Tisch |
| `id` | string | nein | Eigene Ausschnitt-Id |
| `textSnapshot` | string | nein | Fundstellen-Textvorschau; Server kappt auf 2000 Zeichen, `""` wird weggelassen, Nicht-String ignoriert (siehe [Fundstellen-Provenienz](#fundstellen-provenienz-textsnapshot--filesha256)) |
| `fileSha256` | string | nein | **Wird vom Server ersetzt** (Hash aus der eigenen `files`-Tabelle); nur Standalone-Modus, im jlawyer-Modus immer entfernt |

```json
{ "type": "addCutout", "payload": { "docId": "d1", "page": 1, "rect": { "x": 20, "y": 40, "w": 200, "h": 100 }, "position": { "x": 500, "y": 500 } } }
```

Fehler (`400`): Quelldokument unbekannt · `page` ungültig · ungültiges `rect`. Übernimmt
`fileId` (und, falls gesetzt, `kind`/Dateiname) des Quelldokuments — keine eigene
Dateiablage.

### moveCutout

Verschiebt einen Ausschnitt.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Ausschnitt-Id |
| `position` | `{x,y}` | ja | Neue Weltposition |

```json
{ "type": "moveCutout", "payload": { "id": "cu1", "position": { "x": 520, "y": 480 } } }
```

Fehler (`400`): Ausschnitt-Id unbekannt.

### removeCutout

Entfernt einen Ausschnitt endgültig (ohne Papierkorb).

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Ausschnitt-Id |

```json
{ "type": "removeCutout", "payload": { "id": "cu1" } }
```

Fehler (`400`): Ausschnitt-Id unbekannt. Räumt Verknüpfungen und Klammer-Mitgliedschaft mit
auf.

## Korb

### trashObject

Verschiebt ein Objekt in den Papierkorb — wiederherstellbar, bis er geleert wird.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Zu entsorgendes Objekt: Doc, Stapel, Zettel oder Ausschnitt |
| `trashedAt` | string | ja | ISO-Zeitstempel, vom Client geliefert (`text`-Helfer, nicht leer geprüft in `trashObject` selbst) |
| `trashId` | string | nein | Eigene Id für den entstehenden Korb-Eintrag |

```json
{ "type": "trashObject", "payload": { "id": "d1", "trashedAt": "2026-07-19T10:00:00.000Z" } }
```

Fehler (`400`): Objekt in keiner der vier Sammlungen gefunden · `trashedAt` leer. Bei einem
Doc oder Stapel wandern zusätzlich dessen Striche/Abdeckflächen/Stempel/Fahnen mit in den
Korb-Eintrag; das eigentliche Entfernen läuft intern über `removeDoc`/`removeStack`/
`removeNote`/`removeCutout`. Der Korb-Eintrag bekommt vom Server `trashedBy` (Benutzername
des Auslösers) gestempelt — siehe [Provenienz](#provenienz-createdby--createdat--trashedby).

#### Sonderfall: `emptyTrash`

```json
{ "type": "emptyTrash" }
```

Kein Payload nötig — der Handler nimmt keinen `payload`-Parameter entgegen. Leert
`state.trash` vollständig und unbedingt — kein Fehlerfall, auch bei bereits leerem Korb
(`packages/core/src/trash.ts`). Die entsorgten Objekte sind damit endgültig weg.

### restoreObject

Holt einen Korb-Eintrag zurück auf den Tisch.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `trashId` | string | ja | Korb-Eintrag-Id |

```json
{ "type": "restoreObject", "payload": { "trashId": "t1" } }
```

Fehler (`400`): Korb-Eintrag unbekannt · `"Ein Objekt aus diesem Korb-Eintrag liegt bereits
wieder auf dem Tisch"`, wenn ein Objekt mit derselben Id bereits existiert (Kollision wird
über die Objekt-Id geprüft, nicht über `fileId` — mehrere Kopien mit gleicher `fileId` sind
seit `copyObject` legitim).

### shredTrashItem

Entsorgt genau einen Korb-Eintrag endgültig — kein Wiederherstellen mehr möglich.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `trashId` | string | ja | Korb-Eintrag-Id |

```json
{ "type": "shredTrashItem", "payload": { "trashId": "t1" } }
```

Fehler (`400`): Korb-Eintrag unbekannt.

## Gestaltung

### setBackground

Setzt Farbthema und Material der Tischfläche.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `background.themeId` | `DeskThemeId` | ja | eines von `dark_green`, `bordeaux`, `navy_blue`, `anthracite`, `dark_brown`, `deep_purple`, `dark_white`, `ivory` |
| `background.material` | `DeskMaterial` | ja | eines von `smooth`, `felt`, `leather`, `wood`, `parchment` |
| `background.brightness` | number | ja | 0.75–1.25 (1 = neutral) |
| `background.textureIntensity` | number | ja | 0–1 (0.25 = Standard-Look) |
| `background.vignette` | boolean | ja | Randabdunklung mit Lichtzentrum an/aus |

```json
{ "type": "setBackground", "payload": { "background": { "themeId": "navy_blue", "material": "leather", "brightness": 1, "textureIntensity": 0.25, "vignette": true } } }
```

Alle fünf Unterfelder sind **Pflicht** — der Payload ersetzt das komplette `DeskBackground`,
es gibt kein Teil-Update. Fehler (`400`): unbekannte `themeId`/`material` · `brightness`
außerhalb 0.75–1.25 · `textureIntensity` außerhalb 0–1 · `vignette` kein Boolean.

## Kopie

### copyObject

Dupliziert eine Karte, Seitenkarte, einen Zettel oder einen Ausschnitt inklusive
Annotationen. Gleiche Datei-Referenz, keine Datei-Duplizierung, kein j-lawyer-Schreibvorgang.

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `id` | string | ja | Quellobjekt: Doc, Zettel oder Ausschnitt |

```json
{ "type": "copyObject", "payload": { "id": "d1" } }
```

Fehler (`400`): `"Stapel lassen sich nicht kopieren"`, wenn `id` einen Stapel referenziert ·
Objekt nicht gefunden. Die Kopie bekommt **immer** eine neue, server-generierte Id — anders
als bei den meisten `add*`-Commands gibt es hier **kein** optionales `id`-Feld für das
Ergebnis. Position der Kopie = Quelle + festes Offset `{x: +28, y: +20}`. Bei einer
Doc-Kopie: `open`/`openSize`/`taped` werden verworfen (Kopie startet stets zugeklappt,
Standardgröße, nicht festgeklebt); Striche/Abdeckflächen/Stempel/Fahnen des Quelldokuments
werden mit neuen Ids auf die Kopie mit-dupliziert. Bei Zettel-/Ausschnitt-Kopien wird nur
`taped` verworfen. Provenienz (`createdBy`/`createdAt`) des Originals wird **nicht**
übernommen — die Kopie bekommt einen frischen Server-Stempel, siehe
[Provenienz](#provenienz-createdby--createdat--trashedby).
