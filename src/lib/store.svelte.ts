import {
  applyCommand, darfAktion, docBox, emptyState, findeEbene, SYSTEM_EBENEN,
  type Command, type DesktopState, type Ebene, type Erwartet, type GefahrlicheAktion, type Konflikt, type Rolle,
} from '@j-desk/core';
import { ApiError, type ApiClient, type DeskInfo } from './api';
import { erwartungAus, reaktionFuer, KonfliktAntwort } from './konflikt';
import { planeSprung, type Fundstelle } from './jump';
import { saveLastDeskId } from './session';
import { showToast, toast403, ui, setSourceHighlight, setzeSitzungsUiZurueck } from './ui.svelte';
import { clearAllSnapshots, writeSnapshot, writeSnapshotDebounced } from './snapshot';
import {
  bumpRetry, enqueueCommand, istBereitsAngewendet, queueLength, QueueVollError, readQueue, removeFromQueue,
} from './offlineQueue';
import { setzePraesenzZurueck, setzeSender, uebernimmPraesenz } from './presence.svelte';
import { ladeVorschlaege, setzeFreigabenZurueck, signalEmpfangen } from './freigaben.svelte';
import {
  ladeBenachrichtigungen, setzeBenachrichtigungenZurueck,
  signalEmpfangen as benachrichtigungSignalEmpfangen,
} from './benachrichtigungen.svelte';

let state = $state<DesktopState>(emptyState());
let status = $state<'connecting' | 'online' | 'offline' | 'loggedOut'>('loggedOut');
/** j-lawyer im Abgleich derzeit nicht erreichbar (letzter Stand wird trotzdem angezeigt) — nur j-lawyer-Modus. */
let syncFehler = $state<string | null>(null);
let desks = $state<DeskInfo[]>([]);
let mode = $state<'standalone' | 'jlawyer'>('standalone');
let wsGeneration = 0;
let rev = 0;
let api: ApiClient | null = null;
let deskId = $state<string | null>(null);
let ws: WebSocket | null = null;
let reconnectDelay = 1000;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** 02-07 (PERM-02): eigene Rolle am aktuellen Desk — steuert, ob rollengebundene Aktionen
 *  (Ebenen-/Rollenverwaltung) in der UI erscheinen. Seit WR-04 liefert auch der
 *  j-lawyer-Modus die Rolle mit (der Server ermittelt sie seit WR-02 in desk_roles);
 *  `null` heißt nur noch „(noch) unbekannt" — das Bestandsverhalten dafür ist
 *  „erlaubt" (kannEbenenVerwalten), der Server prüft ohnehin bei jedem Command. */
let myRolle = $state<Rolle | null>(null);
/** D-03 (SAFE-02): Anzahl noch nicht bestätigter Commands des aktuell geladenen Schreibtischs —
 *  einziges neues UI-Signal dieser Phase, gezeigt im bestehenden Verbindungsbanner (Desktop.svelte).
 *  Fortgeschrieben an genau drei Stellen: erfolgreiches enqueueCommand() (erhöhen),
 *  removeFromQueue() in drainQueue() (verringern), loadDesk() (gesetzt via queueLength()). */
let pendingCount = $state(0);
/** SEARCH-03 (07-08): fileIds mit OCR-Qualität unter der Schwelle, für den aktuell geladenen
 *  Schreibtisch — Grundlage für den OCR-Qualitäts-Chip an der Karte (DocCard.svelte). Modul-
 *  lokal statt Teil von `state`: der Chip ist eine reine Nebeninformation, kein Bestandteil des
 *  synchronisierten Desktop-Zustands (kein zusätzliches Broadcast-Feld, s. 07-08-PLAN.md-
 *  Objective — der State wird bei jeder Änderung vollständig neu serialisiert/gebroadcastet). */
let ocrUnsicherFileIds = $state<Set<string>>(new Set());

/**
 * Lädt die OCR-Statusabfrage nach (SEARCH-03) — läuft NIE über einen eigenen
 * Wiederholungstimer, sondern ausschließlich im Anschluss an einen bereits erfolgreichen
 * Zustandsabruf (refresh()/loadDesk()). Die dadurch entstehende Verzögerung zwischen
 * abgeschlossener Erkennung und erscheinendem Chip (bis zum nächsten Zustandsabruf) wird für
 * eine reine Nebeninformation bewusst in Kauf genommen — ein eigener Rundfunkkanal nur für
 * diese Angabe wäre unverhältnismäßig (T-07-41).
 *
 * Wirft NIE nach außen: schlägt der Abruf fehl (Netzfehler, ältere Serverversion ohne diese
 * Route, o. Ä.), bleibt die bisherige Menge unverändert stehen — es wird weder ein Chip
 * vorgetäuscht noch einer unterdrückt.
 */
async function ladeOcrStatus(): Promise<void> {
  if (!api || !deskId) return;
  try {
    const result = await api.ocrStatus(deskId);
    ocrUnsicherFileIds = new Set(result.unsicher);
  } catch {
    // s. Funktionskommentar oben — bisherige Menge bleibt unverändert stehen.
  }
}

/** Passende Meldung, wenn eine Aktion mangels Verbindung nicht ausgeführt wird. */
function offlineMeldung(): string {
  return status === 'connecting'
    ? 'Verbindung wird aufgebaut — gleich erneut versuchen'
    : 'Offline — Aktion nicht möglich';
}

// ---- Ebenen-Umschalter (PERM-01): aktive Zeichen-Ebene neuer Objekte, pro Werkzeug gemerkt ----

const LAYER_KEY_PREFIX = 'jdesk.layer.';
/** Implizite Standard-Ebene (CONTEXT „keine stille Wegnahme von Bestandsverhalten"). */
export const LAYER_FALLBACK = 'kanzlei';

let currentLayerId = $state<string>(LAYER_FALLBACK);
let currentWerkzeug = 'standard';

/** Bekannte Ebenen-ids zum aktuellen Zeitpunkt: die vier Systemebenen plus die
 *  benutzerdefinierten Kanzlei-Ebenen des gerade geladenen Desks. */
function bekannteEbenenIds(): Set<string> {
  return new Set<string>([...SYSTEM_EBENEN.map((e) => e.id), ...(state.layers ?? []).map((e) => e.id)]);
}

/** Zuletzt für dieses Werkzeug gewählte Ebene; unbekannte/veraltete Werte fallen auf die
 *  Standard-Ebene zurück (identisches Fallback-Muster wie inkColors.ts::loadInkColor). */
function ladeEbeneFuerWerkzeug(werkzeug: string): string {
  try {
    const v = localStorage.getItem(LAYER_KEY_PREFIX + werkzeug);
    if (v && bekannteEbenenIds().has(v)) return v;
  } catch { /* localStorage gesperrt — Fallback reicht */ }
  return LAYER_FALLBACK;
}

function speichereEbeneFuerWerkzeug(werkzeug: string, layerId: string): void {
  try { localStorage.setItem(LAYER_KEY_PREFIX + werkzeug, layerId); } catch { /* s. o. */ }
}

// ---- Sichtbarkeits-Panel (PERM-01/PERM-02): rein clientseitiger Anzeigefilter ----

/**
 * Ausgeblendete Ebenen-ids — leer (Default) heißt „alles sichtbar". WICHTIG: das ist ein
 * reiner UI-Filter über bereits vom Server projizierte Daten, KEINE Sicherheitsgrenze — private
 * Fremdobjekte hat der Server längst entfernt (projectStateForActor(), @j-desk/core, PERM-05).
 */
let ausgeblendeteEbenen = $state<Set<string>>(new Set());

/** Bei Desk-Wechsel: das Sichtbarkeits-Panel darf NICHT den Zustand des vorherigen Desks
 *  weiterzeigen (UI-SPEC „loading"-Backstop) — jeder neu geladene Desk startet mit allem sichtbar. */
export function resetVisibleLayers(): void {
  ausgeblendeteEbenen = new Set();
}

