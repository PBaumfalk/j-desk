# Digital Desktop v2 — MCP-Server mit anymize-Anonymisierung (Teilprojekt 4)

**Datum:** 2026-07-16
**Status:** Vom Nutzer freigegeben
**Baut auf:** Teilprojekte 1–3 (Client-Server, Mehrschreibtisch-UI, Benutzer & Teilen); Grundsatzentscheidung aus `2026-07-16-desk-server-design.md`: der MCP-Server spricht dieselbe HTTP-API wie die Clients

## Ziel

KI-Assistenten (Claude Code, Claude Desktop, andere MCP-Clients) können Schreibtische lesen und organisieren — DSGVO-bewusst: Alle Inhalte, die Richtung KI gehen, werden zuvor über die **anymize.ai-API anonymisiert**; Klartext personenbezogener Daten verlässt das Heimnetz nur anonymisiert.

Getroffene Grundsatzentscheidungen:

- **Netzwerkdienst im Heimnetz** (Streamable HTTP), kein lokaler stdio-Prozess pro Client und kein claude.ai-Remote-Connector.
- **Token-Durchreiche:** Jeder MCP-Client authentifiziert sich mit einem Desk-Server-Session-Token; der MCP-Server reicht es durch. Jeder Benutzer agiert als er selbst, die TP3-Rechte gelten automatisch.
- **Lesen + Organisieren, kein Löschen von Inhalten**, keine Uploads, kein Teilen.
- **anymize als Anonymisierungs-Schicht** (Ansatz B): Lese-Tools liefern anonymisierte Inhalte; Schreib-Tools de-anonymisieren serverseitig; zusätzlich ein `deanonymize`-Tool für lesbare KI-Antworten, das per Konfiguration abschaltbar ist.

## Architektur & Deployment

Neues Workspace-Paket `packages/mcp` (TypeScript, offizielles `@modelcontextprotocol/sdk`):

- Eigenständiger Prozess neben dem Desk-Server: `npm run mcp`, Standard-Port 4820 (ENV `MCP_PORT`), Transport **Streamable HTTP** unter `/mcp`.
- ENV-Konfiguration: `DESK_SERVER_URL` (Standard `http://localhost:4810`), `ANYMIZE_API_KEY`, `ANYMIZE_API_URL`, `MCP_ALLOW_DEANONYMIZE` (Standard `true`; `false` = striktes Regime, das `deanonymize`-Tool wird gar nicht erst angeboten).
- **MCP-Clients** schicken `Authorization: Bearer <Desk-Session-Token>`. Anbindung z. B. `claude mcp add --transport http desk http://server:4820/mcp --header "Authorization: Bearer …"`.
- **Login-Helfer** `npm run mcp:token`: fragt Server-URL, Benutzername, Passwort ab (Eingabe verdeckt), ruft `POST /auth/login` auf und druckt das Token für die Client-Konfiguration.
- **Desk-Server-API:** Der MCP-Server ist reiner API-Client (`/api/v1`-Routen aus TP1–TP3); das Bearer-Token wird pro Anfrage durchgereicht. Er hat keinerlei eigenen Datenbestand außer In-Memory-Caches.
- **anymize-API:** serverseitig mit `ANYMIZE_API_KEY` (ein Schlüssel pro Installation; Benutzeridentität kommt vom Desk-Token).

