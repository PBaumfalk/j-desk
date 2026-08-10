import type { CommandMeta, DesktopState } from './model';
import { applyCommand, type Command } from './commands';
import { stempeleGeaenderte } from './stempel';

/**
 * Journal-Zeilentypen, deren `payload` einen vollen `state` trägt und beim Replay einen
 * direkten Zustandsersatz auslösen (kein Command, kein Stempeln) — die EINE Wahrheit, aus der
 * sich sowohl die Server-Projektion (`STATE_TRAGENDE_TYPEN`, `packages/server/src/journal.ts`)
 * als auch der Replay-Algorithmus hier ableiten (schließt Pitfall 2 strukturell statt per
 * Doppelpflege). `stateRestored` gehört bewusst dazu: eine Wiederherstellung mitten im
 * Replay-Bereich ist ein Zustandsersatz wie jeder andere — würde sie übersprungen, liefen alle
 * danach folgenden Commands still auf dem Vor-Wiederherstellungs-Stand (04-01 A-04).
 */
export const ZUSTANDS_TRAGENDE_JOURNAL_TYPEN: ReadonlySet<string> = new Set([
  'snapshot', 'stateReplaced', 'caseSync', 'stateRestored',
]);

/**
 * Journal-Zeilentypen ohne jeden State-Effekt — beim Replay folgenlos übersprungen (kein
 * Command, kein Zustandsersatz). Fasst die "kein echter Command"-Sorte zusammen:
 * `deskCreated` (trägt nur `{name}`) und `exported` (HIST-04, trägt nur `{format}` u.ä.,
 * verbraucht nie einen `rev` und kann daher zwischen zwei echten Commands im Replay-Bereich
 * auftauchen). Ohne diesen Eintrag würde `exported` in den dritten Zweig von `replayJournal`
 * fallen und als unbekanntes Command an `applyCommand()` gereicht, was den Replay hart
 * abbrechen lässt (04-04 CR-01) — obwohl ein Export keinerlei Zustandsänderung bewirkt.
 */
export const NEBENWIRKUNGSFREIE_JOURNAL_TYPEN: ReadonlySet<string> = new Set([
  'deskCreated', 'exported',
  // 12: Doppelstempel-Marker, Replay folgenlos — sonst bricht replayJournal als unbekanntes
  // Command ab (Präzedenz exported, 04-04 CR-01). Die Marker tragen ihre ganze Aussage im
  // Payload (vorschlagId, art, kiAkteur, approvedBy — seit CR-02 bewusst INHALTSFREI, ohne
  // Register-zusammenfassung) und verbrauchen keinen rev.
  'vorschlagGenehmigt', 'vorschlagZurueckgenommen',
]);

/**
 * Gelesene Journal-Zeile für den Replay — strukturell deckungsgleich mit `JournalZeile`
 * (`packages/server/src/journal.ts`). Core darf den Server nicht importieren, deshalb eine
 * eigene, dokumentierte Definition; Änderungen an einer Seite sind an der anderen zu spiegeln.
 */
export interface JournalReplayZeile {
  id: number;
  rev: number;
  type: string;
  payload: unknown;
  actorId: string | null;
  actorName: string;
  at: number;
}

/**
 * Rekonstruiert einen Zustand, indem `entries` (aufsteigend nach `id` sortiert) auf `start`
 * angewendet werden. Drei Fälle je Zeile, in dieser Reihenfolge:
 *  (a) Zustands-tragende Zeile (`ZUSTANDS_TRAGENDE_JOURNAL_TYPEN`) mit vollem `payload.state`
 *      → direkter Ersatz, kein Stempeln. Trägt die Zeile kein Objekt-`state`-Feld (z. B.
 *      `payload === null`), wird sie übersprungen statt den Zustand auf `undefined` zu setzen.
 *  (b) Nebenwirkungsfreie Zeile (`NEBENWIRKUNGSFREIE_JOURNAL_TYPEN`, z. B. `deskCreated`,
 *      `exported`) → überspringen (trägt kein Zustands-Delta).
 *  (c) sonst → als Command anwenden und mit den HISTORISCHEN Stempelwerten (rev/at/actorName
 *      der jeweiligen Zeile) versehen — niemals mit denen des Wiederherstellungs-Zeitpunkts
 *      oder -Akteurs (P-02).
 *
 * Fehler aus `applyCommand` (z. B. `CommandError` bei unbekanntem Typ) werden NICHT
 * geschluckt: die Schleife bricht sofort ab, damit niemals ein halb rekonstruierter Zustand
 * entsteht (P-03). WR-02 (04-04): der ursprüngliche Fehler wird dabei um die auslösende
 * Journal-Zeile (`id`/`rev`/`type`) ergänzt (Nachrichtentext + `cause`) — ohne diesen Kontext
 * lässt sich aus `applyCommand`s Fehlermeldung allein nicht rekonstruieren, welche der (ggf.
 * hunderten) Zeilen im Replay-Bereich den Abbruch ausgelöst hat.
 */
export function replayJournal(start: DesktopState, entries: JournalReplayZeile[]): DesktopState {
  let state = start;
  for (const e of entries) {
    if (ZUSTANDS_TRAGENDE_JOURNAL_TYPEN.has(e.type)) {
      if (e.payload && typeof e.payload === 'object' && 'state' in e.payload) {
        state = (e.payload as { state: DesktopState }).state;
      }
      continue;
    }
    if (NEBENWIRKUNGSFREIE_JOURNAL_TYPEN.has(e.type)) continue;

    const at = new Date(e.at).toISOString();
    const meta: CommandMeta = {
      createdBy: e.actorName,
      createdAt: at,
      ...(e.actorId ? { createdById: e.actorId } : {}),
    };
    const vorher = state;
    let angewendet: DesktopState;
    try {
      angewendet = applyCommand(vorher, { type: e.type, payload: e.payload as Record<string, unknown> } as Command, meta);
    } catch (fehler) {
      const ursache = fehler instanceof Error ? fehler.message : String(fehler);
      throw new Error(`Replay abgebrochen bei Journal-Zeile id=${e.id} rev=${e.rev} type=${e.type}: ${ursache}`, { cause: fehler });
    }
    state = stempeleGeaenderte(vorher, angewendet, { rev: e.rev, at, by: e.actorName });
  }
  return state;
}
