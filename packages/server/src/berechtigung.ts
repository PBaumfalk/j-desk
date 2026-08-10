import {
  effektiveFreigabe, findeEbene, findeObjekt, istObjektSichtbarFuer, projectStateForActor,
  type ActorContext, type Freigabe, type Rolle,
} from '@j-desk/core';
import type { Db } from './db';
import { getDeskState, getRolleForNutzer, listMembers } from './deskStore';

/**
 * Admin-Berechtigungsdiagnose (OPS-03, 14-05): beantwortet „Warum sieht Nutzer X Dokument Y
 * nicht?" ohne SQL. Analog `vorschlagSichtbarkeit.ts` — ein eigenes Server-Modul, das über
 * `projectStateForActor()` entscheidet, „damit Server-Grenze und Client-Komfort nie
 * auseinanderlaufen" (vorschlagSichtbarkeit.ts:44-47). Die EINE bewusste Abweichung vom
 * Vorbild: `vorschlagSichtbarkeit.ts` liefert nur einen Wahrheitswert (early-return reicht);
 * hier muss die Begründung ALLE zutreffenden Gründe sammeln (UI-SPEC E4/partial, in diesem
 * Plan aufgelöst) — die Gründe-Sammlung ist deshalb ein Anhängen an eine Liste, KEINE Kette
 * mit vorzeitiger Rückgabe.
 */

/** Maschinenlesbare Art eines Begründungspunkts — für künftige clientseitige Sonderfälle
 *  (z. B. Icon je Art); der Text selbst ist bereits fertig deutsch (`text`). */
export type BerechtigungsGrundArt = 'ebene-privat-fremd' | 'rolle-gast-intern' | 'ebene-sichtbar' | 'rolle-erlaubt';

export interface BerechtigungsGrund {
  art: BerechtigungsGrundArt;
  text: string;
}

/**
 * Ergebnisform als diskriminierte Union (`gefunden`) — Bestandsstil für optionale Treffer
 * (`{ kind: 'doc' | 'stack'; id: string } | null`-Muster, hier mit benanntem Discriminanten
 * statt `null`, weil der positive Zweig mehrere Pflichtfelder trägt).
 *
 * `gefunden: false` deckt DREI Fälle ab, die bewusst NICHT unterschieden werden (Informations-
 * sparsamkeit, T-14-05-02/T-14-05-05): unbekanntes Objekt, geprüfter Nutzer ohne Rolle an
 * diesem Schreibtisch, ODER das Objekt ist für den FRAGENDEN Eigentümer selbst nicht sichtbar
 * (dessen eigene private Ebenen-Grenze). Eine Unterscheidung würde in Fall 3 verraten, dass ein
 * fremdes privates Objekt EXISTIERT — genau die Andeutung, die die Diagnosefläche verbietet.
 */
export type BerechtigungsBefund =
  | { gefunden: false }
  | {
      gefunden: true;
      sichtbar: boolean;
      gruende: BerechtigungsGrund[];
      nutzerName: string;
      nutzerRolle: Rolle;
      objektName: string;
      objektArt: string;
    };

/** obj_type (VERSIONIERTE_ARTEN-Eintrag) → Anzeige-Art (Copywriting Contract „Objekt + Typ").
 *  Bewusst eigenständig statt aus search/searchQuery.ts importiert — TrefferArt/ART_ZU_TREFFERART
 *  sind dortige Suchergebnis-Interna, kein öffentlicher Vertrag dieses Moduls. */
const ART_LABEL: Partial<Record<string, string>> = {
  docs: 'Karte', stacks: 'Stapel', links: 'Verknüpfung', notes: 'Zettel', cutouts: 'Ausschnitt',
  marks: 'Markierung', stamps: 'Stempel', flags: 'Fähnchen', clips: 'Ausschnitt',
  legalObjects: 'Objekt', tables: 'Tabelle', zeitleisten: 'Zeitleiste', sitzungsmappen: 'Sitzungsmappe',
  zones: 'Zone',
};

/** Bestmöglicher Anzeigename über alle Objektarten — dieselbe Feld-Präzedenz wie
 *  `labelFuer()` (search/searchQuery.ts), aber eigenständig gehalten (s. o.): Name zuerst, dann
 *  Freitext (auf 60 Zeichen gekappt, keine Inhaltspreisgabe über die Diagnosefläche hinaus
 *  nötig), dann Quellenname, sonst der Art-Label als Rückfall. */
function ermittleObjektName(art: string, obj: Record<string, unknown>): string {
  if (typeof obj.name === 'string' && obj.name.trim() !== '') return obj.name;
  if (typeof obj.text === 'string' && obj.text.trim() !== '') return obj.text.trim().slice(0, 60);
  if (typeof obj.sourceName === 'string' && obj.sourceName.trim() !== '') return obj.sourceName;
  return ART_LABEL[art] ?? art;
}

/** Gesperrte Textkonstanten (Copywriting Contract, 14-UI-SPEC.md) — leben im Modul, nicht im
 *  Routen-Handler: Wortlaut ist Vertrag, nicht Ausführungs-Ermessen. Jede Funktion nennt Ebenen-
 *  /Rollenname konkret (PERM-Vokabular) statt eines generischen „keine Berechtigung". */
const GRUND_TEXTE = {
  ebenePrivatFremd: (eigentuemerName: string): string =>
    `Objekt liegt auf der privaten Ebene von „${eigentuemerName}"`,
  rolleGastIntern: (): string =>
    'Nutzer hat die Rolle „externer Gast" — als intern geltende Objekte sind für Gäste nicht sichtbar',
  ebeneSichtbar: (ebenenName: string): string =>
    `Objekt liegt auf Ebene „${ebenenName}"`,
  rolleErlaubt: (rolle: Rolle): string =>
    `Nutzer hat die Rolle „${rolle}"`,
};