/**
 * Reiner clientseitiger Sichtfilter (KEINE Sicherheitsgrenze, s. o.) über bereits projizierte
 * Objekte — fehlende `layerId` gilt implizit als Kanzlei-Ebene (Bestandsverhalten, PERM-01).
 * 02-11: jede Roh-layerId wird vor dem Set-Vergleich über anzeigeEbeneId() auf die
 * Panel-/Anzeige-id abgebildet — eigene Privat-Objekte (Instanz-id `privat-<userId>`) werden
 * so von der Panel-Zeile 'privat' gesteuert wie Objekte jeder anderen Ebene.
 */
export function filterByVisibleLayers<T extends { layerId?: string }>(items: T[], visible: Set<string>, state: DesktopState): T[] {
  return items.filter((o) => visible.has(anzeigeEbeneId(state, o.layerId)));
}

/**
 * Auflösung einer Roh-layerId auf die Panel-/Anzeige-id (02-11, PERM-01): seit 02-09 tragen
 * eigene Privat-Objekte die Instanz-id (`privat-<userId>`) statt der Platzhalter-id — Chip,
 * Sichtbarkeits-Filter und Kontextmenü arbeiten aber mit den Panel-Zeilen-ids, also wird die
 * Instanz-id hier auf die Zeile 'privat' abgebildet. Die so aufgelöste Instanz ist per
 * Projektions-Filter (02-09, projectStateForActor) IMMER die eigene — fremde Privat-Instanzen
 * verlassen den Server gar nicht und kommen hier strukturell nie an. Unbekannte ids werden
 * unverändert zurückgegeben (fail-visible-Konvention aus layers.ts, kein Versteck-Pfad).
 */
export function anzeigeEbeneId(state: DesktopState, layerId: string | undefined): string {
  if (layerId === undefined) return LAYER_FALLBACK;
  if (SYSTEM_EBENEN.some((e) => e.id === layerId)) return layerId;
  const ebene = findeEbene(layerId, state.layers);
  if (!ebene) return layerId;
  return ebene.typ === 'privat' ? 'privat' : ebene.id;
}

/**
 * Feste Zeilenreihenfolge des Sichtbarkeits-Panels (UI-SPEC): die vier Systemebenen in
 * fester Reihenfolge (Kanzlei → privat → KI-Vorschläge → exportierbar), danach
 * benutzerdefinierte Kanzlei-Ebenen alphabetisch. „+ Kanzlei-Ebene…" ist keine Ebene und
 * bleibt Sache der Panel-Komponente (immer letzte Zeile).
 */
export function sortierteEbenenFuerPanel(s: DesktopState): Ebene[] {
  const custom = (s.layers ?? [])
    .filter((e) => e.typ === 'custom')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return [...SYSTEM_EBENEN, ...custom];
}

/** Icon je Ebenentyp (UI-SPEC Icon-Tabelle) — geteilt zwischen Umschalter, Panel, Chip und Kontextmenü. */
export const EBENE_ICON: Record<Ebene['typ'], string> = {
  kanzlei: '👥',
  privat: '🔒',
  'ki-vorschlaege': '🤖',
  exportierbar: '📤',
  custom: '🏷',
};

// ---- Rollengebundenes Ausblenden gefährlicher Aktionen (PERM-04, 02-08 Task 2) ----

/**
 * Ob `rolle` die Aktion `aktion` (endgültiges Löschen/Schreddern, Export, KI/MCP, Upload,
 * Rollen-/Ebenenverwaltung) ausführen darf — steuert AUSSCHLIESSLICH, ob das Bedienelement
 * überhaupt gerendert wird (Decision: ausgeblendet, nicht ausgegraut). Spiegelt `darfAktion()`
 * (@j-desk/core), die auch der Server für die eigentliche 403-Entscheidung nutzt — DIES ist
 * Komfort/Klarheit, nicht die Sicherheitsgrenze (T-02-12); `null` (Rolle unbekannt — seit
 * WR-04 liefert auch der jl-Modus sie mit; `null` bleibt nur für Ausfall-Fälle ohne
 * desk_roles-Zeile) bleibt erlaubt, identisches Bestandsverhalten wie `kannEbenenVerwalten` unten.
 */
export function darfAktionClient(rolle: Rolle | null, aktion: GefahrlicheAktion): boolean {
  return rolle === null || darfAktion(rolle, aktion);
}

