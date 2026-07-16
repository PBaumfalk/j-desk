import { BaseDirectory, exists, readFile, readTextFile, rename } from '@tauri-apps/plugin-fs';
import { ask, message } from '@tauri-apps/plugin-dialog';
import type { DesktopState, Link, Stack, Vec2 } from '@digital-desktop/core';
import type { ApiClient } from './api';
import { desktop } from './store.svelte';

interface V1Doc {
  id: string;
  path: string;
  position: Vec2;
  rotation: number;
  zIndex: number;
}

export interface V1State {
  docs: V1Doc[];
  links: Link[];
  stacks: Stack[];
}

const V1_FILE = 'desktop.json';
const base = { baseDir: BaseDirectory.AppData };

export function parseV1(json: string): V1State | null {
  try {
    const v = JSON.parse(json) as V1State | null;
    if (!v || !Array.isArray(v.docs) || !Array.isArray(v.links) || !Array.isArray(v.stacks)) return null;
    if (!v.docs.every((d) => !!d && typeof d.id === 'string' && typeof d.path === 'string')) return null;
    return v;
  } catch {
    return null;
  }
}

function baseName(path: string): string {
  return path.split('/').pop() ?? 'Dokument.pdf';
}

/** Pur: baut aus v1-Zustand + Upload-Zuordnung den neuen Zustand (fehlende Dateien übersprungen). */
export function buildImportedState(v1: V1State, fileIdByDocId: Map<string, string>): DesktopState {
  const docs = v1.docs
    .filter((d) => fileIdByDocId.has(d.id))
    .map((d) => ({
      id: d.id,
      fileId: fileIdByDocId.get(d.id)!,
      name: baseName(d.path),
      position: d.position,
      rotation: d.rotation,
      zIndex: d.zIndex,
    }));
  const docIds = new Set(docs.map((d) => d.id));
  const stacks = v1.stacks
    .map((st) => ({ ...st, docIds: st.docIds.filter((i) => docIds.has(i)) }))
    .filter((st) => st.docIds.length >= 2);
  const stackIds = new Set(stacks.map((st) => st.id));
  const links = v1.links.filter((l) =>
    [l.fromId, l.toId].every((id) => docIds.has(id) || stackIds.has(id)),
  );
  return { docs, links, stacks };
}

/** Bietet nach dem ersten Login einmalig die Übernahme der lokalen v1-Daten an. */
export async function maybeOfferV1Import(api: ApiClient): Promise<void> {
  try {
    if (!(await exists(V1_FILE, base))) return;
    if (desktop.state.docs.length > 0) return; // nur in einen leeren Schreibtisch importieren
    const v1 = parseV1(await readTextFile(V1_FILE, base));
    if (!v1 || v1.docs.length === 0) return;

    const yes = await ask(
      `Es wurde ein Schreibtisch aus der alten Version gefunden (${v1.docs.length} Dokumente). Auf den Server übernehmen?`,
      { title: 'Digital Desktop', kind: 'info' },
    );
    if (!yes) return;

    const fileIdByDocId = new Map<string, string>();
    const skipped: string[] = [];
    for (const d of v1.docs) {
      try {
        fileIdByDocId.set(d.id, await api.uploadFile(await readFile(d.path), baseName(d.path)));
      } catch {
        skipped.push(d.path);
      }
    }

    const state = buildImportedState(v1, fileIdByDocId);
    if (!desktop.deskId) return;
    await api.putState(desktop.deskId, state);
    await desktop.refresh();
    await rename(V1_FILE, 'desktop.json.importiert', {
      oldPathBaseDir: BaseDirectory.AppData,
      newPathBaseDir: BaseDirectory.AppData,
    });
    await message(
      skipped.length === 0
        ? `Übernommen: ${state.docs.length} Dokumente.`
        : `Übernommen: ${state.docs.length} Dokumente.\nÜbersprungen (lokal nicht gefunden):\n${skipped.join('\n')}`,
      { title: 'Import abgeschlossen' },
    );
  } catch {
    // Import ist Komfort — Fehler dürfen den App-Start nie verhindern
  }
}
