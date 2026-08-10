import { findeObjekt, type Command, type DesktopState, type Erwartet, type Konflikt } from '@j-desk/core';

export class KonfliktAntwort extends Error {
  constructor(readonly konflikt: Konflikt) {
    super('Konflikt');
  }
}

/**
 * Leitet die Erwartung aus der payload ab, statt sie je Command-Typ zu pflegen.
 *
 * Jeder String in der payload (auch verschachtelt, auch in Arrays), der die ID eines
 * bekannten Objekts ist, geht mit seiner updatedRev als Erwartung mit. Das deckt
 * stack.docIds, link.fromId/toId und clip.memberIds ohne Sonderbehandlung ab.
 *
 * Eine gepflegte Liste je Command-Typ wäre die falsche Bauform: ihr Fehlerfall — ein
 * vergessener Eintrag — hiesse „keine Erwartung, keine Erkennung", also genau das stille
 * Überschreiben, das diese Runde beseitigt. Der Preis ist eine gelegentlich zu strenge
 * Erwartung; die fängt die Reaktionsklasse ab.
 */
export function erwartungAus(state: DesktopState, payload: Command['payload']): Erwartet | undefined {
  const erwartet: Erwartet = {};
  let gefunden = false;

  const besuche = (v: unknown, tiefe: number): void => {
    if (tiefe > 4) return; // Nutzlasten sind flach; die Grenze schützt vor Zyklen.
    if (typeof v === 'string') {
      const treffer = findeObjekt(state, v);
      const rev = treffer?.obj.updatedRev;
      if (rev !== undefined && erwartet[v] === undefined) {
        erwartet[v] = rev;
        gefunden = true;
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) besuche(x, tiefe + 1);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) besuche(x, tiefe + 1);
    }
  };

  besuche(payload ?? {}, 0);
  return gefunden ? erwartet : undefined;
}

export type Reaktion = 'wiederholen' | 'fragen';

/**
 * Ortsgebundene Commands: „die letzte Position gewinnt" ist hier das erwartete Verhalten,
 * eine Rückfrage wäre lästig und nicht hilfreich. Alles andere — und alles NICHT
 * Eingetragene — führt zur Rückfrage (K4).
 */
const WIEDERHOLEN = new Set([
  'moveDoc', 'moveStack', 'moveNote', 'moveCutout', 'bringToFront',
  'resizeDoc', 'resizeStack', 'setDocLandscape', 'setBackground',
]);

export function reaktionFuer(typ: string): Reaktion {
  return WIEDERHOLEN.has(typ) ? 'wiederholen' : 'fragen';
}
