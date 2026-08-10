/**
 * Raster-Fallback-Interface für Seiten, die der Content-Stream-Rewriter nicht sicher
 * redigieren kann (rotierte Seiten, Form-XObject-Text — Signale aus redact.ts, 03-05).
 * Die RASTERUNG einer Seite erzeugt einen nackten Pixelstrom ohne Textebene: Rest-Text
 * ist danach per Extraktion/Copy-Paste nachweislich weg, weil es keinen Text mehr gibt
 * (03-RESEARCH Architektur-Schritt 6, Open Question 4).
 *
 * Stand 07-06: `rasterisiereSeite()` ist ein echter Rasterer (pdfjs-dist Legacy-Build + das
 * native Canvas-Paket, s. Import unten) und liefert für lesbare PDF-Seiten ein echtes PNG
 * zurück — sie dient damit als Pixelzulieferer für die OCR-Pipeline (07-07 ocrQueue.ts),
 * NICHT (mehr) als reine Abbruch-Funktion.
 *
 * Das Export-Redaktions-Gate (`rasteriereSeiteFailClosed`) bleibt DAVON UNBERÜHRT bewusst
 * geschlossen: 07-05 hat die Disposition „Option A" entschieden — das Einbetten des PNGs
 * in das Ausgabedokument samt erneutem Verifikationsdurchlauf bliebe Phase-3-Restarbeit
 * (EXP-04) und ist nicht Gegenstand dieser Phase. Deshalb wirft `rasteriereSeiteFailClosed`
 * AUS SICH SELBST HERAUS, unabhängig davon, ob `rasterisiereSeite` erfolgreich ein PNG
 * liefert oder wirft. Ein stilles Zurückkehren dieser Funktion wäre der gefährlichste
 * Regressionsfall im ganzen Projekt: der Export liefe ohne Redaktion weiter und ein
 * unredigiertes Dokument könnte ausgeliefert werden (T-07-28).
 */
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ExportFehler } from './pdfExport';

/** Ergebnis einer gerasterten Seite (nach Checkpoint-„install": genau ein PNG je Seite). */
export interface RasterErgebnis {
  seitenPngs: Uint8Array[];
}

/**
 * Renderauflösung für die OCR-Pixelzulieferung (07-RESEARCH Pitfall 2): 150 dpi ist für
 * Texterkennung ausreichend und begrenzt die Bildgröße bereits am Ansatz, statt erst
 * nachträglich zu deckeln.
 */
export const RASTER_DPI = 150;

/**
 * Harte Obergrenze je Bildkante in Pixeln (DoS-Schutz, T-07-29): eine ungewöhnlich große
 * PDF-Seite darf kein unbegrenzt großes Bild erzeugen. Der Skalierungsfaktor aus
 * `RASTER_DPI` wird bei Bedarf so weit gesenkt, dass keine Kante diesen Wert überschreitet.
 */
export const RASTER_MAX_KANTE_PX = 4000;

/**
 * Gemeinsamer, wortgleicher Meldungstext für alle Rasterungs-Fehlpfade (03-07/07-06):
 * eine deutsche, generische Meldung — nie die rohe pdfjs-/Canvas-Fehlermeldung nach außen
 * (T-07-31). `rasteriereSeiteFailClosed` wirft ihn unabhängig davon, was hier passiert;
 * `rasterisiereSeite` wirft ihn selbst für jeden eigenen Fehlerfall (korrupte Bytes,
 * seitenIndex außerhalb des Dokuments, Render-/Canvas-Fehler).
 */
const RASTER_FEHLER_MELDUNG =
  'Diese Seite kann nicht sicher redigiert werden (rotierte Seite oder verschachtelter Text); ' +
  'der Export wurde abgebrochen, damit kein ungeprüftes Dokument entsteht.';

/**
 * Rendert die bereits geöffnete Seite `seitenIndex` (0-basiert) auf ein auflösungsbegrenztes
 * Canvas und liefert die PNG-Bytes. Ausgelagert aus `rasterisiereSeite`, damit dort EIN
 * `finally { pdf.destroy() }` für sowohl den Erfolgs- als auch den Fehlerfall genügt.
 */
