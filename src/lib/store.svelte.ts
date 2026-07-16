import { exists } from '@tauri-apps/plugin-fs';
import { emptyState, type DesktopState, setMissing } from '@digital-desktop/core';
import { loadState, saveState } from './persistence';
import { debounce } from './debounce';

let state = $state<DesktopState>(emptyState());

const saveSoon = debounce(400, () => {
  void saveState($state.snapshot(state));
});

export const desktop = {
  get state(): DesktopState {
    return state;
  },

  async init(): Promise<void> {
    state = await loadState();
    for (const d of [...state.docs]) {
      const ok = await exists(d.path).catch(() => false);
      if (ok === d.missing) state = setMissing(state, d.id, !ok);
    }
  },

  apply(fn: (s: DesktopState) => DesktopState, opts: { transient?: boolean } = {}): void {
    state = fn(state);
    if (!opts.transient) saveSoon();
  },

  async saveNow(): Promise<void> {
    saveSoon.cancel();
    await saveState($state.snapshot(state));
  },
};