/**
 * Kernfunktion (OPS-03): lädt den Zustand des Schreibtischs, baut den Akteurskontext für den
 * GEPRÜFTEN Nutzer (nicht den fragenden Eigentümer) und entscheidet AUSSCHLIESSLICH über
 * `projectStateForActor()` — die Begründung folgt der Entscheidung, leitet sie nie ab
 * (Vertrauensanker der ganzen Fläche, must_haves 14-05-PLAN.md).
 */
export function pruefeBerechtigung(
  db: Db,
  deskId: string,
  fragenderUserId: string,
  geprueftUserId: string,
  objektId: string,
): BerechtigungsBefund {
  const deskState = getDeskState(db, deskId);
  if (!deskState) return { gefunden: false };
  const { state } = deskState;

  // Unbekannter Nutzer ODER ein Nutzer ohne Rolle an DIESEM Schreibtisch führt zu Nicht-
  // gefunden statt zu einer erfundenen Begründung (must_haves, letzter Punkt).
  const gepruefteRolle = getRolleForNutzer(db, deskId, geprueftUserId);
  if (!gepruefteRolle) return { gefunden: false };

  // Stufe a: existiert das Objekt überhaupt im vollen Zustand?
  const objVoll = findeObjekt(state, objektId);
  if (!objVoll) return { gefunden: false };

  // Stufe b: Informationssparsamkeit (T-14-05-02) — ist das Objekt in der Projektion des
  // FRAGENDEN Eigentümers nicht enthalten, würde jede Begründung die Existenz eines fremden
  // privaten Objekts verraten, das der Fragende selbst nicht sehen darf. Nicht-gefunden statt
  // Begründung, ununterscheidbar vom „Objekt existiert nicht"-Fall (Stufe a).
  const fragenderCtx: ActorContext = { userId: fragenderUserId, rolle: 'Eigentümer' };
  const fragenderProjiziert = projectStateForActor(state, fragenderCtx);
  if (findeObjekt(fragenderProjiziert, objektId) === undefined) return { gefunden: false };

  // Stufe c: die Entscheidung — AUSSCHLIESSLICH über den echten Auslieferungspfad für den
  // GEPRÜFTEN Nutzer. Alles danach ist Begründung, keine zweite Entscheidung.
  const geprueftCtx: ActorContext = { userId: geprueftUserId, rolle: gepruefteRolle };
  const geprueftProjiziert = projectStateForActor(state, geprueftCtx);
  const sichtbar = findeObjekt(geprueftProjiziert, objektId) !== undefined;

  const { art, obj } = objVoll;
  const objRecord = obj as unknown as Record<string, unknown> & { layerId?: string; freigabe?: Freigabe };
  const layerId = objRecord.layerId;
  const ebene = layerId !== undefined ? findeEbene(layerId, state.layers) : undefined;

  const mitglieder = listMembers(db, deskId);
  const nutzerName = mitglieder.find((m) => m.userId === geprueftUserId)?.username ?? 'unbekannt';
  const objektName = ermittleObjektName(art, objRecord);
  const objektArt = ART_LABEL[art] ?? art;

  // Stufe d: beide Achsen UNABHÄNGIG auswerten, ALLE zutreffenden Gründe sammeln — kein
  // Early-Return (löst UI-SPEC E4/partial: sonst fehlt bei zwei gleichzeitigen Ausschlüssen
  // der zweite Grund, und eine Rollenkorrektur wirkt fälschlich als ausreichende Abhilfe).
  const gruende: BerechtigungsGrund[] = [];

  const ebenenSichtbar = istObjektSichtbarFuer(layerId, geprueftCtx, state.layers);
  if (!ebenenSichtbar) {
    // ebenenSichtbar ist nur dann false, wenn istObjektSichtbarFuer eine gefundene, private
    // Ebene mit fremdem Eigentümer traf (layers.ts) — `ebene` ist an dieser Stelle also immer
    // definiert. Informationssparsamkeit: nur Kategorie + Eigentümer-Anzeigename, nie Inhalte.
    const eigentuemerName = mitglieder.find((m) => m.userId === ebene?.ownerUserId)?.username ?? 'unbekannt';
    gruende.push({ art: 'ebene-privat-fremd', text: GRUND_TEXTE.ebenePrivatFremd(eigentuemerName) });
  }

  const freigabe = effektiveFreigabe(objRecord, state.layers);
  if (gepruefteRolle === 'externer Gast' && freigabe === 'intern') {
    gruende.push({ art: 'rolle-gast-intern', text: GRUND_TEXTE.rolleGastIntern() });
  }

  if (!sichtbar) {
    return { gefunden: true, sichtbar: false, gruende, nutzerName, nutzerRolle: gepruefteRolle, objektName, objektArt };
  }

  // Stufe e: im sichtbaren Fall dieselbe Aufzählungsform — nie ein bloßes „Ja" (must_haves).
  const ebenenName = ebene ? ebene.name : 'Kanzlei';
  const positiveGruende: BerechtigungsGrund[] = [
    { art: 'ebene-sichtbar', text: GRUND_TEXTE.ebeneSichtbar(ebenenName) },
    { art: 'rolle-erlaubt', text: GRUND_TEXTE.rolleErlaubt(gepruefteRolle) },
  ];

  return { gefunden: true, sichtbar: true, gruende: positiveGruende, nutzerName, nutzerRolle: gepruefteRolle, objektName, objektArt };
}
