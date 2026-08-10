import { findeObjekt, istObjektSichtbarFuer, type DesktopState, type Rolle } from '@j-desk/core';

interface Sendable {
  send(data: string): void;
}

/** Interner Präsenz-Eintrag pro Socket — trägt zusätzlich zur öffentlichen `PraesenzPerson`
 *  die Sperr-Ablaufzeit (`sperreLaeuftAbUm`, Task 3). Bewusst nicht exportiert: nach außen
 *  darf nur das abgeleitete, für den Empfänger projizierte `PraesenzPerson` sichtbar sein. */
interface PraesenzEintrag {
  userId: string;
  name: string;
  rolle: Rolle;
  objektId?: string;
  sperreLaeuftAbUm?: number;
}

/** Öffentliche, für den Client bestimmte Präsenz-Person (Drahtformat für 06-02). */
export interface PraesenzPerson {
  userId: string;
  name: string;
  rolle: Rolle;
  objektId?: string;
}

/** Rein flüchig, K7: kein Teil von `DesktopState`, kein Journal, keine Datenbank-Anbindung. */
const raeume = new Map<string, Map<Sendable, PraesenzEintrag>>();

/** Kurzzeitige Soft-Lock-Dauer (COLLAB-02): ein Bearbeitungssignal, das länger als diese
 *  Zeitspanne nicht erneuert wird, gilt als abgelaufen (Task 3 wertet dies lazy aus). */
export const LOCK_TTL_MS = 25_000;

/**
 * T-06-04 (Elevation of Privilege): dieselbe Grenze, die `pruefeKommandoRecht` in `app.ts` für
 * mutierende Kommandos zieht — wer nichts ändern darf, kann auch kein Bearbeitungssignal
 * auslösen. Rollen außerhalb dieses Sets bleiben trotzdem im Roster sichtbar (sie sind
 * anwesend), sie tragen nur nie eine `objektId` (s. `setzeBearbeitung`).
 */
export const SIGNALFAEHIGE_ROLLEN: ReadonlySet<Rolle> = new Set(['Eigentümer', 'Bearbeiter', 'Kommentator']);

/** Registriert einen verbundenen Socket samt Actor-Kontext für einen Desk-Room. Spiegelt
 *  `broadcast.ts`s `register()`-Form exakt — dieselbe Registry-Struktur, zweiter, unabhängiger
 *  Zustand ohne geteilte Referenz. */
export function registerPresence(deskId: string, socket: Sendable, userId: string, name: string, rolle: Rolle): void {
  let raum = raeume.get(deskId);
  if (!raum) raeume.set(deskId, (raum = new Map()));
  raum.set(socket, { userId, name, rolle });
}

export function unregisterPresence(deskId: string, socket: Sendable): void {
  const raum = raeume.get(deskId);
  raum?.delete(socket);
  if (raum && raum.size === 0) raeume.delete(deskId);
}

/**
 * T-06-04/WR-01-Pendant: spiegelt `broadcast.ts::aktualisiereRolle()` für die zweite,
 * unabhängige Registry dieses Moduls — ohne diesen Aufruf bliebe `eintrag.rolle` nach einer
 * Rollenänderung auf offenen Verbindungen stale und der SIGNALFAEHIGE_ROLLEN-Gate in
 * `setzeBearbeitung()` würde weiterhin die alte (ggf. bereits entzogene) Rolle prüfen. Eine
 * Herabstufung unterhalb `SIGNALFAEHIGE_ROLLEN` löscht ein bereits laufendes Bearbeitungssignal
 * sofort, statt es bis zum TTL-Ablauf stehen zu lassen.
 */
export function aktualisierePresenzRolle(deskId: string, userId: string, rolle: Rolle): void {
  const raum = raeume.get(deskId);
  if (!raum) return;
  for (const eintrag of raum.values()) {
    if (eintrag.userId !== userId) continue;
    eintrag.rolle = rolle;
    if (!SIGNALFAEHIGE_ROLLEN.has(rolle)) {
      delete eintrag.objektId;
      delete eintrag.sperreLaeuftAbUm;
    }
  }
}

