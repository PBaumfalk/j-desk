# Digital Desktop — MCP Server

MCP-Server für Desktop-Verwaltung mit anonymisierten Dokumenten (via anymize). Verbindet die Desk-API des Digital-Desktop-Servers mit dem Model Context Protocol.

## Start

```bash
ANYMIZE_API_KEY=<key> npm run mcp
```

Der Server läuft auf Port 4820. Ein Auth-Token ist erforderlich; siehe „Token erzeugen".

## Umgebungsvariablen

| Variable | Default | Beschreibung |
|----------|---------|--------------|
| `MCP_PORT` | `4820` | Port des MCP-Servers |
| `DESK_SERVER_URL` | `http://localhost:4810` | URL des Desk-API-Servers |
| `ANYMIZE_API_KEY` | (erforderlich) | API-Key für anymize-Anonymisierung |
| `ANYMIZE_API_URL` | `https://app.anymize.ai` | URL der anymize-API |
| `MCP_ALLOW_DEANONYMIZE` | `true` | Ob `deanonymize`-Tool verfügbar ist |

## Token erzeugen

```bash
npm run mcp:token
```

Das Skript fragt interaktiv nach Desk-Server-URL, Benutzername und Passwort und gibt das Auth-Token aus.

## Client-Anbindung

In Claude Code:

```bash
claude mcp add --transport http desk http://<server>:4820/mcp --header "Authorization: Bearer <token>"
```

Ersetze `<server>` durch Hostname/IP (z. B. `localhost`) und `<token>` durch die Ausgabe von `npm run mcp:token`.

## Hinweise

### Zero Detection Radius (ZDR)

Im anymize-Account muss der „Zero Detection Radius" **AUS** sein, sonst verschleiert anymize zu viele Dokumente.

### Credits und Caching

Jedes Wort im Dokument kostet 1 Credit. Caching greift pro Prozesslaufzeit (nicht über Prozessgrenzen hinweg). Leseanfragen mehrfach auf einem Dokument sparen Credits.

### Platzhalter-Zuordnungen, Mandantentrennung und Speicherwachstum

Platzhalter→Klartext-Zuordnungen (für `deanonymize` sowie für Schreib-Tools mit Platzhaltern im Text, z. B. `rename_stack`, `set_link_note`, `create_desk`) werden **pro Anmelde-Token** im Prozessspeicher geführt. Ein Benutzer kann damit keine Platzhalter aus der Sitzung eines anderen Benutzers auflösen — ein fremder Platzhalter bleibt unbekannt. Der Dateitext-Cache (anonymisierte Volltexte pro `fileId`) ist dagegen bewusst prozessweit geteilt, da der Zugriff darauf bereits über die Desk-API gegatet ist (spart anymize-Credits über Benutzer hinweg). Folge dieser Teilung: Liest ein zweiter berechtigter Benutzer eine bereits gecachte Datei, erhält er den anonymisierten Text, kann deren Platzhalter aber nicht auflösen — die Zuordnungen liegen nur beim Erstleser, und auch erneutes Lesen füllt sie bis zu einem Server-Neustart nicht nach.

Ein Neustart des MCP-Servers verwirft **alle** Zuordnungen und Caches — Dokumente müssen danach erneut gelesen werden, bevor Platzhalter wieder aufgelöst werden können.

Es gibt kein Eviction/TTL: Die Caches wachsen mit der Prozesslaufzeit (pro aktivem Token sowie der geteilte Dateitext-Cache). Bei sehr langer Laufzeit oder vielen Benutzern ggf. den Server neu starten.

## Tools

| Name | Beschreibung |
|------|--------------|
| `list_desks` | Listet alle Schreibtische des Benutzers (Namen anonymisiert) |
| `get_desk` | Liefert Name, Karten, Stapel und Verknüpfungen eines Schreibtischs (Texte anonymisiert) |
| `get_document_text` | Liefert den anonymisierten Volltext eines Dokuments (PDF via OCR) |
| `move_document` | Verschiebt eine Karte an eine neue Position |
| `stack_documents` | Legt eine Karte auf eine andere (bildet/erweitert einen Stapel) |
| `remove_from_stack` | Nimmt eine Karte aus ihrem Stapel und legt sie an eine Position |
| `dissolve_stack` | Löst einen Stapel auf — die Karten bleiben erhalten |
| `rename_stack` | Benennt einen Stapel um (Platzhalter werden in Klartext übersetzt) |
| `move_stack` | Verschiebt einen Stapel |
| `link_documents` | Verbindet zwei Karten mit einer Verknüpfungslinie |
| `set_link_note` | Setzt die Notiz einer Verknüpfung (Platzhalter werden übersetzt) |
| `remove_link` | Entfernt eine Verknüpfungslinie (die Karten bleiben) |
| `create_desk` | Legt einen neuen Schreibtisch an |
| `rename_desk` | Benennt einen Schreibtisch um |
| `deanonymize` | Übersetzt Platzhalter in Klartext (nur wenn `MCP_ALLOW_DEANONYMIZE` nicht `false`) |
