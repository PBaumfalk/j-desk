import {
  projectStateForActor, familieVon, LINK_MEANINGS,
  type ActorContext, type DesktopState, type LegalObject, type LegalObjectKind, type LinkMeaning,
} from '@j-desk/core';
import type { Db } from './db';
import { getDeskState } from './deskStore';

/** Harte Obergrenze der Trefferliste (08-UI-SPEC.md „stille Kappung, kein Hinweis auf weitere
 *  Treffer") — identisches Muster zu SUCHE_MAX_TREFFER (search/searchQuery.ts). */
export const LEGAL_QUERY_MAX_TREFFER = 30;

export type LegalQueryKind =
  | 'facts-without-evidence'
  | 'opposing-claims-without-rebuttal'
  | 'evidence-supporting-multiple-facts';

/** Die drei kanonischen Abfragen (LEGAL-03) — Kennungen und Anzeigenamen sind aus dem
 *  Copywriting Contract (08-UI-SPEC.md) GESPERRT, nicht Ausführungs-Ermessen. */
export const LEGAL_QUERIES: { kind: LegalQueryKind; label: string }[] = [
  { kind: 'facts-without-evidence', label: 'Tatsachen ohne Beweismittel' },
  { kind: 'opposing-claims-without-rebuttal', label: 'Behauptungen der Gegenseite ohne Erwiderung' },
  { kind: 'evidence-supporting-multiple-facts', label: 'Beweismittel, die mehrere Tatsachen stützen' },
];

/** Dieselbe Zeilenform wie ein Suchtreffer (SucheTreffer, search/searchQuery.ts) — der Client
 *  kann dieselbe Trefferzeilen-Komponente wiederverwenden (08-UI-SPEC.md). */
export interface LegalQueryTreffer {
  objektId: string;
  /** Anzeigename des Objekttyps (Art-Badge). */
  art: string;
  /** Gekürzter Objekttext. */
  label: string;
  ersteller?: string;
  datum?: string;
}

/**
 * Anzeigenamen der 13 juristischen Objekttypen — Serverspiegel von
 * `LEGAL_OBJECT_KIND_LABELS` (src/lib/menus.ts, gesperrter Wortlaut aus REQUIREMENTS.md:77):
 * `src/lib` ist SvelteKit-App-Code, kein Teil von `@j-desk/core`, daher hier nicht importierbar
 * (identische Situation wie der Kopfkommentar von `istEchteSchwaerzung()` in
 * search/searchQuery.ts). Beide Stellen müssen den Wortlaut synchron halten — er ist über das
 * Copywriting Contract gesperrt, ändert sich also nicht beiläufig.
 */
const ART_LABEL: Record<LegalObjectKind, string> = {
  tatsache: 'Tatsache',
  'eigene-behauptung': 'eigene Behauptung',
  'behauptung-gegenseite': 'Behauptung der Gegenseite',
  beweismittel: 'Beweismittel',
  gegenbeweis: 'Gegenbeweis',
  rechtsfrage: 'Rechtsfrage',
  tatbestandsmerkmal: 'Tatbestandsmerkmal',
  einwendung: 'Einwendung',
  risiko: 'Risiko',
  frist: 'Frist',
  aufgabe: 'Aufgabe',
  'fundstelle-zitierfaehig': 'zitierfähige Fundstelle',
  ergebnis: 'Ergebnis',
};

/**
 * Fachliche Heuristiken (08-05-PLAN.md `<planner_assumptions>` A1/A2) — bewusst an GENAU EINER
 * Stelle gebündelt, damit eine spätere fachliche Korrektur (z. B. nach juristischer
 * Sichtprüfung) eine Einzeiler-Änderung bleibt. Beide sind KEINE juristisch validierte Regel,
 * sondern eine Annahme des autonomen Laufs — siehe der blockierende Punkt in 08-UAT.md.
 *
 * A2 — „stützen": nur die Bedeutung `belegt` zählt als Beleg (nicht die gesamte Familie
 * „Bestätigend").
 */
const BELEG_BEDEUTUNGEN: ReadonlySet<LinkMeaning> = new Set(['belegt']);

/**
 * A1 — „ohne Erwiderung": eine gegnerische Behauptung gilt als erwidert, sobald mindestens eine
 * Verknüpfung der gesamten Familie „Widersprechend" (widerspricht/widerlegt/entkräftet/streitig,
 * ermittelt über `familieVon`) an ihr hängt.
 */
const ERWIDERUNG_BEDEUTUNGEN: ReadonlySet<LinkMeaning> = new Set(
  LINK_MEANINGS.filter((m) => familieVon(m) === 'widersprechend'),
);

