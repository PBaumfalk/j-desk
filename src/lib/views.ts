import { findeObjekt, SYSTEM_EBENEN, type DesktopState, type Viewport } from '@j-desk/core';

/**
 * Ansichten-Logik (VIEW-01, 11-02): reine, DOM-freie Client-Logik für gespeicherte Ansichten
 * (Position/Zoom, sichtbare Ebenen, Suchbegriff, Hervorhebungen, geöffnete Dokumente).
 *
 * Bewusst NICHT im synchronisierten `DesktopState` und bewusst außerhalb von `store.svelte.ts`:
 * eine Ansicht speichert `visibleLayers`, und `projectStateForActor()` (packages/core/src/projection.ts)
 * filtert Objekte ausschließlich nach ihrer EIGENEN `layerId` — sie säubert keine Ebenen-ids, die als
 * Daten INNERHALB eines anderen Objekts (hier: einer Ansicht) stecken. Ein serverseitiges Ausliefern
 * einer Ansicht würde also die Existenz (und über die `privat-<userId>`-Namenskonvention die Identität)
 * privater Ebenen anderer Nutzer verraten. `localStorage` verlässt den Browser des speichernden
 * Nutzers nie und umgeht dieses Leck strukturell (11-RESEARCH.md, Summary Punkt 1; T-11-01).
 *
 * Liegt bewusst außerhalb von `ui.svelte.ts`, damit sie ohne Runen-Kontext getestet werden kann
 * (Muster `anlagenpaketAuswahl.ts`) — Vitest läuft mit `environment: 'node'`, es gibt kein DOM.
 */

export const VIEWS_KEY_PREFIX = 'jdesk.views.';
export const ANSICHT_NAME_MAX = 40;
/** Wortgleich die Bestandsgrenzen aus zoomAt/zoomToFit (packages/core/src/viewport.ts) — eine
 *  wiederhergestellte Ansicht darf den Zoom nie außerhalb dessen setzen, was der Tisch sonst zulässt. */
export const VP_SCALE_MIN = 0.15;
export const VP_SCALE_MAX = 3;

/** Momentaufnahme-Eingang aus der Oberfläche — dieselben Felder wie `Ansicht`, ohne `id`/`name`/`updatedAt`. */
export interface AnsichtZustand {
  vp: Viewport;
  visibleLayers: string[];
  suchText: string;
  highlightedIds: string[];
  openDocIds: string[];
}

export interface Ansicht extends AnsichtZustand {
  id: string;
  name: string;
  updatedAt: string;
}

/** Trim + Unicode-Normalisierung NFC, gekürzt auf ANSICHT_NAME_MAX UTF-16-Codeeinheiten —
 *  exakt die `maxlength`-Grenze des Eingabefelds (VIEW-01/encoding). */
export function normalisiereName(name: string): string {
  return name.trim().normalize('NFC').slice(0, ANSICHT_NAME_MAX);
}

/** Identitätsvergleich zweier Ansichtsnamen: normalisiereName plus toLocaleLowerCase('de') —
 *  dient AUSSCHLIESSLICH dem Vergleich, nie der Anzeige (VIEW-01/encoding). */
export function nameSchluessel(name: string): string {
  return normalisiereName(name).toLocaleLowerCase('de');
}

