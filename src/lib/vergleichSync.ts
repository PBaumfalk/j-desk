/**
 * Kopplungslogik zweier Betrachterspalten im Vergleichsviewer (COMP-01, 09-08-PLAN.md) — reine,
 * exakt getestete Funktionen, bewusst ohne Svelte-Abhängigkeit und ohne Modulzustand: die
 * Rückkopplungsfalle (09-RESEARCH.md Pitfall 4) wird dadurch prüfbar. In einer `.svelte`-Datei
 * wäre sie es in diesem Projekt nicht, weil die Testumgebung `node` ist und es keine
 * Komponententests gibt.
 *
 * Der Kopplungszustand wird als übergebener Wert behandelt, nicht als Modulzustand: die
 * Komponente hält ihn, dieses Modul entscheidet nur, ob und wie weit angeglichen wird.
 *
 * Ein Versatzausgleich zwischen unterschiedlich langen Fassungen findet in dieser Ausbaustufe
 * NICHT statt — die Seiten werden eins zu eins zugeordnet und am Ende geklemmt. Das ist eine
 * bewusste Festlegung des Objectives (09-08-PLAN.md), keine spätere Fehlerquelle: die
 * Anforderung verlangt „koppelbar", nicht „inhaltlich ausgerichtet".
 */

/**
 * Quelle einer Seiten-/Rollpositions-Bewegung. `programm` markiert eine Angleichung, die das
 * Modul selbst bereits ausgelöst hat — eine Bewegung mit dieser Quelle löst NIE eine weitere
 * Angleichung aus. Genau diese Unterscheidung schließt die Rückkopplung strukturell: dasselbe
 * Prinzip wie das Übergehen überholter Renderläufe (`renderToken` in `PageRenderer.svelte`), nur
 * hier für den Zwei-Spalten-Sync statt für die Async-Renderreihenfolge.
 */
export type SyncQuelle = 'links' | 'rechts' | 'programm';

function klemme(wert: number, min: number, max: number): number {
  return Math.min(Math.max(wert, min), max);
}

/**
 * Ermittelt die neue Seitenzahl der jeweils ANDEREN Spalte, wenn eine Spalte mit `quelle`
 * (`links`/`rechts`) eine Bewegung ausgelöst hat. `null` bedeutet „nichts anzugleichen":
 * Kopplung aus, die auslösende Quelle war bereits `programm` (Rückkopplungsschutz), oder die
 * andere Fassung hat null Seiten. Die gelieferte Zahl ist auf den Bereich von eins bis zur
 * Seitenzahl der anderen Fassung geklemmt — hat die andere Fassung weniger Seiten, klemmt das
 * Ergebnis auf deren letzte Seite; hat sie mehr, bleibt die Seitenzahl unverändert übernommen.
 */
export function koppleSeite(input: {
  gekoppelt: boolean;
  quelle: SyncQuelle;
  seite: number;
  seitenAndereSpalte: number;
}): number | null {
  const { gekoppelt, quelle, seite, seitenAndereSpalte } = input;
  if (!gekoppelt) return null;
  if (quelle === 'programm') return null;
  if (seitenAndereSpalte <= 0) return null;
  return klemme(seite, 1, seitenAndereSpalte);
}

/**
 * Wie `koppleSeite`, aber für die vertikale Rollposition als Bruchteil zwischen null und eins
 * der Seitenhöhe — unterschiedlich hohe Seiten werden so trotzdem sinnvoll aneinander
 * ausgerichtet (09-08-PLAN.md). Derselbe Rückkopplungsschutz (Quelle `programm` → `null`).
 */
export function koppleRollposition(input: {
  gekoppelt: boolean;
  quelle: SyncQuelle;
  bruchteil: number;
}): number | null {
  const { gekoppelt, quelle, bruchteil } = input;
  if (!gekoppelt) return null;
  if (quelle === 'programm') return null;
  return klemme(bruchteil, 0, 1);
}
