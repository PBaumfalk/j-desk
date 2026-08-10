import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestSetup } from '../../src/testServer';
import { sendCommand } from '../../src/deskApi';

/**
 * Eval-Harness des ki-eval-Referenzdatensatzes (Plan 12-09, AI-SPEC Section 5).
 *
 * Lädt die vier gelabelten JSON-Dateien (kritische-pfade / edge-cases / failure-modes /
 * adversarial) und fährt jeden Fall über die ECHTE Vertrauensgrenze: MCP-Client
 * (StreamableHTTP, ts.mcpClient) → propose_* → POST /vorschlaege → pruefeQuellen.
 * Nichts wird gemockt — ein Befund hier ist ein Produktionsbefund.
 *
 * Batch-Ausnahme (dokumentierte Abweichung, s. 12-09-SUMMARY): Mehrquellen-Vorschläge
 * (quellen-Array) sind auf der MCP-Fläche konstruktiv nicht ausdrückbar — der
 * propose_*-Vertrag (schemas.ts, one-way) kennt genau EINE quelle je Call. Die zwei
 * Batch-Fälle (EC-3, FM-6) steigen daher eine Ebene tiefer ein: direkter REST-POST auf
 * /vorschlaege mit demselben Test-Token — dieselbe pruefeQuellen-/Budget-Grenze, kein Mock.
 * Fixtures dafür tragen tool: 'rest:vorschlaege'.
 *
 * Fixture-Format je Fall:
 *   { id, beschreibung, tool, argumente, setup?, erwartung, replay? }
 *   erwartung: { ausgang: 'akzeptieren' } | { ausgang: 'ablehnen', grund } | { ausgang: 'kein_tool' }
 * Dokument-/Notiz-Verweise in argumente: 'doc:<key>' / 'note:<key>' — der Harness löst sie
 * gegen die im Setup angelegten ids auf (deskId injiziert der Harness automatisch).
 */

export interface EvalSeitenText {
  dateiKey: string;
  seite: number;
  text: string;
  /** ocr: true → Text landet in ocr_text statt pdf_text (OCR-Fallback-Pfad der Verifikation). */
  ocr?: boolean;
}

export interface EvalDatei {
  key: string;
  name: string;
}

export interface EvalSetup {
  dateien?: EvalDatei[];
  seitenTexte?: EvalSeitenText[];
  /** Notizzettel, die VOR dem Tool-Call auf dem Desk liegen (z. B. Ziel von propose_edit_note). */
  notizen?: { key: string; kind: string; text: string }[];
  /** Dokumente auf einem ZWEITEN Desk desselben Servers (Mandatsverwechslung FM-4). */
  fremdesMandat?: { dateien: EvalDatei[] };
  /** Dokumente auf demselben Desk, die ein ZWEITER Nutzer in seine private Ebene legt (FM-5). */
  privatFremd?: { dateien: EvalDatei[] };
}

export interface EvalErwartung {
  ausgang: 'akzeptieren' | 'ablehnen' | 'kein_tool';
  /** Maschinenlesbarer Ablehnungsgrund (VorschlagFehlerSchema) bzw. 'protokollfehler' für
   *  SDK-Validierungsablehnungen (strikte Schemas, Halluzinations-Felder). */
  grund?: string;
  /** Vertraulichkeits-Assertion: die Antwort dieses Falls muss mit der des genannten Falls
   *  übereinstimmen (grund/detail/Echo byte-identisch, dokumentId als Eingabe-Echo maskiert). */
  identischMit?: string;
}

export interface EvalFall {
  id: string;
  beschreibung: string;
  tool: string;
  argumente: Record<string, unknown>;
  setup?: EvalSetup;
  erwartung: EvalErwartung;
  /** Replay-Fall (AA-3): der Tool-Call wird zweimal mit demselben idempotenzKey gefahren. */
  replay?: boolean;
}

export interface EvalErgebnis {
  ausgang: 'akzeptieren' | 'ablehnen' | 'kein_tool';
  grund?: string;
  /** Registerzeilen auf dem Fall-Desk nach dem Lauf (-1: nicht erhoben, z. B. kein_tool). */
  registerZeilen: number;
  vorschlagId?: string;
  /** Rohantwort der Vertrauensgrenze (Fehler-JSON bzw. Erfolgs-JSON) für identischMit-Vergleiche. */
  rohAntwort: unknown;
}

const REFERENZ_DATEIEN = ['kritische-pfade', 'edge-cases', 'failure-modes', 'adversarial'] as const;

/** Lädt alle vier Fixture-Dateien (Pfade relativ zu dieser Datei). */
export function ladeFaelle(): { datei: string; faelle: EvalFall[] }[] {
  return REFERENZ_DATEIEN.map((datei) => ({
    datei,
    faelle: JSON.parse(readFileSync(fileURLToPath(new URL(`./referenz/${datei}.json`, import.meta.url)), 'utf8')) as EvalFall[],
  }));
}