/** Markiert den Socket als „bearbeitet objektId" — setzt zugleich die Sperr-Ablaufzeit
 *  (`jetzt + LOCK_TTL_MS`). Ein erneuter Aufruf mit demselben oder einem anderen `objektId`
 *  verlängert die Sperre (Task 3). `jetzt` ist optional (Default `Date.now()`), damit Tests den
 *  Zeitverlauf ohne echte Wartezeit steuern können (Muster wie `autoArchive.ts`). */
export function setzeBearbeitung(deskId: string, socket: Sendable, objektId: string, jetzt: number = Date.now()): void {
  const raum = raeume.get(deskId);
  const eintrag = raum?.get(socket);
  if (!eintrag) return;
  // T-06-04: Rollen ohne Änderungsrecht können kein Bearbeitungssignal auslösen — der Eintrag
  // bleibt bestehen (die Person ist anwesend), nur objektId/Ablaufzeit werden nie gesetzt.
  if (!SIGNALFAEHIGE_ROLLEN.has(eintrag.rolle)) return;
  eintrag.objektId = objektId;
  eintrag.sperreLaeuftAbUm = jetzt + LOCK_TTL_MS;
}

/** Löst ein zuvor gesetztes Bearbeitungssignal wieder — unabhängig von `jetzt`. */
export function loeseBearbeitung(deskId: string, socket: Sendable): void {
  const raum = raeume.get(deskId);
  const eintrag = raum?.get(socket);
  if (!eintrag) return;
  delete eintrag.objektId;
  delete eintrag.sperreLaeuftAbUm;
}

/**
 * Baut den für EINEN Empfänger sichtbaren Präsenz-Roster eines Desk-Rooms. Reihenfolge = Map-
 * Einfügereihenfolge = Verbindungszeitpunkt (UI-SPEC verlangt eine stabile, nicht springende
 * Liste — JS-`Map`-Iteration garantiert das bereits ohne Zusatzaufwand).
 *
 * `state` und `jetzt` sind bereits Teil der finalen Signatur (Task 2 ergänzt die
 * Sichtbarkeitsprüfung über `istObjektSichtbarFuer`, Task 3 die TTL-Auswertung), damit die
 * Aufrufstellen in `app.ts` nicht mehrfach angefasst werden müssen.
 */
export function praesenzRoster(
  deskId: string,
  empfaenger: { userId: string; rolle: Rolle },
  state: DesktopState | undefined,
  jetzt: number = Date.now(),
): PraesenzPerson[] {
  const raum = raeume.get(deskId);
  if (!raum) return [];
  const ergebnis: PraesenzPerson[] = [];
  for (const eintrag of raum.values()) {
    // 06-03 (Präsenz-Rosette, UI-SPEC „Empty State"): der eigene Eintrag gehört NIE in den an
    // einen selbst ausgelieferten Roster — die Rosette zeigt ausschließlich ANDERE Personen an.
    // Serverseitiger Ausschluss statt clientseitiger Filterung: der Client kennt seine eigene
    // userId aktuell nirgends (kein bestehender Übertragungsweg dafür) und braucht sie durch
    // diesen Ausschluss strukturell auch nicht mehr, um „bin ich selbst gemeint" zu beantworten.
    if (eintrag.userId === empfaenger.userId) continue;
    const objektIdWennAktiv = istSperreAktiv(eintrag, jetzt) ? eintrag.objektId : undefined;
    ergebnis.push({
      userId: eintrag.userId,
      name: eintrag.name,
      rolle: eintrag.rolle,
      objektId: sichtbareObjektIdFuer(objektIdWennAktiv, empfaenger, state),
    });
  }
  // CR-02: mehrere Sockets desselben Nutzers (mehrere Tabs/Geräte) erzeugen mehrere Einträge in
  // `raeume` — ohne Dedupe hier bekäme der Client zwei `PraesenzPerson`-Objekte mit identischer
  // `userId`, was das nach `userId` geschlüsselte `{#each}` in `PresenceRoster.svelte` verletzt.
  // Pro `userId` genau einen Eintrag ausliefern; einen mit aktiver `objektId` bevorzugen, sonst
  // den zuerst verbundenen (Map-Einfügereihenfolge).
  const proNutzer = new Map<string, PraesenzPerson>();
  for (const p of ergebnis) {
    const bestehend = proNutzer.get(p.userId);
    if (!bestehend || (p.objektId !== undefined && bestehend.objektId === undefined)) {
      proNutzer.set(p.userId, p);
    }
  }
  return [...proNutzer.values()];
}

