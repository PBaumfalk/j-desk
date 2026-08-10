import { provenienz, type CommandMeta, type DesktopState } from './model';
import type { Rolle } from './roles';
import { findeObjekt } from './stempel';
import { uid } from './uid';

/** Wer eine Sichtbarkeits-/Bearbeitungsentscheidung trifft: Nutzer + seine Rolle am Desk. */
export interface ActorContext {
  userId: string;
  rolle: Rolle;
}

/**
 * Sichtbarkeits-/Bearbeitungsebene eines Objekts (PERM-01/PERM-02).
 *
 * Fester Grundstock (`SYSTEM_EBENEN`): privat / kanzlei / ki-vorschlaege / exportierbar.
 * `privat` ist dort ein Platzhalter-Typ ohne `ownerUserId` — die tatsächliche private Ebene
 * eines einzelnen Nutzers ist eine eigene `Ebene`-Instanz mit `typ: 'privat'` und gesetztem
 * `ownerUserId`, die (wie benutzerdefinierte Kanzlei-Ebenen) in `DesktopState.layers` lebt.
 */
export interface Ebene {
  id: string;
  typ: 'privat' | 'kanzlei' | 'ki-vorschlaege' | 'exportierbar' | 'custom';
  name: string;
  ownerUserId?: string; // nur bei typ 'privat': exklusiver Eigentümer (Sicht-/Bearbeitungsrecht)
  createdBy?: string;   // Provenienz: wer hat die Ebene angelegt; nur bei custom-Ebenen gesetzt
  createdById?: string; // Provenienz: stabile users.id (WR-05); nur bei custom-Ebenen gesetzt
  createdAt?: string;   // Provenienz: wann, ISO-Zeitpunkt; nur bei custom-Ebenen gesetzt
  exportierbar?: boolean; // Exportfreigabe-Flag (PERM-Kontext „Exportfreigabe"); Phase 3 wertet dies aus
}

/** Fester Grundstock der Ebenen (CONTEXT „Ebenen-Modell") — feste ids, keine Eigenkreationen. */
export const SYSTEM_EBENEN: readonly Ebene[] = [
  { id: 'kanzlei', typ: 'kanzlei', name: 'Kanzlei' },
  { id: 'privat', typ: 'privat', name: 'Privat' },
  { id: 'ki-vorschlaege', typ: 'ki-vorschlaege', name: 'KI-Vorschläge' },
  { id: 'exportierbar', typ: 'exportierbar', name: 'Exportierbar', exportierbar: true },
];

/** Ebene (Desk-State oder SYSTEM_EBENEN-Grundstock) zu einer layerId, sonst undefined.
 *  Exportiert für die serverseitige Ebenen-Bearbeitungsprüfung (CR-04, app.ts). */
export function findeEbene(layerId: string, layers?: Ebene[]): Ebene | undefined {
  return (layers ?? []).find((e) => e.id === layerId) ?? SYSTEM_EBENEN.find((e) => e.id === layerId);
}

/**
 * Die Pro-Nutzer-Privat-Instanz eines Nutzers in `state.layers` (02-09, PERM-01).
 * Der `SYSTEM_EBENEN`-Eintrag 'privat' ist nur ein Platzhalter-Typ OHNE `ownerUserId` und
 * daher hier nie ein Treffer — die tatsächliche private Ebene eines Nutzers lebt ausschließlich
 * als Instanz in `state.layers`.
 */
export function findePrivateEbeneFuer(state: DesktopState, userId: string): Ebene | undefined {
  return (state.layers ?? []).find((e) => e.typ === 'privat' && e.ownerUserId === userId);
}

/**
 * Lazy Materialisierung der Pro-Nutzer-Privat-Ebene (02-09, PERM-01): existiert die Instanz
 * des Nutzers noch nicht, wird sie mit deterministischer id (`privat-<userId>`) an
 * `state.layers` angehängt; existiert sie, bleibt der State-Bezug unverändert (idempotent).
 * Die Instanz trägt bewusst keine createdBy/createdAt-Provenienz — sie ist per `ownerUserId`
 * eindeutig zugeordnet (identisch zur Fixture-Form in packages/mcp/src/testServer.ts).
 */
