/**
 * Wortbasierter Vergleich zweier Textfassungen als reine, exakt getestete Funktion — bewusst ohne
 * jede Ein-/Ausgabe und ohne Fremdimporte (Konvention aus geometry.ts/tableFormulas.ts).
 * `packages/core` hat heute null externe Laufzeitabhängigkeiten; der hier gelöste Fall (Vergleich
 * zweier bereits tokenisierter Wortlisten EINER Seite) ist deutlich kleiner als das, was ein
 * allgemeines Diff-Paket löst (beliebige Granularität, Patch-Erzeugung, Zeilen-/Zeichenvergleich) —
 * ein Fremdpaket würde diese Invariante für einen einzigen, klar begrenzten Algorithmus brechen
 * (09-RESEARCH.md „Zero-dependency word-level LCS skeleton"). Der Vergleich wird IMMER SEITENWEISE
 * aufgerufen, nie über ein ganzes Dokument in einem Lauf — die Tabellengröße bleibt dadurch klein.
 */

/**
 * Die Tabelle des Wortvergleichs wächst als Produkt beider Wortlängen (klassische
 * LCS-Tabellenbildung); bei typischen Dokumentseiten mit unter tausend Wörtern ist das unkritisch.
 * Eine entartete Seite (z. B. fehlerhafte Worttrennung mit zehntausenden „Wörtern") darf den
 * Browser aber nicht blockieren — oberhalb dieser Grenze wird gar nicht erst verglichen, siehe
 * `wortDiff`.
 */
export const DIFF_MAX_WOERTER = 4000;

/** Art eines Vergleichsschritts: unverändert, nur in der alten oder nur in der neuen Fassung vorhanden. */
export type DiffArt = 'gleich' | 'entfernt' | 'hinzugefuegt';

/**
 * Ein Schritt des Wortvergleichs. `altIndex`/`neuIndex` beziehen sich auf die ÜBERGEBENEN
 * (nicht normalisierten) Listen — nur so kann die Oberfläche (Plan 09-09) einen Schritt einem
 * Wortrechteck auf der Seite zuordnen. `altIndex` ist bei `gleich` und `entfernt` gesetzt,
 * `neuIndex` bei `gleich` und `hinzugefuegt`.
 */
export interface DiffSchritt {
  art: DiffArt;
  wort: string;
  altIndex?: number;
  neuIndex?: number;
}

/**
 * Ergebnis des Wortvergleichs als unterscheidbare Union. Eine Rückgabe von `null` oder einer
 * leeren Liste im Überlängefall wäre nicht von „kein Unterschied" zu unterscheiden — genau die
 * stille Falschaussage, die dieser Vergleich nicht treffen darf (T-09-13).
 */
export type DiffErgebnis =
  | { art: 'verglichen'; schritte: DiffSchritt[] }
  | { art: 'zu-lang'; woerterAlt: number; woerterNeu: number };

/**
 * Zieht Leerraum jeder Art zu einem einfachen Leerzeichen zusammen und schneidet außen ab.
 * `\s` deckt in JavaScript-Regex bereits alle Leerraum-Arten ab, die in extrahiertem PDF-Text
 * vorkommen können — inklusive geschütztem Leerzeichen und Zeilenumbrüchen (ECMA-262
 * WhiteSpace-Definition) —, daher genügt eine einzige Zeichenklasse ohne zusätzliches Literal.
 * Groß-/Kleinschreibung bleibt unverändert, weil sie in juristischen Texten Bedeutung trägt
 * (z. B. Eigennamen, Aktenzeichen, Satzanfänge).
 */
export function normalisiereWort(w: string): string {
  return w.replace(/\s+/g, ' ').trim();
}

/**
 * Klassische Tabellenbildung über die längste gemeinsame Teilfolge (LCS) der normalisierten
 * Wörter, anschließend Rückwärtsverfolgung (Backtracking) in Textreihenfolge. Verglichen wird auf
 * den normalisierten Werten, ausgegeben wird das Wort der jeweiligen Ursprungsliste. Ein Wort, das
 * nach der Normalisierung leer ist (reines Leerraum-Token), geht NIE als „gleich" in den Vergleich
 * ein — auch nicht gegenüber einem anderen leeren Wort, sonst wäre die leere Zeichenkette
 * fälschlich ein Vergleichswert wie jeder andere. Es behält trotzdem genau einen Schritt
 * (Index-Vollständigkeit), nur eben nie als `gleich`.
 */
export function wortDiff(alt: readonly string[], neu: readonly string[]): DiffErgebnis {
  if (alt.length > DIFF_MAX_WOERTER || neu.length > DIFF_MAX_WOERTER) {
    return { art: 'zu-lang', woerterAlt: alt.length, woerterNeu: neu.length };
  }

  const n = alt.length;
  const m = neu.length;
  const normAlt = alt.map(normalisiereWort);
  const normNeu = neu.map(normalisiereWort);
  const passtZusammen = (i: number, j: number): boolean => normAlt[i] !== '' && normAlt[i] === normNeu[j];

  // dp[i][j] = Länge der längsten gemeinsamen Teilfolge von alt[i..] und neu[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = passtZusammen(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const schritte: DiffSchritt[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (passtZusammen(i, j)) {
      schritte.push({ art: 'gleich', wort: alt[i], altIndex: i, neuIndex: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      schritte.push({ art: 'entfernt', wort: alt[i], altIndex: i });
      i++;
    } else {
      schritte.push({ art: 'hinzugefuegt', wort: neu[j], neuIndex: j });
      j++;
    }
  }
  while (i < n) {
    schritte.push({ art: 'entfernt', wort: alt[i], altIndex: i });
    i++;
  }
  while (j < m) {
    schritte.push({ art: 'hinzugefuegt', wort: neu[j], neuIndex: j });
    j++;
  }

  return { art: 'verglichen', schritte };
}
