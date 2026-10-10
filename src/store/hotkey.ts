import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { defaultHotkeyFor, detectPlatform } from '../lib/hotkey';

/**
 * The summon hotkey. Rust owns it (it is registered before any webview loads
 * and saved in the app config directory, not localStorage), so this store is a
 * cache of what Rust last reported, refreshed when any window changes it.
 */

interface HotkeyInfo {
  hotkey: string;
  default: string;
  error: string | null;
}

interface HotkeyState {
  /** Canonical spelling, e.g. "Ctrl+Alt+Space". Format with `formatHotkey` before showing. */
  hotkey: string;
  defaultHotkey: string;
  /** Why the saved chord is not the one in effect, when Rust had to fall back at startup. */
  error: string | null;
  /** True once Rust has answered; before that the values are the platform default. */
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Resolves to the failure reason, or null when the chord is now active and saved. */
  set: (hotkey: string) => Promise<string | null>;
  reset: () => Promise<string | null>;
}

const platformDefault = defaultHotkeyFor(detectPlatform());

export const useHotkeyStore = create<HotkeyState>()((set, get) => ({
  hotkey: platformDefault,
  defaultHotkey: platformDefault,
  error: null,
  loaded: false,

  refresh: async () => {
    try {
      const info = await invoke<HotkeyInfo>('get_hotkey');
      set({ hotkey: info.hotkey, defaultHotkey: info.default, error: info.error, loaded: true });
    } catch {
      // No Tauri runtime (plain browser preview): keep the platform default.
    }
  },

  set: async (hotkey) => {
    try {
      const info = await invoke<HotkeyInfo>('set_hotkey', { hotkey });
      set({ hotkey: info.hotkey, defaultHotkey: info.default, error: info.error, loaded: true });
      return null;
    } catch (err) {
      // Rust may have switched chords and only failed to save, so re-read
      // rather than trust the previous value.
      await get().refresh();
      return err instanceof Error ? err.message : String(err);
    }
  },

  reset: () => get().set(get().defaultHotkey),
}));

if (typeof window !== 'undefined') {
  void useHotkeyStore.getState().refresh();
  // Settings changes it; the overlay's legend and hint must follow.
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen('hotkey-changed', () => { void useHotkeyStore.getState().refresh(); }))
    .catch(() => { /* no Tauri runtime */ });
}
