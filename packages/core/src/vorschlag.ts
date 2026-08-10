import type { Command } from './commands';

/**
 * Vorschlags-Register der KI-Vertrauensschicht (Phase 12, AI-01/AI-02): Vorschläge leben
 * bewusst AUSSERHALB des DesktopState — die Ebene 'ki-vorschlaege' ist schreibgeschlossenes
 * Vokabular, keine Infrastruktur (12-RESEARCH.md Pattern 1). Export, Replay und Suchindex
 * lesen ausschließlich DesktopState; ein Register-Entwurf kann in keinen dieser Pfade lecken
 * (struktureller Leck-Schutz statt Filterdisziplin). Dieses Modul trägt die reinen
 * Domänentypen und die Statusmaschine; die SQLite-Persistenz liegt in
 * packages/server/src/proposalStore.ts.
 */

export type VorschlagStatus = 'ausstehend' | 'genehmigt' | 'abgelehnt' | 'zurückgenommen';

/** Quellenangabe eines Vorschlags (AI-03) — die art-abhängige Pflicht und die
 *  Zitat-Verifikation werden erst in Plan 12-03 durchgesetzt; hier nur die Datenform. */
export interface Quelle {
  dokumentId: string;
  seite: number;
  zitat: string;
}

export interface Vorschlag {
  id: string;
  deskId: string;
  /** Name der Kommando-Art (in Plan 12-01 nur 'addNote'; Erweiterung art-weise in 12-04). */
  art: string;
  /** Kommando-nahe Nutzdaten — werden von vorschlagAnwenden validiert/abgebildet. */
  payload: Record<string, unknown>;
  quellen: Quelle[];
  zusammenfassung: string;
  status: VorschlagStatus;
  /** Zur GENEHMIGUNGSZEIT berechnete Umkehr-Kommandos (Inversen-Pflicht: keine Inverse, keine Genehmigung). */
  inverse?: Command[];
  /** updatedRev-Mitschnitt der bei der Genehmigung gestempelten Objekte (Rücknahme-Anker).
   *  korb: Korb-Anker einer trashObject-Genehmigung (CR-03) — id ist die KORB-Eintrags-id;
   *  Korb-Einträge sind unversioniert (updatedRev ungenutzt, Konvention 0), die Rücknahme-
   *  Schranke prüft reine Existenz des Eintrags (manuell wiederhergestellt/geschreddert →
   *  ehrlicher 409 statt CommandError-500 beim Abspielen der restoreObject-Inverse). */
  genehmigteObjekte?: { id: string; updatedRev: number; korb?: boolean }[];
  /** Agenten-Retry-Schutz: unique pro (deskId, createdBy); fehlt = kein Duplikatschutz nötig. */
  idempotenzKey?: string;
  createdBy: string;
  createdById?: string;
  createdAt: number;
  decidedBy?: string;
  decidedById?: string;
  decidedAt?: number;
}

export class VorschlagStatusError extends Error {}
export class VorschlagNichtGefundenError extends Error {}

/** kappeTextSnapshot-Präzedenz (app.ts): lange Eingaben werden gekappt, nicht abgelehnt. */
export const ZUSAMMENFASSUNG_MAX = 280;

/** Eingabe der Fabrik — status/decided_* werden hier gesetzt, nicht vom Aufrufer. */
export interface VorschlagEingabe {
  id: string;
  deskId: string;
  art: string;
  payload: Record<string, unknown>;
  quellen?: Quelle[];
  zusammenfassung: string;
  idempotenzKey?: string;
  createdBy: string;
  createdById?: string;
}

/** Reine Fabrik: kappt die Zusammenfassung, setzt status 'ausstehend' + createdAt. */
export function erstelleVorschlag(eingabe: VorschlagEingabe, jetzt: number): Vorschlag {
  return {
    id: eingabe.id,
    deskId: eingabe.deskId,
    art: eingabe.art,
    payload: eingabe.payload,
    quellen: eingabe.quellen ?? [],
    zusammenfassung: eingabe.zusammenfassung.slice(0, ZUSAMMENFASSUNG_MAX),
    status: 'ausstehend',
    ...(eingabe.idempotenzKey !== undefined ? { idempotenzKey: eingabe.idempotenzKey } : {}),
    createdBy: eingabe.createdBy,
    ...(eingabe.createdById !== undefined ? { createdById: eingabe.createdById } : {}),
    createdAt: jetzt,
  };
}

/**
 * Statusmaschine (immutable): erlaubt ausschließlich ausstehend→genehmigt,
 * ausstehend→abgelehnt und genehmigt→zurückgenommen. Jeder andere Übergang wirft
 * VorschlagStatusError (die Route liefert ihn als 409 aus) — ein zweiter Entscheidungsaufruf
 * auf einen entschiedenen Vorschlag ist damit strukturell ausgeschlossen.
 */
export function uebergang(
  v: Vorschlag,
  aktion: 'genehmigen' | 'ablehnen' | 'zuruecknehmen',
  akteur: { id?: string; name: string },
  jetzt: number,
): Vorschlag {
  const erlaubt =
    (aktion === 'genehmigen' && v.status === 'ausstehend') ||
    (aktion === 'ablehnen' && v.status === 'ausstehend') ||
    (aktion === 'zuruecknehmen' && v.status === 'genehmigt');
  if (!erlaubt) {
    throw new VorschlagStatusError(
      `Übergang nicht erlaubt: Vorschlag ist "${v.status}", verlangte Aktion "${aktion}"`,
    );
  }
  const status: VorschlagStatus =
    aktion === 'genehmigen' ? 'genehmigt' : aktion === 'ablehnen' ? 'abgelehnt' : 'zurückgenommen';
  return {
    ...v,
    status,
    decidedBy: akteur.name,
    ...(akteur.id !== undefined ? { decidedById: akteur.id } : {}),
    decidedAt: jetzt,
  };
}
