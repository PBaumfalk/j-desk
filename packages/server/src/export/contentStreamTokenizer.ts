/**
 * Operator-Tokenizer für PDF-Content-Streams (internes Hilfsmodul von redact.ts, 03-05) —
 * nach den Whitespace-/Delimiter-Regeln von ISO 32000 §7.2. Erkennt Literal-Strings
 * (balanciert, mit Backslash-Escapes), Hex-Strings, Arrays (roh, inkl. TJ-Arrays und
 * verschachtelten Strings), Namen, Zahlen und Operator-Keywords. Inline-Bilder
 * (BI … ID <rohdaten> EI) werden als EIN Element überlesen — die Rohdaten sind nicht
 * tokenisierbar. Fortschritts-Garantie: der Index steigt in jedem Schleifendurchlauf
 * strikt (DoS-Schutz gegen präparierte Streams, T-03-05-05).
 */

export interface Operand {
  start: number;
  end: number;
  /** Token-Text, soweit die State-Maschine ihn braucht (Zahlen, Namen); Strings/Arrays bleiben leer. */
  wert: string;
}

/** Operandenfolge + Operator als eine Einheit mit Byte-Bereich [start, end) im Stream. */
export interface Element {
  op: string;
  start: number;
  end: number;
  operande: Operand[];
}

const WEISSRAUM = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const TRENNER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]); // ( ) < > [ ] { } / %
const ZAHL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function latin1(bytes: Uint8Array, von: number, bis: number): string {
  let s = '';
  for (let i = von; i < bis; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Überspringt einen Literal-String ab b[start] === '(' — balancierte Klammern, Escapes. */
function ueberspringeString(b: Uint8Array, start: number): number {
  let i = start + 1;
  let tiefe = 1;
  while (i < b.length && tiefe > 0) {
    if (b[i] === 0x5c) {
      i += 2;
      continue;
    }
    if (b[i] === 0x28) tiefe++;
    else if (b[i] === 0x29) tiefe--;
    i++;
  }
  return i;
}

/** Tokenisiert den gesamten Stream in eine Element-Liste (Operanden + Operator je Eintrag). */
export function tokenisiere(b: Uint8Array): Element[] {
  const elemente: Element[] = [];
  let operande: Operand[] = [];
  let inlineBildStart = -1;
  const n = b.length;
  let i = 0;
  while (i < n) {
    const byte = b[i];
    if (WEISSRAUM.has(byte)) {
      i++;
      continue;
    }
    if (byte === 0x25) {
      // % Kommentar bis Zeilenende
      while (i < n && b[i] !== 0x0a && b[i] !== 0x0d) i++;
      continue;
    }
    if (byte === 0x28) {
      const start = i;
      i = ueberspringeString(b, start);
      operande.push({ start, end: i, wert: '' }); // Inhalt nicht nötig — keine Font-Metriken
      continue;
    }
    if (byte === 0x3c) {
      const start = i;
      if (b[i + 1] === 0x3c) {
        i += 2;
        operande.push({ start, end: i, wert: '<<' });
        continue;
      }
      i++;
      while (i < n && b[i] !== 0x3e) i++;
      i++;
      operande.push({ start, end: i, wert: '' }); // Hex-String
      continue;
    }
    if (byte === 0x3e) {
      const start = i;
      i += b[i + 1] === 0x3e ? 2 : 1;
      operande.push({ start, end: i, wert: '>>' });
      continue;
    }
    if (byte === 0x5b || byte === 0x7b) {
      // [ Array (auch TJ) bzw. { — roh bis zum Gegenstück, Strings darin beachten
      const start = i;
      const oeffner = byte;
      const schliesser = byte === 0x5b ? 0x5d : 0x7d;
      i++;
      let tiefe = 1;
      while (i < n && tiefe > 0) {
        if (b[i] === 0x28) {
          i = ueberspringeString(b, i);
          continue;
        }
        if (b[i] === oeffner) tiefe++;
        else if (b[i] === schliesser) tiefe--;
        i++;
      }
      operande.push({ start, end: i, wert: '' });
      continue;
    }
    if (byte === 0x2f) {
      // /Name
      const start = i;
      i++;
      while (i < n && !WEISSRAUM.has(b[i]) && !TRENNER.has(b[i])) i++;
      operande.push({ start, end: i, wert: latin1(b, start + 1, i) });
      continue;
    }
    // Reguläres Token: Zahl (Operand) oder Operator-Keyword
    const start = i;
    while (i < n && !WEISSRAUM.has(b[i]) && !TRENNER.has(b[i])) i++;
    if (i === start) {
      i++; // verwaiste Trenner ([, ] außerhalb von Arrays) überlesen — Fortschritts-Garantie
      continue;
    }
    const wert = latin1(b, start, i);
    if (ZAHL.test(wert)) {
      operande.push({ start, end: i, wert });
      continue;
    }
    if (wert === 'BI') {
      inlineBildStart = start; // Dict-Tokens bis ID sammeln sich als Operanden an
      operande = [];
      continue;
    }
    if (wert === 'ID' && inlineBildStart >= 0) {
      // Nach ID folgt GENAU ein Whitespace-Byte (CRLF tolerant), dann Rohdaten bis EI
      i++;
      if (b[i - 1] === 0x0d && b[i] === 0x0a) i++;
      while (i + 1 < n) {
        if (
          b[i] === 0x45 &&
          b[i + 1] === 0x49 &&
          WEISSRAUM.has(b[i - 1]) &&
          (i + 2 >= n || WEISSRAUM.has(b[i + 2]) || TRENNER.has(b[i + 2]))
        ) {
          i += 2;
          break;
        }
        i++;
      }
      elemente.push({ op: 'BI', start: inlineBildStart, end: i, operande: [] });
      inlineBildStart = -1;
      operande = [];
      continue;
    }
    elemente.push({ op: wert, start: operande.length > 0 ? operande[0].start : start, end: i, operande });
    operande = [];
  }
  return elemente;
}