export function ensurePrivateLayer(state: DesktopState, userId: string): { state: DesktopState; layerId: string } {
  const vorhanden = findePrivateEbeneFuer(state, userId);
  if (vorhanden) return { state, layerId: vorhanden.id };
  const layerId = `privat-${userId}`;
  const ebene: Ebene = { id: layerId, typ: 'privat', name: 'Privat', ownerUserId: userId };
  return { state: { ...state, layers: [...(state.layers ?? []), ebene] }, layerId };
}

/**
 * Bearbeitungsrecht nach Ebenentyp (PERM-02, wörtlich): private Ebene exklusiv ihr
 * Eigentümer; Kanzlei-Ebene (und benutzerdefinierte Kanzlei-Ebenen) alle Bearbeiter-aufwärts;
 * KI-Vorschläge-Ebene nie direkt — nur via Übernahme (eigener Command, nicht hier abgebildet).
 */
export function darfEbeneBearbeiten(ebene: Ebene, ctx: ActorContext): boolean {
  if (ebene.typ === 'privat') return ctx.userId === ebene.ownerUserId;
  if (ebene.typ === 'ki-vorschlaege') return false;
  // kanzlei, exportierbar, custom: Bearbeiter-aufwärts
  return ctx.rolle === 'Eigentümer' || ctx.rolle === 'Bearbeiter';
}

/**
 * Sichtbarkeit eines Objekts anhand seiner `layerId` (PERM-01/PERM-05).
 *
 * - Fehlende `layerId` (undefined) gilt implizit als Kanzlei-Ebene — sichtbar für alle
 *   (CONTEXT „keine stille Wegnahme von Bestandsverhalten").
 * - Unbekannte `layerId` (in `layers` und `SYSTEM_EBENEN` nicht gefunden) bleibt aus
 *   demselben Grund sichtbar statt fail-closed zu verschwinden.
 * - Private Ebene: nur für ihren Eigentümer sichtbar (PERM-05-Kern).
 * - Alle anderen Ebenentypen (kanzlei/custom/ki-vorschlaege/exportierbar): sichtbar für
 *   jeden Zugriffsberechtigten (Bearbeitungsrecht wird separat über `darfEbeneBearbeiten` geprüft).
 */
export function istObjektSichtbarFuer(layerId: string | undefined, ctx: ActorContext, layers?: Ebene[]): boolean {
  if (layerId === undefined) return true;
  const ebene = findeEbene(layerId, layers);
  if (!ebene) return true;
  if (ebene.typ === 'privat') return ctx.userId === ebene.ownerUserId;
  return true;
}

/**
 * Ordnet ein Objekt (gefunden über alle `VERSIONIERTE_ARTEN`) einer Ziel-Ebene zu (PERM-01).
 *
 * Reine State-Transformation — die Rechteprüfung (darf DIESER Actor DIESES Objekt
 * umhängen) passiert nicht hier, sondern serverseitig im Command-Guard (02-03/02-04).
 * Ziel-Ebene und Objekt werden validiert: unbekannte Ebene/Objekt wirft (kein stiller No-Op).
 *
 * Platzhalter-Auflösung (02-09): ist das Ziel die Platzhalter-id 'privat' (exakt das, was die
 * UI sendet) UND trägt `meta` eine `createdById`, wird die Pro-Nutzer-Privat-Instanz des
 * Auslösers lazy materialisiert (ensurePrivateLayer) und als effektives Ziel verwendet —
 * atomar im selben Command. Die Instanz-id stammt dabei ausschließlich aus `meta.createdById`
 * (Server-Feldhoheit, T-02-09-03), niemals aus dem Payload. Ein meta-loser Aufruf behält das
 * bisherige Platzhalter-Verhalten als dokumentierten Legacy/Test-Pfad — hinter dem
 * Server-Guard ist dieser Pfad produktiv nicht erreichbar.
 */
