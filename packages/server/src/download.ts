/** Header-Aufbereitung für Datei-Downloads (z. B. .jdesk-Export). Reines String-Handling,
    kein Bezug zum .jdesk-Paketformat — deshalb ein eigenes Modul statt jdesk.ts. */

/** Dateinamen auf Unproblematisches reduzieren — Schreibtischnamen sind frei wählbar.
    Leerzeichen bleiben erhalten; in Dateinamen sind sie unproblematisch. Steuerzeichen
    (u. a. \r, \n) müssen raus, sonst wirft Node beim Setzen des content-disposition-Headers
    synchron einen TypeError ("Invalid character in header content") und die Route
    antwortet ungefangen mit 500 statt mit einem sauberen Download.
    `endung` ist seit 03-01 parametrierbar ('.pdf' für die Übergabe-Artefakte); der
    Default '.jdesk' hält alle Bestandsaufrufer unverändert. */
export function dateiname(name: string, endung: '.jdesk' | '.pdf' = '.jdesk'): string {
  // eslint-disable-next-line no-control-regex -- Steuerzeichen sind hier gerade das Ziel.
  const sauber = name.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, '-').trim();
  return `${sauber === '' ? 'Schreibtisch' : sauber}${endung}`;
}

/** content-disposition nach RFC 5987: ein ASCII-sicherer Rückfallwert in filename="..."
    (Zeichen außerhalb des druckbaren ASCII-Bereichs durch "-" ersetzt) für Clients ohne
    filename*-Unterstützung, plus filename*=UTF-8''<prozentkodiert> mit dem vollständigen
    Namen für moderne Browser. Ohne das schlägt setHeader schon bei einem einzelnen
    Halbgeviertstrich oder Zeichen außerhalb Latin-1 fehl.

    toWellFormed() ersetzt unpaarige UTF-16-Surrogate (z. B. aus einem manipulierten
    JSON-Body) durch U+FFFD, bevor encodeURIComponent läuft — sonst wirft encodeURIComponent
    ein ungefangenes URIError ("URI malformed") und die Route antwortet mit 500 statt mit
    einem Download. Wohlgeformte Surrogatpaare (z. B. Emoji) bleiben davon unberührt und
    werden weiterhin korrekt prozentkodiert. */
export function contentDisposition(name: string): string {
  const wohlgeformt = name.toWellFormed();
  // eslint-disable-next-line no-control-regex -- druckbares ASCII als Rückfall-Whitelist.
  const ascii = wohlgeformt.replace(/[^\x20-\x7e]/g, '-');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(wohlgeformt)}`;
}