/**
 * Nachbarschaftsbestimmung: liefert zu `objektId` die Menge der über `projiziert.links`
 * erreichbaren Gegenstück-LegalObjects, gefiltert nach `bedeutungen` — arbeitet ausschließlich
 * auf der PROJIZIERTEN Ausgabe und berücksichtigt beide Richtungen (`fromId`/`toId`), weil die
 * Verknüpfung im Datenmodell ungerichtet angelegt ist.
 *
 * T-08-18: ein Gegenstück, das NICHT unter `sichtbareLegalObjects` steht (fremde Privat-Ebene —
 * Links tragen eine EIGENE `layerId`, unabhängig von der ihrer Endpunkte, und können deshalb
 * sichtbar bleiben, obwohl ein Endpunkt es nicht ist), zählt hier nicht als Nachbar: die
 * Auswertung sieht ihn gar nicht, das sichtbare Objekt bleibt also korrekt unbelegt/unerwidert.
 */
function sichtbareNachbarn(
  projiziert: DesktopState,
  objektId: string,
  bedeutungen: ReadonlySet<LinkMeaning>,
  sichtbareLegalObjects: Map<string, LegalObject>,
): LegalObject[] {
  const gefunden = new Map<string, LegalObject>();
  for (const link of projiziert.links) {
    if (link.kind === undefined || !bedeutungen.has(link.kind)) continue;
    let gegenstueckId: string | undefined;
    if (link.fromId === objektId) gegenstueckId = link.toId;
    else if (link.toId === objektId) gegenstueckId = link.fromId;
    else continue;
    const obj = sichtbareLegalObjects.get(gegenstueckId);
    if (obj) gefunden.set(obj.id, obj);
  }
  return [...gefunden.values()];
}

function factsWithoutEvidence(projiziert: DesktopState, byId: Map<string, LegalObject>): LegalObject[] {
  return (projiziert.legalObjects ?? []).filter(
    (o) => o.kind === 'tatsache' && sichtbareNachbarn(projiziert, o.id, BELEG_BEDEUTUNGEN, byId).length === 0,
  );
}

function opposingClaimsWithoutRebuttal(projiziert: DesktopState, byId: Map<string, LegalObject>): LegalObject[] {
  return (projiziert.legalObjects ?? []).filter(
    (o) => o.kind === 'behauptung-gegenseite' && sichtbareNachbarn(projiziert, o.id, ERWIDERUNG_BEDEUTUNGEN, byId).length === 0,
  );
}

function evidenceSupportingMultipleFacts(projiziert: DesktopState, byId: Map<string, LegalObject>): LegalObject[] {
  return (projiziert.legalObjects ?? []).filter((o) => {
    if (o.kind !== 'beweismittel') return false;
    const belegteTatsachen = sichtbareNachbarn(projiziert, o.id, BELEG_BEDEUTUNGEN, byId).filter((n) => n.kind === 'tatsache');
    return belegteTatsachen.length >= 2;
  });
}

function zuTreffer(o: LegalObject): LegalQueryTreffer {
  return {
    objektId: o.id,
    art: ART_LABEL[o.kind],
    label: o.text.slice(0, 60),
    ersteller: o.createdBy,
    datum: o.createdAt,
  };
}

/**
 * Auswertungsmodul über dem PROJIZIERTEN Zustand (LEGAL-03) — strukturell nach
 * `search/searchQuery.ts` `sucheAufDesk()`. Verbindlicher Ablauf: `getDeskState()` →
 * `projectStateForActor()` → jede Auswertung ausschließlich über die projizierte Ausgabe. Dies
 * ist derselbe PERM-05/SEARCH-04-Präzedenzfall — eine Auswertung über `result.state` (statt der
 * projizierten Ausgabe) wäre exakt dieselbe Fehlerklasse, die diesem Projekt bereits zweimal real
 * passiert ist (Commits `aec4f58`, `fcda808`). `result.state` wird nach dem Projektions-Aufruf an
 * KEINER Stelle mehr gelesen.
 *
 * Ein unbekannter `query`-Wert liefert eine leere Liste statt einer Ausnahme (der Client soll
 * einen Tippfehler an der Route über 400 bemerken, s. app.ts — hier bleibt die Funktion selbst
 * defensiv, falls sie je mit unvalidiertem Input aufgerufen wird).
 */
export function runLegalQuery(db: Db, deskId: string, ctx: ActorContext, query: string): LegalQueryTreffer[] {
  const result = getDeskState(db, deskId);
  if (!result) return [];
  const projiziert = projectStateForActor(result.state, ctx);
  const byId = new Map((projiziert.legalObjects ?? []).map((o) => [o.id, o] as const));

  let treffer: LegalObject[];
  switch (query) {
    case 'facts-without-evidence':
      treffer = factsWithoutEvidence(projiziert, byId);
      break;
    case 'opposing-claims-without-rebuttal':
      treffer = opposingClaimsWithoutRebuttal(projiziert, byId);
      break;
    case 'evidence-supporting-multiple-facts':
      treffer = evidenceSupportingMultipleFacts(projiziert, byId);
      break;
    default:
      return [];
  }

  // Kappung als LETZTER Schritt (T-08-23) — nach der vollständigen fachlichen Auswertung.
  return treffer.slice(0, LEGAL_QUERY_MAX_TREFFER).map(zuTreffer);
}
