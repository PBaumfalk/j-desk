import {
  projectStateForActor,
  zitatAufloesbar,
  type ActorContext,
  type Quelle,
} from '@j-desk/core';
import type { Db } from './db';
import { getDeskState } from './deskStore';

/**
 * Serverseitige Zitat-Verifikation der KI-Quellenpflicht (Phase 12, AI-03) — die DB-Brücke
 * über dem reinen Kernmodul `quelle.ts`. Sie entscheidet, ob ein Vorschlag mit Quellenangabe
 * überhaupt persistiert werden darf (Quellenbruch, AI-SPEC Failure Mode 3).
 *
 * SICHTBARKEITS-DISZIPLIN (verbindlich, T-12-02-01): die Erlaubnisliste der prüfbaren
 * Dokumente kommt AUSSCHLIESSLICH aus `projectStateForActor(state, ctx).docs` — nie aus dem
 * Rohzustand, nie aus einer zweiten, eigenen Filterlogik. Das ist exakt das
 * `fileTextFuerDesk`-Muster (search/fileText.ts) und schließt die zweimal real aufgetretene
 * Leck-Bugklasse aec4f58/fcda808 strukturell. Bei einer docId, die in der Projektion fehlt,
 * wird die Datenbank NICHT befragt (T-09-31/32) — und die Funktion gibt niemals aus, WARUM
 * ein Dokument nicht prüfbar ist: 'mandat_fremd' ist die eine, generische Antwort für
 * „unsichtbar", „nicht auf diesem Desk" und „existiert gar nicht" gleichermaßen (keine
 * Existenz-Auskunft über Fremddokumente).
 *
 * Ehrlichkeit statt Durchwinken: fehlt der Seitentext (weder pdf_text noch ocr_text in
 * file_pages), lautet der grund 'text_nicht_extrahiert' — die Verifikation kann nicht
 * prüfen, was nicht extrahiert wurde, und sagt das. Kein Dokumenttext und kein Zitat
 * gelangen in Fehlertexte oder Logs: Ablehnungsgründe sind maschinenlesbare Codes
 * (`grund`), `betroffeneQuelle` spiegelt ausschließlich die Eingabe des Aufrufers
 * (Retry-Kanal des Agenten, AI-SPEC Section 4b) — niemals Inhalt aus der Datenbank.
 */

export type QuellenGrund = 'mandat_fremd' | 'text_nicht_extrahiert' | 'zitat_nicht_auflösbar';

export type QuellenFehler = {
  ok: false;
  grund: QuellenGrund;
  /** Spiegel der EINGABE (Retry-Kanal) — enthält keinen Datenbankinhalt. */
  betroffeneQuelle: Quelle;
};

export type QuellenErfolg = { ok: true; dokumentId: string; seite: number };

/** Generische Ablehnung für jeden Sichtbarkeits-/Existenz-Fall — bewusst wortgleich,
 *  damit aus der Antwort nichts über Fremddokumente ableitbar ist. */
function mandatFremd(quelle: Quelle): QuellenFehler {
  return { ok: false, grund: 'mandat_fremd', betroffeneQuelle: quelle };
}

/**
 * Prüft eine einzelne Quellenangabe: (a) Desk-Zustand laden (fehlender Desk → generisch
 * 'mandat_fremd'); (b) Projektion für den Akteur bilden; (c) docId gegen die projizierte
 * Erlaubnisliste — nicht gefunden → 'mandat_fremd', OHNE die DB zu befragen; (d) Seitentext
 * aus file_pages (pdf_text zuerst, ocr_text als Fallback) — fehlt beides, ist der grund
 * 'text_nicht_extrahiert'; (e) wörtliche Auflösung über das Kernmodul — scheitert sie, ist
 * der grund 'zitat_nicht_auflösbar' (Seitenbindung ist Teil der Quellenpflicht).
 */
export function pruefeQuelle(
  db: Db,
  deskId: string,
  quelle: Quelle,
  ctx: ActorContext,
): QuellenErfolg | QuellenFehler {
  const result = getDeskState(db, deskId);
  if (!result) return mandatFremd(quelle);

  const projiziert = projectStateForActor(result.state, ctx);
  const doc = projiziert.docs.find((d) => d.id === quelle.dokumentId);
  // T-12-02-01: bei nicht sichtbarer (oder nicht existierender) docId wird die Datenbank
  // NICHT befragt — kein Grund für eine Abfrage, keine Ableitbarkeit aus ihrem Ausbleiben.
  if (!doc) return mandatFremd(quelle);

  const zeile = db
    .prepare(
      `SELECT page AS seite, pdf_text AS pdfText, ocr_text AS ocrText
       FROM file_pages
       WHERE file_id = ? AND page = ?`,
    )
    .get(doc.fileId, quelle.seite) as
    | { seite: number; pdfText: string | null; ocrText: string | null }
    | undefined;

  // pdf_text zuerst, ocr_text als Fallback (fileTextFuerDesk-Vorbild); fehlt beides, ist
  // die ehrliche Antwort 'text_nicht_extrahiert' — nie still durchwinken.
  const seitenText = zeile?.pdfText ?? zeile?.ocrText ?? null;
  if (!seitenText) {
    return { ok: false, grund: 'text_nicht_extrahiert', betroffeneQuelle: quelle };
  }

  if (!zitatAufloesbar(seitenText, quelle.zitat)) {
    return { ok: false, grund: 'zitat_nicht_auflösbar', betroffeneQuelle: quelle };
  }
  return { ok: true, dokumentId: doc.id, seite: quelle.seite };
}

/**
 * Listen-Variante für den Erstellungspfad (Plan 12-03): prüft in Eingabereihenfolge und
 * liefert beim ERSTEN Fehler genau diesen — atomare Semantik, kein Teilerfolg, keine
 * Weiterprüfung nach einer gescheiterten Quelle (AI-SPEC Pitfall 3: ein Batch-Vorschlag
 * darf nie mit einer nicht auflösbaren Fundstelle persistiert werden). Bei lauter
 * auflösbaren Quellen das Erfolgs-Array in Eingabereihenfolge.
 */
export function pruefeQuellen(
  db: Db,
  deskId: string,
  quellen: Quelle[],
  ctx: ActorContext,
): QuellenErfolg[] | QuellenFehler {
  const erfolge: QuellenErfolg[] = [];
  for (const quelle of quellen) {
    const ergebnis = pruefeQuelle(db, deskId, quelle, ctx);
    if (!ergebnis.ok) return ergebnis;
    erfolge.push(ergebnis);
  }
  return erfolge;
}
