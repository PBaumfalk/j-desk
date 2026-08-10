import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpConfig } from './config';
import { Anonymizer } from './anonymizer';
import { MappingStore } from './mapping';
import { AnymizeError } from './anymize';
import * as desk from './deskApi';
import { DeskApiError, VorschlagError } from './deskApi';
import {
  QuelleSchema, VorschlagErgebnisShape, idempotenzKeyFeld,
  type Quelle, type VorschlagErgebnis,
} from './schemas';

export interface McpDeps {
  config: McpConfig;
  anonymizer: Anonymizer;
  mappings: MappingStore;
  token: string;
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fehler = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

function meldung(e: unknown): string {
  if (e instanceof DeskApiError && e.status === 401) return 'Token ungültig — neues Token mit npm run mcp:token erzeugen';
  if (e instanceof DeskApiError || e instanceof AnymizeError) return e.message;
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}

/** Registriert einen Tool-Handler mit einheitlicher Fehlerbehandlung. annotations optional
 *  (12-05: get_document_page_text deklariert readOnlyHint) — Bestandsaufrufe bleiben unverändert. */
function tool(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
  annotations?: { readOnlyHint: boolean; openWorldHint: boolean },
) {
  server.registerTool(name, { description, inputSchema: schema, ...(annotations ? { annotations } : {}) }, async (args: Record<string, unknown>) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fehler(meldung(e));
    }
  });
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'j-desk', version: '0.1.0' });
  const { config, anonymizer, token } = deps;
  const base = config.deskServerUrl;

  tool(server, 'list_desks', 'Listet alle Schreibtische des Benutzers (Namen anonymisiert).', {}, async () => {
    const desks = await desk.listDesks(base, token);
    const namen = await anonymizer.anonNames(desks.map((d) => d.name));
    return desks.map((d, i) => ({ id: d.id, name: namen[i] }));
  });

  tool(server, 'get_desk',
    'Liefert den kompletten Schreibtisch: Karten, Stapel (inkl. Konvolut-Status), Verknüpfungen, Zettel, Ausschnitte, Stempel, Fahnen, Tipp-Ex/Schwärzungs-Zähler, Klammern und Papierkorb (Texte anonymisiert).',
    { deskId: z.string() }, async (a) => {
    const deskId = String(a.deskId);
    const [desks, s] = await Promise.all([desk.listDesks(base, token), desk.getState(base, token, deskId)]);
    const info = desks.find((d) => d.id === deskId);
    if (!info) throw new Error('Schreibtisch nicht gefunden');
    const notesRoh = s.state.notes ?? [];
    const stampsRoh = s.state.stamps ?? [];
    const trashRoh = s.state.trash ?? [];
    const eigenNotes = notesRoh.filter((n) => n.kind === 'eigen');
    const texte = [
      info.name,
      ...s.state.docs.map((d) => d.name),
      ...s.state.stacks.map((st) => st.name),
      ...s.state.links.map((l) => l.note),
      ...notesRoh.map((n) => n.text),
      ...stampsRoh.map((st) => st.text),
      ...trashRoh.map((t) => t.name),
      ...eigenNotes.map((n) => n.customLabel ?? ''),
    ];
    const anon = await anonymizer.anonNames(texte);
    let i = 0;
    const name = anon[i++];
    const docs = s.state.docs.map((d) => ({
      id: d.id, name: anon[i++], position: d.position, kind: d.kind ?? 'pdf',
      ...(d.taped ? { taped: true } : {}),
      ...(d.sourceGone ? { sourceGone: true } : {}),
      ...(d.sourceReplacedAt ? { sourceReplacedAt: d.sourceReplacedAt } : {}),
    }));
    const stacks = s.state.stacks.map((st) => ({ id: st.id, name: anon[i++], docIds: st.docIds, position: st.position, stapled: st.stapled === true, ...(st.taped ? { taped: true } : {}) }));
    const links = s.state.links.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, note: anon[i++] }));
    const noteTexte = notesRoh.map(() => anon[i++]);
    const stamps = stampsRoh.map((st) => ({ id: st.id, docId: st.docId, page: st.page, text: anon[i++], color: st.color, ...(st.date ? { date: st.date } : {}) }));
    const trash = trashRoh.map((t) => ({ id: t.id, kind: t.kind, name: anon[i++], trashedAt: t.trashedAt }));
    const eigenAnon = new Map(eigenNotes.map((n) => [n.id, anon[i++]] as const));
    const notes = notesRoh.map((n, idx) => ({
      id: n.id, kind: n.kind, text: noteTexte[idx], position: n.position,
      ...(n.kind === 'eigen' ? { customLabel: eigenAnon.get(n.id) } : {}),
      ...(n.kind === 'todo' ? { done: n.done === true } : {}),
      ...(n.taped ? { taped: true } : {}),
    }));
    const cutouts = (s.state.cutouts ?? []).map((c) => ({ id: c.id, page: c.page, position: c.position, ...(c.taped ? { taped: true } : {}) }));
    const flags = (s.state.flags ?? []).map((f) => ({ id: f.id, docId: f.docId, page: f.page, color: f.color }));
    const markCounts: Record<string, { tippex: number; redact: number }> = {};
    for (const m of s.state.marks ?? []) {
      const eintrag = (markCounts[m.docId] ??= { tippex: 0, redact: 0 });
      if (m.kind === 'tippex') eintrag.tippex++; else eintrag.redact++;
    }
    const clips = (s.state.clips ?? []).map((c) => ({ id: c.id, memberIds: c.memberIds }));
    return { name, docs, stacks, links, notes, cutouts, stamps, flags, markCounts, clips, trash };
  });

  tool(server, 'get_document_text',
    'Liefert den anonymisierten Volltext eines Dokuments (PDF via OCR; bei konvertierbaren Dateien über die Vorschau-Konvertierung).',
    { deskId: z.string(), docId: z.string() }, async (a) => {
    const s = await desk.getState(base, token, String(a.deskId));
    const doc = s.state.docs.find((d) => d.id === a.docId);
    if (!doc) throw new Error('Dokument nicht gefunden');
    const kind = doc.kind ?? 'pdf';
    if (kind === 'image' || kind === 'other') {
      throw new Error('Für diese Datei-Art ist kein Text-Inhalt verfügbar');
    }
    const laden = kind === 'pdf'
      ? () => desk.getFile(base, token, doc.fileId)
      : () => desk.pollPreview(base, token, doc.fileId);
    return anonymizer.anonFileText(doc.fileId, laden, doc.name);
  });

  tool(server, 'get_document_page_text',
    'Liefert den anonymisierten Text EINER Seite eines Dokuments (pdf_text, ocr als Fallback) — die belastbare Basis für quelle.seite der propose_*-Tools (12-05, A6).',
    { deskId: z.string(), docId: z.string(), seite: z.number().int().min(1) }, async (a) => {
    // docId → fileId über die projizierte Doc-Liste des Token-Inhabers: eine unbekannte ODER
    // unsichtbare docId endet in derselben generischen Meldung — wie die file-text-Route
    // unterscheidet auch dieses Tool die Fälle nicht (keine Existenz-Auskunft, T-09-31/32).
    const s = await desk.getState(base, token, String(a.deskId));
    const doc = s.state.docs.find((d) => d.id === a.docId);
    if (!doc) throw new Error('Dokument nicht gefunden oder nicht sichtbar');
    const ergebnis = await desk.getDocumentPageText(base, token, String(a.deskId), doc.fileId);
    const seite = ergebnis.seiten.find((p) => p.seite === Number(a.seite));
    if (!seite) throw new Error('Für diese Seite liegt kein extrahierter Text vor');
    // Derselbe Anonymisierungs-Pfad wie get_document_text (T-12-05-05): der Seitentext
    // verlässt den MCP-Server nie im Klartext; das Mapping füllt sich für spätere deanon-Aufrufe.
    const text = await anonymizer.anonText(seite.text);
    return { seite: seite.seite, quelle: seite.quelle, text };
  }, { readOnlyHint: true, openWorldHint: false });

  /** De-anonymisiert ein Text-Argument; unbekannte Platzhalter → Fehler. */
  const deanon = (wert: string): string => {
    const r = deps.mappings.deanonymize(wert);
    if (r.unknown.length > 0) {
      throw new Error(
        `Unbekannte Platzhalter: ${r.unknown.join(', ')} — Dokument erneut lesen (Zuordnung ging z. B. durch Neustart verloren)`,
      );
    }
    return r.text;
  };

  /**
   * Vorschlags-Gate (12-05, AI-SPEC Guardrail 1): die gesamte Schreibfläche der MCP ist
   * auf VORSCHLÄGE umgebaut — die 24 bisherigen Direkt-Mutations-Tools sind ersatzlos durch
   * 19 propose_*-Tools ersetzt (die fünf LOESCH-Tools remove_note/remove_stamp/remove_flag/
   * remove_clip/remove_link entfallen; KI-Aufräumen läuft über propose_trash_object, dessen
   * Inverse restoreObject ist). Einzige Schreib-Naht: deanon() VOR dem REST-Call (Pitfall 2 —
   * ein Zitat mit [[Person-N]] wird serverseitig gegen den KLARTEXT verifiziert), dann
   * POST /vorschlaege. KEIN propose-Tool ruft sendCommand: schreibende MCP-Tools können
   * physisch kein applyDeskCommand auslösen. Genehmigung/Ablehnung/Rücknahme existieren hier
   * konstruktiv NICHT (Self-Approval-Verbot, T-12-05-02) — nur als REST-Route mit menschlicher
   * Rollenprüfung.
   */

  /** Kappung der Vorab-Anzeige (AI-SPEC: Zusammenfassung ≤ 280 Zeichen, menschlich prüfbar). */
  const kappe = (t: string): string => (t.length > 280 ? `${t.slice(0, 277)}…` : t);

  async function vorschlag(
    deskId: string,
    art: string,
    payload: Record<string, unknown>,
    opts: { quelle?: Quelle; zusammenfassung: string; echoZusammenfassung?: string; idempotenzKey?: string },
  ): Promise<VorschlagErgebnis> {
    const quellen = opts.quelle
      ? [{ dokumentId: opts.quelle.dokumentId, seite: opts.quelle.seite, zitat: deanon(opts.quelle.zitat) }]
      : undefined;
    const zusammenfassung = kappe(opts.zusammenfassung);
    // CR-01 (It. 3): das agentenseitige Echo bleibt in der PLATZHALTER-Form, die der Agent
    // selbst geschrieben hat (echoZusammenfassung aus der Roheingabe VOR deanon). Die
    // deanonymisierte Register-Fassung darf nie an den Agenten zurückfließen — sonst ist die
    // ERFOLGSantwort dasselbe Deanonymisierungs-Orakel wie die It.-2-Fehlernaht, und das
    // auch bei MCP_ALLOW_DEANONYMIZE=false. Das Register (menschliche Prüffläche) behält
    // die Klartext-Fassung; der one-way-Vertrag des outputSchemas bleibt formstabil.
    const echo = kappe(opts.echoZusammenfassung ?? opts.zusammenfassung);
    const r = await desk.sendeVorschlag(base, token, deskId, {
      art,
      payload,
      ...(quellen ? { quellen } : {}),
      zusammenfassung,
      ...(opts.idempotenzKey !== undefined ? { idempotenzKey: opts.idempotenzKey } : {}),
    });
    // kommandoAnzahl 1: jede art der propose-Fläche bildet auf genau EIN Kommando ab
    // (vorschlagAnwenden, 12-04) — ändert sich das je, ist diese Stelle der Anpassungspunkt.
    return { vorschlagId: r.vorschlagId, status: 'ausstehend', kommandoAnzahl: 1, zusammenfassung: echo };
  }

  /** Ehrliche Vorab-Anzeige (MCP-Spec: Annotations sind untrusted Dekoration, kein Gate —
   *  das Gate ist das Vorschlagsmodell selbst). */
  const PROPOSE_ANNOTATIONS = {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  } as const;

  /**
   * Registriert ein propose_*-Tool. Drei Vertragspunkte:
   * (a) STRENGE: das inputSchema wird als z.object(shape).strict() registriert — die SDK
   *     validiert eingehende Args mit genau diesem Objekt und weist unbekannte
   *     (halluzinierte) Felder als Protokollfehler zurück (AI-SPEC Pitfall 4). Die Strenge
   *     sitzt bewusst an der REGISTRIERUNG, nicht im Handler: die SDK übergibt dem Handler
   *     nur bereits geparste (von unbekannten Feldern befreite) Args — ein In-Handler-Parse
   *     käme an ein Halluzinations-Feld nie mehr heran.
   * (b) Ergebnis: structuredContent nach VorschlagErgebnisShape + JSON-Text-Spiegel
   *     (Spec-2025-06-18-Empfehlung für Alt-Clients).
   * (c) Fachfehler: VorschlagError mit grund → isError mit maschinenlesbarem JSON
   *     { grund, detail, betroffeneQuelle? } — der Agent kann korrigieren statt blind zu
   *     wiederholen; kein Dokumenttext in Fehlertexten (T-12-05-05). betroffeneQuelle wird
   *     ZITAT-FREI weitergegeben (CR-01 It. 2): der Server spiegelt in seiner 422 das VOR
   *     dem REST-Call deanonymisierte KLARTEXT-Zitat (Pitfall 2) — ungefiltert durchgereicht
   *     wäre das ein Deanonymisierungs-Orakel, das auch MCP_ALLOW_DEANONYMIZE=false still
   *     umginge. dokumentId/seite bleiben als maschinenlesbarer Retry-Kanal erhalten; das
   *     eigene Platzhalter-Zitat kennt der Agent aus seinem Call bereits.
   */
  function proposeTool(
    name: string,
    description: string,
    inputShape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<VorschlagErgebnis>,
  ): void {
    server.registerTool(name, {
      description,
      inputSchema: z.object(inputShape).strict(),
      outputSchema: VorschlagErgebnisShape,
      annotations: PROPOSE_ANNOTATIONS,
    }, async (args) => {
      try {
        const ergebnis = await handler(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(ergebnis, null, 2) }],
          structuredContent: ergebnis,
        };
      } catch (e) {
        if (e instanceof VorschlagError && e.grund !== undefined) {
          // CR-01 (It. 2): das Zitat-Echo der 422 NIEMALS zum Agenten — es trägt das vor dem
          // REST-Call deanonymisierte Klartext-Zitat (Deanonymisierungs-Orakel, wirkt auch bei
          // MCP_ALLOW_DEANONYMIZE=false). Der Retry-Kanal bleibt maschinenlesbar: nur
          // dokumentId/seite werden durchgereicht, unbekannte Zusatzfelder fallen weg.
          const quelle = e.betroffeneQuelle;
          const gekuerzt = quelle !== null && typeof quelle === 'object'
            ? {
                dokumentId: (quelle as Record<string, unknown>).dokumentId,
                seite: (quelle as Record<string, unknown>).seite,
              }
            : undefined;
          return fehler(JSON.stringify({
            grund: e.grund,
            detail: e.message,
            ...(gekuerzt !== undefined ? { betroffeneQuelle: gekuerzt } : {}),
          }, null, 2));
        }
        return fehler(meldung(e));
      }
    });
  }

  const GATE_HINWEIS =
    'Erzeugt einen genehmigungspflichtigen VORSCHLAG — wirkt NICHT direkt auf den Schreibtisch; ' +
    'ein Mensch genehmigt oder lehnt in der J-DESK-Oberfläche. Platzhalter ([[Person-N]]) in Texten werden vor der Prüfung in Klartext übersetzt.';
  const QUELLE_PFLICHT =
    'QUELLENPFLICHT: quelle (dokumentId, seite, zitat) ist Pflicht — das Zitat muss WÖRTLICH im Text der genannten Seite vorkommen (Platzhalter erlaubt).';
  const QUELLE_OPTIONAL = 'quelle ist optional — eine Fundstelle macht den Vorschlag für den Prüfer belastbarer.';

  const str = (a: Record<string, unknown>, feld: string): string => String(a[feld]);
  const num = (a: Record<string, unknown>, feld: string): number => Number(a[feld]);
  const pos = (a: Record<string, unknown>): { x: number; y: number } => ({ x: num(a, 'x'), y: num(a, 'y') });
  const quelleVon = (a: Record<string, unknown>): Quelle | undefined =>
    a.quelle === undefined ? undefined : (a.quelle as Quelle);
  const idem = (a: Record<string, unknown>): string | undefined =>
    a.idempotenzKey === undefined ? undefined : String(a.idempotenzKey);

  proposeTool('propose_move_document', `Verschiebt eine Karte an eine neue Position. ${GATE_HINWEIS}`,
    { deskId: z.string(), docId: z.string(), x: z.number(), y: z.number(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'moveDoc', { id: str(a, 'docId'), position: pos(a) },
      { zusammenfassung: `Karte an Position (${num(a, 'x')}, ${num(a, 'y')}) verschieben`, idempotenzKey: idem(a) }));

  proposeTool('propose_stack_documents', `Legt eine Karte auf eine andere (bildet/erweitert einen Stapel). ${GATE_HINWEIS}`,
    { deskId: z.string(), draggedId: z.string(), targetId: z.string(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'stackDocs', { draggedId: str(a, 'draggedId'), targetId: str(a, 'targetId') },
      { zusammenfassung: 'Karte auf eine andere stapeln', idempotenzKey: idem(a) }));

  proposeTool('propose_remove_from_stack', `Nimmt eine Karte aus ihrem Stapel und legt sie an eine Position. ${GATE_HINWEIS}`,
    { deskId: z.string(), docId: z.string(), x: z.number(), y: z.number(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'removeFromStack', { docId: str(a, 'docId'), position: pos(a) },
      { zusammenfassung: 'Karte aus Stapel lösen', idempotenzKey: idem(a) }));

  proposeTool('propose_dissolve_stack', `Löst einen Stapel auf — die Karten bleiben erhalten. ${GATE_HINWEIS}`,
    { deskId: z.string(), stackId: z.string(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'dissolveStack', { stackId: str(a, 'stackId') },
      { zusammenfassung: 'Stapel auflösen', idempotenzKey: idem(a) }));

  proposeTool('propose_rename_stack', `Benennt einen Stapel um. ${GATE_HINWEIS}`,
    { deskId: z.string(), stackId: z.string(), name: z.string().min(1), idempotenzKey: idempotenzKeyFeld },
    (a) => {
      // CR-01 (It. 3): zwei Fassungen — Register in Klartext (Prüffläche), Agenten-Echo in
      // der Platzhalter-Form der Roheingabe (kein Deanonymisierungs-Orakel im Erfolgspfad).
      const rohName = str(a, 'name');
      const name = deanon(rohName);
      return vorschlag(str(a, 'deskId'), 'renameStack', { stackId: str(a, 'stackId'), name },
        { zusammenfassung: `Stapel umbenennen: ${name}`, echoZusammenfassung: `Stapel umbenennen: ${rohName}`, idempotenzKey: idem(a) });
    });

  proposeTool('propose_move_stack', `Verschiebt einen Stapel. ${GATE_HINWEIS}`,
    { deskId: z.string(), stackId: z.string(), x: z.number(), y: z.number(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'moveStack', { stackId: str(a, 'stackId'), position: pos(a) },
      { zusammenfassung: 'Stapel verschieben', idempotenzKey: idem(a) }));

  proposeTool('propose_link_documents', `Verbindet zwei Objekte (Karten, Stapel, Notizzettel oder Ausschnitte) mit einer Schnur. ${GATE_HINWEIS} ${QUELLE_PFLICHT}`,
    { deskId: z.string(), fromId: z.string(), toId: z.string(), quelle: QuelleSchema, idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'addLink', { fromId: str(a, 'fromId'), toId: str(a, 'toId') },
      { quelle: quelleVon(a)!, zusammenfassung: 'Zwei Objekte verknüpfen', idempotenzKey: idem(a) }));

  // 'eigen' ist bewusst NICHT vorschlagsfähig: customLabel ist dort Pflicht (notes.ts), die
  // Genehmigungs-Abbildung (vorschlagAnwenden, addNote) trägt es nicht — ein solcher Vorschlag
  // wäre strukturell nicht genehmigbar.
  const PROPOSE_NOTE_KINDS = ['notiz', 'frage', 'these', 'angriffspunkt', 'risiko', 'behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'tafel'] as const;

  proposeTool('propose_add_note', `Legt einen Notizzettel bzw. ein Gedankenobjekt vor. ${GATE_HINWEIS} ${QUELLE_PFLICHT}`,
    { deskId: z.string(), kind: z.enum(PROPOSE_NOTE_KINDS), text: z.string().min(1).max(2000), x: z.number(), y: z.number(), quelle: QuelleSchema, idempotenzKey: idempotenzKeyFeld },
    (a) => {
      // CR-01 (It. 3): Echo in Platzhalter-Form (Roheingabe), Register in Klartext.
      const rohText = str(a, 'text');
      const text = deanon(rohText);
      return vorschlag(str(a, 'deskId'), 'addNote', { kind: str(a, 'kind'), text, position: pos(a) },
        { quelle: quelleVon(a)!, zusammenfassung: `Notiz (${str(a, 'kind')}): ${text.slice(0, 120)}`, echoZusammenfassung: `Notiz (${str(a, 'kind')}): ${rohText.slice(0, 120)}`, idempotenzKey: idem(a) });
    });

  proposeTool('propose_edit_note', `Ersetzt den Text eines Notizzettels. ${GATE_HINWEIS} ${QUELLE_PFLICHT}`,
    { deskId: z.string(), noteId: z.string(), text: z.string().min(1).max(2000), quelle: QuelleSchema, idempotenzKey: idempotenzKeyFeld },
    (a) => {
      // CR-01 (It. 3): Echo in Platzhalter-Form (Roheingabe), Register in Klartext.
      const rohText = str(a, 'text');
      const text = deanon(rohText);
      return vorschlag(str(a, 'deskId'), 'editNote', { id: str(a, 'noteId'), text },
        { quelle: quelleVon(a)!, zusammenfassung: `Notiz-Text ersetzen: ${text.slice(0, 120)}`, echoZusammenfassung: `Notiz-Text ersetzen: ${rohText.slice(0, 120)}`, idempotenzKey: idem(a) });
    });

  const FLAG_FARBEN: Record<string, string> = { gelb: '#f5c518', rot: '#e5484d', blau: '#3b82f6', gruen: '#30a46c' };
  const STAMP_PRESETS: Record<string, { color: 'red' | 'blue'; withDate?: boolean }> = {
    ERLEDIGT: { color: 'red' }, WICHTIG: { color: 'red' }, 'FRIST!': { color: 'red' },
    GEPRÜFT: { color: 'blue' }, EINGANG: { color: 'blue', withDate: true }, ENTWURF: { color: 'blue' }, KOPIE: { color: 'blue' },
  };

  proposeTool('propose_add_stamp',
    `Stempelt eine Dokumentseite: preset (ERLEDIGT/WICHTIG/FRIST!/GEPRÜFT/EINGANG/ENTWURF/KOPIE) ODER freeText. Position automatisch oben rechts. ${GATE_HINWEIS} ${QUELLE_OPTIONAL}`,
    { deskId: z.string(), docId: z.string(), page: z.number().int().min(1), preset: z.string().optional(), freeText: z.string().max(2000).optional(), quelle: QuelleSchema.optional(), idempotenzKey: idempotenzKeyFeld },
    (a) => {
      const preset = a.preset === undefined ? undefined : STAMP_PRESETS[str(a, 'preset')];
      if (a.preset !== undefined && !preset) throw new Error(`Unbekanntes Preset: ${str(a, 'preset')}`);
      if (!preset && a.freeText === undefined) throw new Error('preset oder freeText angeben');
      // CR-01 (It. 3): zwei Fassungen — Register in Klartext, Agenten-Echo in der
      // Platzhalter-Form der Roheingabe (beim preset-Pfad identisch, dort liegt kein
      // deanon vor).
      const rohText = preset ? str(a, 'preset') : str(a, 'freeText');
      const text = preset ? str(a, 'preset') : deanon(str(a, 'freeText'));
      const docId = str(a, 'docId');
      // CR-01: das Register-Payload ist FLACH (docId/page/x/… auf Top-Ebene) — die flache
      // Form ist die kanonische Register-Wahrheit: vorschlagAnwenden validiert flach,
      // REFERENZ_FELDER/referenzierteDocIds (PERM-05-Sichtfilter) lesen flach. Die
      // Verschachtelung { stamp: {…} } ist allein die Kommando-Form und entsteht erst beim
      // Abbilden aufs Kommando (vorschlagAnwenden, addStamp-Case).
      const stamp: Record<string, unknown> = {
        docId,
        page: num(a, 'page'),
        x: 595 - 130, y: 70,
        angle: (docId.charCodeAt(0) % 13) - 6,
        text,
        color: preset?.color ?? 'blue',
        ...(preset?.withDate ? { date: new Date().toISOString().slice(0, 10) } : {}),
        baseW: 595, baseH: 842,
      };
      return vorschlag(str(a, 'deskId'), 'addStamp', stamp,
        { quelle: quelleVon(a), zusammenfassung: `Stempel „${text}" setzen (S. ${num(a, 'page')})`, echoZusammenfassung: `Stempel „${rohText}" setzen (S. ${num(a, 'page')})`, idempotenzKey: idem(a) });
    });

  proposeTool('propose_add_flag', `Setzt eine Notizfahne (gelb/rot/blau/gruen) an den Seitenrand — Klick springt zur Seite. ${GATE_HINWEIS} ${QUELLE_OPTIONAL}`,
    { deskId: z.string(), docId: z.string(), page: z.number().int().min(1), color: z.enum(['gelb', 'rot', 'blau', 'gruen']), quelle: QuelleSchema.optional(), idempotenzKey: idempotenzKeyFeld },
    async (a) => {
      // Offset-Konvention des alten Direkt-Tools: jede weitere Fahne am Dokument rückt nach unten.
      const s = await desk.getState(base, token, str(a, 'deskId'));
      const vorhandene = (s.state.flags ?? []).filter((f) => f.docId === a.docId).length;
      // Flache Register-Form wie bei addStamp (CR-01) — die { flag: {…} }-Verschachtelung
      // ist Kommando-Form und entsteht erst in vorschlagAnwenden.
      const flag = {
        docId: str(a, 'docId'),
        page: num(a, 'page'),
        offset: Math.min(0.9, 0.08 + vorhandene * 0.18),
        color: FLAG_FARBEN[str(a, 'color')],
      };
      return vorschlag(str(a, 'deskId'), 'addFlag', flag,
        { quelle: quelleVon(a), zusammenfassung: `Notizfahne (${str(a, 'color')}) an S. ${num(a, 'page')}`, idempotenzKey: idem(a) });
    });

  proposeTool('propose_staple_stack', `Heftet einen Stapel zum Konvolut (blättert dann als Ganzes). ${GATE_HINWEIS}`,
    { deskId: z.string(), stackId: z.string(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'stapleStack', { stackId: str(a, 'stackId') },
      { zusammenfassung: 'Stapel zum Konvolut heften', idempotenzKey: idem(a) }));

  proposeTool('propose_unstaple_stack', `Entheftet ein Konvolut wieder zum losen Stapel. ${GATE_HINWEIS}`,
    { deskId: z.string(), stackId: z.string(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'unstapleStack', { stackId: str(a, 'stackId') },
      { zusammenfassung: 'Konvolut lösen', idempotenzKey: idem(a) }));

  proposeTool('propose_clip_objects', `Klammert zwei Objekte zusammen (gemeinsames Verschieben). ${GATE_HINWEIS}`,
    { deskId: z.string(), aId: z.string(), bId: z.string(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'addClip', { aId: str(a, 'aId'), bId: str(a, 'bId') },
      { zusammenfassung: 'Objekte zusammenklammern', idempotenzKey: idem(a) }));

  proposeTool('propose_trash_object', `Legt ein Objekt in den Papierkorb (wiederherstellbar — NICHT endgültig). ${GATE_HINWEIS}`,
    { deskId: z.string(), objectId: z.string(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'trashObject', { objectId: str(a, 'objectId') },
      { zusammenfassung: 'Objekt in den Papierkorb legen', idempotenzKey: idem(a) }));

  proposeTool('propose_restore_trash', `Holt einen Korb-Eintrag zurück auf den Tisch. ${GATE_HINWEIS}`,
    { deskId: z.string(), trashId: z.string(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'restoreObject', { trashId: str(a, 'trashId') },
      { zusammenfassung: 'Objekt aus dem Papierkorb zurückholen', idempotenzKey: idem(a) }));

  proposeTool('propose_set_note_done', `Hakt einen To-do-Zettel ab oder hebt das Abhaken auf. ${GATE_HINWEIS}`,
    { deskId: z.string(), noteId: z.string(), done: z.boolean(), idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'setNoteDone', { id: str(a, 'noteId'), done: a.done === true },
      { zusammenfassung: a.done === true ? 'To-do abhaken' : 'To-do wieder öffnen', idempotenzKey: idem(a) }));

  proposeTool('propose_extract_page', `Enthefterzange: löst eine Seite eines Dokuments als eigene Karte heraus (nicht destruktiv). ${GATE_HINWEIS} ${QUELLE_PFLICHT}`,
    { deskId: z.string(), docId: z.string(), page: z.number().int().min(1), x: z.number(), y: z.number(), quelle: QuelleSchema, idempotenzKey: idempotenzKeyFeld },
    (a) => vorschlag(str(a, 'deskId'), 'extractPage', { docId: str(a, 'docId'), page: num(a, 'page'), position: pos(a) },
      { quelle: quelleVon(a)!, zusammenfassung: `Seite ${num(a, 'page')} als Karte herauslösen`, idempotenzKey: idem(a) }));

  proposeTool('propose_set_link_note', `Setzt die Notiz einer Verknüpfung. ${GATE_HINWEIS}`,
    { deskId: z.string(), linkId: z.string(), note: z.string().min(1).max(2000), idempotenzKey: idempotenzKeyFeld },
    (a) => {
      // CR-01 (It. 3): Echo in Platzhalter-Form (Roheingabe), Register in Klartext.
      const rohNote = str(a, 'note');
      const note = deanon(rohNote);
      return vorschlag(str(a, 'deskId'), 'setLinkNote', { linkId: str(a, 'linkId'), note },
        { zusammenfassung: `Verknüpfungsnotiz setzen: ${note.slice(0, 120)}`, echoZusammenfassung: `Verknüpfungsnotiz setzen: ${rohNote.slice(0, 120)}`, idempotenzKey: idem(a) });
    });

  tool(server, 'create_desk', 'Legt einen neuen Schreibtisch an.', { name: z.string() }, async (a) => {
    const d = await desk.createDesk(base, token, deanon(String(a.name)));
    return { id: d.id, name: String(a.name) };
  });

  tool(server, 'rename_desk', 'Benennt einen Schreibtisch um.', { deskId: z.string(), name: z.string() }, async (a) => {
    await desk.renameDesk(base, token, String(a.deskId), deanon(String(a.name)));
    return { ok: true };
  });

  if (config.allowDeanonymize) {
    tool(server, 'deanonymize', 'Übersetzt Platzhalter in Klartext (für lesbare Antworten an den Benutzer).', { text: z.string() }, async (a) => {
      const r = deps.mappings.deanonymize(String(a.text));
      return r.unknown.length > 0 ? `${r.text}\n\n[Unbekannte Platzhalter: ${r.unknown.join(', ')}]` : r.text;
    });
  }

  return server;
}