export const desktop = {
  get state(): DesktopState {
    return state;
  },
  get status() {
    return status;
  },
  get syncFehler(): string | null {
    return syncFehler;
  },
  get api(): ApiClient | null {
    return api;
  },
  get deskId(): string | null {
    return deskId;
  },
  get desks(): DeskInfo[] {
    return desks;
  },
  /** 'jlawyer': Akten statt eigener Schreibtische; Verwaltung liegt in j-lawyer. */
  get mode() {
    return mode;
  },
  /** PERM-02: eigene Rolle am aktuellen Desk (`null` = unbekannt, s. o.). */
  get myRolle(): Rolle | null {
    return myRolle;
  },
  /** D-03 (SAFE-02): Anzahl noch nicht bestätigter Commands des aktuellen Schreibtischs — s. o. */
  get pendingCount(): number {
    return pendingCount;
  },
  /** SEARCH-03 (07-08): true, wenn die Datei mindestens eine Seite unter der OCR-Konfidenz-
   *  Schwelle trägt — Grundlage für den „OCR unsicher"-Chip an der Karte (DocCard.svelte). */
  ocrUnsicher(fileId: string): boolean {
    return ocrUnsicherFileIds.has(fileId);
  },
  /** 02-08 (PERM-03/PERM-04): derselbe Zustand wie `myRolle` (02-07) — dieser Plan spricht von
   *  „currentRolle" (Teilen-Dialog/Ausblenden gefährlicher Aktionen); bewusst nur ein zweiter
   *  Zugriffsname statt eines zweiten States, um keine zwei Wahrheiten zu haben. */
  get currentRolle(): Rolle | null {
    return myRolle;
  },
  /** Rendering-Gate für rollengebundene Aktionen (Ebenen-/Rollenverwaltung, T-02-06): der
   *  Server prüft ohnehin bei jedem Command erneut (02-04) — dies steuert nur, ob die
   *  Bedienelemente überhaupt erscheinen. Unbekannte Rolle (`null`) bleibt erlaubt. */
  get kannEbenenVerwalten(): boolean {
    return myRolle === null || myRolle === 'Eigentümer' || myRolle === 'Bearbeiter';
  },

  /** Aktive Zeichen-Ebene neuer Objekte (PERM-01) — Default 'kanzlei'. */
  get currentLayerId(): string {
    return currentLayerId;
  },

  /** Nutzer wählt im Ebenen-Umschalter eine Ebene für das aktuell aktive Werkzeug. */
  setActiveLayer(layerId: string): void {
    currentLayerId = layerId;
    speichereEbeneFuerWerkzeug(currentWerkzeug, layerId);
  },

  /** Werkzeugwechsel: die zuletzt für DIESES Werkzeug gewählte Ebene wird wieder aktiv
   *  (kein Reset beim Werkzeugwechsel, Decision aus 02-UI-SPEC). */
  wechsleWerkzeug(werkzeug: string): void {
    currentWerkzeug = werkzeug;
    currentLayerId = ladeEbeneFuerWerkzeug(werkzeug);
  },

  /** Sichtbarkeits-Panel: aktuell sichtbare Ebenen-ids (rein clientseitiger Anzeigefilter). */
  get visibleLayers(): Set<string> {
    const sichtbar = new Set<string>();
    for (const id of bekannteEbenenIds()) if (!ausgeblendeteEbenen.has(id)) sichtbar.add(id);
    return sichtbar;
  },

  /** Ebene im Sichtbarkeits-Panel ein-/ausblenden (optimistisch, kein Server-Roundtrip). */
  toggleLayerVisibility(layerId: string): void {
    const next = new Set(ausgeblendeteEbenen);
    if (next.has(layerId)) next.delete(layerId);
    else next.add(layerId);
    ausgeblendeteEbenen = next;
  },

  /** Nach erfolgreichem Login: Schreibtische (bzw. Akten) laden, letzten (oder ersten) öffnen.
   *
   * CR-03 (SAFE-01): Ist beim Aufruf bereits ein gecachter Schreibtisch sichtbar
   * (`hydrateFromCache()` hat `deskId` gesetzt, bevor `start()` läuft — das Cache-First-Boot),
   * darf ein Netzwerkfehler auf DIESEM ersten Roundtrip (egal ob bei `client.status()`,
   * `listDesks()`/`getCases()` oder `loadDesk()`) NICHT unbehandelt aus `start()` fallen: es
   * gäbe dann nie einen Reconnect-Timer, `status` bliebe für immer 'connecting', und
   * `Desktop.svelte` würde die volle Fläche dauerhaft mit dem "Verbinde…"-Blocker abdecken. Statt
   * dessen tritt `start()` in genau denselben Reconnect-Kreislauf ein wie jeder spätere
   * WebSocket-Abbruch (`onDisconnected()` plant Refresh + Drain + Neuverbindung).
   *
   * Das gilt ausdrücklich NUR für echte Netzfehler. WR-08: `!(e instanceof ApiError)` allein war
   * zu weit gefasst — das fing nicht nur einen Netzfehler ab, sondern JEDEN anderen geworfenen
   * Wert, einschliesslich des zwei Zeilen darüber geworfenen `Error('Keine Akten in j-lawyer
   * sichtbar')` (ein legitimer Fachfehler, keiner, der sich durch Warten löst) und jedes
   * unerwarteten Programmierfehlers (z. B. ein `TypeError` aus einer kaputten
   * Antwort-Destrukturierung) — beides würde so, statt sichtbar zu werden, für immer lautlos im
   * Reconnect-Kreislauf verschwinden. Ein echter `fetch()`-Netzfehler (Server nicht erreichbar)
   * wird von Browsern als `TypeError` geworfen (s. `api.test.ts`: `new TypeError('Failed to
   * fetch')`); die Prüfung ist daher auf `e instanceof TypeError` verengt — deutlich näher am
   * tatsächlichen Netzfehler-Fall als "alles, was kein ApiError ist", auch wenn sie (wie im
   * Fix-Vorschlag vermerkt) einen aus einem echten Bug geworfenen TypeError nicht von einem
   * Netzfehler unterscheiden kann. Ein `ApiError` (allen voran 401: Token abgelaufen/ungültig) IST
   * eine Serverantwort und muss unverändert an den Aufrufer durchgereicht werden — `+page.svelte`s
   * `onMount()`-Handler erkennt 401 dort und räumt die Sitzung ab (`clearSession()`); ein
   * stillschweigendes Verschlucken würde die App mit einem dauerhaft ungültigen Token in eine
   * endlose Reconnect-Schleife schicken, statt zum Login zurückzukehren. Ist noch KEIN Cache
   * sichtbar (kein `deskId`), bleibt das bisherige Verhalten ohnehin erhalten: jeder Fehler geht
   * unverändert an den Aufrufer (der Login-Screen entscheidet).
   */
  async start(client: ApiClient, lastDeskId?: string): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    api = client;
    stopped = false;
    status = 'connecting';
    syncFehler = null;
    try {
      mode = (await client.status()).mode === 'jlawyer' ? 'jlawyer' : 'standalone';
      if (mode === 'jlawyer') {
        const cases = await client.getCases();
        desks = cases.map((c) => ({
          id: c.id,
          name: [c.fileNumber, c.name, c.reason && `(${c.reason})`].filter(Boolean).join(' '),
          ownerId: '',
        }));
        if (desks.length === 0) throw new Error('Keine Akten in j-lawyer sichtbar');
      } else {
        desks = await client.listDesks();
        if (desks.length === 0) desks = [await client.createDesk('Schreibtisch 1')];
      }
      const target = desks.find((d) => d.id === lastDeskId) ?? desks[0];
      await loadDesk(target.id);
    } catch (e) {
      if (deskId && e instanceof TypeError) {
        // Ein gecachter Schreibtisch ist bereits sichtbar UND der Fehler ist (soweit
        // unterscheidbar, s. Kommentar oben, WR-08) ein echter Netzfehler — statt endlos auf
        // 'connecting' hängenzubleiben, in den normalen Reconnect-Kreislauf eintreten (CR-03).
        onDisconnected();
        return;
      }
      throw e; // ApiError, Fachfehler, Bug, oder kein Cache vorhanden: Aufrufer entscheidet wie bisher.
    }
  },

  /** Nur lokal anwenden (Drag-Zwischenschritte) — der Server erfährt nichts. */
  applyLocal(fn: (s: DesktopState) => DesktopState): void {
    state = fn(state);
  },

  /** Server-Antwort mit rev+state übernehmen (z. B. nach Akten-Upload). */
  acceptServerState(result: { rev: number; state: DesktopState }): void {
    if (result.rev >= rev) {
      rev = result.rev;
      state = result.state;
      if (deskId) writeSnapshotDebounced(deskId, rev, state);
    }
  },

  /**
   * Cache-First-Boot (SAFE-01, D-04): rendert einen aus IndexedDB gelesenen Stand SOFORT,
   * bevor die Server-Antwort da ist. Wirkt nur, solange noch kein Desk geladen ist
   * (`deskId === null`) — ein bereits laufender Sync darf nicht zurückgedreht werden.
   * `status` bleibt bewusst 'connecting', NICHT 'online': es besteht keine Verbindung.
   */
  hydrateFromCache(cachedDeskId: string, cachedRev: number, cachedState: DesktopState): void {
    if (deskId !== null) return;
    deskId = cachedDeskId;
    rev = cachedRev;
    state = cachedState;
    status = 'connecting';
  },

  /**
   * Optimistisch lokal anwenden, dann ans Backend; die Server-Antwort ist maßgeblich.
   *
   * Rückgabewert (13-08, UX-02): `{ ok, error? }` — rein additiv, ALLE Bestandsaufrufer
   * ignorieren den Rückgabewert unverändert (`void desktop.command(...)`/`await
   * desktop.command(...)` ohne Zuweisung, geprüft vor der Einführung). Eingeführt, damit
   * `AufraeumenDialog.svelte` eine Folge von Einzelkommandos fail-honest auswerten kann (P7 —
   * der Kommandopfad selbst bleibt unverändert, dies macht sein ohnehin vorhandenes
   * Erfolg/Fehlschlag-Wissen nur nach außen sichtbar). `optionen.silent` unterdrückt die
   * MODULEIGENEN Toasts dieser Funktion (Offline-Hinweis, 403, generischer Fehler) — der
   * Aufrufer zeigt dann selbst GENAU EINEN zusammenfassenden Toast statt eines Toasts pro
   * Einzelkommando (Toast-Lärm-Vermeidung bei einer mehrzeiligen Ausführung); alle übrigen
   * Bestandsaufrufer lassen `optionen` weg und erhalten unverändert ihre bisherigen
   * Einzel-Toasts.
   */
  async command(
    type: string,
    payload: Command['payload'],
    optionen?: { silent?: boolean },
  ): Promise<{ ok: boolean; error?: string }> {
    const toast = (nachricht: string): void => {
      if (!optionen?.silent) showToast(nachricht);
    };
    // SAFE-02 (D-01/D-02): bei fehlender Verbindung wird das Command NICHT mehr stillschweigend
    // fallen gelassen — es wirkt optimistisch wie im Online-Pfad und landet in der IndexedDB-
    // Warteschlange, damit es nach der Wiederverbindung nachgespielt werden kann (drainQueue()).
    // Ohne geladenen Desk (deskId === null) bleibt es beim bisherigen Verhalten.
    if (status !== 'online') {
      if (!deskId) {
        const meldung = offlineMeldung();
        toast(meldung);
        return { ok: false, error: meldung };
      }
      const erwartet = erwartungAus(state, payload);
      const cmd: Command & { erwartet?: Erwartet } = { type, payload, ...(erwartet ? { erwartet } : {}) };
      const vorher = state;
      try {
        state = applyCommand(state, cmd);
      } catch {
        // Server validiert maßgeblich
      }
      try {
        await enqueueCommand(deskId, cmd);
        pendingCount++;
      } catch (e) {
        if (!(e instanceof QueueVollError)) throw e;
        // D-16: kein vorhandener Eintrag wird verdrängt — stattdessen wird das NEUE Command
        // sichtbar abgelehnt und die optimistische Anwendung zurückgenommen.
        state = vorher;
        const meldung = 'Zu viele nicht übertragene Änderungen — bitte erst die Verbindung wiederherstellen.';
        toast(meldung);
        return { ok: false, error: meldung };
      }
      toast(offlineMeldung());
      // Erfolgreich in die Offline-Warteschlange aufgenommen — wird nach Wiederverbindung
      // nachgespielt (drainQueue()). Aus Sicht des Aufrufers (AufraeumenDialog) ist das kein
      // Fehlschlag DIESER Zeile, anders als der defensive Nachreih-Fallback im Online-Zweig
      // unten (dort war der Server bereits erreichbar UND hat einen Fehler gemeldet).
      return { ok: true };
    }
    if (!api || !deskId) return { ok: false, error: 'Keine Verbindung zum Schreibtisch.' };

    // Erwartung VOR der optimistischen Anwendung ableiten: danach trägt der lokale
    // Zustand bereits unsere eigene Änderung, und wir erwarteten gegen uns selbst.
    const erwartet = erwartungAus(state, payload);
    const cmd: Command & { erwartet?: Erwartet } = { type, payload, ...(erwartet ? { erwartet } : {}) };

    const vorher = state;
    try {
      state = applyCommand(state, cmd);
    } catch {
      // Server validiert maßgeblich
    }
    let ergebnis: { ok: boolean; error?: string } = { ok: true };
    try {
      const result = await api.sendCommand(deskId, cmd);
      if (result.rev >= rev) {
        rev = result.rev;
        state = result.state;
        if (deskId) writeSnapshotDebounced(deskId, rev, state);
      }
    } catch (e) {
      if (e instanceof KonfliktAntwort) {
        state = vorher; // Optimistische Anwendung zurücknehmen, kein Voll-Reload nötig.
        await this.behandleKonflikt(cmd, e.konflikt);
        // Konservativ als Fehlschlag berichtet: behandleKonflikt() versucht bei ortsgebundenen
        // Commands (WIEDERHOLEN, konflikt.ts) bis zu zwei stille Wiederholungen, die durchaus
        // erfolgreich sein können — dieser Rückgabewert bildet den (rareren) Fall NICHT ab, um
        // keine zweite, kaskadierende Rückgabepfad-Verzweigung einzuführen. Ein „Konflikt"
        // wird darum nie fälschlich als Erfolg gemeldet (fail-honest bevorzugt zu vorsichtig
        // gegenüber zu großzügig).
        return { ok: false, error: 'Zwischenzeitlich geändert (Konflikt).' };
      }
      await this.refresh().catch(() => {});
      // 02-08 (PERM-04, T-02-12): 403 ist der Race-Condition-Fallback (Rolle wurde serverseitig
      // geändert, während die UI die Aktion noch anbot) — die primäre Verteidigung bleibt das
      // Ausblenden (darfAktionClient); alle übrigen Fehler laufen wie bisher über die generische
      // Meldung.
      // WR-05: für 403 aus dem Command-Pfad gilt die SERVER-Meldung (body.error) — sie ist
      // immer deutsch und präzise (Ebenen- „privaten Ebene einer anderen Person", Kommentator-
      // und Rollen-Fälle, app.ts). Die frühere clientseitige Typ-zu-Text-Zuordnung
      // (fallFuerCommand) bildete CR-04-Ebenen-Ablehnungen fälschlich auf den Rollen-Fall ab
      // („Ihre Rolle erlaubt das nicht") — fachlich falsch, die Rolle IST ausreichend.
      if (e instanceof ApiError && e.status === 403) {
        toast(e.message);
        ergebnis = { ok: false, error: e.message };
      } else {
        // SAFE-02 (D-01): die Antwort ging evtl. unterwegs verloren, das Command könnte den
        // Server dennoch erreicht haben — statt es fallenzulassen, in die Warteschlange
        // einreihen; istBereitsAngewendet() sichert das Nachspielen gegen Dubletten ab. Trotz
        // des defensiven Nachreihens gilt diese Zeile aus Aufrufer-Sicht als fehlgeschlagen
        // (der Server hat soeben einen Fehler gemeldet — anders als der reine Offline-Zweig
        // oben, wo gar keine Anfrage gestellt wurde).
        try {
          if (deskId) {
            await enqueueCommand(deskId, cmd);
            pendingCount++;
          }
        } catch (qe) {
          if (!(qe instanceof QueueVollError)) throw qe;
          // D-16: kein vorhandener Eintrag wird verdrängt — die optimistische Anwendung
          // dieses NEUEN Commands wird zurückgenommen und sichtbar abgelehnt.
          state = vorher;
          const meldung = 'Zu viele nicht übertragene Änderungen — bitte erst die Verbindung wiederherstellen.';
          toast(meldung);
          return { ok: false, error: meldung };
        }
        const meldung = e instanceof Error ? e.message : 'Aktion fehlgeschlagen';
        toast(meldung);
        ergebnis = { ok: false, error: meldung };
      }
    }
    return ergebnis;
  },

  /**
   * Ortsgebundene Konflikte still auf dem neuen Stand neu aufsetzen; alles andere
   * der Nutzerin vorlegen. Höchstens zwei stille Versuche — danach ist etwas anderes
   * los als gleichzeitiges Verschieben, und Weiterprobieren verschleiert es nur.
   */
  async behandleKonflikt(cmd: Command, konflikt: Konflikt, versuch = 1): Promise<void> {
    if (reaktionFuer(cmd.type) === 'wiederholen' && versuch <= 2) {
      await this.refresh().catch(() => {});
      const erwartet = erwartungAus(state, cmd.payload);
      try {
        const result = await api!.sendCommand(deskId!, { ...cmd, ...(erwartet ? { erwartet } : {}) });
        if (result.rev >= rev) {
          rev = result.rev;
          state = result.state;
          if (deskId) writeSnapshotDebounced(deskId, rev, state);
        }
        return;
      } catch (e) {
        if (e instanceof KonfliktAntwort) return this.behandleKonflikt(cmd, e.konflikt, versuch + 1);
        showToast(e instanceof Error ? e.message : 'Aktion fehlgeschlagen');
        return;
      }
    }
    await this.refresh().catch(() => {});
    ui.konflikt = { cmd, konflikt };  // Das Overlay aus Task 6 übernimmt.
  },

  /**
   * Sprung zur Fundstelle: zurück zur Originalstelle im Dokument. Ausschnitte (fileId-Anker)
   * holen die Quelle bei Bedarf neu auf den Tisch; dokumentgebundene Objekte (docId-Anker)
   * können das nicht — dort endet der Weg mit einer Erklärung.
   */
  async jumpTo(ziel: Fundstelle): Promise<void> {
    let plan = planeSprung(state, ziel);
    if (plan.art === 'weg') {
      showToast('Quelldokument ist derzeit nicht verfügbar.');
      return;
    }
    if (plan.art === 'anlegen') {
      if (!api || ziel.fileId === undefined) { showToast('Quelldokument ist derzeit nicht verfügbar. Der Ausschnitt bleibt erhalten.'); return; }
      try {
        const meta = await api.fileMeta(ziel.fileId);
        const anker = ziel.ankerPosition ?? { x: 0, y: 0 };
        const position = { x: anker.x + (ziel.rect?.w ?? 0) + 24, y: anker.y };
        await this.command('addDoc', { fileId: meta.id, name: meta.name, position, kind: meta.kind });
      } catch {
        showToast('Quelldokument ist derzeit nicht verfügbar. Der Ausschnitt bleibt erhalten.');
        return;
      }
      // addDoc wirkt optimistisch sofort — die Karte danach über die fileId wiederfinden.
      plan = planeSprung(state, ziel);
      if (plan.art !== 'springen') {
        // Sicherheitsnetz: command() wirft nie zum Aufrufer (fängt intern, zeigt einen generischen
        // Toast, refresht) — schlägt addDoc nach erfolgreichem fileMeta doch fehl (z. B. Lösch-Race
        // zwischen Meta-Abruf und Command), bliebe die Ablehnung sonst ohne erklärenden Toast.
        showToast('Quelldokument ist derzeit nicht verfügbar. Der Ausschnitt bleibt erhalten.');
        return;
      }
    }
    if (plan.art === 'papierkorb') {
      // Praktisch unerreichbar direkt nach addDoc (die Quelle kann nicht binnen desselben
      // Funktionsaufrufs in den Papierkorb wandern) — greift nur beim ursprünglichen planeSprung oben.
      showToast('Quelldokument liegt im Papierkorb.');
      return;
    }
    if (plan.art === 'stapel') {
      // Karte liegt in einem Stapel und wird nicht frei gerendert — expandDoc/Zentrieren liefen
      // ins Leere. Kein Konvolut-Aufschlag-Sprung in dieser Runde (Backlog): stattdessen erklären,
      // wo die Quelle liegt, der Nutzer zieht die Karte selbst heraus.
      showToast(`Quelldokument liegt im Stapel „${plan.stackName}".`);
      return;
    }
    const { doc, brauchtExpand, brauchtPage } = plan;
    if (brauchtExpand) void this.command('expandDoc', { id: doc.id });
    if (brauchtPage) void this.command('setDocPage', { id: doc.id, page: ziel.page });
    // Nach den (synchron optimistisch wirkenden) Commands liegt die aktuelle Box bereits vor.
    const aktuell = state.docs.find((d) => d.id === doc.id) ?? doc;
    ui.jumpRequest = { box: docBox(aktuell) };
    ui.docJumpTarget = doc.id;
    if (ziel.rect) {
      setSourceHighlight({ docId: doc.id, page: ziel.page, rect: ziel.rect, until: Date.now() + 2500 });
    } else if (ziel.ganzeSeite) {
      // Das Rechteck kann hier nicht gebildet werden — die Basis-Seitengröße ist nur in der
      // Viewer-Ebene bekannt (SourceHighlight.svelte bekommt sie als `base`-Prop) und bildet
      // daraus selbst das volle Seitenrechteck.
      setSourceHighlight({ docId: doc.id, page: ziel.page, ganzeSeite: true, until: Date.now() + 2500 });
    }
  },

  /** Kompletten Zustand vom Server holen (nach Reconnect oder Fehler); im
      j-lawyer-Modus läuft dabei zugleich der Akten-Abgleich. */
  async refresh(): Promise<void> {
    if (stopped) return;
    if (!api || !deskId) return;
    try {
      const result = mode === 'jlawyer' ? await api.getCaseDesk(deskId) : await api.getState(deskId);
      if (mode === 'jlawyer') syncFehler = result.syncFehler ?? null;
      myRolle = result.rolle ?? null;
      if (result.rev >= rev) {
        rev = result.rev;
        state = result.state;
        if (deskId) writeSnapshotDebounced(deskId, rev, state);
      }
      // SEARCH-03: Nachladen der OCR-Statusabfrage nach jedem erfolgreichen Zustandsabruf —
      // s. ladeOcrStatus() für die Begründung (kein eigener Wiederholungstimer, wirft nie).
      await ladeOcrStatus();
      // 12-06 (AI-01, E1/error): der Bestands-Sync synchronisiert auch den Freigaben-Zähler —
      // nach einer Wiederverbindung ist der Zählerstand ohne eigenen Kanal wieder korrekt.
      await ladeVorschlaege(api, deskId);
    } catch (e) {
      // WR-03: 403 = die Mitgliedschaft wurde serverseitig entzogen — die gecachte Rolle
      // darf nicht weiter rollengebundene Aktionen anbieten (darfAktionClient(null, …)
      // ist fail-open „erlaubt", aber ohne Rolle sperrt der Server ohnehin alles).
      if (e instanceof ApiError && e.status === 403) myRolle = null;
      throw e;
    }
  },

  async switchDesk(id: string): Promise<void> {
    if (!api || id === deskId) return;
    if (status !== 'online') {
      showToast(offlineMeldung());
      return;
    }
    status = 'connecting';
    closeWs();
    try {
      await loadDesk(id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
      onDisconnected();
    }
  },

  /**
   * `vorlageId` optional (TMPL-01, 13-07): der VorlagenDialog übergibt sie, um den Desk aus
   * einer Mandatsvorlage anzulegen — der Bestandsweg (DeskSwitcher „Neuer Schreibtisch…") ruft
   * unverändert ohne das Feld auf. Rückgabewert (Erfolg/Misserfolg) ermöglicht dem Aufrufer
   * eigenes Verhalten nach dem Anlegen (VorlagenDialog: Erfolgs-Toast + Dialog schließen bei
   * true; Dialog bleibt bei false offen — der Fehler-Toast mit der präzisen Server-Meldung ist
   * hier bereits gezeigt, E11/error).
   */
  async createDesk(name: string, vorlageId?: string): Promise<boolean> {
    if (!api) return false;
    if (status !== 'online') {
      showToast(offlineMeldung());
      return false;
    }
    try {
      const desk = await api.createDesk(name, vorlageId);
      desks = await api.listDesks();
      await this.switchDesk(desk.id);
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Anlegen fehlgeschlagen');
      return false;
    }
  },

  async renameDesk(id: string, name: string): Promise<void> {
    if (!api) return;
    if (status !== 'online') {
      showToast(offlineMeldung());
      return;
    }
    try {
      await api.renameDesk(id, name);
      desks = await api.listDesks();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Umbenennen fehlgeschlagen');
    }
  },

  async deleteDesk(id: string): Promise<void> {
    if (!api) return;
    if (status !== 'online') {
      showToast(offlineMeldung());
      return;
    }
    try {
      await api.deleteDesk(id);
      desks = await api.listDesks();
      if (id === deskId) {
        if (desks.length === 0) desks = [await api.createDesk('Schreibtisch 1')];
        status = 'connecting';
        closeWs();
        try {
          await loadDesk(desks[0].id);
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Wechsel fehlgeschlagen');
          onDisconnected();
        }
      }
    } catch (e) {
      // 02-10 (PERM-04): ein 403 des Delete-Guards (Rolle zwischen Rendern und Klick
      // entzogen) zeigt den Lösch-Wortlaut aus dem Copywriting-Contract statt des
      // generischen Guard-Textes — Spiegelstelle zu toast403FallFuerDeskAktion('loeschen')
      // in deskAktionen.ts (Literal statt Import: store ↔ deskAktionen wäre zirkulär).
      if (e instanceof ApiError && e.status === 403) toast403('loeschen', myRolle);
      else showToast(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
    }
  },

  async stop(): Promise<void> {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    stopped = true;
    status = 'loggedOut';
    syncFehler = null;
    pendingCount = 0;
    ws?.close();
    ws = null;
    // T-05-01/D-18: der gecachte Schreibtisch-Zustand (Mandantentext, eigene Privat-Ebene)
    // darf eine Abmeldung nicht überleben — auf einem geteilten Kanzleirechner darf die
    // nächste Person ihn nicht im Browser-Speicher vorfinden. Leeres catch: dieselbe
    // Konvention wie bei localStorage in ladeEbeneFuerWerkzeug — ein blockierter
    // IndexedDB-Zugriff darf das Abmelden nicht verhindern.
    try { await clearAllSnapshots(); } catch { /* s. o. */ }
    // Ein offenes Konflikt-Overlay hält Mandantentext (cmd.payload) und den Namen der
    // Kolleg:in — das darf nicht bis zur nächsten Anmeldung in diesem Browser stehen bleiben.
    // stop() ist der Logout-Weg des Stores (aktuell nur von abmelden() gerufen, aber auch ein
    // künftiger Sitzungsablauf träfe hier auf den Reset, ohne dass abmelden() dafür sorgen müsste).
    ui.konflikt = null;
    // Dasselbe Zustand-Leck-Muster wie oben (und wie clearHistorieCache): das Herkunfts-Popover
    // und ein offenes Kontextmenü referenzieren Objekt-IDs bzw. Aktionen der gerade beendeten
    // Sitzung und dürfen der nächsten Person an diesem Gerät nicht ungefragt angezeigt werden
    // (WR-02, gefunden von gsd-code-reviewer).
    ui.provenancePopover = null;
    ui.menu = null;
    // 02-07: Rolle und Sichtbarkeits-Panel-Zustand gehören zur beendeten Sitzung — dasselbe
    // Leck-Muster wie oben (WR-02), die nächste Anmeldung an diesem Gerät startet neutral.
    myRolle = null;
    resetVisibleLayers();
    // 02-08: der Teilen-Dialog zeigt die Mitgliederliste EINES Desks — offen über den Logout
    // hinweg stehen zu lassen, wäre dasselbe Leck-Muster (WR-02).
    ui.teilenOffen = false;
    // 06-02 (K7/WR-02-Muster): Präsenz der beendeten Sitzung darf nicht bis zur nächsten
    // Anmeldung an diesem Gerät stehen bleiben.
    setzePraesenzZurueck();
    // 06-03 (WR-02-Muster): dieselbe Begründung wie ui.teilenOffen oben — die aufgeklappte
    // Präsenz-Rosette der beendeten Sitzung darf nicht stehen bleiben.
    ui.praesenzOffen = false;
    // 11-01 Task 3 (WR-02-Muster): auf einem geteilten Kanzleigerät darf weder ein Sitzungsmodus-
    // Zustand noch eine Ansichten-Hervorhebung der beendeten Sitzung stehen bleiben.
    setzeSitzungsUiZurueck();
    // 12-06 (AI-01, WR-02-Muster, T-12-06-03): die wartenden KI-Freigaben (Zusammenfassungen,
    // Zitate, Akteurnamen) und ein offener VorschlaegeDialog gehören zur beendeten Sitzung —
    // auf einem geteilten Kanzleigerät darf die nächste Person sie nicht vorfinden.
    setzeFreigabenZurueck();
    ui.vorschlaegeOffen = false;
    // 13-01 (NOTIF-01, WR-02-Muster): die Inbox (Nutzernamen, Notiztitel — Mandatsinhalt)
    // gehört ebenfalls zur beendeten Sitzung; das Panel-Flag läuft über das Bündel
    // setzeSitzungsUiZurueck() oben mit.
    setzeBenachrichtigungenZurueck();
  },
};

/** Lädt Zustand + rev des Schreibtischs (bzw. der Akte) und verbindet den WebSocket. */
async function loadDesk(id: string): Promise<void> {
  if (!api) return;
  // Ein an Desk A offen gebliebenes Konflikt-Overlay darf nicht auf den neuen Desk mitwandern
  // (Zettel-Text von Desk A würde sonst über einen Klick auf Desk B landen, deskId zeigt ja
  // schon um) — dasselbe Muster wie clearHistorieCache beim Abmelden.
  ui.konflikt = null;
  // Ebenso das Herkunfts-Popover (WR-02): dessen id gehört zum alten Desk-Zustand — ohne Reset
  // fände die anzeige-Ableitung dort zufällig ein gleich benanntes Objekt im neuen Desk.
  ui.provenancePopover = null;
  // 02-07: das Sichtbarkeits-Panel darf ebenfalls nicht den Zustand des vorherigen Desks
  // weiterzeigen (backstop — UI-SPEC „loading"-Zustand direkt nach Desk-Wechsel).
  resetVisibleLayers();
  // 02-08: die Mitgliederliste des Teilen-Dialogs gehört zum vorherigen Desk (WR-02-Muster).
  ui.teilenOffen = false;
  // 06-02 (K7/WR-02-Muster): Präsenz gehört zum vorherigen Desk-Room (der Server registriert
  // erst nach dem neuen WS-Connect neu) — ohne Reset zeigte die Rosette kurzzeitig die Personen
  // des alten Desks.
  setzePraesenzZurueck();
  // 06-03 (WR-02-Muster): die aufgeklappte Präsenz-Rosette gehört zum vorherigen Desk und darf
  // nicht offen stehen bleiben — dieselbe Begründung wie ui.teilenOffen oben.
  ui.praesenzOffen = false;
  // 11-01 Task 3 (WR-02-Muster): Sitzungsmodus und Ansichten-Hervorhebung gehören zum vorherigen
  // Desk — dieselbe Begründung wie ui.teilenOffen oben, ein Schreibtischwechsel darf sie nicht
  // mitnehmen.
  setzeSitzungsUiZurueck();
  // 12-06 (AI-01, WR-02-Muster, T-12-06-03): der Vorschlagszustand (Warteliste, Dialog-Flag)
  // gehört zum vorherigen Desk — ohne Reset zeigte der Zähler kurzzeitig die Freigaben des
  // alten Desks; die neue Liste kommt unten projiziert per GET nach.
  setzeFreigabenZurueck();
  ui.vorschlaegeOffen = false;
  // 13-01 (NOTIF-01, WR-02-Muster): die Inbox des vorherigen Desks/der vorherigen Sitzung
  // darf nicht stehen bleiben — dieselbe Begründung wie setzeFreigabenZurueck() oben; die
  // eigene Liste kommt unten per user-scoped GET nach. Das Panel-Flag läuft über das
  // Bündel setzeSitzungsUiZurueck() oben mit.
  setzeBenachrichtigungenZurueck();
  deskId = id;
  const result = mode === 'jlawyer' ? await api.getCaseDesk(id) : await api.getState(id);
  if (mode === 'jlawyer') syncFehler = result.syncFehler ?? null;
  myRolle = result.rolle ?? null;
  rev = result.rev; // Zähler gehört zum neuen Schreibtisch — nicht vergleichen
  state = result.state;
  saveLastDeskId(id);
  void writeSnapshot(id, rev, state);
  // D-03: ein nach Neustart geerbter Wartestand (SAFE-02) wird sofort korrekt angezeigt —
  // ohne diese Zeile bliebe pendingCount auf 0 stehen, bis der nächste Reconnect drained.
  pendingCount = await queueLength(id).catch(() => 0);
  // SEARCH-03: Nachladen der OCR-Statusabfrage nach dem ersten Laden eines Schreibtischs —
  // s. ladeOcrStatus() für die Begründung (kein eigener Wiederholungstimer, wirft nie).
  await ladeOcrStatus();
  // 12-06 (AI-01, E1/loading): die projizierte Vorschlagsliste wird MIT dem Desk geladen
  // (pendingCount-Präzedenz) — der Freigaben-Zähler hat keinen eigenen Ladepfad/Spinner,
  // danach pflegt ihn ausschließlich das WS-Signal über REST-Nachladen. Wirft nie.
  await ladeVorschlaege(api, id);
  // 13-01 (NOTIF-01, E10/loading): die eigene Inbox wird ebenfalls MIT dem Desk geladen
  // (pendingCount-Präzedenz wie oben) — der Ungelesen-Badge am 🔔-Button hat keinen
  // eigenen Ladepfad/Spinner, danach pflegt ihn ausschließlich das inhaltsfreie
  // WS-Signal über user-scoped REST-Nachladen. Wirft nie.
  await ladeBenachrichtigungen(api);
  connectWs();
}

/** Trennt den aktuellen Socket und invalidiert dessen Listener (Generationswechsel). */
function closeWs(): void {
  wsGeneration++;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const socket = ws;
  ws = null;
  socket?.close();
}

function connectWs(): void {
  if (!api || !deskId || stopped) return;
  const generation = ++wsGeneration;
  void (async () => {
    let ticket: string;
    try {
      ticket = (await api!.wsTicket()).ticket;
    } catch {
      if (generation === wsGeneration) onDisconnected();
      return;
    }
    if (generation !== wsGeneration || stopped || !api || !deskId) return;
    openSocket(generation, api.wsUrl(deskId, ticket));
  })();
}

function openSocket(generation: number, url: string): void {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    onDisconnected();
    return;
  }
  socket.onopen = () => {
    if (generation !== wsGeneration) {
      // Während des Verbindens wurde gewechselt/geschlossen — diesen Socket verwerfen.
      socket.close();
      return;
    }
    ws = socket;
    reconnectDelay = 1000;
    status = 'online';
    // 06-02: der Sendekanal für Präsenz-/Bearbeitungssignale wird injiziert (presence.svelte.ts
    // kennt den WebSocket bewusst nicht selbst) — schreibt nur, solange der Socket offen ist,
    // gekapselt in try/catch nach dem Vorbild der übrigen Sendepfade dieser Datei.
    setzeSender((nachricht) => {
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(nachricht));
      } catch { /* toter Socket — wird über sein close-Ereignis abgeräumt */ }
    });
  };
  socket.onmessage = (ev) => {
    if (generation !== wsGeneration) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data as string);
    } catch {
      return; // fehlerhafte Nachricht verwerfen — der nächste Broadcast bringt den vollen Zustand
    }
    // 06-02/T-06-08: Nachrichten mit einem `typ`-Feld (Präsenz-Rückkanal aus 06-01) laufen in
    // einem eigenen Zweig VOR dem bestehenden rev/state-Wächter und brechen in JEDEM Fall mit
    // return ab — unabhängig vom Rückgabewert von uebernimmPraesenz(). Eine Nachricht mit `typ`,
    // die keine gültige Präsenzmeldung ist, darf so nicht in den rev/state-Pfad durchfallen.
    if (parsed !== null && typeof parsed === 'object' && 'typ' in parsed) {
      uebernimmPraesenz(parsed);
      return;
    }
    // 12-06 (AI-01, Pitfall 3): das inhaltsfreie Vorschlags-Signal ist ein reiner Trigger —
    // es trägt keinen Zähler und keine Inhalte (Andeutungs-Verbot, VORSCHLAG_SIGNAL aus 12-03).
    // Darum wird hier NUR das projizierte REST-Nachladen ausgelöst; Felder aus der Nachricht
    // werden nie gelesen. Das Signal trägt bewusst kein rev/state und darf nicht in den
    // rev/state-Pfad darunter durchfallen (dort würde es verworfen).
    if (parsed !== null && typeof parsed === 'object' && (parsed as { event?: unknown }).event === 'vorschlaegeGeaendert') {
      if (api && deskId) void signalEmpfangen(api, deskId);
      return;
    }
    // 13-01 (NOTIF-01, Pitfall P2): das inhaltsfreie Benachrichtigungs-Signal ist — wie das
    // Vorschlags-Signal oben — ein reiner Trigger ohne Zähler/Inhalte (Andeutungs-Verbot,
    // BENACHRICHTIGUNG_SIGNAL). Es wird NUR das user-scoped REST-Nachladen ausgelöst; Felder
    // aus der Nachricht werden nie gelesen. Das Signal trägt bewusst kein rev/state und darf
    // nicht in den rev/state-Pfad darunter durchfallen (dort würde es verworfen).
    if (parsed !== null && typeof parsed === 'object' && (parsed as { event?: unknown }).event === 'benachrichtigungenGeaendert') {
      if (api) void benachrichtigungSignalEmpfangen(api);
      return;
    }
    const data = parsed as { rev: number; state: DesktopState; event?: string };
    if (typeof data?.rev !== 'number' || !data.state) return;
    if (data.rev >= rev) {
      rev = data.rev;
      state = data.state;
      if (deskId) writeSnapshotDebounced(deskId, rev, state);
      // D-08: der Toast darf NIE einen Stand behaupten, der noch nicht übernommen ist — deshalb
      // erst NACH der rev/state-Übernahme oben. Ein normaler Command-Broadcast trägt kein
      // 'event'-Feld und löst deshalb keinen Toast aus.
      if (data.event === 'restored') {
        showToast('Schreibtisch wurde auf einen früheren Stand zurückgesetzt');
      }
    }
  };
  socket.onclose = (ev: CloseEvent) => {
    // Der native WebSocket feuert onclose auch nach onerror und nach fehlgeschlagenem
    // Verbindungsaufbau — ein einziger Einstiegspunkt für die Reconnect-Logik.
    if (generation !== wsGeneration) return;
    // 06-02: der Sendekanal gehört zu DIESEM Socket — bei Trennung zurücksetzen, damit
    // bearbeitetJetzt()/ruhtJetzt() keine Nachricht mehr in einen bereits geschlossenen Socket
    // schreiben (die Erneuerung selbst läuft unabhängig weiter, sende?.() wird dann zum No-Op).
    setzeSender(null);
    // WR-03: 4003 ist KEIN Netzausfall — der Server hat den Zugriff entzogen
    // (trenneNutzer nach Rollenentzug, broadcast.ts) oder verweigert (Connect-Guard).
    // Der bisherige Pfad behandelte das wie einen Netzausfall: refresh() → 403 (vom
    // .catch verschluckt) → Reconnect → Ticket läuft (Session ist ja gültig) → Guard
    // schließt erneut mit 4003 → Endlosschleife mit Dauerlast und dem irreführenden
    // Banner „Verbindung getrennt". Stattdessen: kein Reconnect, klarer Endzustand.
    if (ev.code === 4003) {
      void behandleZugriffEntzogen();
      return;
    }
    onDisconnected();
  };
}

