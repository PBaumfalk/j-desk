import { BaseDirectory, exists, mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { appCacheDir, join } from '@tauri-apps/api/path';
import type { ApiClient } from './api';

const base = { baseDir: BaseDirectory.AppCache };

/** Lädt die Server-Datei einmalig in den lokalen Cache und liefert den absoluten Pfad. */
export async function ensureCached(api: ApiClient, fileId: string): Promise<string> {
  const rel = `files/${fileId}.pdf`;
  if (!(await exists(rel, base))) {
    await mkdir('files', { ...base, recursive: true }).catch(() => {});
    await writeFile(rel, await api.fetchFile(fileId), base);
  }
  return await join(await appCacheDir(), rel);
}
