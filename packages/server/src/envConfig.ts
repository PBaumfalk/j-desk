/** WR-02: sicherheitsrelevante Stundenwerte (Backup-Takt, Akten-Automatik-Takt) wurden bislang
 *  über ein bares `Number(process.env.X ?? fallback)` gelesen — ein Tippfehler (z. B.
 *  `BACKUP_INTERVAL_HOURS=6h`) liefert `NaN` und wird von der jeweiligen Konsumentenlogik
 *  UNTERSCHIEDLICH (und beide Male falsch) behandelt: `starteBackupIntervall()` schaltet den
 *  Takt still ab (nicht von einer beabsichtigten Deaktivierung unterscheidbar), während
 *  `sollArchivieren()` genau EINMAL archiviert und danach für immer verstummt, ganz ohne
 *  Hinweis auf die Fehlkonfiguration. `parseHours()` ist die einzige Stelle, die einen aus der
 *  Umgebung gelesenen Stundenwert in eine Zahl umwandelt: ein nicht-numerischer Wert wird LAUT
 *  protokolliert (nicht still auf NaN abgebildet) und fällt auf den dokumentierten Standardwert
 *  zurück — dieselbe Semantik wie ein nicht gesetzter Wert, aber mit einer Warnung, die den
 *  Tippfehler sichtbar macht. */
export function parseHours(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  // Number('') === 0 (JS-Eigenheit) — ein leerer, aber GESETZTER Wert (z. B. eine versehentlich
  // leer exportierte Env-Variable) würde sonst still als "0 = abgeschaltet" durchgehen, obwohl
  // vermutlich kein Wert gemeint war. Dieselbe Klasse Fehlkonfiguration wie ein Tippfehler.
  const wert = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(wert)) {
    console.error(
      `Ungültiger Wert für ${name}=${JSON.stringify(raw)} — erwartet eine Zahl (Stunden). ` +
        `Verwende den Standardwert ${fallback} stattdessen.`,
    );
    return fallback;
  }
  return wert;
}
