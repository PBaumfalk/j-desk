import { wortDiff, type DiffSchritt } from '@j-desk/core';
import type { Rect, WortMitPosition } from './pdfText';

/**
 * Zusammenbau des Seitenvergleichs (COMP-02, Plan 09-09) als reine Funktion — verbindet den
 * Wortvergleich aus `@j-desk/core` (`wortDiff`, Plan 09-03) mit den Wortrechtecken aus
 * `pdfText.ts` (`seitenWoerter`, Plan 09-03). Die einzige Stelle mit echter Logik im
 * Vergleichsviewer; `VergleichsViewer.svelte` (Task 3) ruft ausschließlich diese Funktion auf.
 *
 * `SeitenVergleich` trägt bewusst KEINEN Wortlaut — weder als Text noch als Wortliste. Eine
 * Wortliste im Ergebnis wäre der Weg, auf dem geschwärzter oder für den Betrachter gesperrter
 * Text doch noch sichtbar würde (T-09-36): die Oberfläche markiert Stellen und zählt, sie
 * zitiert nicht. Diese Beschränkung steht deshalb im Datentyp, nicht nur in der Komponente, die
 * ihn konsumiert — eine Komponente kann eine Beschränkung vergessen umzusetzen, ein Datentyp
 * ohne das Feld nicht.
 */

/**
 * Eingabe je Seite/Fassung: Wörter mit Position (eingebetteter Text, `seitenWoerter`), reiner
 * Text ohne Position (erkannter/OCR-Text, Rückfallweg aus Plan 09-08), überhaupt kein
 * extrahierbarer Text, oder eine Seite, deren eingebetteter Text vollständig unter echten
 * Schwärzungen liegt (`hatteRohtext` aus `seitenWoerter`, CR-01). Der letzte Fall MUSS von
 * `kein-text` getrennt bleiben: nur `kein-text` darf einen Rückfall auf den unfilterten
 * Server-Text (`fetchFileText`) rechtfertigen — `geschwaerzt` nie, sonst wäre die Schwärzung
 * über genau diesen Rückfallweg umgangen.
 */
export type SeiteEingabe =
  | { art: 'positionen'; woerter: WortMitPosition[] }
  | { art: 'text'; text: string }
  | { art: 'kein-text' }
  | { art: 'geschwaerzt' };

/**
 * Ergebnis des Seitenvergleichs als unterscheidbare Union — fünf Varianten, weil ein leeres
 * Rechteckfeld sonst dreierlei bedeuten könnte: kein Unterschied, kein Text, oder nicht
 * verglichen. Genau diese Verwechslung darf die Oberfläche nicht machen können (T-09-38).
 * `geschwaerzt` ist bewusst von `kein-text` getrennt (CR-01): beide führen zu keiner Markierung,
 * aber nur `geschwaerzt` sagt ehrlich "hier gab es Text, er ist aber vollständig geschwärzt" statt
 * fälschlich zu behaupten, die Seite habe keinen Text.
 */
export type SeitenVergleich =
  | { art: 'markiert'; entferntRects: Rect[]; hinzugefuegtRects: Rect[]; entferntAnzahl: number; hinzugefuegtAnzahl: number }
  | { art: 'ohne-stellen'; entferntAnzahl: number; hinzugefuegtAnzahl: number }
  | { art: 'kein-text'; spalte: 'links' | 'rechts' | 'beide' }
  | { art: 'geschwaerzt'; spalte: 'links' | 'rechts' | 'beide' }
  | { art: 'zu-lang'; woerterAlt: number; woerterNeu: number };

/**
 * Quellen für `seiteEingabeFuer()` — als Funktionsobjekt injiziert, damit die
 * Rückfall-Entscheidung ohne echte pdf.js-/API-Aufrufe testbar bleibt (dieselbe Trennung wie bei
 * `vergleicheSeite`/`seitenWoerter` selbst: Logik in einem reinen Modul, `VergleichsViewer.svelte`
 * liefert nur die konkreten Implementierungen).
 */
export interface SeiteEingabeQuellen {
  /** Rohbytes der Datei (Original oder Vorschau) — `null`/Ausnahme bedeutet "nicht verfügbar". */
  bytesFor(): Promise<Uint8Array>;
  /** Eingebetteter Text mit Position, bereits um `ueberdeckungen` bereinigt (siehe `seitenWoerter`). */
  seitenWoerter(bytes: Uint8Array): Promise<{ woerter: WortMitPosition[]; hatteRohtext: boolean }>;
  /** Serverseitig erkannter Text (unfiltert, Rückfallweg Plan 09-08) für die angegebene Seite. */
  erkannterTextFuer(seite: number): Promise<string | undefined>;
}

