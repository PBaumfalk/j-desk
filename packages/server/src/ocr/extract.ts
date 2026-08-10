/**
 * PDF-Seitentextextraktion, serverseitig (SEARCH-01/SEARCH-03-Grundlage, 07-04). Portiert die
 * `getDocument`/`getPage`/`getTextContent`-Folge aus `src/lib/pdfText.ts` bzw.
 * `packages/server/src/export/verify.ts` (identischer Import-Pfad: der bereits im Projekt
 * serverseitig verwendete pdfjs-Legacy-Build, kein neues Paket).
 *
 * Unterschied zu `textInRect` (pdfText.ts): DORT wird JEDER Fehler zu '' geschluckt, weil das
 * Schneiden/Abdecken nie blockieren darf. HIER darf ein Extraktionsfehler NICHT verschluckt
 * werden — er muss von "Seite ohne eingebetteten Text" unterscheidbar bleiben, weil `ocrQueue.ts`
 * davon den `file_extract.stand`-Wert ableitet (`fehler` vs. `ocr-ausstehend`/`pdf-text`). Der
 * Aufrufer (ocrQueue.ts) fängt den Fehler stattdessen selbst und vermerkt ihn als Zustand.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Seitentext + OCR-Bedarf einer einzelnen PDF-Seite (dateilokal — Seite 1 = erste Seite DIESER Datei). */
export interface SeitenText {
  page: number;
  text: string;
  brauchtOcr: boolean;
}

/** Weniger extrahierte Zeichen auf einer Seite gilt als "kein eingebetteter Text", also OCR-Bedarf. */
export const TEXT_SCHWELLE_ZEICHEN = 20;

/**
 * Öffnet das PDF-Dokument, iteriert alle Seiten, liest `getTextContent()` und fügt die
 * Textelemente zu einem Seitentext zusammen (Trennung wie `pdfText.ts`/`verify.ts`: Items mit
 * Leerzeichen verbunden). Wirft bei unlesbaren Bytes — kein Fehler wird geschluckt (s. o.).
 * `finally { destroy() }` wie im Vorbild, gegen Worker-/Speicherlecks bei häufiger Extraktion.
 */
export async function extrahiereSeitentexte(bytes: Uint8Array): Promise<SeitenText[]> {
  // pdfjs lehnt node:Buffer strikt ab ("Please provide binary data as Uint8Array, rather than
  // Buffer"), obwohl Buffer strukturell ein Uint8Array ist — der reale Bytes-Zulieferer aus
  // storeFile()/cachedDocBytes() liefert aber genau ein Buffer. `new Uint8Array(bytes)` kopiert
  // in eine "echte" Uint8Array-Instanz, für einen bereits reinen Uint8Array-Input (z. B. aus
  // pdf-lib `.save()`) eine günstige, unschädliche Kopie.
  const data = Buffer.isBuffer(bytes) ? new Uint8Array(bytes) : bytes;
  const pdf = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
  try {
    const seiten: SeitenText[] = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      seiten.push({ page: i, text, brauchtOcr: text.trim().length < TEXT_SCHWELLE_ZEICHEN });
    }
    return seiten;
  } finally {
    await pdf.destroy();
  }
}