/** Registerzeilen des Fall-Desks über die projizierte REST-Liste (Plan 12-03). */
async function registerZeilenZaehlen(ts: TestSetup, deskId: string): Promise<number> {
  const res = await fetch(`${ts.deskUrl}/api/v1/desks/${deskId}/vorschlaege`, {
    headers: { authorization: `Bearer ${ts.token}` },
  });
  if (!res.ok) throw new Error(`Vorschlagsliste nicht ladbar (HTTP ${res.status})`);
  return ((await res.json()) as { vorschlaege: unknown[] }).vorschlaege.length;
}

const textOf = (r: { content: unknown }): string =>
  (r.content as { text: string }[]).map((c) => c.text).join('');

/** Stabile JSON-Form mit maskierter dokumentId in betroffeneQuelle: betroffeneQuelle ist das
 *  bewusste Eingabe-Echo (Retry-Kanal des Agenten) — die SICHERHEITSrelevante Aussage des
 *  identischMit-Vergleichs ist, dass alle serverkontrollierten Felder (grund, detail, seite/
 *  zitat-Echo) byte-identisch sind, egal ob das Dokument fremdmandatig, privat-unsichtbar
 *  oder nicht existent ist. */
export function maskiereDokumentId(roh: unknown): string {
  return JSON.stringify(roh, (schluessel, wert: unknown) =>
    schluessel === 'dokumentId' ? '<maskiert>' : wert);
}

/** Löst 'doc:<key>'/'note:<key>'-Verweise rekursiv in argumente auf. */
function loeseVerweise(
  wert: unknown,
  docIds: Map<string, string>,
  notizIds: Map<string, string>,
): unknown {
  if (typeof wert === 'string') {
    if (wert.startsWith('doc:')) {
      const id = docIds.get(wert.slice(4));
      if (id === undefined) throw new Error(`Unbekannter dateiKey in Fixture: ${wert}`);
      return id;
    }
    if (wert.startsWith('note:')) {
      const id = notizIds.get(wert.slice(5));
      if (id === undefined) throw new Error(`Unbekannter notizKey in Fixture: ${wert}`);
      return id;
    }
    return wert;
  }
  if (Array.isArray(wert)) return wert.map((e) => loeseVerweise(e, docIds, notizIds));
  if (wert !== null && typeof wert === 'object') {
    return Object.fromEntries(
      Object.entries(wert as Record<string, unknown>).map(([k, v]) => [k, loeseVerweise(v, docIds, notizIds)]),
    );
  }
  return wert;
}

/**
 * Fährt einen Eval-Fall über die echte Vertrauensgrenze und normiert das Ergebnis:
 * akzeptieren = kein isError + vorschlagId + genau eine neue Registerzeile; ablehnen =
 * isError/422 + maschinenlesbarer grund, persistenzfrei (0 Registerzeilen); kein_tool =
 * tools/list-Namensprüfung (Self-Approval-Verbot). Der Harness bewertet NICHT — er misst;
 * der Vergleich mit fall.erwartung steht in ki-eval.test.ts.
 */