/**
 * Orchestriert die Eingabe-Beschaffung für `vergleicheSeite()` einer Seite (CR-01, Iterationen 1+2)
 * — aus `VergleichsViewer.svelte` herausgelöst, damit die sicherheitskritische Rückfall-
 * Entscheidung (unfilterter Server-Text vs. `geschwaerzt`) unabhängig von echten pdf.js-/API-
 * Aufrufen mit Mocks getestet werden kann.
 *
 * Reihenfolge: zuerst Bytes + eingebetteter Text mit Positionen (`quellen.bytesFor`/
 * `quellen.seitenWoerter`). Liefert das echte Wörter, `art: 'positionen'`. Liefert es KEINE Wörter,
 * aber `hatteRohtext: true` (die Seite hatte Text, er lag vollständig unter einer echten
 * Schwärzung), `art: 'geschwaerzt'` — niemals ein Rückfall auf den unfilterten Server-Text
 * (`quellen.erkannterTextFuer`), das würde die Schwärzung umgehen (CR-01, Iteration 1).
 *
 * CR-01, Iteration 2: `hatteRohtext: false` ist zweideutig — es bedeutet ENTWEDER "diese Seite hat
 * wirklich keinen eingebetteten Text" ODER "die Extraktion ist fehlgeschlagen und konnte es nicht
 * positiv prüfen" (`bytesFor()` wirft z. B. bei Vorschau-Fehler/Zeitüberschreitung oder
 * Netzwerkfehler; `seitenWoerter()` fängt jede pdf.js-Ausnahme intern ab und liefert in BEIDEN
 * Fällen dieselbe Form zurück — kaputte/unlesbare PDF-Bytes sind vom "hatte nie Text"-Fall nicht zu
 * unterscheiden). Trägt die Seite mindestens eine echte Schwärzung (`ueberdeckungen`, unabhängig
 * von der Extraktion aus `marksFor()` berechnet und VOR `bytesFor()` bekannt), darf der Server-
 * Fallback deshalb in KEINEM der beiden Fälle laufen — fail closed statt fail open, entsprechend
 * der Projektvorgabe "Schwärzungen müssen echt schwärzen". Der Check läuft deshalb UNABHÄNGIG vom
 * `bytesFor`/`seitenWoerter`-Zweig, nicht als `else`-Zweig daran gekoppelt — er greift sowohl, wenn
 * `bytesFor()` scheitert (`bytes === null`), als auch, wenn `bytesFor()` gelingt, `seitenWoerter()`
 * aber intern scheitert (`woerter: []`, `hatteRohtext: false`, kein Wurf). Nur wenn die Seite KEINE
 * echte Schwärzung trägt, ist der Server-Fallback in jedem Fall unbedenklich.
 */
export async function seiteEingabeFuer(
  seite: number,
  ueberdeckungen: readonly Rect[],
  quellen: SeiteEingabeQuellen,
): Promise<SeiteEingabe> {
  const bytes = await quellen.bytesFor().catch(() => null);
  if (bytes) {
    const { woerter, hatteRohtext } = await quellen.seitenWoerter(bytes);
    if (woerter.length > 0) return { art: 'positionen', woerter };
    if (hatteRohtext) return { art: 'geschwaerzt' };
  }
  // CR-01-residual (Iteration 2): siehe Doc-Kommentar oben — greift unabhängig davon, ob Bytes
  // gar nicht erst verfügbar waren oder die Extraktion lief, aber kein positives Ergebnis lieferte.
  if (ueberdeckungen.length > 0) return { art: 'geschwaerzt' };
  const text = await quellen.erkannterTextFuer(seite);
  if (text) return { art: 'text', text };
  return { art: 'kein-text' };
}

function woerterVon(eingabe: SeiteEingabe): string[] {
  if (eingabe.art === 'positionen') return eingabe.woerter.map((w) => w.text);
  if (eingabe.art === 'text') return eingabe.text.split(/\s+/).filter((w) => w.length > 0);
  return [];
}

/**
 * Liest je Schritt das Rechteck des zugehörigen Worts unverändert aus der Wortliste — keine
 * Skalierung hier, die übernimmt `markierungenAus`. Ein Schritt ohne gültigen Index oder ohne
 * passenden Eintrag in `woerter` liefert kein Rechteck (Defensivfall, bei intaktem `wortDiff`
 * nicht erwartet) und wird trotzdem gezählt — die Zählung entsteht immer aus der Schrittliste
 * selbst, nie aus der Länge der Rechteckliste.
 */
