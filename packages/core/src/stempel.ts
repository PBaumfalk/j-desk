import type { DesktopState } from './model';

export interface Stempel {
  rev: number;
  at: string;
  by: string;
}

/** Objekt mit eigener Version. Alle versionierten Arten tragen eine `id`. */
interface Versioniert {
  id: string;
  updatedRev?: number;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Arten, die eine eigene Version tragen.
 *
 * `trash` fehlt bewusst: seine Einträge sind historische Kopien entfernter Objekte,
 * keine lebenden Objekte — sie werden nie bearbeitet, also nie versioniert.
 * `background` fehlt, weil es kein Array von Objekten mit id ist; Hintergrundwechsel
 * sind unstrittig und brauchen keine Konflikterkennung.
 *
 * `zones` steht seit 13-02 hier (Planner-Entscheidung, Präzisierung zu U4) — anders als
 * `layers` sind Zonen versionierte Objekte: die findeObjekt-Auffindbarkeit ist die Grundlage
 * der Journal-CR-03-Auflösung und der Offline-Dublettenerkennung (istBereitsAngewendet
 * prüft erzeugende Kommandos über findeObjekt), und der WR-02-Wächter erzwingt für jeden
 * erzeugenden Typ eine INHALT_OBJEKT_ID-Auflösung. Die U4-Kernaussagen (kein layerId,
 * keine Referenzen) bleiben unverändert — updatedRev kommt nur als Stempel-Nebenprodukt.
 */
export const VERSIONIERTE_ARTEN = [
  'docs', 'stacks', 'links', 'strokes', 'notes', 'cutouts', 'marks', 'stamps', 'flags', 'clips',
  'legalObjects', 'tables', 'zeitleisten', 'sitzungsmappen', 'zones',
] as const;

type Art = (typeof VERSIONIERTE_ARTEN)[number];

function liste(s: DesktopState, art: Art): Versioniert[] | undefined {
  return (s as unknown as Record<string, Versioniert[] | undefined>)[art];
}

/**
 * Stempelt genau die Objekte, deren Referenz sich zwischen `alt` und `neu` geändert hat —
 * sowie alle neu hinzugekommenen.
 *
 * Das trägt, weil alle Domänenmodule konsequent Struktur teilen
 * (`s.docs.map((d) => (d.id === id ? { ...d, position } : d))`): unveränderte Objekte
 * behalten ihre Identität.
 *
 * Bewusst zentral statt in den rund 50 Handlern. Der Fehlerfall zeigt so in die
 * ungefährliche Richtung: Baut ein Handler wider Erwarten alle Objekte neu, werden zu
 * VIELE gestempelt — das erzeugt Konflikte, wo keine sind, und die betreffen fast nur
 * ortsgebundene Commands, die der Client still neu aufsetzt. Ein vergessener Stempel
 * dagegen hiesse: nie ein Konflikt erkannt, also stilles Überschreiben. Zu viel stempeln
 * ist folgenlos, zu wenig stempeln wäre das Leck.
 *
 * Der Wächtertest in stempel.test.ts prüft die Strukturteilung über alle Command-Typen.
 */
export function stempeleGeaenderte(alt: DesktopState, neu: DesktopState, s: Stempel): DesktopState {
  if (alt === neu) return alt;
  const ergebnis = { ...neu } as unknown as Record<string, unknown>;
  let etwasGeaendert = false;

  for (const art of VERSIONIERTE_ARTEN) {
    const vorher = liste(alt, art);
    const nachher = liste(neu, art);
    if (!nachher || vorher === nachher) continue;

    const altNachId = new Map<string, Versioniert>();
    for (const o of vorher ?? []) altNachId.set(o.id, o);

    let listeGeaendert = false;
    const gestempelt = nachher.map((o) => {
      if (altNachId.get(o.id) === o) return o;
      listeGeaendert = true;
      return { ...o, updatedRev: s.rev, updatedAt: s.at, updatedBy: s.by };
    });

    if (listeGeaendert) {
      ergebnis[art] = gestempelt;
      etwasGeaendert = true;
    }
  }

  return etwasGeaendert ? (ergebnis as unknown as DesktopState) : neu;
}

/** Sucht ein Objekt über alle versionierten Arten. Grundlage der Vorbedingungsprüfung. */
export function findeObjekt(s: DesktopState, id: string): { art: string; obj: Versioniert } | undefined {
  for (const art of VERSIONIERTE_ARTEN) {
    const gefunden = liste(s, art)?.find((o) => o.id === id);
    if (gefunden) return { art, obj: gefunden };
  }
  return undefined;
}
