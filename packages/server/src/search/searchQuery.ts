import { projectStateForActor, VERSIONIERTE_ARTEN, type ActorContext, type DesktopState } from '@j-desk/core';
import type { Db } from '../db';
import { getDeskState } from '../deskStore';
import { KONFIDENZ_SCHWELLE } from '../ocr/ocrQueue';

export const SUCHE_MAX_TREFFER = 30;

export type TrefferArt =
  | 'Karte'
  | 'Stapel'
  | 'Zettel'
  | 'Verknüpfung'
  | 'Markierung'
  | 'Stempel'
  | 'Ausschnitt'
  | 'PDF-Text'
  | 'OCR'
  | 'Zeitleiste'
  | 'Objekt'
  | 'Tabelle';

export interface SucheTreffer {
  id: string;
  art: TrefferArt;
  objId?: string;
  fileId?: string;
  docId?: string;
  page?: number;
  label: string;
  snippet?: string;
  ersteller?: string;
  datum?: string;
  ocrUnsicher?: boolean;
  rang: number;
}

/**
 * obj_type-Wert aus `search_fts` (= VERSIONIERTE_ARTEN-Eintrag) → Anzeige-Art im
 * Copywriting-Contract (07-UI-SPEC.md). Bewusst OHNE `flags`-Eintrag: Fahnen werden zwar in
 * `indexZeileFuer` indiziert (searchSync.ts), haben aber weder in 07-UI-SPEC.md noch in der
 * Klick-Weiche von 07-03-PLAN.md einen eigenen Art-Badge — ein Fahnen-Kandidat fällt daher unten
 * über `if (!art) continue` lautlos aus der Ergebnisliste (dieselbe Stelle, die auch
 * `strokes`/`clips`-Reste abfangen würde, kämen sie je in `search_fts` vor).
 *
 * WR-03 (09-REVIEW.md): `zeitleisten` ist bewusst enthalten — `indexZeileFuer` (searchSync.ts)
 * indiziert den festen Kartentitel einer Zeitleiste als eigene Produktentscheidung dieser Phase
 * (09-02 revidierte 09-01s ursprüngliche Entscheidung dagegen); ohne diesen Eintrag würde jede so
 * indizierte Zeile hier stillschweigend herausgefiltert und die Indizierung bliebe wirkungslos.
 * `tables`/`legalObjects` waren dieselbe Lücke, nur aus Phase 8 — hier nachgezogen: beide
 * werden in `indexZeileFuer` (searchSync.ts) seit Phase 8 indiziert, fielen ohne Eintrag aber
 * ebenso lautlos heraus. Auswirkung war erheblich: alle 13 juristischen Objekttypen aus
 * LEGAL-01 (Tatsache, eigene Behauptung, Behauptung der Gegenseite, Beweismittel …) blieben
 * über die Suche unauffindbar, obwohl das Anlegen genau dieser Objekte der Kern des Produkts
 * ist. Am laufenden System reproduziert (2026-08-10): „Kaufpreis" lieferte null Treffer, obwohl
 * eine Behauptungskarte mit diesem Wort auf dem Tisch lag.
 *
 * Damit das Muster nicht ein viertes Mal auftritt, prüft ein Wächtertest in
 * `searchQuery.test.ts`, dass jede Art aus `VERSIONIERTE_ARTEN` entweder einen Badge hat oder
 * ausdrücklich als badge-los geführt wird — eine wirkungslose Indizierung fällt sonst nicht auf.
 */
export const ART_ZU_TREFFERART: Partial<Record<string, TrefferArt>> = {
  docs: 'Karte',
  stacks: 'Stapel',
  notes: 'Zettel',
  links: 'Verknüpfung',
  marks: 'Markierung',
  stamps: 'Stempel',
  cutouts: 'Ausschnitt',
  zeitleisten: 'Zeitleiste',
  legalObjects: 'Objekt',
  tables: 'Tabelle',
};