export function changeLayerId(state: DesktopState, objectId: string, layerId: string, meta?: CommandMeta): DesktopState {
  let arbeitsState = state;
  let zielId = layerId;
  if (layerId === 'privat' && meta?.createdById) {
    const materialisiert = ensurePrivateLayer(state, meta.createdById);
    arbeitsState = materialisiert.state;
    zielId = materialisiert.layerId;
  }
  if (!findeEbene(zielId, arbeitsState.layers)) throw new Error(`Unbekannte Ebene: ${zielId}`);
  const treffer = findeObjekt(arbeitsState, objectId);
  if (!treffer) throw new Error(`Unbekanntes Objekt: ${objectId}`);
  const { art } = treffer;
  const liste = (arbeitsState as unknown as Record<string, { id: string; layerId?: string }[]>)[art];
  const neueListe = liste.map((o) => (o.id === objectId ? { ...o, layerId: zielId } : o));
  return { ...arbeitsState, [art]: neueListe } as DesktopState;
}

/**
 * Legt eine benannte, benutzerdefinierte Kanzlei-Ebene an (PERM-02).
 *
 * `createdBy`/`createdAt` kommen ausschließlich aus `meta` (Server-Feldhoheit, identisch
 * zum Provenienz-Muster bei Objekten) — ein im Payload mitgeschickter `createdBy` wird
 * nie übernommen, weil diese Funktion ihn gar nicht entgegennimmt.
 */
export function addCustomLayer(
  state: DesktopState,
  name: string,
  meta?: CommandMeta,
  exportierbar = false,
): DesktopState {
  if (name.length < 1 || name.length > 40) {
    throw new Error('Ebenen-Name muss zwischen 1 und 40 Zeichen lang sein');
  }
  const ebene: Ebene = {
    id: uid(),
    typ: 'custom',
    name,
    exportierbar,
    ...provenienz(meta),
  };
  return { ...state, layers: [...(state.layers ?? []), ebene] };
}

/**
 * Setzt/löscht das Exportfreigabe-Flag einer bereits vorhandenen Ebene (02-07,
 * Sichtbarkeits-Panel-Checkbox — Auswertung erst Phase 3). Wirkt NUR auf Ebenen in
 * `state.layers` (benutzerdefinierte Kanzlei-Ebenen + private Nutzer-Instanzen) — die vier
 * `SYSTEM_EBENEN` sind ein hardcodierter, nicht-persistenter Grundstock ohne Desk-Zustand;
 * eine unbekannte/System-`layerId` wirft (kein stiller No-Op, analog changeLayerId).
 *
 * Platzhalter-Auflösung (WR-01, 02-REVIEW Iteration 3): ist das Ziel die Platzhalter-id
 * 'privat' UND trägt `meta` eine `createdById`, wird — exakt wie bei changeLayerId — die
 * Pro-Nutzer-Privat-Instanz des Auslösers lazy materialisiert und als effektives Ziel
 * verwendet (die Instanz-id stammt ausschließlich aus `meta.createdById`, Server-Feldhoheit,
 * niemals aus dem Payload). Ohne meta bleibt 'privat' der dokumentierte Legacy-Pfad und
 * wirft als nicht änderbare System-Ebene. Ob ein Actor eine konkrete Privat-Instanz
 * überhaupt anfassen darf (Eigentum), prüft der Server-Guard in app.ts — nicht hier.
 */
export function setLayerExportierbar(
  state: DesktopState, layerId: string, exportierbar: boolean, meta?: CommandMeta,
): DesktopState {
  let arbeitsState = state;
  let zielId = layerId;
  if (layerId === 'privat' && meta?.createdById) {
    const materialisiert = ensurePrivateLayer(state, meta.createdById);
    arbeitsState = materialisiert.state;
    zielId = materialisiert.layerId;
  }
  const idx = (arbeitsState.layers ?? []).findIndex((e) => e.id === zielId);
  if (idx === -1) throw new Error(`Unbekannte oder nicht änderbare Ebene: ${zielId}`);
  const layers = arbeitsState.layers!.map((e, i) => (i === idx ? { ...e, exportierbar } : e));
  return { ...arbeitsState, layers };
}
