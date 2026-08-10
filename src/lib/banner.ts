/**
 * Verbindungs-/Wartestand-Banner (D-03, SAFE-02; SESS-03): der Wortlaut existiert genau
 * einmal — hier — und wird vom normalen Tisch (Desktop.svelte) und der Sitzungsmodus-Chrome
 * (SitzungsmodusShell.svelte) gemeinsam genutzt. Alle Funktionen sind rein.
 */

export type VerbindungsStatus = 'online' | 'offline' | 'connecting';

/** „ — N Änderungen warten auf Übertragung" (Singularform „ — 1 Änderung wartet …"), leer bei 0. */
export function wartestandZusatz(pendingCount: number): string {
  if (pendingCount <= 0) return '';
  return pendingCount === 1
    ? ' — 1 Änderung wartet auf Übertragung'
    : ` — ${pendingCount} Änderungen warten auf Übertragung`;
}

/** Bannertext für die drei Fälle: offline/connecting (Text + Wartestand-Zusatz)
 *  und online mit noch offener Warteschlange (Drain läuft, kein Zähleranhang). */
export function bannerText(status: string, pendingCount: number): string {
  if (status === 'offline') return `Verbindung getrennt — verbinde neu…${wartestandZusatz(pendingCount)}`;
  if (status === 'connecting') return `Verbinde…${wartestandZusatz(pendingCount)}`;
  return 'Änderungen werden übertragen…'; // status === 'online' && pendingCount > 0
}

/** Sichtbarkeitsbedingung des Banners: getrennt, verbindend oder offene Warteschlange. */
export function bannerSichtbar(status: string, pendingCount: number): boolean {
  return status === 'offline' || status === 'connecting' || pendingCount > 0;
}

/** Der modale Blocker gilt ausdrücklich NUR für getrennt und verbindend — nicht für den
 *  Online-Fall mit offener Warteschlange (der Drain läuft im Hintergrund, ohne die
 *  Bedienung zu sperren). */
export function bannerBlockiert(status: string): boolean {
  return status === 'offline' || status === 'connecting';
}