function istEndlicheZahl(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Prüft alle Pflichtfelder einer Ansicht auf Typ — ungültige Einträge werden beim Lesen
 *  übersprungen statt einen NaN-Viewport zu erzeugen oder abzustürzen (T-11-07, VIEW-01/precision). */
export function istGueltigeAnsicht(v: unknown): v is Ansicht {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<Ansicht>;
  return (
    typeof a.id === 'string' &&
    typeof a.name === 'string' &&
    typeof a.updatedAt === 'string' &&
    typeof a.suchText === 'string' &&
    !!a.vp && typeof a.vp === 'object' &&
    istEndlicheZahl(a.vp.x) && istEndlicheZahl(a.vp.y) && istEndlicheZahl(a.vp.scale) &&
    Array.isArray(a.visibleLayers) &&
    Array.isArray(a.highlightedIds) &&
    Array.isArray(a.openDocIds)
  );
}

/** Liest die gespeicherten Ansichten eines Schreibtischs. Gesperrter/kaputter/fehlender Speicher
 *  ergibt eine leere Liste statt eines Absturzes (Bestandsmuster LAYER_KEY_PREFIX, store.svelte.ts). */
export function leseAnsichten(deskId: string): Ansicht[] {
  try {
    const raw = localStorage.getItem(VIEWS_KEY_PREFIX + deskId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(istGueltigeAnsicht);
  } catch {
    return [];
  }
}

/** Schreibt die Ansichten eines Schreibtischs. Best-Effort — gesperrter Speicher kehrt still
 *  zurück, kein Toast (Bestandsmuster LAYER_KEY_PREFIX). */
export function schreibeAnsichten(deskId: string, ansichten: Ansicht[]): void {
  try {
    localStorage.setItem(VIEWS_KEY_PREFIX + deskId, JSON.stringify(ansichten));
  } catch {
    /* localStorage gesperrt — Best-Effort reicht, s. o. */
  }
}

/** Dreistufige Sortierregel (VIEW-01/ordering): Name über localeCompare('de'), bei Gleichheit
 *  updatedAt absteigend, danach id — deterministisch und stabil bei gleicher Eingabe. */
export function sortiereAnsichten(ansichten: Ansicht[]): Ansicht[] {
  return [...ansichten].sort((a, b) => {
    const nameVergleich = a.name.localeCompare(b.name, 'de');
    if (nameVergleich !== 0) return nameVergleich;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Speichert (legt an/überschreibt) eine Ansicht unter `name`. Liest unmittelbar vor dem Schreiben
 * erneut aus localStorage (Read-Modify-Write, VIEW-01/concurrency) — eine in einem anderen Tab
 * gespeicherte Ansicht geht so nicht verloren. Namensgleichheit (nameSchluessel) ersetzt den
 * bestehenden Eintrag (gleiche id, neues updatedAt) statt eine Dublette anzulegen (VIEW-01/adjacency).
 */
export function ansichtSpeichern(
  deskId: string,
  name: string,
  zustand: AnsichtZustand,
  jetztIso: string,
  neueId: string,
): Ansicht[] {
  const aktuelle = leseAnsichten(deskId);
  const normName = normalisiereName(name);
  const schluessel = nameSchluessel(name);
  const bestehend = aktuelle.find((a) => nameSchluessel(a.name) === schluessel);
  const eintrag: Ansicht = { id: bestehend?.id ?? neueId, name: normName, ...zustand, updatedAt: jetztIso };
  const naechste = bestehend
    ? aktuelle.map((a) => (a.id === bestehend.id ? eintrag : a))
    : [...aktuelle, eintrag];
  const sortiert = sortiereAnsichten(naechste);
  schreibeAnsichten(deskId, sortiert);
  return sortiert;
}

/** Entfernt eine Ansicht per id. Liest/schreibt nach demselben Read-Modify-Write-Muster wie
 *  ansichtSpeichern. Eine unbekannte id lässt die Liste unverändert. */
export function ansichtEntfernen(deskId: string, id: string): Ansicht[] {
  const aktuelle = leseAnsichten(deskId);
  const naechste = aktuelle.filter((a) => a.id !== id);
  schreibeAnsichten(deskId, naechste);
  return naechste;
}

/** Ergebnis von planeAnsichtAnwendung — was Plan 11-08 tatsächlich auf den Tisch anwendet. */
export interface AnsichtPlan {
  vp: Viewport;
  visibleLayers: string[];
  suchText: string;
  highlightedIds: Set<string>;
  zuOeffnendeDocIds: string[];
  fehlendeDocs: number;
}

/** Nicht endliche Werte ergeben 1 (kein NaN-Viewport, Bestandsverhalten), sonst geklemmt auf
 *  [VP_SCALE_MIN, VP_SCALE_MAX] — identische Grenzen zu zoomAt/zoomToFit
 *  (packages/core/src/viewport.ts), bewusst gekoppelt an dieselben Zahlenwerte. */
export function klemmeSkalierung(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(VP_SCALE_MAX, Math.max(VP_SCALE_MIN, scale));
}

/**
 * Plant das Anwenden einer Ansicht auf den aktuellen State (VIEW-01). Fail-honest, kein
 * Alles-oder-nichts-Abbruch: alle auflösbaren Bestandteile greifen, `fehlendeDocs` ist genau die
 * Zahl, die Plan 11-08 in den Toast-Wortlaut „{N} Dokument(e) aus dieser Ansicht sind nicht mehr
 * vorhanden." einsetzt — nicht die bereits geöffneten Dokumente und nicht die weggefallenen
 * Hervorhebungen. Reine Funktion: verändert weder `state` noch `ansicht`, liefert bei gleichen
 * Eingaben immer dasselbe Ergebnis.
 *
 * Das Wiederherstellen von `visibleLayers` kann strukturell keine für den Nutzer unsichtbare
 * Ebene freischalten: der Sichtbarkeits-Filter (filterByVisibleLayers, store.svelte.ts) arbeitet
 * ausschließlich über bereits serverseitig projizierte Daten — er ist keine Sicherheitsgrenze
 * (T-11-08, store.svelte.ts:108-112).
 */
export function planeAnsichtAnwendung(state: DesktopState, ansicht: Ansicht): AnsichtPlan {
  const vp: Viewport = { x: ansicht.vp.x, y: ansicht.vp.y, scale: klemmeSkalierung(ansicht.vp.scale) };

  const bekannteEbenenIds = new Set<string>([
    ...SYSTEM_EBENEN.map((e) => e.id),
    ...(state.layers ?? []).map((e) => e.id),
  ]);
  const visibleLayers = ansicht.visibleLayers.filter((id) => bekannteEbenenIds.has(id));

  const highlightedIds = new Set<string>(
    ansicht.highlightedIds.filter((id) => findeObjekt(state, id) !== undefined),
  );

  const zuOeffnendeDocIds: string[] = [];
  let fehlendeDocs = 0;
  for (const docId of ansicht.openDocIds) {
    const doc = state.docs.find((d) => d.id === docId);
    if (!doc) { fehlendeDocs += 1; continue; }
    if (!doc.open) zuOeffnendeDocIds.push(docId);
  }

  return { vp, visibleLayers, suchText: ansicht.suchText, highlightedIds, zuOeffnendeDocIds, fehlendeDocs };
}
