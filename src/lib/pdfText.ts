import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Gleicher Import-/Worker-Pfad wie PageRenderer.svelte — ein gemeinsamer Worker für Rendern und Text-Extraktion.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Basiskoordinaten-Rechteck (PDF-Viewport scale = 1) — wie Cutout/Mark.rect. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Nur der Ausschnitt von pdfjs' TextItem, den die Rect-Filterung braucht. */
export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height?: number;
}

/** Nur der Ausschnitt von pdfjs' PageViewport, den die Rect-Filterung braucht — pdfjs-frei testbar. */
export interface ViewportLike {
  convertToViewportPoint(x: number, y: number): number[];
}

/**
 * Wandelt Item-Ursprung und -Ecke in Basiskoordinaten um und liefert Rechteck plus Mittelpunkt —
 * gemeinsame Transformationsmathematik für `itemsImRect` und `alleWoerterMitPosition`. Zwei Kopien
 * derselben Umrechnung wären zwei Wahrheiten; deshalb rufen BEIDE Funktionen ausschließlich diesen
 * Helfer auf, nie die Viewport-Umrechnung direkt.
 */
function itemRect(item: TextItemLike, viewport: ViewportLike): { rect: Rect; cx: number; cy: number } {
  const tx = item.transform;
  const h = item.height ?? Math.abs(tx[3]);
  const [x0, y0] = viewport.convertToViewportPoint(tx[4], tx[5]);
  const [x1, y1] = viewport.convertToViewportPoint(tx[4] + item.width, tx[5] + h);
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const rect: Rect = { x, y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  return { rect, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/**
 * Fundstellen-Provenienz: Filtert TextItems auf die, deren Box-Mittelpunkt im Rect liegt,
 * und setzt sie in Lesereihenfolge zusammen. pdfjs-Space ist y-up — die Umrechnung übernimmt der
 * gemeinsame Helfer `itemRect` (Viewport bei scale = 1).
 * Reihenfolge: nach y (Zeilen, Toleranz ~2px geclustert), dann x; Zeilen mit '\n', Items mit ' ' joinen.
 * Reine Funktion ohne pdfjs-Abhängigkeit — direkt mit gemockten Items/Viewport testbar.
 */
export function itemsImRect(items: readonly TextItemLike[], viewport: ViewportLike, rect: Rect): string {
  const ZEILEN_TOLERANZ = 2;
  const treffer: { x: number; y: number; str: string }[] = [];
  for (const item of items) {
    if (!item.str) continue; // TextMarkedContent o.ä. hat keinen str — überspringen
    const { rect: r, cx, cy } = itemRect(item, viewport);
    if (cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h) continue;
    treffer.push({ x: r.x, y: r.y, str: item.str });
  }
  if (treffer.length === 0) return '';
  treffer.sort((a, b) => a.y - b.y || a.x - b.x);
  const zeilen: (typeof treffer)[] = [];
  for (const t of treffer) {
    const letzte = zeilen[zeilen.length - 1];
    if (letzte && Math.abs(letzte[0].y - t.y) <= ZEILEN_TOLERANZ) letzte.push(t);
    else zeilen.push([t]);
  }
  return zeilen.map((zeile) => zeile.sort((a, b) => a.x - b.x).map((t) => t.str).join(' ')).join('\n');
}

/**
 * Extrahiert den sichtbaren Text im Basiskoordinaten-Rechteck einer PDF-Seite (Fundstellen-
 * Provenienz: Text-Snapshot beim Schneiden/Abdecken). `quelle` ist entweder rohe Bytes (Cache-
 * Pfad wie PageRenderer) oder eine URL. Zusatznutzen, kein Muss — JEDER Fehler (kaputte Bytes,
 * fehlende Seite, pdfjs-Ausnahme) liefert '' statt zu werfen; das Schneiden/Abdecken darf
 * dadurch nie blockiert oder abgebrochen werden.
 */
export async function textInRect(quelle: Uint8Array | string, pageNumber: number, rect: Rect): Promise<string> {
  let pdf: pdfjs.PDFDocumentProxy | undefined;
  try {
    pdf = await pdfjs.getDocument(typeof quelle === 'string' ? { url: quelle } : { data: quelle }).promise;
    const p = Math.min(Math.max(1, pageNumber), pdf.numPages); // clampen wie PageRenderer
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    return itemsImRect(content.items as TextItemLike[], viewport, rect);
  } catch {
    return '';
  } finally {
    // Dokument stets freigeben (auch im Fehlerfall), sonst Worker-Leak bei häufigem Schneiden/Abdecken.
    try {
      await pdf?.destroy?.();
    } catch {
      /* Aufräumen bestmöglich — ein Fehler hier ist irrelevant */
    }
  }
}

/** Ein Wort mit seinem Rechteck in Basiskoordinaten (PDF-Viewport scale = 1). */
export interface WortMitPosition {
  text: string;
  rect: Rect;
}

/**
 * Liefert JEDES Wort einer Seite mit Rechteck in Basiskoordinaten — anders als `itemsImRect`, das
 * nur die Wörter innerhalb EINES Zielrechtecks zu einem String zusammensetzt. Eingabe für den
 * Wortvergleich (COMP-02, Plan 09-09). Dieselbe Zeilenclusterung/Sortierung wie `itemsImRect`:
 * nach Zeile (Toleranz ~2px), innerhalb der Zeile nach x — Lesereihenfolge.
 *
 * `ueberdeckungen` sind bereits vorgefilterte Rechtecke ECHTER Schwärzungen (redact/tippex, siehe
 * `istEchteSchwaerzung` in `markSchwaerzung.ts`) — die Aufrufseite (Plan 09-09) filtert
 * `desktop.state.marks` auf docId/Seite/Art, BEVOR sie hier ankommen; diese Funktion selbst kennt
 * keine Markierungsart, sie schließt jedes übergebene Rechteck gleichermaßen aus. Ein Wort, dessen
 * Rechteckmittelpunkt in einem dieser Rechtecke liegt, fehlt in der Ausgabe.
 *
 * Die Filterung geschieht HIER, an der Extraktion, nicht erst beim Zeichnen des Diff-Overlays: ein
 * geschwärztes Wort darf gar nicht erst in den Vergleich eingehen — sonst verriete schon die bloße
 * EXISTENZ einer Unterschiedsmarkierung an dieser Stelle etwas über den überdeckten Text (T-09-11).
 */
export function alleWoerterMitPosition(
  items: readonly TextItemLike[],
  viewport: ViewportLike,
  ueberdeckungen?: readonly Rect[],
): WortMitPosition[] {
  const ZEILEN_TOLERANZ = 2;
  const treffer: { x: number; y: number; text: string; rect: Rect }[] = [];
  for (const item of items) {
    if (!item.str) continue; // TextMarkedContent o.ä. hat keinen str — überspringen
    const { rect, cx, cy } = itemRect(item, viewport);
    const geschwaerzt = ueberdeckungen?.some((u) => cx >= u.x && cx <= u.x + u.w && cy >= u.y && cy <= u.y + u.h);
    if (geschwaerzt) continue;
    treffer.push({ x: rect.x, y: rect.y, text: item.str, rect });
  }
  if (treffer.length === 0) return [];
  treffer.sort((a, b) => a.y - b.y || a.x - b.x);
  const zeilen: (typeof treffer)[] = [];
  for (const t of treffer) {
    const letzte = zeilen[zeilen.length - 1];
    if (letzte && Math.abs(letzte[0].y - t.y) <= ZEILEN_TOLERANZ) letzte.push(t);
    else zeilen.push([t]);
  }
  return zeilen
    .flatMap((zeile) => zeile.sort((a, b) => a.x - b.x))
    .map((t) => ({ text: t.text, rect: t.rect }));
}

/**
 * Liefert alle Wörter einer PDF-Seite mit Rechteck (Basiskoordinaten) plus die Basisgröße der
 * Seite — async Rahmen exakt nach `textInRect`: PDF öffnen, Seite klemmen, Viewport bei scale = 1
 * holen, `getTextContent()` aufrufen, `alleWoerterMitPosition` anwenden, im `finally` das Dokument
 * freigeben. Die Basisgröße wird mitgeliefert, weil die Overlay-Skalierung in Plan 09-09 sie
 * braucht (`f = renderedWidth / basis.w`, wie `SourceHighlight.svelte`).
 *
 * JEDER Fehler (kaputte Bytes, fehlende Seite, pdfjs-Ausnahme) liefert eine leere Wortliste und
 * `basis: null`, wirft aber nie — der Vergleich ist Zusatznutzen und darf das Betrachten nie
 * blockieren, dieselbe Haltung wie beim Text-Schnappschuss (`textInRect`).
 *
 * `hatteRohtext` unterscheidet die beiden Ursachen für eine leere `woerter`-Liste, die die
 * Aufrufseite sonst nicht auseinanderhalten könnte: "diese Seite hat gar keinen eingebetteten
 * Text" (z. B. ein echtes Scan-Bild) versus "die Seite hatte Text, aber jedes Wort lag unter
 * einer echten Schwärzung (`ueberdeckungen`) und wurde herausgefiltert". Nur der erste Fall darf
 * einen Rückfall auf unfilterten Text (Server-Fallback) auslösen — im zweiten Fall wäre das
 * ansonsten die Schwärzung selbst, die umgangen wird (CR-01).
 */
export async function seitenWoerter(
  quelle: Uint8Array | string,
  pageNumber: number,
  ueberdeckungen?: readonly Rect[],
): Promise<{ woerter: WortMitPosition[]; basis: { w: number; h: number } | null; hatteRohtext: boolean }> {
  let pdf: pdfjs.PDFDocumentProxy | undefined;
  try {
    pdf = await pdfjs.getDocument(typeof quelle === 'string' ? { url: quelle } : { data: quelle }).promise;
    const p = Math.min(Math.max(1, pageNumber), pdf.numPages); // clampen wie PageRenderer/textInRect
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items as TextItemLike[];
    const woerter = alleWoerterMitPosition(items, viewport, ueberdeckungen);
    // Ungefiltert, nur zur Existenzprüfung — beantwortet ausschließlich "gab es überhaupt Text auf
    // dieser Seite", nie an den Aufrufer als Wortliste weitergereicht (kein Leck ungeschwärzten Texts).
    const hatteRohtext = alleWoerterMitPosition(items, viewport).length > 0;
    return { woerter, basis: { w: viewport.width, h: viewport.height }, hatteRohtext };
  } catch {
    return { woerter: [], basis: null, hatteRohtext: false };
  } finally {
    // Dokument stets freigeben (auch im Fehlerfall), sonst Worker-Leak — exakt wie textInRect.
    try {
      await pdf?.destroy?.();
    } catch {
      /* Aufräumen bestmöglich — ein Fehler hier ist irrelevant */
    }
  }
}
