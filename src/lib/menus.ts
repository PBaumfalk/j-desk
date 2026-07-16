import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { writeFile } from '@tauri-apps/plugin-fs';
import { collectLinkedDocs, type Doc, type Stack } from '@digital-desktop/core';
import { desktop } from './store.svelte';
import { ui, showToast } from './ui.svelte';
import { ensureCached } from './fileCache';

export async function openDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  try {
    await openPath(await ensureCached(desktop.api, doc.fileId));
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Öffnen fehlgeschlagen');
  }
}

export function openWithLinked(entityId: string): void {
  for (const d of collectLinkedDocs(desktop.state, entityId)) void openDoc(d);
}

export async function downloadDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  const target = await saveDialog({ defaultPath: doc.name });
  if (typeof target !== 'string') return;
  try {
    await writeFile(target, await desktop.api.fetchFile(doc.fileId));
    showToast(`Gespeichert: ${doc.name}`);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Herunterladen fehlgeschlagen');
  }
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  ui.menu = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Öffnen', action: () => void openDoc(doc) },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeDoc', { id: doc.id }) },
    ],
  };
}

export function showStackMenu(e: MouseEvent, stack: Stack): void {
  ui.menu = {
    x: e.clientX,
    y: e.clientY,
    items: [
      { label: 'Auffächern', action: () => { ui.fannedStackId = ui.fannedStackId === stack.id ? null : stack.id; } },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(stack.id) },
      { label: 'Benennen…', action: () => { ui.editingStackId = stack.id; } },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = stack.id; } },
      { label: 'Stapel auflösen', action: () => void desktop.command('dissolveStack', { stackId: stack.id }) },
      { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeStack', { stackId: stack.id }) },
    ],
  };
}