/**
 * SEARCH-04/T-07-09: keine Zitat-Vorschau für Schwärzungsflächen. Beide `MarkKind`-Werte
 * (`redact` UND `tippex`) gelten als echte Schwärzung — wortgleiche Definition wie
 * `istEchteSchwaerzung()` in `src/lib/markSchwaerzung.ts` (client-seitig, nicht von hier aus
 * importierbar: `src/lib` ist SvelteKit-App-Code, kein Teil von `@j-desk/core`). Diese engere
 * "nur redact"-Lesart wäre bereits zweimal ein realer Leck-Bug gewesen (CR-02 ProvenancePopover,
 * CR-03 history.ts) — der Export (pdfExport.ts D-01) behandelt beide Arten identisch als echte
 * Schwärzung (beide löschen den darunterliegenden Content-Stream-Text), also muss die Suche das
 * auch tun, sonst leckt ein Tipp-Ex-Textsnapshot über die Suchvorschau ein drittes Mal.
 */
export function snippetErlaubt(art: string, obj: unknown): boolean {
  if (art !== 'marks' || obj === null || typeof obj !== 'object') return true;
  const kind = (obj as Record<string, unknown>).kind;
  return kind !== 'redact' && kind !== 'tippex';
}

/** Löst `fromId`/`toId` einer Verknüpfung auf einen Anzeigenamen auf — NUR im PROJIZIERTEN
 *  State (nie im Rohzustand): ein für den Betrachter unsichtbares Zielobjekt liefert `undefined`,
 *  NIE einen Platzhalter (T-07-10) — sonst ließe sich aus dem Platzhalter allein schon die
 *  Existenz eines unsichtbaren Objekts ableiten. */
function benennungFuerId(state: DesktopState, id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  const doc = state.docs.find((d) => d.id === id);
  if (doc && doc.name.trim() !== '') return doc.name;
  const stack = state.stacks.find((s) => s.id === id);
  if (stack && stack.name.trim() !== '') return stack.name;
  return undefined;
}

/**
 * Zerlegt den Nutzertext in einen FTS5-MATCH-Ausdruck: Buchstaben (inkl. deutscher Umlaute
 * und ß), Ziffern und Bindestriche bilden Tokens, alles andere trennt. Leere Tokenmenge → null.
 * Jedes Token wird gequotet (enthaltene Anführungszeichen verdoppelt), das LETZTE Token
 * zusätzlich mit angehängtem `*` für Präfixtreffer (deutsche Komposita: Teilworteingabe soll
 * am Wortanfang treffen, 07-RESEARCH.md Pitfall 5).
 *
 * ASVS V5 / T-07-03: kein Operatorzeichen aus dem Nutzertext kann so die FTS5-Suchsemantik
 * verändern oder einen Parserfehler auslösen — die Bereinigung ersetzt NICHT die Parameter-
 * bindung, der fertige Ausdruck wird trotzdem ausschließlich als gebundener Parameter an
 * `MATCH ?` übergeben (nie interpoliert, auch nicht „nur für das Ranking").
 */
