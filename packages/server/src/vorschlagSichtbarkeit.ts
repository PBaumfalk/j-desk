import {
  findeObjekt, istObjektSichtbarFuer, projectStateForActor,
  type ActorContext, type DesktopState, type Vorschlag,
} from '@j-desk/core';

/**
 * Rechteposition der Rücknahme (WR-01, Re-Review It. 2): die zuruecknehmen-Route hängt am
 * 'manage'-Guard und spielt die persistierte Inverse bewusst OHNE Kommando-Guard ab
 * (restoreDeskTo-Präzedenz — die Inverse enthält arten, die der Routen-Guard für diese Rolle
 * ablehnen würde, z. B. removeNote als Inverse von addNote). Diese Ersatzkontrolle setzte
 * bisher implizit RECHTEGLEICHHEIT zwischen Genehmiger und Rücknehmendem voraus — die ist
 * nicht erzwungen: der inhaltsfreie Journal-Marker 'vorschlagGenehmigt' ist für ALLE
 * manage-Rollen sichtbar und trägt die vorschlagId, sodass ein beliebiger manage-Berechtigter
 * die Rücknahme einer fremden Genehmigung auslösen konnte — inklusive blinder Inverse-Schreib-
 * zugriffe auf Objekten einer fremden PRIVAT-Ebene (die Ebenen-Stufe greift nur bei der
 * Genehmigung; die Quellenpflicht prüft nur die Sichtbarkeit des QUELL-Dokuments, nicht des
 * Ziel-Objekts).
 *
 * Die Schranke bindet die Rücknahme deshalb an die Rechteposition der Genehmigung — drei
 * Wege, ein Verbot (fail-closed, sobald ALLE drei verfehlt sind):
 *
 *  (1) EIGENTÜMER: Desk-Souverän — kann den Desk bereits vollständig zurücksetzen
 *      (restoreDeskTo, gleiche Route-Tragweite 'manage'); eine Sperre wäre Sicherheitstheater
 *      und bräche den Betreuer-Fall (KI-Übernahme im Team rückgängig machen).
 *  (2) GENEHMIGER (decidedById === actor): konnte nur genehmigen, was er zum Genehmigungs-
 *      zeitpunkt selbst sehen und bearbeiten durfte (pruefeKommandosFuerActor, Ebenen-Stufe) —
 *      die Rücknahme kehrt nur das selbst Geprüfte um (dokumentierter Designfall).
 *  (3) SICHTBARKEIT aller Anker-Objekte: für jeden Anker aus genehmigteObjekte muss das
 *      Objekt für den Rücknehmenden SICHTBAR sein — dieselbe Zwei-Stufen-Regel wie die
 *      projizierte GET-Liste (PERM-05): existiert der Anker im vollen State, fehlt er aber in
 *      der Projektion für diesen Akteur, liegt er auf einer unsichtbaren (privaten) Ebene.
 *      Korb-Anker (trashObject-Genehmigung) prüfen die layerIds der Korb-Vollkopien — dieselbe
 *      Auflösung wie korbReferenzSichtbar (WR-07) in proposals.ts: die restoreObject-Inverse
 *      schriebe die Kopien sonst blind auf ihre (ggf. fremd-private) Ursprungs-Ebene zurück.
 *
 * Bewusst KEINE Vollprüfung der Inverse über pruefeKommandosFuerActor: sie bräche den
 * Designfall (die removeNote-Inverse ist Eigentümer-only über /commands, obwohl der
 * Bearbeiter-Genehmiger das addNote genehmigen durfte — die Rechtefrage wurde bei der
 * Genehmigung geklärt). Eine reine decidedById-Bindung ohne Weg (3) wäre enger als das
 * Bestands-Rechtemodell (manage-Rollen dürfen vergleichbare Aktionen — restore-Route) und
 * blockierte legitime Team-Rücknahmen (Genehmiger nicht verfügbar), ohne die eigentliche
 * Lücke — Schreiben auf UNSICHTBAREN Ebenen — besser zu schließen.
 *
 * Geteilt zwischen der zuruecknehmen-Route (proposals.ts, 403 vor dem Abspielen) und der
 * Journal-Projektion (journal.ts, Auslieferungs-Flag 'zuruecknehmenErlaubt' für die
 * Client-Ausblendung der Zeilenaktion, PERM-04-Muster) — ein Modul, damit Server-Grenze und
 * Client-Komfort nie auseinanderlaufen.
 */

