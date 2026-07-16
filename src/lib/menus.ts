import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  type Doc, type Stack, collectLinkedPaths, setDocPath, dissolveStack, removeDoc, removeStack,
} from '@digital-desktop/core';
import { desktop } from './store.svelte';
import { ui } from './ui.svelte';
import { invalidateThumbnail } from './thumbnails';

export function openWithLinked(entityId: string): void {
  for (const p of collectLinkedPaths(desktop.state, entityId)) void openPath(p);
}

export async function relinkDoc(doc: Doc): Promise<void> {
  const picked = await openDialog({ multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (typeof picked === 'string') {
    invalidateThumbnail(doc.id);
    desktop.apply((s) => setDocPath(s, doc.id, picked));
  }
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  const items = doc.missing
    ? [
        { label: 'Datei neu verknüpfen…', action: () => void relinkDoc(doc) },
        { label: 'Vom Schreibtisch entfernen', action: () => desktop.apply((s) => removeDoc(s, doc.id)) },
      ]
    : [
        { label: 'Öffnen', action: () => void openPath(doc.path) },
        { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(doc.id) },
        { label: 'Verknüpfen…', action: () => { ui.linkingFromId = doc.id; } },
        { label: 'Im Finder zeigen', action: () => void revealItemInDir(doc.path) },
        { label: 'Vom Schreibtisch entfernen', action: () => desktop.apply((s) => removeDoc(s, doc.id)) },
      ];
  ui.menu = { x: e.clientX, y: e.clientY, items };
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
      { label: 'Stapel auflösen', action: () => desktop.apply((s) => dissolveStack(s, stack.id)) },
      { label: 'Vom Schreibtisch entfernen', action: () => desktop.apply((s) => removeStack(s, stack.id)) },
    ],
  };
}
