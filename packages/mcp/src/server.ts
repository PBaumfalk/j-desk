import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpConfig } from './config';
import { Anonymizer } from './anonymizer';
import { MappingStore } from './mapping';
import { AnymizeError } from './anymize';
import * as desk from './deskApi';
import { DeskApiError } from './deskApi';

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

/** Registriert einen Tool-Handler mit einheitlicher Fehlerbehandlung. */
function tool(server: McpServer, name: string, description: string, schema: z.ZodRawShape, handler: (args: Record<string, unknown>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema: schema }, async (args: Record<string, unknown>) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fehler(meldung(e));
    }
  });
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'digital-desktop', version: '0.1.0' });
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
    const docs = s.state.docs.map((d) => ({ id: d.id, name: anon[i++], position: d.position, kind: d.kind ?? 'pdf', ...(d.taped ? { taped: true } : {}) }));
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

  const cmd = (deskId: unknown, type: string, payload: unknown) =>
    desk.sendCommand(base, token, String(deskId), { type, payload }).then((r) => ({ ok: true, rev: r.rev }));

  tool(server, 'move_document', 'Verschiebt eine Karte an eine neue Position.', { deskId: z.string(), docId: z.string(), x: z.number(), y: z.number() },
    (a) => cmd(a.deskId, 'moveDoc', { id: a.docId, position: { x: a.x, y: a.y } }));

  tool(server, 'stack_documents', 'Legt eine Karte auf eine andere (bildet/erweitert einen Stapel).', { deskId: z.string(), draggedId: z.string(), targetId: z.string() },
    (a) => cmd(a.deskId, 'stackDocs', { draggedId: a.draggedId, targetId: a.targetId, id: randomUUID() }));

  tool(server, 'remove_from_stack', 'Nimmt eine Karte aus ihrem Stapel und legt sie an eine Position.', { deskId: z.string(), docId: z.string(), x: z.number(), y: z.number() },
    (a) => cmd(a.deskId, 'removeFromStack', { docId: a.docId, position: { x: a.x, y: a.y } }));

  tool(server, 'dissolve_stack', 'Löst einen Stapel auf — die Karten bleiben erhalten.', { deskId: z.string(), stackId: z.string() },
    (a) => cmd(a.deskId, 'dissolveStack', { stackId: a.stackId }));

  tool(server, 'rename_stack', 'Benennt einen Stapel um (Platzhalter werden in Klartext übersetzt).', { deskId: z.string(), stackId: z.string(), name: z.string() },
    (a) => cmd(a.deskId, 'renameStack', { stackId: a.stackId, name: deanon(String(a.name)) }));

  tool(server, 'move_stack', 'Verschiebt einen Stapel.', { deskId: z.string(), stackId: z.string(), x: z.number(), y: z.number() },
    (a) => cmd(a.deskId, 'moveStack', { stackId: a.stackId, position: { x: a.x, y: a.y } }));

  tool(server, 'link_documents', 'Verbindet zwei Objekte (Karten, Stapel, Notizzettel oder Ausschnitte) mit einer Schnur.', { deskId: z.string(), fromId: z.string(), toId: z.string() },
    (a) => cmd(a.deskId, 'addLink', { fromId: a.fromId, toId: a.toId, id: randomUUID() }));

  tool(server, 'add_note',
    'Legt einen Notizzettel bzw. ein Gedankenobjekt auf den Schreibtisch (Platzhalter im Text werden in Klartext übersetzt).',
    { deskId: z.string(), kind: z.enum(['notiz', 'frage', 'these', 'angriffspunkt', 'risiko', 'behauptung', 'beweisziel', 'idee', 'todo', 'argument', 'rechtsfrage', 'eigen', 'tafel']),
      text: z.string(), x: z.number(), y: z.number(), customLabel: z.string().optional() },
    async (a) => {
      const id = randomUUID();
      await cmd(a.deskId, 'addNote', {
        kind: a.kind, text: deanon(String(a.text)), position: { x: a.x, y: a.y }, id,
        ...(a.customLabel !== undefined ? { customLabel: deanon(String(a.customLabel)) } : {}),
      });
      return { ok: true, id };
    });

  tool(server, 'edit_note', 'Ersetzt den Text eines Notizzettels (Platzhalter werden übersetzt).',
    { deskId: z.string(), noteId: z.string(), text: z.string() },
    (a) => cmd(a.deskId, 'editNote', { id: a.noteId, text: deanon(String(a.text)) }));

  tool(server, 'remove_note', 'Entfernt einen Notizzettel samt seiner Schnüre.',
    { deskId: z.string(), noteId: z.string() },
    (a) => cmd(a.deskId, 'removeNote', { id: a.noteId }));

  const FLAG_FARBEN: Record<string, string> = { gelb: '#f5c518', rot: '#e5484d', blau: '#3b82f6', gruen: '#30a46c' };
  const STAMP_PRESETS: Record<string, { color: 'red' | 'blue'; withDate?: boolean }> = {
    ERLEDIGT: { color: 'red' }, WICHTIG: { color: 'red' }, 'FRIST!': { color: 'red' },
    GEPRÜFT: { color: 'blue' }, EINGANG: { color: 'blue', withDate: true }, ENTWURF: { color: 'blue' }, KOPIE: { color: 'blue' },
  };

  tool(server, 'add_stamp',
    'Stempelt eine Dokumentseite: preset (ERLEDIGT/WICHTIG/FRIST!/GEPRÜFT/EINGANG/ENTWURF/KOPIE) ODER freeText (Platzhalter werden übersetzt). Position automatisch oben rechts.',
    { deskId: z.string(), docId: z.string(), page: z.number(), preset: z.string().optional(), freeText: z.string().optional() },
    async (a) => {
      const id = randomUUID();
      const preset = a.preset === undefined ? undefined : STAMP_PRESETS[String(a.preset)];
      if (a.preset !== undefined && !preset) throw new Error(`Unbekanntes Preset: ${String(a.preset)}`);
      if (!preset && a.freeText === undefined) throw new Error('preset oder freeText angeben');
      const text = preset ? String(a.preset) : deanon(String(a.freeText));
      await cmd(a.deskId, 'addStamp', { stamp: {
        id, docId: a.docId, page: a.page, x: 595 - 130, y: 70,
        angle: (id.charCodeAt(0) % 13) - 6, text, color: preset?.color ?? 'blue',
        ...(preset?.withDate ? { date: new Date().toISOString().slice(0, 10) } : {}),
        baseW: 595, baseH: 842,
      } });
      return { ok: true, id };
    });

  tool(server, 'remove_stamp', 'Entfernt einen Stempelabdruck.', { deskId: z.string(), stampId: z.string() },
    (a) => cmd(a.deskId, 'removeStamp', { stampId: a.stampId }));

  tool(server, 'add_flag', 'Setzt eine Notizfahne (gelb/rot/blau/gruen) an den Seitenrand — Klick springt zur Seite.',
    { deskId: z.string(), docId: z.string(), page: z.number(), color: z.enum(['gelb', 'rot', 'blau', 'gruen']) },
    async (a) => {
      const id = randomUUID();
      const s = await desk.getState(base, token, String(a.deskId));
      const vorhandene = (s.state.flags ?? []).filter((f) => f.docId === a.docId).length;
      await cmd(a.deskId, 'addFlag', { flag: { id, docId: a.docId, page: a.page, offset: Math.min(0.9, 0.08 + vorhandene * 0.18), color: FLAG_FARBEN[String(a.color)] } });
      return { ok: true, id };
    });

  tool(server, 'remove_flag', 'Entfernt eine Notizfahne.', { deskId: z.string(), flagId: z.string() },
    (a) => cmd(a.deskId, 'removeFlag', { flagId: a.flagId }));

  tool(server, 'staple_stack', 'Heftet einen Stapel zum Konvolut (blättert dann als Ganzes).', { deskId: z.string(), stackId: z.string() },
    (a) => cmd(a.deskId, 'stapleStack', { stackId: a.stackId }));

  tool(server, 'unstaple_stack', 'Entheftet ein Konvolut wieder zum losen Stapel.', { deskId: z.string(), stackId: z.string() },
    (a) => cmd(a.deskId, 'unstapleStack', { stackId: a.stackId }));

  tool(server, 'clip_objects', 'Klammert zwei Objekte zusammen (gemeinsames Verschieben).', { deskId: z.string(), aId: z.string(), bId: z.string() },
    (a) => cmd(a.deskId, 'addClip', { aId: a.aId, bId: a.bId, id: randomUUID() }));

  tool(server, 'remove_clip', 'Löst eine Büroklammer-Gruppe.', { deskId: z.string(), clipId: z.string() },
    (a) => cmd(a.deskId, 'removeClip', { clipId: a.clipId }));

  tool(server, 'trash_object', 'Legt ein Objekt in den Papierkorb (wiederherstellbar — NICHT endgültig).', { deskId: z.string(), objectId: z.string() },
    (a) => cmd(a.deskId, 'trashObject', { id: a.objectId, trashedAt: new Date().toISOString() }));

  tool(server, 'restore_trash', 'Holt einen Korb-Eintrag zurück auf den Tisch.', { deskId: z.string(), trashId: z.string() },
    (a) => cmd(a.deskId, 'restoreObject', { trashId: a.trashId }));

  tool(server, 'set_note_done', 'Hakt einen To-do-Zettel ab oder hebt das Abhaken auf.', { deskId: z.string(), noteId: z.string(), done: z.boolean() },
    (a) => cmd(a.deskId, 'setNoteDone', { id: a.noteId, done: a.done }));

  tool(server, 'extract_page',
    'Enthefterzange: löst eine Seite eines Dokuments als eigene Karte heraus (nicht destruktiv).',
    { deskId: z.string(), docId: z.string(), page: z.number(), x: z.number(), y: z.number() },
    async (a) => {
      const id = randomUUID();
      await cmd(a.deskId, 'extractPage', { docId: a.docId, page: a.page, position: { x: a.x, y: a.y }, id });
      return { ok: true, id };
    });

  tool(server, 'set_link_note', 'Setzt die Notiz einer Verknüpfung (Platzhalter werden übersetzt).', { deskId: z.string(), linkId: z.string(), note: z.string() },
    (a) => cmd(a.deskId, 'setLinkNote', { linkId: a.linkId, note: deanon(String(a.note)) }));

  tool(server, 'remove_link', 'Entfernt eine Verknüpfungslinie (die Karten bleiben).', { deskId: z.string(), linkId: z.string() },
    (a) => cmd(a.deskId, 'removeLink', { linkId: a.linkId }));

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
