# DigitalDesk — Langzeitvision (Nordstern)

Erfasst: 2026-07-18. Quelle: vom Auftraggeber (Patrick Baumfalk) übergebene
Gesamtspezifikation. Dieses Dokument ist der **Nordstern** für die
Produktentwicklung — kein Umsetzungsauftrag für einen einzelnen Schritt.
Umgesetzt wird weiterhin inkrementell über einzelne Teilprojekte
(Spec → Plan → Subagent-Driven Development), gemessen an dieser Vision.

Kurzfassung der Idee: J-Lawyer ist der Aktenschrank, DigitalDesk der
Schreibtisch, die PDFs die Papiere. Der Benutzer arbeitet mit Dokumenten so
frei wie mit Papierakten auf einem echten Schreibtisch. Alle Bearbeitungen
sind **nicht destruktiv** und werden als eigene Workspace-Datei (`.jdesk`)
**innerhalb der J-Lawyer-Akte** gespeichert. Später: reichhaltige Werkzeuge,
Gedankenobjekte als eigenständige Arbeitsobjekte, und eine kontrollierte
agentische KI-Schnittstelle (MCP), die auf demselben Schreibtisch arbeitet
wie der Mensch.

---

## Editor's Note: Abgleich mit dem tatsächlichen Stand (2026-07-18)

Diese Vision wurde als geschlossene Spezifikation formuliert und trifft an
mehreren Stellen Technologie-Entscheidungen, die **nicht** zum bereits
gebauten, lauffähigen Stand passen. Das ist kein Fehler der Vision — der Autor
konnte den Ist-Stand darin nicht kennen. Aber bevor irgendetwas davon umgesetzt
wird, müssen diese Divergenzen bewusst entschieden werden. Sie sind hier
dokumentiert, damit sie nicht stillschweigend „mitgebaut" werden.

**Ist-Stand (existiert, getestet, teils reviewt):**
- Monorepo: **ein** npm-Workspace (`packages/core`, `packages/server`,
  `packages/mcp` + Wurzel-Client).
- Frontend: **SvelteKit + Svelte 5** (Runes), PDF via `pdfjs-dist`, DOM-Karten
  (keine Canvas-Engine). Läuft im Browser (Tauri wurde in TP-A gerade entfernt).
- Backend: **Fastify + SQLite** (better-sqlite3), WebSocket-Live-Sync,
  eigene Token-Auth/Kontenverwaltung.
- Persistenz: `DesktopState` (docs/links/stacks) in SQLite auf dem Server.
- MCP: existierender MCP-Server (TP4) mit Anonymisierung, konten-basiert.
- Geplant/laufend: TP-A Browser-Port (fertig, Ready-to-merge, pending UAT),
  Inline-Viewer (`feature/inline-viewer`, Spec geschrieben, pending Review).

**Divergenzen Vision ↔ Ist-Stand (Entscheidungsbedarf):**
1. **Frontend-Framework:** Vision nennt *React + Vite + Konva/Pixi/Fabric +
   Zustand/Redux*. Ist: *SvelteKit + Svelte 5 + DOM*. → Hard requirement oder
   Default des Autors? Ein Wechsel bedeutet praktisch Neubau des Clients.
2. **Rendering-Engine:** Vision will Canvas-Engine (Konva/Pixi) für 200+
   Objekte @ 60fps. Ist: DOM-Karten. Für die Werkzeug-/Objekt-Dichte der
   Vision ist eine Canvas-Engine plausibel nötig — betrifft die Frontend-Wahl.
3. **Datenbank:** Vision nennt *PostgreSQL* + optional Redis. Ist: *SQLite*.
   ABER: die Vision speichert den Workspace als `.jdesk` **in J-Lawyer**, nicht
   in einer eigenen DB → eine eigene DB ist evtl. gar nicht nötig (nur für
   Sessions/Locks/Audit). Das reduziert die Divergenz stark.