/**
 * T-06-06/Pitfall 4: Ablaufzeit LAZY beim Lesen auswerten statt über einen Hintergrund-Timer —
 * ein laufender `setInterval`/`setTimeout`-Kehrlauf im Modul würde in Tests offene Handles
 * hinterlassen und hat in diesem Projekt kein Vorbild; die faule Auswertung liefert dieselbe
 * Garantie ohne Nebenwirkung. Damit kann eine Sperre eine abgebrochene Verbindung nicht
 * überleben, selbst wenn deren `close`-Ereignis nie ausgelöst wird. Grenzfall bewusst
 * festgeschrieben: `jetzt === sperreLaeuftAbUm` gilt bereits als abgelaufen (`<`, nicht `<=`).
 */
function istSperreAktiv(eintrag: PraesenzEintrag, jetzt: number): boolean {
  if (eintrag.objektId === undefined || eintrag.sperreLaeuftAbUm === undefined) return false;
  return jetzt < eintrag.sperreLaeuftAbUm;
}

/**
 * PERM-05/T-06-01: Präsenzmeldungen sind KEIN Teil von `DesktopState` und laufen daher nicht
 * automatisch durch `projectStateForActor()` — dieselbe Rundfunk-Leck-Bugklasse, die die
 * Commits aec4f58/fcda808 bereits einmal real getroffen hat, gilt hier erneut, wenn dieser
 * Filter fehlt. Fail-Closed: unbekanntes Objekt, fehlender `state` oder fehlendes Sichtrecht
 * führen ALLE zum Weglassen der `objektId` — der Roster-Eintrag der Person selbst bleibt in
 * jedem Fall erhalten (sie ist weiterhin anwesend, nur das Objekt bleibt unerwähnt).
 */
function sichtbareObjektIdFuer(
  objektId: string | undefined,
  empfaenger: { userId: string; rolle: Rolle },
  state: DesktopState | undefined,
): string | undefined {
  if (objektId === undefined || state === undefined) return undefined;
  const treffer = findeObjekt(state, objektId);
  if (!treffer) return undefined;
  const layerId = (treffer.obj as { layerId?: string }).layerId;
  return istObjektSichtbarFuer(layerId, empfaenger, state.layers) ? objektId : undefined;
}

/**
 * Sendet an JEDEN Socket eines Desk-Rooms dessen EIGENEN, empfängerspezifisch projizierten
 * Präsenz-Roster (PERM-05) — exakt das Muster von `broadcast.ts`s `broadcast()`, hier auf die
 * Präsenz-Nutzlast übertragen: Projektion passiert HIER, pro Socket, nicht vorher.
 */
export function sendePraesenz(deskId: string, state: DesktopState | undefined, jetzt: number = Date.now()): void {
  const raum = raeume.get(deskId);
  if (!raum) return;
  for (const [socket, eintrag] of raum) {
    const personen = praesenzRoster(deskId, { userId: eintrag.userId, rolle: eintrag.rolle }, state, jetzt);
    try {
      socket.send(JSON.stringify({ typ: 'praesenz', personen }));
    } catch {
      // toter Socket — wird über sein close-Event ausgetragen
    }
  }
}