export async function fahreFall(ts: TestSetup, fall: EvalFall): Promise<EvalErgebnis> {
  if (fall.erwartung.ausgang === 'kein_tool') {
    const tools = await ts.mcpClient.listTools();
    const namen = tools.tools.map((t) => t.name);
    const genehmigungsArtig = namen.filter((n) => /genehmig|approv|ablehn|reject|zurueck/i.test(n));
    return {
      ausgang: namen.includes(fall.tool) || genehmigungsArtig.length > 0 ? 'akzeptieren' : 'kein_tool',
      registerZeilen: -1,
      rohAntwort: { gesucht: fall.tool, genehmigungsArtigeTools: genehmigungsArtig },
    };
  }

  const setup = fall.setup ?? {};
  const deskId = await ts.createDesk(`Eval ${fall.id}`);
  const docIds = new Map<string, string>();
  const notizIds = new Map<string, string>();

  for (const datei of setup.dateien ?? []) {
    docIds.set(datei.key, await ts.addDoc(deskId, datei.name));
  }
  for (const datei of setup.fremdesMandat?.dateien ?? []) {
    // Zweiter Desk desselben Servers: das Dokument existiert WIRKLICH (mit Seitentext) —
    // die Ablehnung muss aus der Mandatsgrenze kommen, nicht aus Nichtexistenz.
    const fremdDesk = await ts.createDesk(`Eval ${fall.id} fremd`);
    docIds.set(datei.key, await ts.addDoc(fremdDesk, datei.name));
    const seiten = (setup.seitenTexte ?? []).filter((s) => s.dateiKey === datei.key);
    if (seiten.length > 0) {
      ts.legeSeitenAnFuerDoc(fremdDesk, docIds.get(datei.key)!, seiten.map((s) => ({ page: s.seite, pdfText: s.text })));
    }
  }
  for (const datei of setup.privatFremd?.dateien ?? []) {
    // Dasselbe Mandat, aber privat-unsichtbar: ein ZWEITER Nutzer legt das Dokument in
    // seine private Ebene (privat-<zweitId>) — der MCP-Token-Inhaber sieht es nicht.
    const docId = await ts.addDoc(deskId, datei.name);
    docIds.set(datei.key, docId);
    const seiten = (setup.seitenTexte ?? []).filter((s) => s.dateiKey === datei.key);
    if (seiten.length > 0) {
      ts.legeSeitenAnFuerDoc(deskId, docId, seiten.map((s) => ({ page: s.seite, pdfText: s.text })));
    }
    const zweit = await ts.zweitBenutzer();
    ts.gewaehreRolle(deskId, zweit.userId, 'Bearbeiter');
    await sendCommand(ts.deskUrl, zweit.token, deskId, {
      type: 'changeLayerId',
      payload: { objectId: docId, layerId: 'privat' },
    });
  }
  for (const notiz of setup.notizen ?? []) {
    const id = `eval-${fall.id}-${notiz.key}`;
    await sendCommand(ts.deskUrl, ts.token, deskId, {
      type: 'addNote',
      payload: { id, kind: notiz.kind, text: notiz.text, position: { x: 0, y: 0 } },
    });
    notizIds.set(notiz.key, id);
  }
  // Seitentexte der regulären Dateien (fremdesMandat/privatFremd sind oben behandelt).
  const eigeneKeys = new Set((setup.dateien ?? []).map((d) => d.key));
  for (const key of eigeneKeys) {
    const seiten = (setup.seitenTexte ?? []).filter((s) => s.dateiKey === key);
    if (seiten.length > 0) {
      ts.legeSeitenAnFuerDoc(deskId, docIds.get(key)!, seiten.map((s) => ({
        page: s.seite,
        ...(s.ocr === true ? { ocrText: s.text } : { pdfText: s.text }),
      })));
    }
  }

  const argumente = loeseVerweise(fall.argumente, docIds, notizIds) as Record<string, unknown>;

  if (fall.tool === 'rest:vorschlaege') {
    // Batch-Einsteig (s. Modulkommentar): Mehrquellen-/Budget-Fälle direkt gegen die
    // REST-Grenze — derselbe Server, dasselbe Token, dieselbe pruefeQuellen-Prüfung.
    const res = await fetch(`${ts.deskUrl}/api/v1/desks/${deskId}/vorschlaege`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...argumente }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const registerZeilen = await registerZeilenZaehlen(ts, deskId);
    if (res.ok) {
      return { ausgang: 'akzeptieren', registerZeilen, vorschlagId: String(body.vorschlagId), rohAntwort: body };
    }
    return { ausgang: 'ablehnen', grund: typeof body.grund === 'string' ? body.grund : undefined, registerZeilen, rohAntwort: body };
  }

  const aufruf = () =>
    ts.mcpClient.callTool({ name: fall.tool, arguments: { ...argumente, deskId } });

  const r = await aufruf();
  const text = textOf(r);

  if (r.isError !== true) {
    const ergebnis = JSON.parse(text) as { vorschlagId: string };
    let vorschlagId = ergebnis.vorschlagId;
    if (fall.replay === true) {
      const r2 = await aufruf();
      const zweit = JSON.parse(textOf(r2)) as { vorschlagId: string };
      if (zweit.vorschlagId !== vorschlagId) {
        // Replay-Bruch: zweite Registerzeile oder neue id — der Fall geht als ablehnen-
        // Artifakt zurück, damit der Erwartungsvergleich ihn als FAIL sichtbar macht.
        return { ausgang: 'ablehnen', grund: 'replay_bruch', registerZeilen: await registerZeilenZaehlen(ts, deskId), rohAntwort: { erst: vorschlagId, zweit: zweit.vorschlagId } };
      }
      vorschlagId = zweit.vorschlagId;
    }
    return { ausgang: 'akzeptieren', registerZeilen: await registerZeilenZaehlen(ts, deskId), vorschlagId, rohAntwort: ergebnis };
  }

  // Ablehnung: fachlicher Fachfehler (fehler()-JSON mit grund) oder SDK-Protokollfehler
  // (strikte Schema-Validierung VOR dem Handler — Text 'Invalid arguments', kein grund-JSON).
  let grund: string | undefined;
  let rohAntwort: unknown = text;
  try {
    const fehlerJson = JSON.parse(text) as { grund?: string };
    if (typeof fehlerJson.grund === 'string') {
      grund = fehlerJson.grund;
      rohAntwort = fehlerJson;
    }
  } catch {
    // kein JSON — Protokollebene
  }
  if (grund === undefined && text.includes('Invalid arguments')) grund = 'protokollfehler';
  return { ausgang: 'ablehnen', grund, registerZeilen: await registerZeilenZaehlen(ts, deskId), rohAntwort };
}
