import { z } from 'zod';

/**
 * Vertrags-Schemas der MCP-Vorschlagsfläche (Phase 12-05, AI-01/AI-03).
 *
 * REVERSIBILITÄT one-way: diese Schemas sind der Verhaltensvertrag gegenüber externen
 * MCP-Clients (AI-SPEC Section 3, Tool Use) — Änderungen nur ADDITIV (neue optionale
 * Felder), niemals Umbenennung oder Semantikwechsel. Eine nachträgliche Umbenennung
 * bricht jeden angeschlossenen Agenten; die tools/list-Antwort ist seine einzige
 * Discovery-Fläche.
 *
 * Strenge (AI-SPEC Pitfall 4): QuelleSchema ist .strict() — unbekannte (halluzinierte)
 * Felder werden nicht still gestripped, sondern enden als Protokollfehler. Die Top-Level-
 * Strenge der propose_*-Tool-Args baut der proposeTool-Wrapper in server.ts ebenfalls
 * über .strict() (dort die Begründung, warum die Strenge an der SDK-Registrierung sitzt).
 */

/** Fundstelle (Quellenpflicht, AI-03): das Zitat wird serverseitig WÖRTLICH gegen den
 *  extrahierten Text der genannten Seite geprüft (quelleServer.ts). */
export const QuelleSchema = z
  .object({
    dokumentId: z.string().min(1),
    seite: z.number().int().min(1),
    zitat: z.string().min(1).max(1000),
  })
  .strict();
export type Quelle = z.infer<typeof QuelleSchema>;

/** Raw Shape des strukturierten Erfolgsergebnisses aller propose_*-Tools (Spec 2025-06-18:
 *  outputSchema als Raw Shape; der Handler spiegelt zusätzlich als JSON-Text für Alt-Clients). */
export const VorschlagErgebnisShape = {
  vorschlagId: z.string(),
  status: z.enum(['ausstehend']),
  kommandoAnzahl: z.number().int().min(1),
  zusammenfassung: z.string().max(280),
} satisfies z.ZodRawShape;
export const VorschlagErgebnisSchema = z.object(VorschlagErgebnisShape);
export type VorschlagErgebnis = z.infer<typeof VorschlagErgebnisSchema>;

/** Maschinenlesbarer Fachfehler (Retry-Kanal des Agenten): grund-Codes decken die
 *  Server-Ablehnungen aus proposals.ts/quelleServer.ts ab — kein Dokumenttext im detail. */
export const VorschlagFehlerSchema = z.object({
  grund: z.enum([
    'zitat_nicht_auflösbar',
    'mandat_fremd',
    'text_nicht_extrahiert',
    'quelle_fehlt',
    'budget_überschritten',
    'art_nicht_genehmigungsfähig',
  ]),
  detail: z.string(),
});
export type VorschlagFehler = z.infer<typeof VorschlagFehlerSchema>;

/** Agenten-Retry-Schutz (AI-SPEC Pitfall 5): Replay desselben Schlüssels liefert denselben
 *  Vorschlag ohne zweite Registerzeile (Server-Unique aus Plan 12-01). */
export const idempotenzKeyFeld = z.string().uuid().optional();