/**
 * WR-03: Zugriff entzogen (WS-Close 4003). Einmalig refresh() versuchen — bestätigt der
 * Server den Entzug mit 403, wird klar gemeldet, WAS passiert ist (statt des
 * irreführenden „Verbindung getrennt"-Banners), die Desk-Liste neu geladen (GET /desks
 * filtert rollenbasiert — der Desk verschwindet) und auf einen verbleibenden Desk
 * gewechselt. Gelingt der refresh doch (Rolle nur herabgestuft o. ä.) oder scheitert er
 * aus Netzgründen, läuft der normale Reconnect-Pfad — nur der bestätigte Entzug beendet
 * die Verbindung endgültig (kein Reconnect-Timer, keine Dauerlast).
 */
async function behandleZugriffEntzogen(): Promise<void> {
  ws = null;
  try {
    await desktop.refresh();
    // refresh() GELANG — der Zugriff besteht noch: wie ein normaler Abbruch behandeln.
    onDisconnected();
    return;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 403)) {
      onDisconnected(); // Netzfehler o. ä. — normaler Reconnect-Pfad
      return;
    }
  }
  showToast('Der Zugriff auf diesen Schreibtisch wurde entfernt.');
  status = 'connecting';
  closeWs();
  try {
    if (mode === 'jlawyer') {
      const cases = await api!.getCases();
      desks = cases.map((c) => ({
        id: c.id,
        name: [c.fileNumber, c.name, c.reason && `(${c.reason})`].filter(Boolean).join(' '),
        ownerId: '',
      }));
    } else {
      desks = await api!.listDesks();
    }
    if (mode === 'standalone' && desks.length === 0) {
      // Wie start(): es gibt immer einen eigenen Schreibtisch, auf den zurückgekehrt
      // werden kann — statt eines toten Endzustands ganz ohne Desk.
      desks = [await api!.createDesk('Schreibtisch 1')];
    }
    const naechster = desks.find((d) => d.id !== deskId) ?? desks[0];
    if (naechster) {
      await loadDesk(naechster.id);
      return;
    }
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Desk-Liste konnte nicht neu geladen werden');
  }
  // jl-Modus ohne verbleibende Akte (oder Listen-/Wechselfehler): sauberer Endzustand —
  // leerer Tisch, keine Rolle, kein Reconnect-Timer, kein Banner-Dauerfeuer.
  deskId = null;
  rev = 0;
  state = emptyState();
  myRolle = null;
  status = 'online';
}

