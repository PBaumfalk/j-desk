import type { DeskBackground } from '@digital-desktop/core';

export interface MenuItem {
  label: string;
  action: () => void;
}

export const ui = $state({
  linkingFromId: null as string | null,
  /** Büroklammer: „Anklammern an…" wartet auf das Zielobjekt (Muster linkingFromId). */
  clippingFromId: null as string | null,
  editingStackId: null as string | null,
  editingNoteId: null as string | null,
  fannedStackId: null as string | null,
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
  toast: null as string | null,
  /** Aktive Desk-Pointer (Pan/Pinch) — Karten lassen weitere Finger dann zum Desk durch. */
  deskPointers: 0,
  /** Lupe: runder vergrößerter Ausschnitt folgt dem Zeiger. */
  lupe: false,
  /** Papierkorb: Bildschirm-Rechteck (Drop-Ziel) und geöffnetes Panel. */
  trashRect: null as { x: number; y: number; w: number; h: number } | null,
  trashOpen: false,
  /** Gestaltung: lokale Regler-Vorschau — wirkt nur auf die Darstellung, bis das Command beim Loslassen gesendet ist. */
  backgroundPreview: null as DeskBackground | null,
});

export function showToast(message: string): void {
  ui.toast = message;
  setTimeout(() => {
    if (ui.toast === message) ui.toast = null;
  }, 4000);
}

/** Liegt der Zeiger über dem Papierkorb? (Drop-Erkennung beim Karten-Loslassen) */
export function pointerUeberKorb(clientX: number, clientY: number): boolean {
  const r = ui.trashRect;
  return !!r && clientX >= r.x && clientX <= r.x + r.w && clientY >= r.y && clientY <= r.y + r.h;
}