/** Anker-Sichtprüfung (Weg 3): true, wenn JEDER Anker für ctx sichtbar (oder nicht mehr
 *  nachweisbar existent — die 409-Schranke des updatedRev-Mitschnitts fängt das fail-honest
 *  ab; hier kein fail-closed gegen Nichtexistierendes, wie bei referenzierteObjektIds). */
export function ruecknahmeAnkerSichtbar(
  state: DesktopState,
  genehmigteObjekte: Vorschlag['genehmigteObjekte'],
  ctx: ActorContext,
): boolean {
  const projiziert = projectStateForActor(state, ctx);
  for (const o of genehmigteObjekte ?? []) {
    if (o.korb === true) {
      // Korb-Anker: die Inverse (restoreObject) stellt die Vollkopien auf ihren Ursprungs-
      // Ebenen wieder her — Sichtprüfung über die layerIds der Kopien (korbReferenzSichtbar-
      // Muster). Fehlt der Eintrag, entscheidet die Existenz-Schranke (409), nicht die Rechte.
      const eintrag = (state.trash ?? []).find((t) => t.id === o.id);
      if (!eintrag) continue;
      const kopien = Object.values(eintrag.payload).flat() as { layerId?: string }[];
      if (!kopien.every((k) => istObjektSichtbarFuer(k.layerId, ctx, state.layers))) return false;
      continue;
    }
    if (findeObjekt(state, o.id) !== undefined && findeObjekt(projiziert, o.id) === undefined) return false;
    // WR-01 (It. 3): Stempel/Fahnen sind seitenverankerte Dekoration — ihr Rechte-Kontext
    // ist das ELTERN-DOKUMENT, nicht das eigene (meist fehlende) layerId: die Ebenen-Stufe
    // der Genehmigung prüft ebenfalls das Dokument (objektbezug.ts), und ein Stempel an
    // einem Dokument auf fremder Privat-Ebene bliebe sonst formal "sichtbar" (implizit
    // Kanzlei-Ebene), obwohl der Rücknehmende den Kontext nicht prüfen kann — die Inverse
    // (removeStamp/removeFlag) griffe dann an einem Objekt an, das fachlich zur fremden
    // Privat-Ebene gehört. Fail-closed nur bei nachgewiesener Unsichtbarkeit: ist das
    // Dokument im vollen State nicht mehr auffindbar (z. B. endgültig gelöscht), entscheidet
    // die 409-Existenz-Schranke, nicht die Rechte (Konvention des Hauptzweigs).
    const voll = findeObjekt(state, o.id);
    if (voll !== undefined && (voll.art === 'stamps' || voll.art === 'flags')) {
      const docId = (voll.obj as { docId?: unknown }).docId;
      if (typeof docId === 'string' && docId !== ''
          && findeObjekt(state, docId) !== undefined
          && findeObjekt(projiziert, docId) === undefined) return false;
    }
  }
  return true;
}

/** Gesamtregel: Eigentümer ODER Genehmiger ODER vollständige Anker-Sichtbarkeit. */
export function ruecknahmeErlaubt(
  v: Pick<Vorschlag, 'genehmigteObjekte' | 'decidedById'>,
  state: DesktopState,
  ctx: ActorContext,
): boolean {
  if (ctx.rolle === 'Eigentümer') return true;
  if (v.decidedById !== undefined && v.decidedById === ctx.userId) return true;
  return ruecknahmeAnkerSichtbar(state, v.genehmigteObjekte, ctx);
}
