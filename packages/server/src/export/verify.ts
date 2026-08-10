/**
 * pdfjs-Verifikationshelfer (EXP-03/EXP-04, 03-RESEARCH Pattern 3): extrahiert den gesamten
 * Text einer PDF serverseitig (legacy build, Node-tauglich, ohne Canvas/Worker) — das
 * normative Orakel der Trace-Tests: ein Marker-String, der hier NICHT auftaucht, ist
 * nachweislich nicht im Artefakt. Rohtext-Suche in den PDF-Bytes wäre unzuverlässig
 * (UTF-16/Hex-/CID-Kodierung, 03-RESEARCH Anti-Pattern „Rohtext-Suche als Verifikation").
 * Dient in 03-01 dem Tracer-Test; 03-03/03-07 bauen daraus das Verifikationsgate.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function extrahiereText(bytes: Uint8Array): Promise<string> {
  return (await extrahiereSeiten(bytes)).join('\n');
}

/**
 * Seitenweise Variante von extrahiereText (03-04): Pagination-Tests müssen Kopf-/Fußzeilen
 * JE Seite nachweisen — mit dem Gesamttext ließe sich nicht zuordnen, welche Seite was trägt.
 */
export async function extrahiereSeiten(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
  try {
    const seiten: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      seiten.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    }
    return seiten;
  } finally {
    await pdf.destroy();
  }
}
