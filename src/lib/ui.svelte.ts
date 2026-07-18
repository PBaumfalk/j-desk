export interface MenuItem {
  label: string;
  action: () => void;
}

export const ui = $state({
  linkingFromId: null as string | null,
  editingStackId: null as string | null,
  fannedStackId: null as string | null,
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
  toast: null as string | null,
  /** Aktive Desk-Pointer (Pan/Pinch) — Karten lassen weitere Finger dann zum Desk durch. */
  deskPointers: 0,
});

export function showToast(message: string): void {
  ui.toast = message;
  setTimeout(() => {
    if (ui.toast === message) ui.toast = null;
  }, 4000);
}
