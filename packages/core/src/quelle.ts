/**
 * Zitat-Verifikation der KI-Quellenpflicht (Phase 12, AI-03) — das reine, DB-freie Kernmodul.
 *
 * Warum Determinismus hier juristische Pflicht ist: die Prüfung entscheidet, ob eine
 * KI-Behauptung als „durch eine konkrete Fundstelle belegt" gelten darf (Quellenbruch,
 * AI-SPEC Failure Mode 3 — „echte Hülle, falscher Inhalt"). Ein Anwalt, der eine Ablehnung
 * hinterfragt, muss die Regel nachvollziehen können: exakter Zeichenvergleich nach einer
 * kleinen, benannten Normalisierungs-Pipeline. Unscharfe Ähnlichkeitsverfahren erzeugen
 * unerklärbare Grenzfälle (warum wurde DIESES Zitat durchgewunken, JENES nicht?) und sind
 * hier bewusst ausgeschlossen — Toleranz existiert ausschließlich als dokumentierte
 * Normalisierung (Whitespace/Umbruch, Silbentrennung, Unicode-Form, Kleinschreibung).
 * OCR-Rauschen wird nach Normalisierung exakt verglichen: was dann nicht matcht, wird
 * abgelehnt statt durchgewunken. Ob diese Toleranz in der Praxis reicht, zeigt die
 * Flywheel-Metrik „Zitat-Ablehnungsquote" — sie kalibriert die NORMALISIERUNG, niemals
 * die Härte der Prüfung (A5 aus 12-RESEARCH.md).
 *
 * Modulgrenze: reine String-Funktionen, keine Imports — der Aufrufer (DB-Brücke im
 * Server-Paket, Plan 12-02 Task 2) liefert Seitentext und Zitat, dieses Modul kennt
 * weder Datenbank noch Desk-State.
 */

/**
 * Stufe (a): Unicode-Normalform NFC — vorgeprägte Zeichen (U+00E4) und Combining-Sequenzen
 * (a + U+0308) müssen wörtlich gleich verglichen werden, sonst scheitert jede Fundstelle,
 * deren PDF-Extraktion eine andere Unicode-Form gewählt hat als der Agent.
 */
const normalform = (t: string): string => t.normalize('NFC');

/**
 * Stufe (c): Bindestrich-/Soft-Hyphen-Umbruch-Trennung auflösen — das Muster
 * „Trennstrich (ASCII '-' ODER Soft-Hyphen U+00AD) + Umbruch (+ Folge-Whitespace)" wird
 * OHNE Ersatzzeichen entfernt: Silbentrennung „Infor-\nmation" → „Information".
 * Muss VOR dem Whitespace-Kollaps laufen — nach dem Kollaps wäre der Trennstrich vom
 * Umbruch durch ein Leerzeichen getrennt und die Trenn-Information verloren. Der
 * Soft-Hyphen steht bewusst in derselben Stufe: PDF-Extraktionen setzen ihn genau an
 * Trennstellen; würde Stufe (b) ihn vorher entfernen, bliebe ein falscher Wortzwischenraum.
 */
const trennungAufloesen = (t: string): string => t.replace(/[-\u00AD]\r?\n\s*/g, '');

/**
 * Stufe (b): übrige Soft-Hyphens (U+00AD) entfernen — sie sind bedingte Trennzeichen und
 * tragen im extrahierten Text keine sichtbare Information; vereinzelt stehende (ohne
 * Umbruch) würden sonst den wörtlichen Vergleich stören.
 */
const softHyphensEntfernen = (t: string): string => t.replace(/\u00AD/g, '');

/**
 * Stufe (d): jede Whitespace-Sequenz (Leerzeichen, Tabs, Umbrüche) zu genau einem
 * Leerzeichen kollabieren — Zeilenumbriiche des Satzspiegels sind kein Inhalt.
 */
const whitespaceKollabieren = (t: string): string => t.replace(/\s+/g, ' ');

/**
 * Stufe (e): Kleinschreibung — Fundstellen sind wörtlich, aber nicht schreibungsfixiert;
 * ein Zitat am Satzanfang unterscheidet sich sonst nur durch die Majuskel vom Vorkommen.
 */
const kleinschreiben = (t: string): string => t.toLowerCase();

/**
 * Deterministische Normalisierungs-Pipeline für den Zitat-Vergleich. Die Stufenfolge ist
 * verbindlich: Trennung auflösen (c) VOR Whitespace-Kollaps (d) — siehe Stufen-Kommentare.
 * Stufe (f) `trim` schließt führende/abschließende Ränder nach dem Kollaps an.
 */
export function normalisiere(text: string): string {
  return kleinschreiben(whitespaceKollabieren(softHyphensEntfernen(trennungAufloesen(normalform(text))))).trim();
}

/**
 * Wörtliche Auflösbarkeitsprüfung: liefert `true` genau dann, wenn das normalisierte
 * Zitat wörtlich im normalisierten Seitentext vorkommt. Ein leeres oder whitespace-only
 * Zitat ist NIE auflösbar (liefert `false`, wirft nicht) — ein Agent kann sich nicht mit
 * einem leeren String durch das Gate „durchmatchen" (der leere String ist Teilstring
 * jedes Textes). Keine Toleranz, keine Magie: ein einziger `includes`-Vergleich nach
 * Normalisierung — das Ergebnis ist deterministisch und erklärbar.
 */
export function zitatAufloesbar(seitenText: string, zitat: string): boolean {
  const nadel = normalisiere(zitat);
  if (nadel === '') return false;
  return normalisiere(seitenText).includes(nadel);
}

/**
 * Diagnose-/Test-Variante: wie `zitatAufloesbar`, aber zählt die (überlappungsfreien)
 * Vorkommen im normalisierten Text. Mehrfachvorkommen auf derselben Seite gelten als
 * auflösbar — die Fundstelle steht wörtlich dort; Mehrdeutigkeit ist in Phase 12 kein
 * Ablehnungsgrund (dokumentierte Entscheidung, der Flywheel beobachtet sie; Verschärfung
 * über Kontextfenster wäre eine Flywheel-Aktion aus AI-SPEC Section 6).
 */
export function findeZitat(seitenText: string, zitat: string): { gefunden: boolean; anzahl: number } {
  const nadel = normalisiere(zitat);
  if (nadel === '') return { gefunden: false, anzahl: 0 };
  const heuhaufen = normalisiere(seitenText);
  let anzahl = 0;
  let von = 0;
  for (;;) {
    const treffer = heuhaufen.indexOf(nadel, von);
    if (treffer === -1) break;
    anzahl += 1;
    von = treffer + nadel.length;
  }
  return { gefunden: anzahl > 0, anzahl };
}
