import { BaseDirectory, exists, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';

export interface Session {
  serverUrl: string;
  token: string;
  lastDeskId?: string;
}

const FILE = 'session.json';
const base = { baseDir: BaseDirectory.AppData };

export function parseSession(json: string): Session | null {
  try {
    const v = JSON.parse(json) as Session | null;
    if (!v || typeof v.serverUrl !== 'string' || typeof v.token !== 'string') return null;
    return {
      serverUrl: v.serverUrl,
      token: v.token,
      ...(typeof v.lastDeskId === 'string' ? { lastDeskId: v.lastDeskId } : {}),
    };
  } catch {
    return null;
  }
}

export async function loadSession(): Promise<Session | null> {
  try {
    if (await exists(FILE, base)) return parseSession(await readTextFile(FILE, base));
  } catch {
    // wie nicht vorhanden behandeln
  }
  return null;
}

export async function saveSession(session: Session): Promise<void> {
  await writeTextFile(FILE, JSON.stringify(session), base);
}

export async function clearSession(): Promise<void> {
  await remove(FILE, base).catch(() => {});
}

/** Merkt sich den zuletzt aktiven Schreibtisch (pro Gerät). */
export async function saveLastDeskId(deskId: string): Promise<void> {
  const session = await loadSession();
  if (session) await saveSession({ ...session, lastDeskId: deskId });
}
