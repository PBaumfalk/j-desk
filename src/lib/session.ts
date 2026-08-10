export interface Session {
  token: string;
  lastDeskId?: string;
  /** Angemeldeter Name (MOBILE-02, 11-09): die Telefon-Aufgabenliste filtert auf den eigenen
   *  Verantwortlichen — der Bestand kannte bisher keine clientseitige Namensquelle. Optional:
   *  Sitzungen aus der Zeit vor diesem Feld tragen es nicht, die Liste zeigt dann nur
   *  unverantwortete Aufgaben (fail-open, kein falscher Fremdname). */
  name?: string;
}

const KEY = 'digital-desktop.session';

export function parseSession(json: string): Session | null {
  try {
    const v = JSON.parse(json) as Session | null;
    if (!v || typeof v.token !== 'string') return null;
    return {
      token: v.token,
      ...(typeof v.lastDeskId === 'string' ? { lastDeskId: v.lastDeskId } : {}),
      ...(typeof v.name === 'string' ? { name: v.name } : {}),
    };
  } catch {
    return null;
  }
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSession(raw) : null;
  } catch {
    return null; // z. B. localStorage gesperrt — wie nicht vorhanden behandeln
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Speichern ist Komfort — Anmeldung funktioniert auch ohne
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // bereits weg
  }
}

/** Merkt sich den zuletzt aktiven Schreibtisch (pro Browser). */
export function saveLastDeskId(deskId: string): void {
  const session = loadSession();
  if (session) saveSession({ ...session, lastDeskId: deskId });
}