/** WR-06: Obergrenze an Sendeversuchen für einen Eintrag, der an einem transienten 5xx scheitert,
 *  über Wiederverbindungen hinweg (der Zähler ist auf dem Eintrag persistiert, s. `retries` in
 *  `offlineQueue.ts`) — danach wird endgültig aufgegeben, damit ein dauerhaft kaputter Server
 *  nicht auf ewig wedgt (dasselbe Grundproblem, das CR-02 für deterministische Fehler löst). */
const MAX_5XX_VERSUCHE = 3;

/**
 * SAFE-02 (D-02): spielt nach der Wiederverbindung alle gequeuten Commands EINES Schreibtischs
 * in Einfügereihenfolge nach — läuft nur, wenn das vorangegangene refresh() erfolgreich war
 * (Aufrufstelle: onDisconnected()), der geprüfte Zustand ist also der frisch geholte und wird
 * nach jedem erfolgreichen Senden mit dem Server-Ergebnis fortgeschrieben.
 *
 * Ein erzeugendes Command, dessen Zielobjekt im (fortgeschriebenen) Zustand bereits existiert,
 * wird übersprungen und entfernt (T-05-05, Dublettenschutz). Eine Serverantwort wird nach ihrer
 * Deterministik unterschieden:
 *  - Konflikt (409, `KonfliktAntwort`) und ein deterministischer Client-/Serverfehler
 *    (`ApiError` mit Status < 500, z. B. 400 CommandError bei veraltetem Payload nach einem
 *    Schema-Wechsel, 403, 404 DeskNotFoundError) fallen bei jedem erneuten Versuch identisch aus
 *    — der Eintrag wird sofort entfernt und gezählt (D-15/T-05-09: KEIN Konflikt-Overlay, das
 *    bleibt dem Live-Konflikt vorbehalten).
 *  - Ein 5xx (`ApiError` mit Status >= 500) ist NICHT deterministisch (transienter Serverfehler,
 *    z. B. eine kurzzeitige SQLite-Sperre oder ein Ausfall während eines Deploys) — WR-06: bis zu
 *    `MAX_5XX_VERSUCHE` Versuche (über mehrere Wiederverbindungen hinweg) bleibt der Eintrag
 *    stehen wie bei einem echten Netzfehler (Abbruch der Schleife, Rest bleibt stehen); erst nach
 *    Erreichen der Obergrenze wird er entfernt und gezählt, damit ein dauerhaft kaputter Server
 *    die Warteschlange nicht auf ewig blockiert.
 *  - Das AUSBLEIBEN einer Antwort (ein echter Netzfehler — weder KonfliktAntwort noch ApiError)
 *    bricht die Schleife ebenfalls ab; die restlichen Einträge bleiben stehen, der nächste
 *    Wiederverbindungsversuch macht weiter.
 * Andernfalls würde ein einzelner, dauerhaft fehlschlagender Eintrag (z. B. ein Command gegen ein
 * inzwischen gelöschtes Objekt) die gesamte FIFO-Warteschlange für dieses Desk auf ewig blockieren
 * (CR-02). Nach dem Durchlauf erscheint bei mindestens einem verworfenen Eintrag genau EINE
 * zusammenfassende Meldung — ein Durchlauf ohne Verwerfen erzeugt keine Meldung. WR-07: die
 * Meldung nennt "der Schreibtisch wurde zwischenzeitlich geändert" nur, wenn AUSSCHLIESSLICH
 * echte 409-Konflikte verworfen wurden — sonst (400/403/404, oder ein 5xx nach Ausschöpfen der
 * Versuche) eine neutrale Formulierung, die keine falsche Ursache suggeriert.
 */
