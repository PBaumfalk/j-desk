import {
  projectStateForActor,
  type ActorContext, type DesktopState, type Rolle,
} from '@j-desk/core';
import type { Db } from './db';
import { getDeskState } from './deskStore';

/**
 * AR-02-04 (02-SECURITY.md, WR-03) — geschlossener Sicherheitsvorbehalt: bisher lieferten die
 * drei desk-losen Datei-Leserouten des eigenständigen Modus (Inhalt, Vorschau, Metadaten) Bytes
 * an JEDE angemeldete Sitzung mit bekannter Dateikennung — unabhängig davon, ob das
 * referenzierende Objekt für diesen Nutzer überhaupt sichtbar war. Diese Funktion schließt die
 * Lücke: sie beantwortet „darf dieser Nutzer diese Datei lesen?" damit, ob mindestens ein für
 * ihn SICHTBARES Objekt auf die Dateikennung verweist — auf IRGENDEINEM Schreibtisch, auf dem er
 * eine Rolle hat (Dublettenerkennung, files.ts, kann dieselbe Datei über mehrere Schreibtische
 * verknüpfen; eine Prüfung gegen nur einen Schreibtisch sperrt legitime Fälle aus).
 *
 * Die Prüfung läuft bewusst über `projectStateForActor()` (denselben Pfad wie jede andere
 * Auslieferung) statt über eine eigene Sichtbarkeitsregel: eine zweite Wahrheit über
 * Sichtbarkeit driftet garantiert von der ersten ab, sobald sich Ebenen- oder Freigabe-Logik
 * ändern (projection.ts-Kopfkommentar, Broadcast-Leck-Bugklasse aec4f58/fcda808).
 */

/**
 * Die AKTIVEN Objektarten, die eine Dateikennung tragen können — geprüft werden genau diese
 * beiden. Kommt künftig eine neue aktive Objektart mit eigenem `fileId` hinzu, MUSS sie hier
 * ergänzt werden: ein Vergessen ist keine neue Sicherheitslücke, sondern ein GEBROCHENER
 * ANZEIGEPFAD (das Objekt bleibt sichtbar, seine Datei aber nicht mehr abrufbar).
 *
 *  1. Dokumentkarten (`state.docs`, `Doc.fileId`) — deckt sowohl freistehende Karten als auch
 *     Konvolut-Bestandteile ab: ein Konvolut (`Stack`) referenziert seine Mitglieder nur über
 *     `docIds` (konvolut.ts), die Mitglieder selbst bleiben normale Einträge in `state.docs` mit
 *     eigenem `fileId`/`layerId` — keine zweite Struktur, kein separater Prüfschritt nötig
 *     (deshalb NICHT `freeDocs()` verwenden, das würde Konvolut-Mitglieder fälschlich auslassen).
 *  2. Ausschnitte (`state.cutouts`, `Cutout.fileId`) — Scheren-Ausschnitte einer PDF-Seite.
 *
 * BEWUSST NICHT geprüft: `state.trash` (Papierkorb). Korb-Einträge tragen laut
 * `projection.ts`-Kopfkommentar VOLLKOPIEN entfernter Objekte inkl. `fileId` (docs/cutouts
 * innerhalb von `TrashedItem.payload`, s. `trash.ts` `TrashPayload`), fallen also formal unter
 * denselben Datei-tragenden Fall. Sie sind hier ausgenommen, weil aktuell KEINE Route Datei-Bytes
 * über die `fileId` eines Papierkorb-Eintrags ausliefert — `TrashCan.svelte` (die einzige
 * Papierkorb-UI) zeigt ausschließlich Name/Art/Zeitpunkt, keine Vorschau, keinen Dateizugriff.
 * Diese Auslassung ist bewusst und heute folgenlos (fail-safe: ein nur im Korb referenziertes
 * Dokument gilt hier als NICHT sichtbar, nicht als fälschlich sichtbar). Kommt künftig eine
 * Papierkorb-Vorschau hinzu, MUSS `referenziertDatei()` erweitert werden, um auch
 * `state.trash`-Payloads zu scannen (Muster: `Object.values(t.payload).every(...)` wie in
 * `projection.ts:52-63`).
 */
function referenziertDatei(state: DesktopState, fileId: string): boolean {
  if (state.docs.some((d) => d.fileId === fileId)) return true;
  if ((state.cutouts ?? []).some((c) => c.fileId === fileId)) return true;
  return false;
}

/** Alle Schreibtische, auf denen `userId` eine Rolle hat, samt dieser Rolle — Grundlage der
 *  Mehrfachbezug-Prüfung (Dublettenerkennung über sha256 kann dieselbe Datei auf mehreren
 *  Schreibtischen desselben Nutzers referenzieren). */
function deskRollenFuerNutzer(db: Db, userId: string): { deskId: string; rolle: Rolle }[] {
  return db
    .prepare('SELECT desk_id AS deskId, rolle FROM desk_roles WHERE user_id = ?')
    .all(userId) as { deskId: string; rolle: Rolle }[];
}

/**
 * Kernfunktion: darf `userId` die Datei `fileId` lesen? Rein lesend, wirft NIE bei unbekannter
 * Datei/unbekanntem Nutzer — liefert schlicht `false`. Die Unterscheidung zwischen „Datei
 * existiert nicht" und „Datei nicht sichtbar" gehört bewusst nicht in diese Antwort (die
 * Aufrufer-Route liefert in beiden Fällen dieselbe Nicht-gefunden-Antwort, T-14-07-02).
 *
 * Ablauf: über alle Schreibtische des Nutzers iterieren, je Schreibtisch den Zustand für ihn als
 * Akteur projizieren und nach einem referenzierenden Objekt suchen — beim ersten Treffer sofort
 * abbrechen (T-14-07-03, hält den Lesepfad unter Last tragfähig).
 */
export function istDateiSichtbarFuer(db: Db, userId: string, fileId: string): boolean {
  for (const { deskId, rolle } of deskRollenFuerNutzer(db, userId)) {
    const geladen = getDeskState(db, deskId);
    if (!geladen) continue;
    const ctx: ActorContext = { userId, rolle };
    const projiziert = projectStateForActor(geladen.state, ctx);
    if (referenziertDatei(projiziert, fileId)) return true;
  }
  return false;
}
