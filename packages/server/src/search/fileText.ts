import { projectStateForActor, type ActorContext } from '@j-desk/core';
import type { Db } from '../db';
import { getDeskState } from '../deskStore';

/** Text einer einzelnen Seite — `quelle` benennt, ob der Text eingebettet vorlag oder erkannt
 *  wurde (COMP-02, 09-08-PLAN.md). Keine Wortkoordinaten: die Erkennung aus Phase 7 speichert
 *  keine Wortrechtecke, dieser Rückfallweg liefert bewusst nur Text ohne Positionsmarkierung. */
export interface SeitenText {
  seite: number;
  text: string;
  quelle: 'pdf-text' | 'ocr';
}

/**
 * COMP-01/02 (09-08-PLAN.md): sichtbarkeitsgefilterte Textabfrage für den Rückfallweg
 * eingescannter Fassungen im Vergleichsviewer — dieselbe Zwei-Stufen-Sichtbarkeitsprüfung wie
 * `ocrStatusFuerDesk` (ocrStatus.ts, T-07-38/T-09-31): die Erlaubnisliste der fileIds entsteht
 * AUSSCHLIESSLICH aus `projiziert.docs` — nie aus dem Rohzustand, nie aus dem Papierkorb, nie
 * aus einer zweiten, potenziell abweichenden Sichtbarkeitsprüfung.
 *
 * Rückgabe `null` bedeutet „nicht auslieferbar" und wird von der Route (app.ts) in GENAU EINE,
 * ununterscheidbare Ablehnung übersetzt — weder der Umstand, dass der Schreibtisch fehlt, noch
 * der, dass die Datei existiert aber unsichtbar ist, noch der, dass sie schlicht nicht existiert,
 * darf aus der Antwort ableitbar sein (T-09-32).
 */
export function fileTextFuerDesk(
  db: Db,
  deskId: string,
  fileId: string,
  ctx: ActorContext,
): { seiten: SeitenText[]; stand: string } | null {
  const result = getDeskState(db, deskId);
  if (!result) return null;

  const projiziert = projectStateForActor(result.state, ctx);
  const sichtbareFileIds = new Set(projiziert.docs.map((doc) => doc.fileId));
  // T-09-31/T-09-32: bei nicht sichtbarer (oder nicht existierender) Datei-id wird die
  // Datenbank NICHT befragt — kein Grund für eine Abfrage, und keine Möglichkeit, aus dem
  // Ausbleiben einer Abfrage irgendetwas über die Datei abzuleiten.
  if (!sichtbareFileIds.has(fileId)) return null;

  const zeilen = db
    .prepare(
      `SELECT page AS seite, pdf_text AS pdfText, ocr_text AS ocrText
       FROM file_pages
       WHERE file_id = ?
       ORDER BY page`,
    )
    .all(fileId) as { seite: number; pdfText: string | null; ocrText: string | null }[];

  // Der Text wird unverändert durchgereicht — keine Normalisierung hier, die liegt im
  // Vergleichsmodul (Plan 09-03) und darf nicht doppelt existieren. Seiten ganz ohne Text
  // (weder eingebettet noch erkannt) tragen keinen Eintrag — eine leere Liste ist der
  // wohlgeformte, ehrliche Zustand, kein Fehler.
  const seiten: SeitenText[] = [];
  for (const z of zeilen) {
    if (z.pdfText) {
      seiten.push({ seite: z.seite, text: z.pdfText, quelle: 'pdf-text' });
    } else if (z.ocrText) {
      seiten.push({ seite: z.seite, text: z.ocrText, quelle: 'ocr' });
    }
  }

  const extraktZeile = db.prepare('SELECT stand FROM file_extract WHERE file_id = ?').get(fileId) as
    | { stand: string }
    | undefined;
  // Kein file_extract-Eintrag (z. B. nie extrahiert): 'unbekannt' statt eines Fehlers — dieselbe
  // fail-honest-Lesart wie eine leere Seitenliste, keine Ablehnung.
  const stand = extraktZeile?.stand ?? 'unbekannt';

  return { seiten, stand };
}
