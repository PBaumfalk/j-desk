import { projectStateForActor, type ActorContext } from '@j-desk/core';
import type { Db } from '../db';
import { getDeskState } from '../deskStore';
import { KONFIDENZ_SCHWELLE } from '../ocr/ocrQueue';

export interface OcrStatus {
  unsicher: string[];
}

/**
 * SEARCH-03 (Chip-Anzeige): sichtbarkeitsgefilterte Statusabfrage für den OCR-Qualitäts-Chip an
 * der Karte (DocCard.svelte, 07-08-PLAN.md). Dieselbe Zwei-Stufen-Sichtbarkeitsprüfung wie
 * `sucheAufDesk` (searchQuery.ts, T-07-01/T-07-19): die Erlaubnisliste der fileIds entsteht
 * AUSSCHLIESSLICH aus `projiziert.docs` — nie aus dem Rohzustand, nie aus einer zweiten,
 * potenziell abweichenden Sichtbarkeitsprüfung (T-07-38).
 *
 * Aggregationsregel (Planner-Entscheidung, s. 07-08-PLAN.md-Objective, 07-UI-SPEC.md „unresolved"
 * offengelassen, 07-RESEARCH.md Open Question 1 empfiehlt dieselbe Lesart): die Dokument-Konfidenz
 * ist das MINIMUM der Seitenkonfidenzen über alle Seiten, für die tatsächlich ein OCR-Lauf
 * stattgefunden hat — Seiten ohne Erkennung (`ocr_confidence IS NULL`, z. B. Seiten mit
 * eingebettetem Text, die nie gerastert wurden) gehen NICHT in die Aggregation ein. Das ist die
 * konservativste, fail-honest-konsistente Lesart von „der Chip erscheint, sobald IRGENDEINE Seite
 * unter der Schwelle liegt": eine einzelne unbrauchbare Seite in einem langen, ansonsten gut
 * erkannten Dokument darf nicht in einem Durchschnitt verschwinden.
 */
export function ocrStatusFuerDesk(db: Db, deskId: string, ctx: ActorContext): OcrStatus {
  const result = getDeskState(db, deskId);
  if (!result) return { unsicher: [] };

  const projiziert = projectStateForActor(result.state, ctx);
  const sichtbareFileIds = [...new Set(projiziert.docs.map((doc) => doc.fileId))];
  // T-07-38: bei leerer Erlaubnisliste wird die Datenbank nicht befragt — kein Grund, eine
  // Abfrage mit einer leeren IN-Liste zu formulieren, und keine Möglichkeit, aus dem Ausbleiben
  // einer Abfrage irgendetwas über unsichtbare Dateien abzuleiten.
  if (sichtbareFileIds.length === 0) return { unsicher: [] };

  const platzhalter = sichtbareFileIds.map(() => '?').join(', ');
  const zeilen = db
    .prepare(
      `SELECT fe.file_id AS fileId, MIN(fp.ocr_confidence) AS minKonfidenz
       FROM file_extract fe
       JOIN file_pages fp ON fp.file_id = fe.file_id AND fp.ocr_confidence IS NOT NULL
       WHERE fe.stand = 'ocr-fertig' AND fe.file_id IN (${platzhalter})
       GROUP BY fe.file_id`,
    )
    .all(...sichtbareFileIds) as { fileId: string; minKonfidenz: number | null }[];

  const unsicher = zeilen
    .filter((z) => typeof z.minKonfidenz === 'number' && z.minKonfidenz < KONFIDENZ_SCHWELLE)
    .map((z) => z.fileId);

  return { unsicher };
}