async function drainQueue(): Promise<void> {
  if (!api || !deskId) return;
  const eintraege = await readQueue(deskId);
  let verworfenKonflikt = 0;
  let verworfenSonst = 0;
  for (const entry of eintraege) {
    if (entry.seq === undefined) continue;
    if (istBereitsAngewendet(state, entry.cmd)) {
      await removeFromQueue(entry.seq);
      pendingCount = Math.max(0, pendingCount - 1);
      continue;
    }
    try {
      const result = await api.sendCommand(deskId, entry.cmd);
      if (result.rev >= rev) {
        rev = result.rev;
        state = result.state;
        if (deskId) writeSnapshotDebounced(deskId, rev, state);
      }
      await removeFromQueue(entry.seq);
      pendingCount = Math.max(0, pendingCount - 1);
    } catch (e) {
      if (e instanceof KonfliktAntwort) {
        // 409: echter Konflikt — deterministisch, kein Retry sinnvoll (D-15/T-05-09).
        await removeFromQueue(entry.seq);
        pendingCount = Math.max(0, pendingCount - 1);
        verworfenKonflikt++;
        continue;
      }
      if (e instanceof ApiError) {
        if (e.status >= 500) {
          // WR-06: transienter Serverfehler — bis zur Obergrenze wie ein Netzfehler behandeln
          // (Rest der Warteschlange bleibt stehen, nächster Reconnect versucht diesen Eintrag
          // erneut), statt ihn wie einen deterministischen 400/404 sofort wegzuwerfen.
          const versuche = (entry.retries ?? 0) + 1;
          if (versuche < MAX_5XX_VERSUCHE) {
            await bumpRetry(entry, versuche);
            break;
          }
          // Obergrenze erreicht: endgültig aufgeben, damit ein dauerhaft kaputter Server die
          // Warteschlange nicht auf ewig blockiert (CR-02s Kernproblem bliebe sonst für 5xx offen).
          await removeFromQueue(entry.seq);
          pendingCount = Math.max(0, pendingCount - 1);
          verworfenSonst++;
          continue;
        }
        // 400/403/404 usw.: deterministischer Client-/Serverfehler — bei erneutem Versuch
        // identisch, kein Retry sinnvoll (CR-02).
        await removeFromQueue(entry.seq);
        pendingCount = Math.max(0, pendingCount - 1);
        verworfenSonst++;
        continue;
      }
      break; // echter Netzfehler: Rest bleibt stehen, nächster Reconnect-Versuch macht weiter.
    }
  }
  const verworfenGesamt = verworfenKonflikt + verworfenSonst;
  if (verworfenGesamt > 0) {
    // WR-07: nur wenn AUSSCHLIESSLICH echte Konflikte verworfen wurden, ist "der Schreibtisch
    // wurde zwischenzeitlich geändert" zutreffend — sonst neutrale Formulierung ohne falsche
    // Ursachenangabe.
    const nurKonflikt = verworfenSonst === 0;
    showToast(
      nurKonflikt
        ? verworfenGesamt === 1
          ? '1 Änderung konnte nicht nachgetragen werden — der Schreibtisch wurde zwischenzeitlich geändert.'
          : `${verworfenGesamt} Änderungen konnten nicht nachgetragen werden — der Schreibtisch wurde zwischenzeitlich geändert.`
        : verworfenGesamt === 1
          ? '1 Änderung konnte nicht nachgetragen werden.'
          : `${verworfenGesamt} Änderungen konnten nicht nachgetragen werden.`,
    );
  }
}

function onDisconnected(): void {
  // Doppel-Feuer (Fehler-String + Close) nicht doppelt einplanen; ein
  // bereits laufender Reconnect-Timer bleibt maßgeblich.
  if (stopped || reconnectTimer !== undefined) return;
  status = 'offline';
  ws = null;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void (async () => {
      let refreshedOk = true;
      await desktop.refresh().catch(() => {
        refreshedOk = false;
      });
      // SAFE-02 (D-02): der Drain läuft nur gegen einen frisch bestätigten Serverzustand —
      // scheitert refresh() (weiterhin kein Netz), wird nicht gedraint; connectWs() versucht
      // trotzdem, unverändertes Bestandsverhalten.
      if (refreshedOk) await drainQueue();
      await connectWs();
    })();
  }, delay);
}
