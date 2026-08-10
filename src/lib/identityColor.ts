/**
 * Präsenz-Identitätsfarbe (06-UI-SPEC.md „Präsenz-Identitätsfarbe"): eine kategoriale Farbe pro
 * Nutzer, abgeleitet aus der `userId` statt aus einer festen Palette. `STABILO_COLORS`/
 * `PEN_COLORS` (inkColors.ts) sind Werkzeugfarben, die der Nutzer selbst für Markierungen auf
 * demselben Kartendokument wählt — eine Identitätsfarbe am Kartenrand darf sich damit optisch
 * nicht vermischen (z. B. eine gelbe Markierung neben einem zufällig auch gelben Präsenz-Ring).
 * Ein eigener, kontinuierlicher Farbraum (voller Farbkreis statt 6 Swatches) vermeidet das
 * strukturell und kollidiert nicht ab der 7. gleichzeitig verbundenen Person.
 */

/** Einfacher, deterministischer Zeichenketten-Hash ohne externe Abhängigkeit (Bit-Rotation über
 *  die Zeichencodes) — kein Krypto-Hash, kein neues Paket (T-06-SC). Liefert für dieselbe
 *  Zeichenkette bei jedem Aufruf denselben, nichtnegativen Ganzzahlwert. */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0; // auf 32-bit-Ganzzahl zwingen
  }
  return h >>> 0; // als nichtnegative Ganzzahl interpretieren
}

/** Farbwinkel + feste Sättigung/Helligkeit je Theme (UI-SPEC-Formel, hier nicht abgewandelt):
 *  `hsl(hue, 65%, 45%)` im hellen Theme, `hsl(hue, 60%, 65%)` im dunklen Theme (höhere
 *  Helligkeit für Kontrast auf dunklem Glass-Hintergrund). Der Farbwinkel bleibt für dieselbe
 *  `userId` über beide Themes hinweg identisch — nur Sättigung/Helligkeit unterscheiden sich. */
export function identityColor(userId: string, dunkel: boolean): string {
  const hue = hashString(userId) % 360;
  return dunkel ? `hsl(${hue}, 60%, 65%)` : `hsl(${hue}, 65%, 45%)`;
}

/** Erstes durch Leerzeichen getrenntes Wortsegment des Anzeigenamens (Bearbeitungs-Pille an der
 *  Karte, 06-04) — enthält der (getrimmte) Name kein Leerzeichen, wird er unverändert
 *  zurückgegeben. */
export function vorname(name: string): string {
  const getrimmt = name.trim();
  const leerzeichen = getrimmt.indexOf(' ');
  return leerzeichen === -1 ? getrimmt : getrimmt.slice(0, leerzeichen);
}
