import {
  BaseDirectory, copyFile, exists, mkdir, readTextFile, writeTextFile,
} from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { emptyState, type DesktopState } from './state/model';

const FILE = 'desktop.json';
const BAK = 'desktop.json.bak';
const base = { baseDir: BaseDirectory.AppData };

export function deserialize(json: string): DesktopState | null {
  try {
    const v = JSON.parse(json);
    if (!v || !Array.isArray(v.docs) || !Array.isArray(v.links) || !Array.isArray(v.stacks)) return null;
    return v as DesktopState;
  } catch {
    return null;
  }
}

async function ensureAppDataDir(): Promise<void> {
  const dir = await appDataDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/** Lädt desktop.json; bei Fehler/Beschädigung das Backup; sonst leerer Schreibtisch. */
export async function loadState(): Promise<DesktopState> {
  await ensureAppDataDir();
  for (const file of [FILE, BAK]) {
    try {
      if (await exists(file, base)) {
        const s = deserialize(await readTextFile(file, base));
        if (s) return s;
      }
    } catch {
      // weiter mit dem nächsten Kandidaten
    }
  }
  return emptyState();
}

/** Schreibt den Zustand; die Vorversion wird vorher als .bak gesichert. */
export async function saveState(s: DesktopState): Promise<void> {
  await ensureAppDataDir();
  if (await exists(FILE, base)) {
    const current = await readTextFile(FILE, base).catch(() => null);
    if (current !== null && deserialize(current)) {
      await copyFile(FILE, BAK, { fromPathBaseDir: BaseDirectory.AppData, toPathBaseDir: BaseDirectory.AppData });
    }
  }
  await writeTextFile(FILE, JSON.stringify(s, null, 2), base);
}
