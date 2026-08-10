import { CommandError } from './errors';

/**
 * ExternRef (EXT-01, 13-02 Task 2, Vorentscheidung U3): die Kennzeichnung externer Inhalte
 * (Weblink, Urteil, Norm, E-Mail, Foto, Medien, Textfragment) als FELD auf Doc/Note.
 *
 * Bewusst KEIN neuer Objekttyp und keine neue Kartenklasse: ein Typ müsste TrashPayload
 * (trash.ts), findeObjekt (stempel.ts), die objektbezug-Tabellen, Projektion, Export und
 * Suche berühren — exakt die CR-03-Fehlerklasse (app.ts), die für ein Markierungs-Flag
 * unverhältnismäßig ist. Dateibasierte Arten sind Docs (Bestands-Uploadpfad), textbasierte
 * Arten sind Notes mit strukturiertem Text plus dieser Metadaten-Markierung.
 *
 * Das Feld ist DEKLARATIV und niemals rechte-relevant: eine extern-Markierung ändert nichts
 * an Sichtbarkeit, Freigabe oder Export über die Bestandsregeln hinaus — die Kennzeichnung
 * ersetzt keine Ebenen-/Freigabe-Prüfung (T-13-02-05). Der 🌐-Chip ist eine reine Ableitung
 * (chipFuerExtern, 13-06), kein Datenmodell-Eingriff.
 *
 * Validierung (T-13-02-03, ASVS V5): art gegen die sieben Werte; url nur mit Protokoll
 * http/https — ein javascript:- oder protokolloser Wert dürfte sonst in href/title der
 * Karten landen. Die Validator-Position ist der Kommandopfad (commands.ts), nicht die
 * Domänenfunktionen (Trennung Payload-Validierung vs. Domänenlogik, Bestandsmuster).
 */

export type ExternArt = 'weblink' | 'urteil' | 'norm' | 'email' | 'foto' | 'medien' | 'textfragment';

/** Die sieben bekannten Arten — auch UI-Registry für die Erfassungs-Oberfläche (13-06). */
export const EXTERN_ARTEN: readonly ExternArt[] = ['weblink', 'urteil', 'norm', 'email', 'foto', 'medien', 'textfragment'];

export interface ExternRef {
  art: ExternArt;
  url?: string;     // nur http/https (Protokoll-Bremse, T-13-02-03)
  quelle?: string;  // Freitext-Herkunft (z. B. „BGH, VI ZR 1/23", „Mandant Handy")
}

/** Protokoll-Whitelist: ausschließlich http/https (Schema Groß-/Kleinschreibung tolerant). */
const URL_PROTOKOLL = /^https?:\/\//i;

/**
 * Validiert ein externes-Referenz-Payload-Feld: undefined/null bleibt undefined (das Feld
 * ist optional); alles andere muss ein Objekt mit bekannter art sein, url/quelle werden nur
 * in geprüfter Form übernommen. Wirft CommandError mit deutschem Feldnamen.
 */
export function valideExternRef(v: unknown): ExternRef | undefined {
  if (v === undefined || v === null) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new CommandError('Feld "extern" muss ein Objekt sein');
  }
  const r = v as Record<string, unknown>;

  if (typeof r.art !== 'string' || !(EXTERN_ARTEN as readonly string[]).includes(r.art)) {
    throw new CommandError('Feld "extern.art" muss eine bekannte Art sein');
  }

  let url: string | undefined;
  if (r.url !== undefined) {
    if (typeof r.url !== 'string') throw new CommandError('Feld "extern.url" muss ein Text sein');
    if (!URL_PROTOKOLL.test(r.url)) {
      throw new CommandError('Feld "extern.url" muss mit http:// oder https:// beginnen');
    }
    url = r.url;
  }

  let quelle: string | undefined;
  if (r.quelle !== undefined) {
    if (typeof r.quelle !== 'string') throw new CommandError('Feld "extern.quelle" muss ein Text sein');
    quelle = r.quelle;
  }

  return {
    art: r.art as ExternArt,
    ...(url !== undefined ? { url } : {}),
    ...(quelle !== undefined ? { quelle } : {}),
  };
}