4. **Workspace-Format:** Vision = versioniertes `.jdesk`-ZIP in der J-Lawyer-Akte.
   Ist: `DesktopState`-JSON in SQLite. → Der Wechsel auf `.jdesk`-in-J-Lawyer
   ist ein Kernstück der Vision und ersetzt die heutige Server-Persistenz.
5. **Bridge/Tauri:** Vision führt eine **kleine** Tauri-Bridge wieder ein
   (Dateityp-Registrierung `.jdesk`, `digitaldesk://`-Protokoll, Browserstart).
   Das ist eine ANDERE Rolle als das alte Tauri (das der ganze Client war) —
   kein Widerspruch zum TP-A-Entfernen, aber bewusst zu planen.
6. **Domänenmodell:** Vision modelliert Seiten als First-Class `PageInstance`,
   dazu `Cutout`, `StickyNote`, `Annotation`, `StringRelation`, `ToolObject`,
   `WorkspaceOperation` (mit inversem Command für Undo). Ist: `Doc`/`Link`/
   `Stack`. → Deutliche, aber schrittweise erreichbare Erweiterung.
7. **Paketmanager/Monorepo-Tool:** Vision = *pnpm + Turborepo/Nx*. Ist: *npm
   workspaces*. Divergenz gering, aber vorhanden.
8. **Produktname:** Vision = „DigitalDesk". Ist: „Digital Desktop". Trivial,
   aber angleichen.

**Was sich NICHT beißt (direkt anschlussfähig):**
- „J-Lawyer als führendes System, nicht destruktiv, kein Schatten-DMS" deckt
  sich exakt mit dem bereits beschlossenen Browser+J-Lawyer-Rework.
