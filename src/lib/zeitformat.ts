/**
 * Geteilte Zeitdarstellung für die neuen Oberflächen dieser Phase (Wiederherstellung, Übergabe).
 * `tag()`/`uhrzeit()` übernehmen exakt das Verhalten der gleichnamigen lokalen Funktionen in
 * `src/lib/components/HistoryOverlay.svelte` — bewusste Duplikation statt Refaktorierung des
 * Bestandsoverlays (D-01: HistoryOverlay.svelte bleibt unverändert).
 */

/** Tagesüberschrift; heute/gestern ausgeschrieben, sonst Datum (TT.MM.JJJJ). */
export function tag(zeit: number): string {
  const d = new Date(zeit);
  const heute = new Date();
  const gleich = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (gleich(d, heute)) return 'Heute';
  const gestern = new Date(heute.getTime() - 86_400_000);
  if (gleich(d, gestern)) return 'Gestern';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Uhrzeit im Format HH:MM (de-DE, zweistellig). */
export function uhrzeit(zeit: number): string {
  return new Date(zeit).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** „{Tag} {Uhrzeit}" — der von 04-UI-SPEC.md geforderte Wortlaut für lange Zeitpunktangaben. */
export function zeitpunktLang(zeit: number): string {
  return `${tag(zeit)} ${uhrzeit(zeit)}`;
}