export function fts5QueryAus(q: string): string | null {
  const tokens = q.match(/[\p{L}\p{N}-]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .map((t, i) => {
      const gequotet = `"${t.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${gequotet}*` : gequotet;
    })
    .join(' ');
}

/**
 * Label-Regeln, wortgleich vom bisherigen Client-Filter (Desktop.svelte) übernommen: Doc →
 * `name`; Stack → `name` oder `Stapel (<Anzahl docIds>)`; Note → optionales
 * `[customLabel] `-Präfix plus getrimmter `text`, auf 60 Zeichen gekappt. Für Notizen ohne
 * Text (nur Kind, kein Volltext) bleibt hier bewusst der getrimmte Leerstring — 07-03 füllt
 * die Beschriftung anhand des Kind-Labels clientseitig auf.
 *
 * `state` ist der PROJIZIERTE State (nie der Rohzustand) — einzig relevant für `links`, wo
 * `fromId`/`toId` auf Karten-/Stapelnamen aufgelöst werden (T-07-10).
 */
export function labelFuer(art: string, obj: Record<string, unknown>, state: DesktopState): string {
  if (art === 'docs') return typeof obj.name === 'string' ? obj.name : '';
  if (art === 'stacks') {
    if (typeof obj.name === 'string' && obj.name.trim() !== '') return obj.name;
    const anzahl = Array.isArray(obj.docIds) ? obj.docIds.length : 0;
    return `Stapel (${anzahl})`;
  }
  if (art === 'notes') {
    const praefix = typeof obj.customLabel === 'string' && obj.customLabel.trim() !== '' ? `[${obj.customLabel}] ` : '';
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    return `${praefix}${text}`.slice(0, 60);
  }
  if (art === 'marks') {
    const kindLabel = obj.kind === 'redact' ? 'Schwärzung' : 'Tipp-Ex';
    const seite = typeof obj.page === 'number' ? `, S. ${obj.page}` : '';
    const beginn =
      snippetErlaubt(art, obj) && typeof obj.textSnapshot === 'string' && obj.textSnapshot.trim() !== ''
        ? `: ${obj.textSnapshot.trim().slice(0, 40)}`
        : '';
    return `${kindLabel}${seite}${beginn}`;
  }
  if (art === 'stamps') {
    return typeof obj.text === 'string' ? obj.text : '';
  }
  if (art === 'cutouts') {
    if (typeof obj.sourceName === 'string' && obj.sourceName.trim() !== '') return obj.sourceName;
    const seite = typeof obj.page === 'number' ? `, S. ${obj.page}` : '';
    return `Ausschnitt${seite}`;
  }
  if (art === 'links') {
    const note = typeof obj.note === 'string' ? obj.note.trim() : '';
    if (note !== '') return note;
    const namen = [benennungFuerId(state, obj.fromId), benennungFuerId(state, obj.toId)].filter(
      (n): n is string => n !== undefined,
    );
    return namen.join(' ↔ ');
  }
  // Juristische Objekte tragen ihre Aussage im Freitext — dieselbe Kürzung wie `notes` oben,
  // damit eine lange Behauptung die Trefferliste nicht sprengt. Ohne diesen Zweig fiel der
  // Eintrag zwar durch (der Badge allein reicht für die Auslieferung), erschien aber mit leerem
  // Label: ein Treffer, den man in der Liste nicht lesen kann.
  if (art === 'legalObjects') {
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    return text.slice(0, 60);
  }
  // Tabellen: nur der Kartentitel ist indiziert (Zellen bewusst nicht, s. searchSync.ts), also
  // ist er auch das Label. Unbenannte Tabellen tragen einen leeren Titel — dann ein sprechender
  // Ersatz statt einer leeren Zeile, nach dem Vorbild von `stacks` oben.
  if (art === 'tables') {
    const titel = typeof obj.titel === 'string' ? obj.titel.trim() : '';
    return titel !== '' ? titel.slice(0, 60) : 'Tabelle';
  }
  return '';
}

/** Harte Obergrenze der Vorschau-Länge in der HTTP-Antwort — s. `gekuerzterSnippet()`. */
const SNIPPET_MAX = 80;

/**
 * Zusätzliche, harte Kürzung der bereits durch `snippet()` grob begrenzten FTS5-Vorschau auf
 * höchstens 80 Zeichen (beidseitige Auslassungszeichen bleiben erhalten, sofern vorhanden).
 *
 * Dokumentierte Abweichung von 07-UI-SPEC.md (Copywriting Contract, Zeile „Snippet-Zitat"): die
 * Spec verlangt zusätzlich ein `title`-Attribut mit dem UNGEKÜRZTEN Fundtext. Das liefert dieser
 * Plan bewusst NICHT — `Mark.textSnapshot`/`Cutout.textSnapshot` reichen bis 2000 Zeichen, und
 * ein `title`-Tooltip mit vollständigem internem Annotationstext ist in einem Mandantenumfeld
 * eine unnötige Preisgabefläche (Bildschirmfreigabe, Screenshot, Blick über die Schulter). Der
 * Client setzt `title` stattdessen auf dieselbe gekürzte Vorschau — was der Server nie sendet,
 * kann nicht durchsickern.
 */
function gekuerzterSnippet(roh: string): string {
  if (roh.length <= SNIPPET_MAX) return roh;
  return `${roh.slice(0, SNIPPET_MAX - 1)}…`;
}

/**
 * WR-03 (07-Review): `bm25()` ist corpus-relativ je Virtual Table — die Term-/Dokument-
 * häufigkeiten von `search_fts` (kurze Objekt-Labels) und `file_pages_fts` (volle Seitentexte)
 * unterscheiden sich, ein `-2.1` aus der einen Tabelle ist also NICHT ohne Weiteres relevanter
 * oder weniger relevant als ein `-2.1` aus der anderen. Min-Max-Normalisierung INNERHALB jeder
 * Quelle (auf [0, 1], 0 = bester Treffer der jeweiligen Quelle) macht die Werte über Quellen
 * hinweg vergleichbar, bevor sie in einer gemeinsamen Liste sortiert werden — mutiert die
 * übergebenen Objekte in place, damit dieselbe Referenz später in `treffer` landet.
 *
 * WR-03-residual (07-Review, Iteration 2): Aufrufer MUSS bereits auf die für den Betrachter
 * sichtbaren Kandidaten gefiltert haben, BEVOR normalisiert wird — ein unsichtbarer Kandidat
 * (z. B. private Ebene eines anderen Nutzers) mit extremem BM25-Rohwert würde sonst die
 * min/max-Skala verzerren, gegen die auch die sichtbaren Kandidaten normalisiert werden, obwohl
 * er selbst nie in `treffer` landet (T-07-01 filtert ihn dort ohnehin lautlos heraus).
 */
function normalisiereRaenge(kandidaten: { rang: number }[]): void {
  if (kandidaten.length === 0) return;
  const werte = kandidaten.map((k) => k.rang);
  const min = Math.min(...werte);
  const max = Math.max(...werte);
  const spanne = max - min;
  for (const k of kandidaten) {
    k.rang = spanne === 0 ? 0 : (k.rang - min) / spanne;
  }
}

/**
 * Zweistufige Sichtbarkeitsprüfung (SEARCH-04, T-07-01): `search_fts` liefert nur Kandidaten
 * (auch aus für den Anfragenden unsichtbaren Ebenen — der Index selbst ist KEIN Sicherheits-
 * Grenzobjekt), behalten wird ein Kandidat NUR, wenn seine `obj_id` unter derselben Art im
 * ERGEBNIS von `projectStateForActor()` tatsächlich vorkommt. Keine zweite, konkurrierende
 * Sichtbarkeitsprüfung — dieselbe Bugklasse hat dieses Projekt bereits zweimal real erzeugt
 * (aec4f58, fcda808), siehe auch die Begründung in projection.ts.
 *
 * Die Kappung auf SUCHE_MAX_TREFFER steht ERST NACH diesem Filter (T-07-02): sonst könnte ein
 * unsichtbarer, aber textlich relevanterer Kandidat einen sichtbaren, weniger relevanten
 * Treffer aus der gekappten Liste verdrängen.
 */
export function sucheAufDesk(db: Db, deskId: string, ctx: ActorContext, q: string): SucheTreffer[] {
  const ftsQuery = fts5QueryAus(q);
  if (ftsQuery === null) return [];

  const result = getDeskState(db, deskId);
  if (!result) return [];

  const projiziert = projectStateForActor(result.state, ctx);
  const objekteNachArt = new Map<string, Map<string, Record<string, unknown>>>();
  for (const art of VERSIONIERTE_ARTEN) {
    const liste = (projiziert as unknown as Record<string, Record<string, unknown>[] | undefined>)[art];
    if (!liste) continue;
    objekteNachArt.set(art, new Map(liste.map((o) => [o.id as string, o])));
  }

  // fileId → Doc-Zuordnung aus dem PROJIZIERTEN State (07-04, SEARCH-01 "PDF-Inhalt"): gleichzeitig
  // die Erlaubnisliste für Kandidaten B (Datei-Text) UND die Quelle für docId/label beim Sprung.
  // Bei mehreren Karten derselben Datei auf diesem Desk wird die ERSTE genommen — der Sprung
  // landet dann auf einer der Karten, was fachlich genügt.
  const docJeFileId = new Map<string, (typeof projiziert.docs)[number]>();
  for (const doc of projiziert.docs) {
    if (!docJeFileId.has(doc.fileId)) docJeFileId.set(doc.fileId, doc);
  }

  const kandidaten = db
    .prepare(
      `SELECT obj_type AS objType, obj_id AS objId,
              snippet(search_fts, 4, '', '', '…', 12) AS snippet,
              bm25(search_fts) AS rang
       FROM search_fts WHERE search_fts MATCH ? AND desk_id = ?
       ORDER BY rang`,
    )
    .all(ftsQuery, deskId) as { objType: string; objId: string; snippet: string; rang: number }[];
  // WR-03-residual/WR-04: Der Filter vor der Normalisierung muss beides prüfen — Sichtbarkeit
  // (T-07-01) UND Art-Badge —, sonst verzerrt ein Kandidat, der später sowieso aus `treffer`
  // fällt (z. B. flags: indiziert, aber ohne Art-Badge, s. o.), die min/max-Skala für die,
  // die tatsächlich angezeigt werden.
  const kandidatenSichtbar = kandidaten.filter(
    (k) =>
      objekteNachArt.get(k.objType)?.get(k.objId) !== undefined &&
      ART_ZU_TREFFERART[k.objType] !== undefined,
  );
  normalisiereRaenge(kandidatenSichtbar); // WR-03: eigene Skala von search_fts, s. Kommentar oben.

  const treffer: SucheTreffer[] = [];
  for (const k of kandidatenSichtbar) {
    const obj = objekteNachArt.get(k.objType)!.get(k.objId)!;
    const art = ART_ZU_TREFFERART[k.objType]!; // durch den Filter oben garantiert definiert

    const eintrag: SucheTreffer = {
      id: k.objId,
      art,
      objId: k.objId,
      label: labelFuer(k.objType, obj, projiziert),
      ersteller: typeof obj.createdBy === 'string' ? obj.createdBy : undefined,
      datum: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
      rang: k.rang,
    };
    // T-07-09/T-07-11: kein Zitat für Schwärzungen, sonst hart auf SNIPPET_MAX gekürzt. Leeres
    // `snippet()`-Ergebnis (Treffer kam nur über ersteller/datum, nicht über `text`) bleibt
    // ebenfalls weg statt als leerer String zu erscheinen.
    if (snippetErlaubt(k.objType, obj) && k.snippet.trim() !== '') {
      eintrag.snippet = gekuerzterSnippet(k.snippet);
    }
    // 07-03 braucht diese Felder für den Sprung — NUR für die Arten, die sie tatsächlich tragen
    // (marks/stamps: docId+page; cutouts: fileId+page). Bewusst NICHT generisch über
    // `obj.docId`/`obj.fileId`/`obj.page`, weil z. B. `Doc` selbst ein `fileId` UND ein `page`
    // (aktuell angezeigte Seite) trägt, das hier nichts mit einem Sprungziel zu tun hat.
    if (k.objType === 'marks' || k.objType === 'stamps') {
      if (typeof obj.docId === 'string') eintrag.docId = obj.docId;
      if (typeof obj.page === 'number') eintrag.page = obj.page;
    } else if (k.objType === 'cutouts') {
      if (typeof obj.fileId === 'string') eintrag.fileId = obj.fileId;
      if (typeof obj.page === 'number') eintrag.page = obj.page;
    }

    treffer.push(eintrag);
  }

  // Kandidaten B: Datei-Text (SEARCH-01 "PDF-Inhalt", 07-04) UND OCR-Text (SEARCH-03, 07-07). Die
  // Einschränkung auf die sichtbaren fileIds in der Abfrage (IN-Liste) ist Effizienz — die
  // Prüfung GEGEN DIESELBE Zuordnung nach der Abfrage (`docJeFileId.get(k.fileId)`) ist die
  // eigentliche Sicherheitsaussage (T-07-19): doppelte Absicherung, nicht nur eine. Dieselbe
  // Erlaubnisliste gilt für BEIDE Herkunftsarten — kein separater, potenziell schwächerer
  // Sichtbarkeitspfad für OCR-Treffer.
  const sichtbareFileIds = [...docJeFileId.keys()];
  if (sichtbareFileIds.length > 0) {
    const platzhalter = sichtbareFileIds.map(() => '?').join(', ');

    // Zwei spaltengefilterte FTS5-Abfragen statt einer einzigen (07-07): ein Kandidat, dessen
    // pdf_text zufällig nicht leer ist, aber dessen TREFFER nur im ocr_text derselben Seite
    // liegt (Seite hat beides — kurzer eingebetteter Text plus OCR-Ergebnis), würde sich sonst
    // fälschlich als 'PDF-Text' ausgeben. Der FTS5-Spaltenfilter (`spalte : ausdruck`, s.
    // sqlite.org/fts5.html#fts5_column_filters) bindet den bereits vollständig sanitierten
    // `ftsQuery` (fts5QueryAus — quotierte Tokens, kein rohes Operatorzeichen) NUR an die
    // jeweilige Spalte; die Injektionsfreiheit (ASVS V5) bleibt dieselbe wie zuvor, weil der
    // Nutzertext ausschließlich über den bereits gebundenen, gequoteten Ausdruck einfließt.
    const dateiTextKandidat = (spalte: 'pdf_text' | 'ocr_text', snippetSpaltenIndex: 2 | 3) =>
      db
        .prepare(
          `SELECT file_id AS fileId, page,
                  snippet(file_pages_fts, ${snippetSpaltenIndex}, '', '', '…', 12) AS snippet,
                  bm25(file_pages_fts) AS rang
           FROM file_pages_fts WHERE file_pages_fts MATCH ? AND file_id IN (${platzhalter})`,
        )
        .all(`${spalte} : ${ftsQuery}`, ...sichtbareFileIds) as {
        fileId: string;
        page: number;
        snippet: string;
        rang: number;
      }[];

    const pdfTextKandidaten = dateiTextKandidat('pdf_text', 2);
    const ocrKandidaten = dateiTextKandidat('ocr_text', 3);
    // WR-03: beide Kandidatenlisten kommen aus DERSELBEN Virtual Table (file_pages_fts) und
    // teilen sich damit dieselbe bm25-Skala — gemeinsam normalisieren, nicht getrennt, sonst
    // würde ausgerechnet die hier korrekte Vergleichbarkeit wieder zerstört.
    normalisiereRaenge([...pdfTextKandidaten, ...ocrKandidaten]);

    // Entfällt-Regel für Doppeltreffer derselben Seite (07-07): steht ein Begriff sowohl im
    // eingebetteten Text als auch im OCR-Text derselben Seite (Normalfall bei nachträglich mit
    // Textebene versehenen Scans), bleibt NUR der Treffer aus dem eingebetteten Text — die
    // zuverlässigere Quelle. Zwei Zeilen für dieselbe Fundstelle wären für den Nutzer Rauschen.
    const bereitsAlsPdfText = new Set(pdfTextKandidaten.map((k) => `${k.fileId}:${k.page}`));

    const confidenceStmt = db.prepare('SELECT ocr_confidence AS confidence FROM file_pages WHERE file_id = ? AND page = ?');

    for (const k of pdfTextKandidaten) {
      const doc = docJeFileId.get(k.fileId);
      if (!doc) continue; // T-07-19: Sicherheits-Gegenprobe NACH der Abfrage — s. Kommentar oben.

      const eintrag: SucheTreffer = {
        // Datei-Id UND Seite kombiniert: der Client braucht einen eindeutigen Schlüssel je Zeile.
        id: `${k.fileId}:${k.page}`,
        art: 'PDF-Text',
        fileId: k.fileId,
        docId: doc.id,
        page: k.page,
        label: doc.name,
        ersteller: typeof doc.createdBy === 'string' ? doc.createdBy : undefined,
        datum: typeof doc.createdAt === 'string' ? doc.createdAt : undefined,
        rang: k.rang,
      };
      if (k.snippet.trim() !== '') eintrag.snippet = gekuerzterSnippet(k.snippet);
      treffer.push(eintrag);
    }

    for (const k of ocrKandidaten) {
      const schluessel = `${k.fileId}:${k.page}`;
      if (bereitsAlsPdfText.has(schluessel)) continue; // Entfällt-Regel — s. Kommentar oben.
      const doc = docJeFileId.get(k.fileId);
      if (!doc) continue; // T-07-19: Sicherheits-Gegenprobe NACH der Abfrage — dieselbe Erlaubnisliste wie PDF-Text-Treffer.

      const confidenceZeile = confidenceStmt.get(k.fileId, k.page) as { confidence: number | null } | undefined;
      const eintrag: SucheTreffer = {
        id: schluessel,
        art: 'OCR',
        fileId: k.fileId,
        docId: doc.id,
        page: k.page,
        label: doc.name,
        ersteller: typeof doc.createdBy === 'string' ? doc.createdBy : undefined,
        datum: typeof doc.createdAt === 'string' ? doc.createdAt : undefined,
        rang: k.rang,
      };
      if (typeof confidenceZeile?.confidence === 'number' && confidenceZeile.confidence < KONFIDENZ_SCHWELLE) {
        eintrag.ocrUnsicher = true;
      }
      if (k.snippet.trim() !== '') eintrag.snippet = gekuerzterSnippet(k.snippet);
      treffer.push(eintrag);
    }
  }

  // Merge Kandidaten A + B, gemeinsam nach Relevanz sortiert, ERST DANACH auf SUCHE_MAX_TREFFER
  // gekappt (T-07-02) — sonst könnte ein unsichtbarer, relevanterer Kandidat einen sichtbaren,
  // weniger relevanten Treffer aus der gekappten Liste verdrängen.
  treffer.sort((a, b) => a.rang - b.rang);
  return treffer.slice(0, SUCHE_MAX_TREFFER);
}