- Bestehende Bausteine sind Vorarbeit: `packages/core` (Command-Pattern,
  Zustandslogik), Links (= „Schnüre"), Stacks, der WebSocket-Live-Sync, der
  IndexedDB-Seiten-Cache, und der vorhandene MCP-Server (Anonymisierung!).
- Der aktuell geplante Inline-Viewer ist ein gültiger Trittstein (Seite groß
  anzeigen = Bühne für Annotationen), auch wenn die Vision Seiten später als
  `PageInstance` first-class modelliert.

**Offene Grundsatzentscheidung (dem Auftraggeber vorzulegen):**
Inkrementelle Evolution des bestehenden Svelte/SQLite-Stands hin zur Vision,
ODER Neubau auf dem in der Vision genannten Stack (React/Konva/Postgres,
pnpm/Turborepo-Monorepo). Empfehlung des Entwicklers: **inkrementelle
Evolution**, mit bewusster Nachprüfung der Canvas-Engine-Frage, sobald die
Objekt-/Werkzeugdichte es erzwingt. Begründung: lauffähiger, getesteter Stand;
die wertvollsten Vision-Ideen (`.jdesk`-in-J-Lawyer, nicht destruktives
Seitenmodell, Werkzeuge, Gedankenobjekte, KI) sind additiv erreichbar; ein
React-Neubau verwirft funktionierenden Code und zieht bereits behobene Fehler
erneut ein.

---

## Kanonische Spezifikation (vom Auftraggeber übergeben, unverändert)

Die folgenden fünf JSON-Blöcke sind die wörtlich übergebene Vision. Bei
Konflikten mit dem „Editor's Note"-Abgleich oben entscheidet der Auftraggeber.

### Block 1 — Projekt, Architektur, Workspace, Domäne, Werkzeuge, MVP, Phasen

```json
{
  "project": {
    "name": "DigitalDesk",
    "working_title": "DigitalDesk for J-Lawyer",
    "core_metaphor": "J-Lawyer ist der Aktenschrank. DigitalDesk ist der Schreibtisch. Die PDFs sind die Papiere. Die Workspace-Datei speichert, wie der Schreibtisch aussieht und was der Benutzer mit den Papieren gemacht hat.",
    "primary_goal": "Browserbasierte Anwendung, in der Benutzer mit digitalen Dokumenten so frei wie mit Papierakten auf einem echten Schreibtisch arbeiten. J-Lawyer bleibt führendes Akten-/DMS. DigitalDesk ist optionale visuelle Arbeitsoberfläche, lädt Dokumente aus J-Lawyer, bearbeitet nicht destruktiv, speichert den Arbeitszustand als Workspace-Datei in der J-Lawyer-Akte."
  },
  "workspace_file": {
    "preferred_extension": ".jdesk",
    "format": "ZIP-basierter, versionierter Container mit JSON-Dateien und optionalen Binärressourcen",
    "mime_type": "application/vnd.digitaldesk.workspace+zip",
    "must_not_contain": ["J-Lawyer-Passwörter", "dauerhafte API-Tokens", "unverschlüsselte Zugangsdaten", "unnötige Vollkopien aller Originaldokumente"],
    "storage_modes": ["linked (Referenzen, Standard)", "frozen (eingefrorene Kopien für Archiv/Offline)"],
    "structure": ["manifest.json", "workspace.json", "annotations/{highlights,ink,notes}.json", "relations/strings.json", "objects/cutouts.json", "previews/", "recovery/", "integrity/checksums.json"],
    "versioning": "fortlaufende Revision + eindeutige Revision-ID; Migrationssystem hebt ältere Versionen; Integritätsprüfung von Manifest/Schema/Prüfsummen/Referenzen; Recovery beschädigter Teilbereiche"
  },
  "domain_entities": ["Workspace", "Desk", "DocumentReference", "PageInstance", "DocumentInstance", "Stack", "Cutout", "StickyNote", "Annotation", "StringRelation", "ToolObject", "WorkspaceOperation(inverse für Undo)"],
  "coordinate_system": "Schreibtisch in Weltkoordinaten; quellenbezogene Bereiche in normalisierten Seitenkoordinaten 0..1",
  "source_reference_rule": "Alle nicht destruktiven Bearbeitungen verweisen auf stabile J-Lawyer-Dokument-ID, Seitenzahl und möglichst Dokument-Hash/Version.",
  "components": ["J-Lawyer Client", "DigitalDesk Bridge (klein, Tauri 2 o. ä.)", "Browser Frontend", "Backend", "J-Lawyer Adapter (Mock + HTTP, isoliert)"],
  "primary_flow": ["Benutzer öffnet .jdesk in J-Lawyer", "OS übergibt an Bridge", "Bridge liest nur minimales Manifest", "Bridge holt Einmal-Token vom Backend", "Bridge öffnet Browser mit nicht wiederverwendbarer Session-URL", "Backend prüft Benutzer/Akte/Workspace", "Backend lädt Workspace + Quelldokumente aus J-Lawyer", "Frontend stellt Schreibtisch wieder her", "Änderungen lokal sofort + Autosave", "Speichern erzeugt neue Workspace-Version in J-Lawyer"],
  "tools": ["Hand", "Enthefterzange", "Hefter", "Büroklammer", "Schere", "Lineal", "Textmarker", "Bleistift", "Kugelschreiber", "Radiergummi", "Tipp-Ex", "Schwärzungswerkzeug", "Notizzettel", "Notizfahne", "Klebeband", "Schnur", "Locher", "Stempel", "Lupe", "Lichttisch", "Kopierer", "Scanner", "Papierkorb", "Schredder"],
  "stacks_preferred": {"frontend": "React+TS, Vite, Zustand/Redux, Konva/Pixi/Fabric, PDF.js, Zod, Vitest/RTL/Playwright", "backend": "Node+TS, Fastify/NestJS, PostgreSQL, Redis optional, S3/FS hinter Interface, Zod/JSON-Schema, OpenAPI, Vitest/Jest/Testcontainers", "repo": "pnpm, Turborepo/Nx"},
  "concurrency_mvp": "Bearbeitungssperre pro Workspace (Lock mit Lease+Heartbeat, Lesemodus für weitere), später CRDT/OT vorbereitet",
  "jlawyer_write_policy": ["keine stillen Änderungen an Originalen", "Entheften/Schere ändern nur Workspace", "neue PDFs nur nach ausdrücklicher Aktion", "kein Überschreiben von Originalen im MVP", "neue Fassung = neues Dokument/Version"],
  "implementation_phases": [
    "1 Foundation: Monorepo, Domänenmodell, Workspace-JSON-Schema, Mock-J-Lawyer, Basis-Backend+OpenAPI, leeres Frontend",
    "2 Vertical Slice: Mock-Akte→PDF laden→auf Tisch→verschieben/drehen/skalieren→speichern→wieder öffnen (exakt wiederhergestellt)",
    "3 Paper Model: Seiteninstanzen, Enthefterzange, Stapel, virtuelles Heften, Seitenreihenfolge",
    "4 Desk Tools: Textmarker, Stift, Radiergummi, Notizzettel, Notizfahnen, Schere, Schnüre, Lineal, Lupe",
    "5 Bridge: .jdesk registrieren, Übergabe, sichere Browser-Session, digitaldesk://, Öffnen im lokalen J-Lawyer",
    "6 J-Lawyer Adapter: Interface stabil, HTTP-Adapter, Config, Rechte, Streaming, Workspace-Update, neues PDF ablegen",
    "7 Reliability/Security: Autosave, Revisionen, Locks, Snapshots, Audit, ZIP/Schema-Sicherheit, Threat Model, E2E"
  ],
  "not_in_first_mvp": ["KI-Analyse", "autom. juristische Kategorisierung", "vollständige Echtzeitkollaboration", "OCR-Eigenbau", "Mobile-App", "Überschreiben von J-Lawyer-Originalen", "komplexe Physik", "vollständige Kanzleiadministration"],
  "engineering_rules": ["TS strict überall", "kein any ohne Begründung", "Domänenlogik unabhängig von UI/DB", "J-Lawyer-Logik nur im Adapter", "Workspace-Schema laufzeitvalidiert", "alle Schreibvorgänge idempotent", "keine stillen Datenverluste", "keine Dummies als fertig", "kleine fokussierte Module", "Tests für Serialisierung, Undo/Redo, Locks/Revisionskonflikte, E2E Öffnen/Speichern"],
  "demo_case": "Fiktive baurechtliche Nachbarakte (Baugenehmigung, Betriebsbeschreibung, Lageplan, Brandschutz, Foto-Stellplätze, Mandantennotiz)"
}
```

### Block 2 — Schreibtisch-Erscheinungsbild (Themes/Material)

```json
{
  "desk_appearance": {
    "default_theme": "dark_green",
    "design_rules": ["nur dunkle, gedeckte, professionelle Töne als Standard", "Papier hebt sich deutlich ab", "Werkzeuge/Auswahl/Markierungen überall gut erkennbar", "Hintergrund verändert nie die echten Farben von Dokumenten/Annotationen", "Materialstrukturen dezent, Lesbarkeit gewahrt"],
    "themes": ["dark_green (Standard)", "bordeaux", "navy_blue", "anthracite", "dark_brown", "deep_purple", "dark_white (Off-White/Pergament)", "ivory (Elfenbein)"],
    "materials": ["smooth", "felt", "leather", "wood", "parchment"],
    "customization": ["Farbe pro Schreibtisch", "Material", "Helligkeit", "Strukturintensität", "optionale Vignette", "optionaler Tischrahmen", "im Workspace speichern", "persönlicher Standard für neue Schreibtische"],
    "workspace_model_extension": {"background": {"themeId": "dark_green", "material": "felt", "brightness": 1, "textureIntensity": 0.25, "vignette": true}},
    "light_surface_rules": ["dunkle Werkzeugleisten/Rahmen", "weiße Seiten durch Schatten/Kontur/Tiefe absetzen", "Hintergrund und Papier nie ineinanderlaufen", "für helle Themes stärkere Kontur + Schlagschatten"]
  }
}
```

### Block 3 — Zukunftsfeatures & Gedankenobjekte

```json
{
  "future_features": {
    "guiding_principle": "DigitalDesk = frei gestaltbarer juristischer Denk- und Arbeitsraum, der den analogen Schreibtisch möglichst vollständig nachbildet und Neues schafft.",
    "features": ["desk_drawers (Schubladen)", "desk_pads (Arbeitsunterlagen/Blöcke)", "desk_lamp (Spotlight)", "edge_trays (Randablage)", "page_tabs (Papierlaschen)", "handwriting_search", "free_canvas (freie Skizzen)", "whiteboard_mode", "workspace_timeline (Zeitmaschine)", "paper_thickness", "paper_weight", "loose_clips", "briefcase (Aktenkoffer)", "multi_monitor", "infinite_workspace", "magnet_bar", "push_pins", "chaos_mode", "custom_tools", "visual_reminders"]
  },
  "thinking_objects": {
    "vision": "Juristische Überlegungen als eigenständige Schreibtischobjekte, gleichberechtigt neben Dokumenten.",
    "types": ["question (Frage)", "hypothesis (These)", "claim (Behauptung)", "evidence_goal (Beweisziel)", "attack_point (Angriffspunkt)", "risk (Risiko)", "idea (Idee)", "todo (To-do)", "argument (Argument)", "legal_issue (Rechtsfrage)"],
    "relationships": ["mit Dokumenten verbindbar", "untereinander verbindbar", "Angriffspunkt referenziert mehrere Beweismittel", "Behauptung durch mehrere Dokumente gestützt/widerlegt", "Rechtsfrage mit Normen/Urteilen/Schriftsätzen verknüpft"],
    "strategic_goal": "Von der Dokumentenoberfläche zum visuellen juristischen Denkraum."
  }
}
```

### Block 4 — Agentische KI-Integration (MCP)

```json
{
  "agentic_ai_integration": {
    "vision": "Kontrollierte agentische Schnittstelle: KI versteht den Schreibtisch (Scene Graph) und führt je nach Berechtigung sichtbare, rückgängig machbare Arbeitsvorgänge aus — auf DEMSELBEN Schreibtisch wie der Mensch.",
    "preferred_protocol": "Model Context Protocol (DigitalDesk MCP Server)",
    "components": ["Agent Gateway (Auth, zeitlich begrenzte Sitzungen, Scope-Bindung, Validierung, Protokoll, Ratenlimit)", "MCP Server (Resources + typisierte Tools → interne Commands)", "AI Orchestrator (mehrstufige Aufträge, Limits, Protokoll)", "Approval Service (menschliche Freigaben, Vorher-Nachher-Vorschau)"],
    "perception": "Primär strukturierter Scene Graph; Screenshots/gerenderte Seiten ergänzen. Layer: structured/text/visual/spatial. Sichtbarkeit: standardmäßig nur aktueller Schreibtisch; verdeckte/geschlossene Dokumente nur auf Abruf; Quellenpflicht.",
    "scopes": ["selection_only", "visible_desk", "entire_desk", "workspace", "case_read_only", "case_write"],
    "permission_levels": ["observe", "suggest", "arrange", "create", "external_write(approval_required)"],
    "mcp_resources": ["digitaldesk://workspace/current", "desk/current", "desk/current/viewport", "desk/current/selection", "document/{id}", "document/{id}/page/{n}", "document/{id}/page/{n}/image", "object/{id}", "workspace/{id}/history", "case/{id}/documents"],
    "mcp_tools_readonly": ["desk_get_state", "desk_get_viewport_snapshot", "desk_find_objects", "document_read_pages", "document_search", "jlawyer_search_case_documents"],
    "mcp_tools_reversible_write": ["desk_move_objects", "desk_rotate_objects", "desk_arrange_objects", "desk_create_stack", "desk_unstack", "desk_unstaple_document", "desk_staple_pages", "desk_create_cutout", "desk_add_highlight", "desk_add_sticky_note", "desk_create_thinking_object", "desk_connect_objects", "desk_create_new_desk", "desk_create_snapshot"],
    "mcp_tools_approval": ["document_compose_pdf (approval)", "jlawyer_save_new_document (explicit)", "jlawyer_create_case_note (explicit)"],
    "agent_modes": ["assistant", "preview", "coworker", "supervised_agent", "batch_agent"],
    "human_in_the_loop": "KI darf denken/vorbereiten; rechtlich/revisionsrelevant/extern wirkende Handlungen bleiben menschlich (immer Freigabe: J-Lawyer-Schreiben, endgültige Schwärzung, Export, unwiderrufliches Löschen, weitere Akten öffnen, externe Weitergabe, Fristen/Wiedervorlagen).",
    "operation_model": "KI nutzt DIESELBEN Commands wie der Mensch; jedes Command actorType human|ai + Sitzung/Zeit/Begründung; reversible Aktionen mit inversem Command; ganzer KI-Auftrag als Command-Gruppe in einem Schritt undo-bar; keine inkonsistenten Teilzustände.",
    "security": ["Sitzungen zeitlich begrenzt", "nie allgemeine J-Lawyer-Credentials, nur objekt-/aktenspezifische Capability-Tokens", "Tools serverseitig autorisiert/validiert", "read-only und write strikt getrennt", "Prompt-Injection-Abwehr: Dokumentinhalt = nicht vertrauenswürdig, keine Tool-Aufrufe aus Dokumentanweisungen, kein Scope-Self-Upgrade, externe Netzugriffe standardmäßig aus", "revisionssichere Protokolle"],
    "provider_abstraction": "Nicht an einen Anbieter gekoppelt; Interface createAgentSession/sendContext/requestToolCall/submitToolResult/streamResponse/cancelRun/estimateUsage; Anthropic, OpenAI, lokale/selbstgehostete OpenAI-kompatible, künftige MCP-Anbieter.",
    "privacy": ["KI-Anbieter pro Kanzlei konfigurierbar", "lokale/selbstgehostete Modelle", "EU/vertraglich freigegebene Cloud", "kein stiller Versand ganzer Akten, nur bedarfsgerechte Seiten/Ausschnitte", "Anzeige welche Daten an wen", "Ausschlusslisten für sensible Akten", "kein Training auf Kanzleidaten", "Löschung temporärer Daten nach Frist"],
    "mvp_must_have": ["MCP Server", "Agentensitzung für aktuellen Schreibtisch", "Scene Graph als Resource", "Seiten gezielt lesen", "Schreibtisch als Bild", "Objekte suchen", "Objekte verschieben", "neuen Schreibtisch erzeugen", "Notizzettel/Gedankenobjekte/Schnüre/Markierungen erzeugen", "Änderungsvorschau", "vollständiges Undo eines Auftrags", "Audit", "Scope-/Rechteauswahl", "kein J-Lawyer-Schreiben ohne Freigabe"],
    "implementation_instruction": "Agentenschnittstelle als eigenständiger Port der Domäne; KEINE direkte Browser-/DOM-Steuerung; strukturierter Scene Graph + typisierte Tools; jeder schreibende Tool-Aufruf → reguläre, validierte, undo-bare Commands; Start mit lokalem Mock-Agent + MCP-Server; Provider-Adapter austauschbar."
  }
}
```

## Verhältnis zu bestehenden Teilprojekten

- **TP-A Browser-Port** (fertig): erfüllt die Vision-Grundhaltung „reine
  Browser-App, J-Lawyer führend". Bleibt Fundament.
- **Inline-Viewer** (`feature/inline-viewer`, laufend): Trittstein zu Phase 2/4
  der Vision (Seite groß = Bühne für Annotationen). Datenmodell wird später
  Richtung `PageInstance` erweitert.
- **TP-B/TP-C (j-lawyer)** aus dem Browser-Rework-Spec entsprechen den
  Vision-Phasen 6 (Adapter) und dem `.jdesk`-Workspace — hier wird die Vision
  konkret die Persistenz umkrempeln (`.jdesk`-in-J-Lawyer statt SQLite).
- **MCP (TP4)** ist Vorarbeit für die agentische KI-Schnittstelle (Block 4).

Nächster Schritt laut Prozess: Grundsatzentscheidung (Evolution vs. Neubau)
durch den Auftraggeber, dann Priorisierung des nächsten Teilprojekts gegen
diese Vision.
