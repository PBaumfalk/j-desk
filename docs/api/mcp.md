# MCP-Server

> Stand: Commit `6001512` — bei API-Änderungen mitpflegen.

Der MCP-Server (`packages/mcp`) macht den Schreibtisch für KI-Agenten (z. B. Claude Code)
über das [Model Context Protocol](https://modelcontextprotocol.io) nutzbar — **ohne** dass
Klardaten aus Mandantendokumenten die eigene Infrastruktur verlassen. Er ist ein eigenständiger
HTTP-Prozess, der die Desk-API (`packages/server`) über das reguläre REST-Interface anspricht
(siehe [rest.md](rest.md)) und dabei sämtliche Texte, die an das Sprachmodell gehen, vorher
durch den externen Anonymisierungsdienst **anymize** schickt.

Quelle für alle Angaben dieser Seite: `packages/mcp/src/server.ts` (Tool-Registrierungen),
`packages/mcp/src/main.ts` (HTTP-Transport), `packages/mcp/src/config.ts` (Umgebungsvariablen),
`packages/mcp/src/token.ts` (`npm run mcp:token`), `packages/mcp/README.md`.

## Zweck: KI-Zugriff ohne Klardaten

Jeder Text, der einem Modell über ein MCP-Tool angezeigt wird — Schreibtisch-/Aktennamen,
Dokumentnamen, Notizzettel-Texte, Stempel-Texte, Verknüpfungsnotizen, Volltexte aus
`get_document_text` — läuft vorher durch `Anonymizer.anonNames`/`anonFileText`
(`packages/mcp/src/anonymizer.ts`), die den anymize-Dienst aufrufen und personenbezogene
Angaben durch Platzhalter ersetzen. Das Modell sieht ausschließlich anonymisierten Text; erst
wenn ein Nutzer eine lesbare Antwort braucht, übersetzt `deanonymize` (bzw. intern die
Schreib-Tools) die Platzhalter wieder zurück.

## Anonymisierung im Detail

- **Mapping pro Token partitioniert:** Jede Sitzung wird über das mitgesendete Desk-Server-Token
  identifiziert; `createShared` (`packages/mcp/src/main.ts`, Zeile 25–39) hält einen
  `MappingStore` **pro Token** im Prozessspeicher (`sessions.get(token)`). Platzhalter aus der
  Sitzung eines Nutzers sind für einen anderen Nutzer damit unauflösbar — ein fremder
  Platzhalter bleibt für `deanonymize` und die Schreib-Tools „unbekannt" (siehe
  `packages/mcp/README.md`, Abschnitt „Platzhalter-Zuordnungen, Mandantentrennung und
  Speicherwachstum"). Der Dateitext-Cache (anonymisierte Volltexte je `fileId`) ist dagegen
  bewusst **prozessweit** geteilt — der Zugriff ist über die Desk-API bereits gegatet, das
  spart anymize-Credits über Nutzer hinweg.
- **`deanonymize` vor Schreibzugriffen:** Text-Argumente, die Klartext an den Schreibtisch
  zurückschreiben (`rename_stack`, `add_note`, `edit_note`, `add_stamp` mit `freeText`,
  `set_link_note`, `create_desk`, `rename_desk`), laufen zuerst durch die lokale `deanon()`-
  Funktion (`packages/mcp/src/server.ts`, Zeile 113–122) — Platzhalter im vom Modell gelieferten
  Text werden dort in Klartext zurückübersetzt, **bevor** der Command an den Desk-Server geht.
  Enthält der Text einen unbekannten Platzhalter (z. B. weil die Mapping-Zuordnung durch einen
  Neustart verloren ging), wirft `deanon()` einen Fehler statt den Platzhalter unübersetzt zu
  schreiben.
- **Ohne API-Key:** `loadConfig` (`packages/mcp/src/config.ts`, Zeile 11–21) wirft beim Start
  `Error('ANYMIZE_API_KEY fehlt')`, wenn die Variable leer/nicht gesetzt ist — der Server startet
  in diesem Fall gar nicht.
- **Zero Detection Radius (ZDR):** Laut `packages/mcp/README.md` muss im anymize-Account der
  „Zero Detection Radius" **AUS** sein — ist er aktiv, verschleiert anymize deutlich mehr
  Dokumente/Begriffe als gewünscht.
- **Credits/Caching:** Jedes Wort im Dokument kostet 1 anymize-Credit; das Caching gilt nur pro
  Prozesslaufzeit (kein Cache über Neustarts hinweg) — mehrfaches Lesen desselben Dokuments in
  derselben Laufzeit spart Credits (`packages/mcp/README.md`).

## Einrichtung

**Umgebungsvariablen** (`packages/mcp/src/config.ts`, Zeile 1–21):

| Variable | Default | Bedeutung |
|---|---|---|
| `MCP_PORT` | `4820` | Port des MCP-Servers |
| `DESK_SERVER_URL` | `http://localhost:4810` | Basis-URL der Desk-API |
| `ANYMIZE_API_KEY` | — (Pflicht) | API-Key für anymize; fehlt er, startet der Prozess mit Fehler |
| `ANYMIZE_API_URL` | `https://app.anymize.ai` | Basis-URL des anymize-Dienstes |
| `MCP_ALLOW_DEANONYMIZE` | `true` | `false` deaktiviert das `deanonymize`-Tool (Registrierung entfällt komplett) |

**Dieselben zwei Variablennamen, zweiter (unabhängiger) Prozess (VOICE-01, 14-09):** Seit Plan
14-09 liest auch der Digital-Desktop-Server (`packages/server`, NICHT dieser MCP-Prozess)
`ANYMIZE_API_KEY`/`ANYMIZE_API_URL` — für die Diktat-Transkription
(`packages/server/src/transkription.ts`), unabhängig von dieser MCP-Anbindung. Beide Prozesse
lesen ihre eigene Umgebung getrennt; ein Schlüssel, im Serverprozess gesetzt, macht die
Transkription verfügbar, unabhängig davon, ob der MCP-Server überhaupt läuft. Einrichtung und
die Betriebs-Zusicherung (Schlüssel ausschließlich serverseitig, kein Startfehler bei fehlendem
Schlüssel) stehen in [`README.md`](../../README.md#transkription-anymize).

**Start:**

```bash
ANYMIZE_API_KEY=<key> npm run mcp
```

**Token erzeugen** (interaktiv, fragt nach Desk-Server-URL, Benutzername, Passwort und meldet
sich per `POST /api/v1/auth/login` an — `packages/mcp/src/token.ts`):

```bash
npm run mcp:token
```

Das ausgegebene Token ist ein reguläres Desk-Server-Sitzungstoken (siehe [rest.md](rest.md) →
`POST /auth/login`) — derselbe Auth-Mechanismus wie die Browser-App, keine separate
MCP-Benutzerverwaltung.

## Betriebsempfehlung: dediziertes Konto für den MCP-Token

Der MCP-Server hat **keine eigene Identität** — `npm run mcp:token` meldet sich mit
Benutzername/Passwort eines ganz normalen Desk-Server-Kontos an und gibt dessen
Sitzungstoken aus (siehe oben). Alle Aktionen, die ein KI-Agent über MCP-Tools auslöst
(`move_document`, `add_note`, `trash_object`, …), laufen serverseitig als Commands über
`POST /api/v1/desks/:id/commands` und werden dort — wie jede andere Aktion — mit dem Actor
dieses Kontos gestempelt und journaliert (`createdBy`/`createdAt` auf neu erzeugten Objekten,
Actor-Einträge in [GET /desks/:id/journal](rest.md#get-apiv1desksidjournal)).

**Empfehlung:** Für den MCP-Token ein **eigenes, dediziertes Konto** anlegen (z. B.
`ki-agent`), statt ein bestehendes Menschen-Konto oder das Konto des einrichtenden Nutzers
mitzuverwenden. Ohne diese Trennung erscheinen KI-ausgelöste Änderungen im Journal und in
`createdBy`/`trashedBy` unter dem Namen des Menschen, dessen Zugangsdaten für `npm run
mcp:token` verwendet wurden — nicht unterscheidbar von dessen eigenen, manuellen Aktionen in
der Browser-App. Ein eigenes Konto macht KI-Aktionen im Journal auf einen Blick erkennbar
(`actorName: "ki-agent"`) und erlaubt es, das Token bei Bedarf unabhängig von einem
menschlichen Konto zu rotieren oder zu widerrufen (`POST /auth/logout` mit diesem Token,
ohne die Sitzung eines Menschen zu beenden). Das Konto braucht keine besonderen Rechte — die
Desk-API kennt keine rollenbasierten Berechtigungen (jedes Konto sieht alle Schreibtische,
siehe [rest.md → GET /desks](rest.md#get-apiv1desks)) — der Nutzen liegt allein in der
Unterscheidbarkeit im Journal.

## Transport

HTTP, stateless **Streamable HTTP** nach MCP-Spezifikation (`StreamableHTTPServerTransport` mit
`sessionIdGenerator: undefined`), ein Endpunkt (`packages/mcp/src/main.ts`, Zeile 41–70):

```
POST http://<host>:<MCP_PORT>/mcp
authorization: Bearer <TOKEN>
```

`<TOKEN>` ist das Desk-Server-Token aus `npm run mcp:token`. Fehlt/passt der Header nicht
(`Bearer `-Präfix), antwortet der MCP-Server mit `401 { "error": "Authorization-Header mit
Desk-Server-Token erforderlich" }`; jede andere HTTP-Methode auf `/mcp` liefert `405 { "error":
"Nur POST wird unterstützt (stateless Streamable HTTP)" }`. Pro Request wird ein frischer
`McpServer` samt Transport aufgebaut und beim Schließen der Antwort wieder abgebaut (`res.on
('close', …)`, Zeile 55–58) — es gibt keinen persistenten Session-Zustand auf Protokollebene,
nur die token-partitionierte Anonymisierungs-Session aus `createShared`.

Client-Anbindung (Beispiel Claude Code, aus `packages/mcp/README.md`):

```bash
claude mcp add --transport http desk http://<server>:4820/mcp --header "Authorization: Bearer <token>"
```

## Tools

Registrierung einheitlich über den `tool()`-Helfer (`packages/mcp/src/server.ts`, Zeile 27–36):
Ausnahmen werfen zu `{ isError: true, content: […] }`, Erfolge zu
`{ content: [{ type: "text", text: … }] }`. Bei `401` vom Desk-Server lautet die Meldung
einheitlich „Token ungültig — neues Token mit npm run mcp:token erzeugen" (`meldung()`, Zeile
21–25).

| Name | Beschreibung (aus der Registrierung) | liest/schreibt |
|---|---|---|
| `list_desks` | Listet alle Schreibtische des Benutzers (Namen anonymisiert). | liest |
| `get_desk` | Liefert den kompletten Schreibtisch: Karten, Stapel (inkl. Konvolut-Status), Verknüpfungen, Zettel, Ausschnitte, Stempel, Fahnen, Tipp-Ex/Schwärzungs-Zähler, Klammern und Papierkorb (Texte anonymisiert). Karten tragen im jlawyer-Modus zusätzlich optional die reinen Flags `sourceGone` (boolean) und `sourceReplacedAt` (ISO-Zeitpunkt) aus dem j-lawyer-Referenzstatus — kein Klartext, nur bei gesetztem Wert überhaupt im Feld vorhanden (siehe rest.md → GET /cases/:id/desk für die Semantik). | liest |
| `get_document_text` | Liefert den anonymisierten Volltext eines Dokuments (PDF via OCR; bei konvertierbaren Dateien über die Vorschau-Konvertierung). | liest |
| `move_document` | Verschiebt eine Karte an eine neue Position. | schreibt |
| `stack_documents` | Legt eine Karte auf eine andere (bildet/erweitert einen Stapel). | schreibt |
| `remove_from_stack` | Nimmt eine Karte aus ihrem Stapel und legt sie an eine Position. | schreibt |
| `dissolve_stack` | Löst einen Stapel auf — die Karten bleiben erhalten. | schreibt |
| `rename_stack` | Benennt einen Stapel um (Platzhalter werden in Klartext übersetzt). | schreibt |
| `move_stack` | Verschiebt einen Stapel. | schreibt |
| `link_documents` | Verbindet zwei Objekte (Karten, Stapel, Notizzettel oder Ausschnitte) mit einer Schnur. | schreibt |
| `add_note` | Legt einen Notizzettel bzw. ein Gedankenobjekt auf den Schreibtisch (Platzhalter im Text werden in Klartext übersetzt). | schreibt |
| `edit_note` | Ersetzt den Text eines Notizzettels (Platzhalter werden übersetzt). | schreibt |
| `remove_note` | Entfernt einen Notizzettel samt seiner Schnüre. | schreibt |
| `add_stamp` | Stempelt eine Dokumentseite: preset (ERLEDIGT/WICHTIG/FRIST!/GEPRÜFT/EINGANG/ENTWURF/KOPIE) ODER freeText (Platzhalter werden übersetzt). Position automatisch oben rechts. | schreibt |
| `remove_stamp` | Entfernt einen Stempelabdruck. | schreibt |
| `add_flag` | Setzt eine Notizfahne (gelb/rot/blau/gruen) an den Seitenrand — Klick springt zur Seite. | liest+schreibt (liest zuerst die vorhandenen Fahnen des Dokuments, um den Offset zu staffeln) |
| `remove_flag` | Entfernt eine Notizfahne. | schreibt |
| `staple_stack` | Heftet einen Stapel zum Konvolut (blättert dann als Ganzes). | schreibt |
| `unstaple_stack` | Entheftet ein Konvolut wieder zum losen Stapel. | schreibt |
| `clip_objects` | Klammert zwei Objekte zusammen (gemeinsames Verschieben). | schreibt |
| `remove_clip` | Löst eine Büroklammer-Gruppe. | schreibt |
| `trash_object` | Legt ein Objekt in den Papierkorb (wiederherstellbar — NICHT endgültig). | schreibt |
| `restore_trash` | Holt einen Korb-Eintrag zurück auf den Tisch. | schreibt |
| `set_note_done` | Hakt einen To-do-Zettel ab oder hebt das Abhaken auf. | schreibt |
| `extract_page` | Enthefterzange: löst eine Seite eines Dokuments als eigene Karte heraus (nicht destruktiv). | schreibt |
| `set_link_note` | Setzt die Notiz einer Verknüpfung (Platzhalter werden übersetzt). | schreibt |
| `remove_link` | Entfernt eine Verknüpfungslinie (die Karten bleiben). | schreibt |
| `create_desk` | Legt einen neuen Schreibtisch an. | schreibt |
| `rename_desk` | Benennt einen Schreibtisch um. | schreibt |
| `deanonymize` | Übersetzt Platzhalter in Klartext (für lesbare Antworten an den Benutzer). | liest (nur lokales Mapping, kein Desk-Server-Zugriff) — nur registriert, wenn `MCP_ALLOW_DEANONYMIZE` nicht `false` ist |

30 Tools insgesamt (29 immer verfügbar, `deanonymize` per Default aktiv, abschaltbar über
`MCP_ALLOW_DEANONYMIZE=false`).

## Bewusste Auslassungen

Folgende Fähigkeiten der Browser-App sind absichtlich **nicht** als MCP-Tool verfügbar
(kein entsprechender `tool(server, …)`-Aufruf in `packages/mcp/src/server.ts`):

- **Upload** (`POST /api/v1/files`, `POST /api/v1/cases/:id/documents`) — Datei-Uploads sind
  binäre Nutzdaten, die nicht sinnvoll anonymisiert über ein Text-Protokoll an ein Modell
  gereicht werden können; das Hochladen bleibt Sache der Browser-App bzw. eines direkten
  REST-Aufrufs.
- **Schreddern/Korb-leeren** (`shredTrashItem`/`emptyTrash`) — endgültiges Löschen aus dem
  Papierkorb ist per Modell-Tool nicht auslösbar; `trash_object`/`restore_trash` decken den
  reversiblen Teil ab. (Einzelne Anmerkungs-Objekte — Zettel, Stempel, Fahnen, Verknüpfungen,
  Ausschnitte — löschen `remove_note`/`remove_stamp`/`remove_flag`/`remove_link`/`remove_clip`
  sehr wohl endgültig; nur der Korbinhalt selbst bleibt für ein Modell unerreichbar.)
- **Zeichnen/Marks/Tape** (`addStroke`, `addMark`/Tipp-Ex/Schwärzung, `tapeObject`/
  `untapeObject`) — feinmotorische, freihändige bzw. rein visuelle Aktionen ohne sinnvolle
  Text-Repräsentation für ein Sprachmodell; ein Modell kann keine Maus führen.
- **Cutouts/Highlights erzeugen** (`addCutout`) — das Ausschneiden eines Bildausschnitts
  erfordert eine Bildschirm-/Pixelauswahl, die über MCP-Textargumente nicht sinnvoll
  spezifizierbar ist; bestehende Cutouts sind über `get_desk` trotzdem lesbar.
- **Viewer-/Gestaltungs-Zustand** (Zoom, Seitenansicht, Hintergrundfarbe/-textur,
  Sortierung/Rotation einzelner Karten außerhalb von `position`) — rein clientseitige/optische
  Zustände ohne fachlichen Mehrwert für einen KI-Agenten, der auf Inhalte statt Layout-Feinheiten
  zielt.
- **Auth-Verwaltung** (Login, Setup, Token-Ausstellung, Betriebsmodus-Wechsel) — Anmeldung
  bleibt außerhalb des MCP-Protokolls (`npm run mcp:token`, siehe oben); ein Modell soll keine
  Kontoverwaltung durchführen können, das Token wird explizit vom Menschen erzeugt und
  eingerichtet.