async function rastereSeiteAusGeoeffnetemDokument(pdf: PDFDocumentProxy, seitenIndex: number, dpi: number): Promise<Uint8Array> {
  // seitenIndex ist die 0-basierte Aufrufer-Konvention (pdfExport.ts/uebersichten.ts);
  // pdfjs erwartet 1-basierte Seitenzahlen bei getPage().
  const pdfSeitenNr = seitenIndex + 1;
  if (pdfSeitenNr < 1 || pdfSeitenNr > pdf.numPages) {
    throw new ExportFehler('verifikation-fehlgeschlagen', RASTER_FEHLER_MELDUNG);
  }
  const page = await pdf.getPage(pdfSeitenNr);

  // Skalierungsfaktor aus der Ziel-DPI (PDF-Standardeinheit: 72 pt = 1 inch), danach bei
  // Bedarf gedeckelt (T-07-29): erst die Seitengröße bei der Wunsch-DPI ermitteln, dann den
  // Faktor so weit senken, dass keine Kante RASTER_MAX_KANTE_PX überschreitet.
  let scale = dpi / 72;
  const wunschViewport = page.getViewport({ scale });
  const laengsteKantePx = Math.max(wunschViewport.width, wunschViewport.height);
  if (laengsteKantePx > RASTER_MAX_KANTE_PX) {
    scale *= RASTER_MAX_KANTE_PX / laengsteKantePx;
  }
  const viewport = page.getViewport({ scale });

  // Annahme A2 (07-RESEARCH) bestätigt: pdfjs-dist Legacy-Build wählt unter Node intern
  // automatisch dieselbe native Canvas-Factory (NodeCanvasFactory ruft dasselbe
  // `createCanvas` auf, das oben importiert ist) — `createCanvas(...).getContext('2d')`
  // lässt sich deshalb direkt als `canvasContext` an `page.render()` übergeben, ohne
  // eigene Adapterklasse.
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');

  // Weißer Hintergrund: Scans ohne eigenen Seitenhintergrund würden sonst mit
  // transparenten Pixeln an tesseract gehen (dunkler Text auf Transparenz statt auf
  // deckendem Weiß verschlechtert die Texterkennung, 07-RESEARCH).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Strukturell kompatibel, aber nicht derselbe TS-Typ wie das DOM-`CanvasRenderingContext2D`,
  // das die pdfjs-Typdeklaration erwartet (native Implementierung, s. o.) — daher der gezielte,
  // lokal aus page.render() selbst abgeleitete Cast statt einer Architekturänderung.
  await page.render({
    canvasContext: ctx as unknown as Parameters<typeof page.render>[0]['canvasContext'],
    viewport,
  }).promise;

  return canvas.toBuffer('image/png');
}

/**
 * Rasterisiert die Seite `seitenIndex` (0-basiert) des Dokuments zu einem PNG — Pixelzulieferer
 * für die OCR-Pipeline (07-07 ocrQueue.ts). Jeder Fehler (korrupte/unlesbare Bytes, Seite
 * außerhalb des Dokuments, Render-/Canvas-Fehler) wird als `ExportFehler` mit demselben
 * `reason`-Wert weitergegeben, den auch `rasteriereSeiteFailClosed` verwendet — nie die rohe
 * pdfjs-/Canvas-Meldung nach außen (T-07-31). `finally { pdf.destroy() }` wie in
 * `ocr/extract.ts`, gegen Worker-/Speicherlecks bei häufiger Rasterung.
 *
 * WICHTIG (T-07-28): diese Funktion dient AUSSCHLIESSLICH der OCR-Zulieferung. Das
 * Export-Redaktions-Gate (`rasteriereSeiteFailClosed`) ruft sie NICHT mehr auf und bleibt
 * unabhängig davon fail-closed — siehe Kopfkommentar dieser Datei.
 */
export async function rasterisiereSeite(bytes: Uint8Array, seitenIndex: number, dpi = RASTER_DPI): Promise<Uint8Array> {
  // pdfjs lehnt node:Buffer strikt ab, obwohl Buffer strukturell ein Uint8Array ist
  // (identische Absicherung wie ocr/extract.ts).
  const data = Buffer.isBuffer(bytes) ? new Uint8Array(bytes) : bytes;
  let pdf: PDFDocumentProxy | undefined;
  try {
    pdf = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise;
    return await rastereSeiteAusGeoeffnetemDokument(pdf, seitenIndex, dpi);
  } catch (e) {
    if (e instanceof ExportFehler) throw e;
    throw new ExportFehler('verifikation-fehlgeschlagen', RASTER_FEHLER_MELDUNG);
  } finally {
    await pdf?.destroy();
  }
}

/**
 * WR-02 / T-07-28: fail-closed-Aufruf des Raster-Fallbacks für alle Call-Sites
 * (pdfExport.ts x2, uebersichten.ts x1). Wirft AUS SICH SELBST HERAUS und ruft
 * `rasterisiereSeite` bewusst NICHT (mehr) auf — seit 07-06 kann `rasterisiereSeite` für
 * lesbare Seiten erfolgreich ein PNG zurückliefern (statt wie zuvor unbedingt zu werfen).
 * Würde diese Funktion weiterhin nur den Wurf von `rasterisiereSeite` erben, würde ein
 * Erfolg dort dieses Gate lautlos zu einem Durchlass machen: der Export liefe ohne
 * Redaktion weiter und ein unredigiertes Dokument könnte ausgeliefert werden — der
 * höchste Risikograd im gesamten Projekt. `reason` und Meldungstext bleiben wortgleich
 * die bisherigen (03-07), damit die vier Bestandstests unverändert grün bleiben.
 */
export async function rasteriereSeiteFailClosed(bytes: Uint8Array, seitenIndex: number): Promise<void> {
  void bytes;
  void seitenIndex;
  throw new ExportFehler('verifikation-fehlgeschlagen', RASTER_FEHLER_MELDUNG);
}
