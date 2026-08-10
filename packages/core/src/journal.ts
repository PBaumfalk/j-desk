/**
 * Antwortform der Journal-Route (`GET /api/v1/desks/:id/journal`), wie sie der Client für die
 * Historie erwartet. Der Server liest die Zeilen aus `command_journal` und liefert sie in dieser
 * Form aus, hält dafür aber eine eigene Typdefinition (`JournalZeile` in
 * packages/server/src/journal.ts) — kein gemeinsamer Typ, also kein Compile-Schutz gegen
 * Drift zwischen Server-Antwort und dieser Beschreibung; bei Änderungen beide Seiten pflegen.
 */
export interface JournalEintragDto {
  id: number;
  rev: number;
  type: string;
  /** Command-Payload; bei snapshot/stateReplaced/caseSync ist `state` serverseitig auf '…' gekürzt. */
  payload: unknown;
  actorId: string | null;
  actorName: string;
  /** Zeitpunkt in Millisekunden seit Epoch. */
  at: number;
}
