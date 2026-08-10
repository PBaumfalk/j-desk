import type { DesktopState } from './model';
import { istObjektSichtbarFuer, type ActorContext } from './layers';
import { effektiveFreigabe } from './freigabe';
import { VERSIONIERTE_ARTEN } from './stempel';
import type { TrashedItem } from './trash';

export type { ActorContext } from './layers';

/**
 * Zentrale Sichtbarkeits-Projektion (PERM-01/PERM-05): filtert aus dem vollen `DesktopState`
 * genau das heraus, was `ctx` sehen darf — unsichtbare Objekte fehlen KOMPLETT, kein
 * Platzhalter, keine Metadaten. Der Nutzer nur einer einzigen reinen Funktion vertrauen zu
 * müssen (statt jeden Auslieferungspfad einzeln richtig zu bekommen) schließt strukturell die
 * Broadcast-Leck-Bugklasse, die im Projekt bereits zweimal real auftrat (aec4f58, fcda808).
 *
 * Iteriert nach dem `stempeleGeaenderte`-Muster (stempel.ts) über `VERSIONIERTE_ARTEN`, damit
 * keine ebenenfähige Objektart vergessen werden kann. Gibt bei unveränderter Sichtbarkeit
 * denselben State-Bezug zurück (keine unnötige Kopie).
 *
 * Der Papierkorb steht bewusst NICHT in `VERSIONIERTE_ARTEN` (historische Kopien, nie
 * versioniert, s. stempel.ts) — seine Einträge tragen aber VOLLKOPIEN entfernter Objekte
 * (inkl. name/text/textSnapshot/fileId) und werden deshalb hier separat projiziert (CR-02):
 * ein Korb-Eintrag bleibt nur stehen, wenn SEIN GESAMTER Inhalt für den Betrachter sichtbar
 * ist (kein Platzhalter, kein teilweiser Eintrag — ein gemischter Eintrag fällt komplett).
 */
export function projectStateForActor(state: DesktopState, ctx: ActorContext): DesktopState {
  const ergebnis = { ...state } as unknown as Record<string, unknown>;
  let geaendert = false;

  // Mandant-Stufe (EXP-03, D-06): NUR die Rolle 'externer Gast' erhält die Zusatzbedingung
  // effektiveFreigabe(obj, state.layers) !== 'intern' — 'mandant' heißt Gast-sichtbar, aber
  // NICHT exportierbar; der Export filtert separat über freigabeFilter (freigabe.ts), die
  // Projektion bleibt die Sichtbarkeits-Grenze. Alle anderen Rollen behalten ihr bisheriges
  // Sichtverhalten unverändert (kein stiller Verhaltenswechsel, T-03-02-03). Derselbe
  // einzige Filterpunkt gilt wie jede Stufe dieser Funktion für alle Auslieferungspfade.
  const gastFilter = ctx.rolle === 'externer Gast';

  for (const art of VERSIONIERTE_ARTEN) {
    const liste = (state as unknown as Record<string, { layerId?: string }[] | undefined>)[art];
    if (!liste) continue;

    const gefiltert = liste.filter((obj) =>
      istObjektSichtbarFuer(obj.layerId, ctx, state.layers) &&
      (!gastFilter || effektiveFreigabe(obj, state.layers) !== 'intern'));

    if (gefiltert.length !== liste.length) {
      ergebnis[art] = gefiltert;
      geaendert = true;
    }
  }

  const korb = state.trash;
  if (korb && korb.length > 0) {
    const gefiltert = korb.filter((t: TrashedItem) =>
      Object.values(t.payload).every((liste: { layerId?: string }[]) =>
        liste.every((o) =>
          istObjektSichtbarFuer(o.layerId, ctx, state.layers) &&
          (!gastFilter || effektiveFreigabe(o, state.layers) !== 'intern'))));
    if (gefiltert.length !== korb.length) {
      ergebnis.trash = gefiltert;
      geaendert = true;
    }
  }

  // Fremde Privat-Instanzen aus state.layers filtern (02-09, T-02-09-01, CONTEXT „keine
  // Andeutung privater Ebenen anderer"): sonst sähe jeder Betrachter id/name/ownerUserId der
  // privaten Ebenen aller Mitnutzer — eine Andeutung, die PERM-05 verbietet, selbst wenn die
  // Objekte selbst längst gefiltert sind. Alle 10 Auslieferungspfade erben diesen Filter, weil
  // sie alle durch diese eine Funktion laufen. Eigene Instanz, custom- und alle übrigen
  // Einträge bleiben; bei nichts zu filtern unveränderte Referenz (geaendert-Konvention).
  if (state.layers && state.layers.length > 0) {
    const gefiltert = state.layers.filter((e) => !(e.typ === 'privat' && e.ownerUserId !== ctx.userId));
    if (gefiltert.length !== state.layers.length) {
      ergebnis.layers = gefiltert;
      geaendert = true;
    }
  }

  return geaendert ? (ergebnis as unknown as DesktopState) : state;
}
