import type { DesktopState } from './model';
import { findeObjekt } from './stempel';

export interface Konflikt {
  objektId: string;
  typ: string;
  art: 'geaendert' | 'geloescht';
  von: string | null;
  am: string | null;
}

/** Objekt-ID → erwartete updatedRev. Der Client leitet sie aus der payload ab. */
export type Erwartet = Record<string, number>;

export class KonfliktError extends Error {
  constructor(readonly konflikt: Konflikt) {
    super('Das Objekt wurde zwischenzeitlich geändert');
  }
}

/**
 * Prüft die mitgeschickten Erwartungen gegen den aktuellen Zustand.
 *
 * Zwei bewusste Annahmen zugunsten des Weiterarbeitens:
 * - Fehlt `erwartet` ganz, wird angenommen. Das ist der alte Client (nicht neugeladener
 *   Tab), der blockiert sonst dauerhaft.
 * - Trägt das Objekt selbst keine `updatedRev`, wird angenommen. Das ist ein Alt-Zustand
 *   vor der Migration; über ihn lässt sich nichts aussagen.
 *
 * Beides schwächt die Erkennung nur vorübergehend: nach der Migration und einem
 * Neuladen tragen alle Objekte und alle Clients ihre Versionen.
 */
export function pruefeErwartung(s: DesktopState, erwartet: Erwartet | undefined): Konflikt | null {
  if (!erwartet) return null;
  for (const [objektId, rev] of Object.entries(erwartet)) {
    const gefunden = findeObjekt(s, objektId);
    if (!gefunden) {
      return { objektId, typ: 'unbekannt', art: 'geloescht', von: null, am: null };
    }
    const ist = gefunden.obj.updatedRev;
    if (ist === undefined) continue;
    if (ist !== rev) {
      return {
        objektId,
        typ: gefunden.art,
        art: 'geaendert',
        von: gefunden.obj.updatedBy ?? null,
        am: gefunden.obj.updatedAt ?? null,
      };
    }
  }
  return null;
}