function rechteckeAus(
  schritte: readonly DiffSchritt[],
  index: (s: DiffSchritt) => number | undefined,
  woerter: readonly WortMitPosition[],
): Rect[] {
  const rects: Rect[] = [];
  for (const s of schritte) {
    const i = index(s);
    if (i !== undefined && woerter[i]) rects.push(woerter[i].rect);
  }
  return rects;
}

/**
 * Vergleicht zwei Fassungen einer Seite. Die vier Eingabearten spiegeln sich NICHT eins zu eins
 * in den fünf Ausgabevarianten: „ohne Stellenmarkierung" entsteht sowohl, wenn BEIDE Seiten nur
 * Text ohne Position haben, als auch, wenn NUR EINE Seite Positionen hat — ein Wort, dessen
 * Rechteck zwar bekannt wäre, aber die andere Fassung liefert keins, bekommt ebenfalls kein
 * Rechteck. Zwei Spalten, von denen nur eine markiert ist, wäre irreführend (sähe aus wie ein
 * technischer Fehler statt einer bewussten Grenze).
 */
export function vergleicheSeite(alt: SeiteEingabe, neu: SeiteEingabe): SeitenVergleich {
  // 'kein-text' und 'geschwaerzt' sind beides "nicht vergleichbar" — welcher der beiden Gründe
  // gemeldet wird, entscheidet sich pro Seite; sind BEIDE Seiten betroffen und ist mindestens eine
  // davon geschwärzt, hat die Schwärzungs-Meldung Vorrang (die konfidenziellere/spezifischere
  // Aussage, CR-01) statt sie in der weniger genauen "kein-text"-Meldung untergehen zu lassen.
  const grundVon = (e: SeiteEingabe): 'kein-text' | 'geschwaerzt' | null =>
    e.art === 'kein-text' ? 'kein-text' : e.art === 'geschwaerzt' ? 'geschwaerzt' : null;
  const altGrund = grundVon(alt);
  const neuGrund = grundVon(neu);
  if (altGrund && neuGrund) {
    const art = altGrund === 'geschwaerzt' || neuGrund === 'geschwaerzt' ? 'geschwaerzt' : 'kein-text';
    return { art, spalte: 'beide' };
  }
  if (altGrund) return { art: altGrund, spalte: 'links' };
  if (neuGrund) return { art: neuGrund, spalte: 'rechts' };

  const ergebnis = wortDiff(woerterVon(alt), woerterVon(neu));
  if (ergebnis.art === 'zu-lang') {
    return { art: 'zu-lang', woerterAlt: ergebnis.woerterAlt, woerterNeu: ergebnis.woerterNeu };
  }

  const entfernt = ergebnis.schritte.filter((s) => s.art === 'entfernt');
  const hinzugefuegt = ergebnis.schritte.filter((s) => s.art === 'hinzugefuegt');

  if (alt.art !== 'positionen' || neu.art !== 'positionen') {
    return { art: 'ohne-stellen', entferntAnzahl: entfernt.length, hinzugefuegtAnzahl: hinzugefuegt.length };
  }

  return {
    art: 'markiert',
    entferntRects: rechteckeAus(entfernt, (s) => s.altIndex, alt.woerter),
    hinzugefuegtRects: rechteckeAus(hinzugefuegt, (s) => s.neuIndex, neu.woerter),
    entferntAnzahl: entfernt.length,
    hinzugefuegtAnzahl: hinzugefuegt.length,
  };
}

/**
 * Rechnet Basiskoordinaten-Rechtecke in Darstellungspixel um — derselbe Breitenfaktor wie
 * `SourceHighlight.svelte`/`MarkLayer.svelte` (`f = dargestellteBreite / basisBreite`), damit für
 * dieselbe Umrechnung kein zweiter Rechenweg entsteht (`DiffOverlay.svelte`, Task 2, ruft
 * ausschließlich diese Funktion auf).
 */
export function markierungenAus(
  rects: readonly Rect[],
  basisBreite: number,
  dargestellteBreite: number,
): { x: number; y: number; w: number; h: number }[] {
  const f = basisBreite > 0 ? dargestellteBreite / basisBreite : 1;
  return rects.map((r) => ({ x: r.x * f, y: r.y * f, w: r.w * f, h: r.h * f }));
}
