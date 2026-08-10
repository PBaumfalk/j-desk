import type { Rolle } from '@j-desk/core';

/** Client-seitiges Gegenstück zu `packages/server/src/presence.ts::PraesenzPerson` —
 *  dasselbe Drahtformat (06-01-SUMMARY.md), hier als eigener Typ, damit dieses Modul
 *  keine Server-Abhängigkeit braucht. */
export interface PraesenzPerson {
  userId: string;
  name: string;
  rolle: Rolle;
  objektId?: string;
}

/** Präsenzdaten liegen bewusst in einem eigenen, kleinen reaktiven Zustand — zu keinem
 *  Zeitpunkt Teil von `DesktopState` (K7): sie sind rein flüchtig (WS-gebunden), landen nie
 *  in `writeSnapshotDebounced`/IndexedDB und dürfen es auch nie. */
export const praesenz = $state<{ personen: PraesenzPerson[] }>({ personen: [] });

/**
 * Streng defensive Deutung einer eingehenden WS-Nachricht: liefert `null` bei jeder Form, die
 * nicht exakt einer Präsenzmeldung entspricht — niemals eine Ausnahme (T-06-08). Ungültige
 * Einzeleinträge in `personen` werden übersprungen, nicht die ganze Nachricht verworfen.
 */
export function deutePraesenzNachricht(data: unknown): PraesenzPerson[] | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.typ !== 'praesenz') return null;
  if (!Array.isArray(d.personen)) return null;
  const ergebnis: PraesenzPerson[] = [];
  for (const eintrag of d.personen) {
    if (typeof eintrag !== 'object' || eintrag === null) continue;
    const e = eintrag as Record<string, unknown>;
    if (typeof e.userId !== 'string' || typeof e.name !== 'string' || typeof e.rolle !== 'string') continue;
    const person: PraesenzPerson = { userId: e.userId, name: e.name, rolle: e.rolle as Rolle };
    if (typeof e.objektId === 'string') person.objektId = e.objektId;
    ergebnis.push(person);
  }
  return ergebnis;
}

/**
 * Übernimmt eine eingehende Nachricht, falls sie eine gültige Präsenzmeldung ist — Vollbild-
 * Semantik (keine Zusammenführung von Deltas, das Drahtformat aus 06-01 sendet immer den
 * vollständigen Roster). Liefert `true`, wenn die Nachricht als Präsenzmeldung behandelt wurde
 * (unabhängig davon, ob `store.svelte.ts` danach noch etwas anderes damit tut).
 */
export function uebernimmPraesenz(data: unknown): boolean {
  const personen = deutePraesenzNachricht(data);
  if (personen === null) return false;
  praesenz.personen = personen;
  return true;
}

/** Alle verbundenen Personen außer dem Betrachter selbst (Rosette/Roster). */
export function anderePersonen(eigeneUserId: string | null): PraesenzPerson[] {
  return praesenz.personen.filter((p) => p.userId !== eigeneUserId);
}

/** Die fremde Person, die `objektId` gerade bearbeitet (Soft-Lock-Dekoration an Karten) —
 *  `undefined`, wenn niemand oder nur der Betrachter selbst es bearbeitet (UI-SPEC: kein Ring
 *  um die eigene, gerade aktiv bearbeitete Karte). */
export function personFuerObjekt(objektId: string, eigeneUserId: string | null): PraesenzPerson | undefined {
  return praesenz.personen.find((p) => p.objektId === objektId && p.userId !== eigeneUserId);
}

// ---- Senden/Erneuern des Bearbeitungssignals (Task 2) ----

/** Bewusst deutlich kleiner als die serverseitige Ablaufzeit `LOCK_TTL_MS = 25_000` (06-01):
 *  so überstehen zwei verlorene Erneuerungen den Ablauf noch, während eine tatsächlich
 *  verschwundene Verbindung binnen höchstens 25 Sekunden aus der Anzeige fällt. */
export const RENEW_INTERVAL_MS = 10_000;

/** Modul-lokal injizierter Sendekanal — `presence.svelte.ts` importiert den WebSocket bewusst
 *  NICHT selbst (Prohibition), damit alle Sendepfade im Test ohne Netzwerk prüfbar bleiben und
 *  der Generations-/Wiederverbindungs-Lebenszyklus allein in `store.svelte.ts` verantwortet
 *  bleibt. */
let sende: ((nachricht: unknown) => void) | null = null;
let erneuerungsTimer: ReturnType<typeof setInterval> | undefined;

/** Setzt (oder löscht mit `null`) den Sendekanal — von `store.svelte.ts` beim Verbindungsaufbau
 *  bzw. beim Trennen/Generationswechsel aufgerufen. */
export function setzeSender(sendeFn: ((nachricht: unknown) => void) | null): void {
  sende = sendeFn;
}

function stoppeErneuerung(): void {
  clearInterval(erneuerungsTimer);
  erneuerungsTimer = undefined;
}

/** Sendet sofort `{typ:'bearbeitet', objektId}` und erneuert es fortan alle `RENEW_INTERVAL_MS`,
 *  solange die Bearbeitung läuft. Ein bereits laufendes Intervall wird beim Wechsel des Objekts
 *  zuerst gestoppt — es darf nie mehr als ein aktives Intervall geben. Ist kein Sender gesetzt,
 *  löst dies keine Ausnahme aus und sendet nichts. */
export function bearbeitetJetzt(objektId: string): void {
  stoppeErneuerung();
  const nachricht = { typ: 'bearbeitet', objektId };
  sende?.(nachricht);
  erneuerungsTimer = setInterval(() => sende?.(nachricht), RENEW_INTERVAL_MS);
}

/** Sendet einmal `{typ:'ruht'}` und stoppt die Erneuerung. */
export function ruhtJetzt(): void {
  stoppeErneuerung();
  sende?.({ typ: 'ruht' });
}

/** Leert den Präsenzzustand vollständig und stoppt eine laufende Erneuerung — bei Desk-Wechsel
 *  und beim Abmelden (WR-02-Muster). Sendet dabei bewusst nichts: die Verbindung ist ohnehin
 *  nicht mehr zuständig, der Server räumt über sein close-Ereignis und die Ablaufzeit auf. */
export function setzePraesenzZurueck(): void {
  stoppeErneuerung();
  praesenz.personen = [];
}
