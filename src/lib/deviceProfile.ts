/**
 * Geräteprofil-Erkennung (MOBILE-01/02): reine, DOM-freie Kernlogik. Jeder Zugriff auf
 * `window`, `matchMedia` oder `localStorage` steht hinter einem typeof-Guard bzw. try/catch,
 * damit die Erkennung unter Vitest `environment: 'node'` (kein DOM) testbar bleibt — die
 * reaktive `svelte/reactivity`-Hülle darüber entsteht erst in Plan 11-07/11-09.
 */

export type DeviceProfile = 'desktop' | 'ipad' | 'smartphone';
export type ProfilAuswahl = 'auto' | DeviceProfile;

export const PROFIL_AUSWAHLEN: readonly ProfilAuswahl[] = ['auto', 'desktop', 'ipad', 'smartphone'];
export const DEVICE_PROFILE_KEY = 'jdesk.deviceProfile';
/** Einziger numerischer Schwellwert der Profilerkennung (11-UI-SPEC.md Spacing Exceptions). */
export const BREAKPOINT_SMARTPHONE = 600;

/**
 * Löst das Geräteprofil aus Maßen, Zeigertyp und manueller Übersteuerung auf — reine Funktion:
 * zweimaliger Aufruf mit denselben Argumenten liefert denselben Wert, ohne Nebenwirkung.
 *
 * Verwendet bewusst die KÜRZERE Bildschirmkante (`Math.min(width, height)`), nicht die reine
 * Breite: ein quer gehaltenes Smartphone hat eine lange Kante deutlich über 600px, bleibt über
 * die kürzere Kante aber verlässlich als Smartphone erkannt — orientierungsunabhängig.
 */
export function resolveDeviceProfile(
  width: number,
  height: number,
  pointerCoarse: boolean,
  override: ProfilAuswahl = 'auto',
): DeviceProfile {
  if (override !== 'auto') return override;
  const k = Math.min(width, height);
  if (k < BREAKPOINT_SMARTPHONE) return 'smartphone';
  if (pointerCoarse) return 'ipad';
  return 'desktop';
}

/**
 * Gespeicherte Profil-Übersteuerung; liefert `'auto'`, wenn nichts gespeichert ist, der Wert
 * nicht in `PROFIL_AUSWAHLEN` steht (veraltet/manipuliert) oder der Zugriff wirft (gesperrter
 * Speicher, privates Fenster) — identisches Fallback-Muster wie `LAYER_KEY_PREFIX`
 * (`store.svelte.ts::ladeEbeneFuerWerkzeug`).
 */
export function leseProfilAuswahl(): ProfilAuswahl {
  try {
    const v = localStorage.getItem(DEVICE_PROFILE_KEY);
    if (v && (PROFIL_AUSWAHLEN as readonly string[]).includes(v)) return v as ProfilAuswahl;
  } catch { /* localStorage gesperrt — Fallback reicht */ }
  return 'auto';
}

/** Schreibt die Profil-Übersteuerung (Best-Effort, still bei gesperrtem Speicher). */
export function schreibeProfilAuswahl(auswahl: ProfilAuswahl): void {
  try { localStorage.setItem(DEVICE_PROFILE_KEY, auswahl); } catch { /* s. o. */ }
}

/**
 * Misst das aktuelle Geräteprofil aus der echten Umgebung. Fällt auf `'desktop'` zurück, sobald
 * `window` oder `window.matchMedia` fehlen (Testumgebung, serverseitiges Rendern) — fail open
 * zur bisherigen, getesteten Oberfläche, ohne Fehlertext.
 */
export function erkanntesProfilAusUmgebung(): DeviceProfile {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop';
  const pointerCoarse = window.matchMedia('(pointer: coarse)').matches;
  return resolveDeviceProfile(window.innerWidth, window.innerHeight, pointerCoarse, leseProfilAuswahl());
}

/**
 * Das während einer laufenden Sitzung wirksame Profil: ein eingefrorenes Profil gewinnt immer
 * gegen das gerade erkannte. Grund: eine Drehung oder Größenänderung mitten in einem Termin
 * darf die Oberfläche nicht unter der laufenden Sitzung wegziehen — Plan 11-07 friert beim
 * Sitzungsstart mit dem dann erkannten Profil ein und taut beim Sitzungsende wieder auf
 * (eingefroren = null).
 */
export function aktivesProfil(erkannt: DeviceProfile, eingefroren: DeviceProfile | null): DeviceProfile {
  return eingefroren ?? erkannt;
}

const PROFIL_LABEL: Record<DeviceProfile, string> = {
  desktop: 'Desktop',
  ipad: 'iPad',
  smartphone: 'Smartphone',
};

/** Anzeigename eines Geräteprofils. */
export function profilLabel(profil: DeviceProfile): string {
  return PROFIL_LABEL[profil];
}

/**
 * Die vier festen Zeilen der Profil-Auswahlliste (11-UI-SPEC.md Copywriting Contract) in
 * fester Reihenfolge. Genau die zur aktuellen `auswahl` passende Zeile trägt das „✓ "-Präfix
 * (identisches Muster zum Ebenen-Umschalter); die erste Zeile nennt zusätzlich das erkannte
 * Profil in Klammern, unabhängig davon, ob „Automatisch" gerade aktiv ist.
 */
export function profilMenuZeilen(
  auswahl: ProfilAuswahl,
  erkannt: DeviceProfile,
): { wert: ProfilAuswahl; label: string }[] {
  const zeilen: { wert: ProfilAuswahl; label: string }[] = [
    { wert: 'auto', label: `Automatisch (erkannt: ${profilLabel(erkannt)})` },
    { wert: 'desktop', label: 'Desktop erzwingen' },
    { wert: 'ipad', label: 'iPad erzwingen' },
    { wert: 'smartphone', label: 'Smartphone erzwingen' },
  ];
  return zeilen.map((zeile) => (zeile.wert === auswahl ? { ...zeile, label: `✓ ${zeile.label}` } : zeile));
}
