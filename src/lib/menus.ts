import { clipOf, collectLinkedDocs, isTaped, type Cutout, type Doc, type Note, type NoteKind, type Stack } from '@digital-desktop/core';
import { desktop } from './store.svelte';
import { ui, showToast, type MenuItem } from './ui.svelte';
import { getFileUrl } from './fileCache';

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  notiz: 'Notiz',
  frage: 'Frage',
  these: 'These',
  angriffspunkt: 'Angriffspunkt',
  risiko: 'Risiko',
};

function papierkorbEintrag(objektId: string): MenuItem {
  return { label: 'In den Papierkorb', action: () => void desktop.command('trashObject', { id: objektId, trashedAt: new Date().toISOString() }) };
}

function befestigungsEintraege(objektId: string): MenuItem[] {
  const items: MenuItem[] = [];
  items.push(
    isTaped(desktop.state, objektId)
      ? { label: 'Band abziehen', action: () => void desktop.command('untapeObject', { id: objektId }) }
      : { label: 'Festkleben', action: () => void desktop.command('tapeObject', { id: objektId }) },
  );
  const clip = clipOf(desktop.state, objektId);
  items.push({ label: 'Anklammern an…', action: () => { ui.clippingFromId = objektId; } });
  if (clip) items.push({ label: 'Klammer entfernen', action: () => void desktop.command('removeClip', { clipId: clip.id }) });
  return items;
}

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
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: doc.id }) },
      { label: 'Herunterladen…', action: () => void downloadDoc(doc) },
      ...befestigungsEintraege(doc.id),
      papierkorbEintrag(doc.id),
    ],
  };
}

export function showDocMenu(e: MouseEvent, doc: Doc): void {
  showDocMenuAt(e.clientX, e.clientY, doc);
}

export function showStackMenuAt(x: number, y: number, stack: Stack): void {
  const basis: MenuItem[] = stack.stapled
    ? [
        { label: 'Aufschlagen', action: () => void desktop.command('expandStack', { id: stack.id }) },
        { label: 'Entheften', action: () => void desktop.command('unstapleStack', { stackId: stack.id }) },
      ]
    : [
        { label: 'Auffächern', action: () => { ui.fannedStackId = ui.fannedStackId === stack.id ? null : stack.id; } },
        { label: 'Heften', action: () => void desktop.command('stapleStack', { stackId: stack.id }) },
        { label: 'Stapel auflösen', action: () => void desktop.command('dissolveStack', { stackId: stack.id }) },
      ];
  ui.menu = {
    x, y,
    items: [
      ...basis,
      { label: 'Mit allen Verknüpften öffnen', action: () => openWithLinked(stack.id) },
      { label: 'Benennen…', action: () => { ui.editingStackId = stack.id; } },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = stack.id; } },
      ...befestigungsEintraege(stack.id),
      papierkorbEintrag(stack.id),
    ],
  };
}

export function showStackMenu(e: MouseEvent, stack: Stack): void {
  showStackMenuAt(e.clientX, e.clientY, stack);
}

export function showNoteMenuAt(x: number, y: number, note: Note): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Bearbeiten', action: () => { ui.editingNoteId = note.id; } },
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = note.id; } },
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: note.id }) },
      ...befestigungsEintraege(note.id),
      papierkorbEintrag(note.id),
    ],
  };
}

export function showNoteMenu(e: MouseEvent, note: Note): void {
  showNoteMenuAt(e.clientX, e.clientY, note);
}

export function showCutoutMenuAt(x: number, y: number, cutout: Cutout): void {
  ui.menu = {
    x, y,
    items: [
      { label: 'Verknüpfen…', action: () => { ui.linkingFromId = cutout.id; } },
      { label: 'Kopieren', action: () => void desktop.command('copyObject', { id: cutout.id }) },
      ...befestigungsEintraege(cutout.id),
      papierkorbEintrag(cutout.id),
    ],
  };
}

export function showCutoutMenu(e: MouseEvent, cutout: Cutout): void {
  showCutoutMenuAt(e.clientX, e.clientY, cutout);
}
