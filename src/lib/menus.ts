import { collectLinkedDocs, type Doc, type Stack } from '@digital-desktop/core';
import { desktop } from './store.svelte';
import { ui, showToast } from './ui.svelte';
import { getFileUrl } from './fileCache';

export async function openDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  // Fenster synchron zur Nutzergeste öffnen, sonst greift der Popup-Blocker.
  const win = window.open('', '_blank');
  try {
    const url = await getFileUrl(desktop.api, doc.fileId);
    if (win) win.location.href = url;
    else window.open(url, '_blank');
  } catch (e) {
    win?.close();
    showToast(e instanceof Error ? e.message : 'Öffnen fehlgeschlagen');
  }
}

export function openWithLinked(entityId: string): void {
  for (const d of collectLinkedDocs(desktop.state, entityId)) void openDoc(d);
}

export async function downloadDoc(doc: Doc): Promise<void> {
  if (!desktop.api) return;
  try {
    const a = document.createElement('a');
    a.href = await getFileUrl(desktop.api, doc.fileId);
    a.download = doc.name;
    a.click();
    showToast(`Heruntergeladen: ${doc.name}`);
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Herunterladen fehlgeschlagen');
  }
}

export function showDocMenuAt(x: number, y: number, doc: Doc): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Aufschlagen', action: () => void desktop.command('expandDoc', { id: doc.id }) },
      { label: 'In neuem Tab öffnen', action: () => void openDoc(doc) },
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      { label: 'Vom Schreibtisch entfernen', action: () => void desktop.command('removeDoc', { id: doc.id }) },
    ],
  };
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  showDocMenuAt(e.clientX, e.clientY, doc);
}

export function showStackMenuAt(x: number, y: number, stack: Stack): void {
  ui.menu = {
    x, y,
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

export function showStackMenu(e: MouseEvent, stack: Stack): void {
  showStackMenuAt(e.clientX, e.clientY, stack);
}