**Fail-closed-Grundsatz:** Ist anymize nicht erreichbar oder liefert Fehler, gibt der MCP-Server niemals Klartext-Inhalte aus. Betroffene Tools melden einen Fehler („Anonymisierung nicht verfügbar"); Layout-Operationen ohne Textbezug funktionieren weiter.

## Tools

Lese-Tools:

| Tool | Eingaben | Liefert |
|---|---|---|
| `list_desks` | — | Schreibtische: id, anonymisierter Name, isOwner |
| `get_desk` | deskId | Karten, Stapel, Verknüpfungen: ids, anonymisierte Namen, Positionen, anonymisierte Link-Notizen |
| `get_document_text` | deskId, docId | Anonymisierter Volltext des Dokuments (PDF via Desk-API laden → anymize-File-API inkl. OCR → anonymisierter Text; Ergebnis pro fileId gecacht) |

Organisier-Tools (1:1 auf die bestehenden Kommandos/Routen der Desk-API):

| Tool | Desk-API |
|---|---|
| `move_document` | `moveDoc` |
| `stack_documents` | `stackDocs` |
| `remove_from_stack` | `removeFromStack` |
| `dissolve_stack` | `dissolveStack` (Karten bleiben erhalten) |
| `rename_stack` | `renameStack` |
| `move_stack` | `moveStack` |
| `link_documents` | `addLink` |
| `set_link_note` | `setLinkNote` |
| `remove_link` | `removeLink` |
| `create_desk` | `POST /desks` |
| `rename_desk` | `PATCH /desks/:id` |

Bewusst ausgeschlossen: `removeDoc`, `removeStack`, `DELETE /desks/:id`, Mitglieder/Teilen, `POST /files` (Uploads). Destruktives bleibt beim Menschen.

`deanonymize` (nur wenn `MCP_ALLOW_DEANONYMIZE=true`): Text mit Platzhaltern → Klartext, damit die KI dem Benutzer lesbare Antworten geben kann. Bewusste Abwägung: Der Klartext läuft dann durch den KI-Kontext — wer das nicht will, schaltet das Tool ab (striktes Regime).

## Anonymisierungs-Fluss

Die anymize-API ist dokumentiert in `docs/anymize-api.md` (Referenz-Auszug). Kernpunkte:

- Alle Texte Richtung KI (Desk-, Karten-, Stapelnamen, Link-Notizen, Dokumenttexte) laufen durch die anymize-API: Text via `POST /api/anonymize`, PDFs via `POST /api/ocr` (multipart). Beide sind **asynchron** — Ergebnis per Polling über `GET /api/status/{jobId}` (2–5 s Takt, Timeout mit klarer Meldung).
- Das Mapping Platzhalter↔Original liefert `GET /api/status/{jobId}/strings` (hash_pairs). Die **Token↔Klartext-Zuordnung** hält der MCP-Server im Prozessspeicher (gemeinsam mit dem fileId→Text-Cache). Kein Persistieren von Klartext-Mappings auf Platte.
- **Credits:** Anonymisierung kostet 1 Credit pro Wort. Deshalb wird jedes Anonymisierungs-Ergebnis gecacht: Dokumenttexte pro fileId, Namen/Notizen pro exaktem String — wiederholte Desk-Reads lösen keine neuen anymize-Aufrufe aus.
- **ZDR-Vorbehalt:** Bei aktiviertem Zero Data Retention im anymize-Account sind hash_pairs und `POST /api/deanonymize` nicht verfügbar — der De-Anonymisierungs-Rundweg setzt **ZDR = aus** voraus. Der MCP-Server erkennt den Fall (strings-Abruf schlägt fehl) und meldet ihn verständlich.
- **Schreib-Tools de-anonymisieren serverseitig:** Enthält ein Argument (Stapelname, Link-Notiz, Desk-Name) Platzhalter aus früheren Tool-Antworten, werden sie vor dem Desk-API-Aufruf in Klartext zurückübersetzt. Auf dem Schreibtisch landen nie Platzhalter.
- Unbekannte Platzhalter (z. B. nach Prozess-Neustart): Fehler mit Hinweis, das Dokument erneut zu lesen — niemals Platzhalter durchschreiben.
- De-Anonymisierung (Schreib-Tools und `deanonymize`-Tool) erfolgt **lokal über das gehaltene Mapping** — sie funktioniert damit auch, wenn anymize gerade nicht erreichbar ist. anymizes eigener De-Anonymisierungs-Endpunkt ist nur die Rückfalloption, falls die Anonymisierungs-Antwort kein Mapping ausliefert.
- Verbleibender Research-Schritt zu Beginn der Planphase (mit echtem API-Key): das reale Platzhalterformat verifizieren — die Doku zeigt sowohl `[[Type-HASH]]` als auch `[PREFIX-N]`; die Implementierung erkennt beide Formen tolerant.

## Fehlerbehandlung

- anymize down/Fehler → Tool-Fehler, fail-closed (s. o.).
- Desk-API 401 → „Token ungültig — neues Token mit npm run mcp:token erzeugen"; 403 → „Kein Zugriff auf diesen Schreibtisch"; 404 → „Nicht gefunden". Alle Meldungen deutsch.
- Größenlimits für `get_document_text`: PDFs über 25 MB werden abgelehnt; extrahierter Text wird bei 100.000 Zeichen abgeschnitten (mit Hinweis im Ergebnis).
- MCP-Tool-Fehler als `isError`-Ergebnisse mit verständlichem Text, keine rohen Stacktraces.

## Tests

Vitest im Paket `packages/mcp`:

- **Integrationstests:** echter Desk-Server in-memory (`buildApp` aus `packages/server`) + MCP-Server + offizieller MCP-SDK-Client über Streamable HTTP; **anymize per HTTP-Mock** mit deterministischen Platzhaltern.
- Abgedeckt: Token-Durchreiche (gültig, ungültig, fremder Desk → 403-Meldung); jedes Tool einmal end-to-end; Anonymisierung auf allen Lesewegen (auch Namen); serverseitige De-Anonymisierung beim Schreiben; fail-closed bei anymize-Ausfall; `MCP_ALLOW_DEANONYMIZE=false` versteckt das Tool; Mapping-Verlust-Fehlerpfad; Dokumenttext-Cache (zweiter Aufruf ohne anymize-Call).
- **Manuelle UAT:** gegen echten anymize-Account und Claude Code im Heimnetz.

## Nicht im Umfang (Teilprojekt 4)

- claude.ai-Remote-Connector (OAuth am MCP-Endpunkt)
- Datei-Uploads durch die KI; Löschen von Karten/Stapeln/Schreibtischen; Teilen/Mitgliederverwaltung per KI
- Eingebaute KI-Funktion im Tauri-Client (ggf. späteres Teilprojekt)
- MCP-Resources/-Prompts — nur Tools (YAGNI)
- stdio-Transport (kann bei Bedarf später ergänzt werden, das SDK unterstützt beide)
