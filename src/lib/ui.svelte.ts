export interface MenuItem {
  label: string;
  action: () => void;
}

export const ui = $state({
  linkingFromId: null as string | null,
  editingStackId: null as string | null,
  fannedStackId: null as string | null,
  menu: null as { x: number; y: number; items: MenuItem[] } | null,
});
