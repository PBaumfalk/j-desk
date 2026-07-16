# anymize-API — Referenz für Teilprojekt 4 (Stand 2026-07-17, vom Nutzer aus der offiziellen Doku übernommen)

Auszug der für den MCP-Server relevanten Endpunkte. Vollständige Doku: app.anymize.ai/api-docs.

## Basis

- Core-API-Basis: `https://app.anymize.ai/api`
- Auth: `Authorization: Bearer <ANYMIZE_API_KEY>` (Key aus App → Einstellungen → API)
- 401-Fehlerformat: `{"error": {"message", "type": "auth_error", "code": "invalid_api_key"}}`

## Text-Anonymisierung (asynchron)

```
POST /api/anonymize          {"text": "...", "language": "de"}
→ 202 {"job_id": "job_...", "status": "processing"}
```

`language`: de (Default), en, fr, es, it.

## Datei-Anonymisierung / OCR (asynchron)

```
POST /api/ocr                multipart/form-data: file (PDF, PNG, JPG, TIFF), language
→ {"job_id": "job_...", "status": "processing"}
```

Pipeline: OCR extrahiert Text → Anonymisierung ersetzt PII. Ergebnis = anonymisierter Text.

## Job-Status (Polling, 2–5 s Takt)

```
GET /api/status/{jobId}
→ processing: {"job_id", "status": "processing", "progress": 45}
→ completed:  {"job_id", "status": "completed", "result": {"text": "<anonymisierter Text>", "entities_found": 12, "processing_time_ms": 2340}}
→ failed:     {"job_id", "status": "failed", ...Fehlerdetails}
```

## Hash-Paare (Mapping Platzhalter ↔ Original)

```
GET /api/status/{jobId}/strings
→ {"job_id", "hash_pairs": [{"original": "Max Mustermann", "hash": "[PERSON-1]", "prefix_name": "Person", "placeholder": "PERSON-1"}, ...], "total": 3}
```

Entity-Typen: Person, Location, Organization, Date, Email, Phone, Address, IBAN, ID.

⚠️ **Format-Unstimmigkeit in der Doku:** Die Chat-Doku zeigt Platzhalter als `[[Person-QSEZB6]]` (Format `[[Type-HASH]]`), die hash_pairs-Beispiele als `[PERSON-1]`. Das reale Format im Research-Schritt mit echtem Key verifizieren; Implementierung soll beide Formen tolerant erkennen.

## De-Anonymisierung (Server-Fallback)

```
POST /api/deanonymize        {"text": "... [[Person-QSEZB6]] ..."}
→ 200 {"text": "<Klartext>", "replacements": 2}
```

Einschränkungen: Original-Job muss noch existieren; nur derselbe Benutzer; **nicht verfügbar bei aktiviertem Zero Data Retention (ZDR)**.

## ZDR-Vorbehalt (wichtig)

ZDR wird im Account konfiguriert (nicht pro Request). Bei aktivem ZDR sind **hash_pairs UND deanonymize nicht verfügbar** → der De-Anonymisierungs-Rundweg des MCP-Servers funktioniert nur mit ZDR = aus. Der MCP-Server muss diesen Fall erkennen (strings-Abruf schlägt fehl) und klar melden.

## Kosten

Anonymisierung: 1 Wort = 1 Credit. → Caching von Anonymisierungs-Ergebnissen (Dokumenttexte pro fileId, Namen pro exaktem String) spart Credits, nicht nur Zeit.

## Für TP4 nicht benötigt (aber vorhanden)

- OpenAI-kompatible Chat-API (`/api/v1/llm/chat/completions`) und Anonymer Chat (`/api/v1/llm-anonymous/...`)
- Wissensdatenbanken/RAG (`/api/v1/knowledge-bases`, `/api/v1/rag/search`) + gehosteter anymize-MCP-Server (`/api/mcp`)
- Transkription (`/api/transcribe`), Dokument-Export (`/api/v1/jobs/{id}/export`), Projekte/Meetings/Jobs (`/api/v1/projects`, `/api/v1/jobs`, ...)
- Text-Job-Upload `POST /api/v1/jobs/upload-text` (Alternative zu /api/anonymize mit Projekt-/KB-Verknüpfung)
