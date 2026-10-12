import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { defaultHotkeyFor, detectPlatform } from '../lib/hotkey';

/**
 * The summon hotkey. Rust owns it (it is registered before any webview loads
 * and saved in the app config directory, not localStorage), so this store is a
 * cache of what Rust last reported, refreshed when any window changes it.
 *
 * On a Wayland desktop with the GlobalShortcuts portal the key is bound by the
 * desktop rather than grabbed by the app: `managedBySystem` is true, `hotkey`
 * is what the desktop actually bound, and changing it goes through
 * `configure` (the desktop's own editor) instead of `set`.
 */

export type HotkeyBackend = 'portal' | 'native' | 'none';
export type HotkeyPhase = 'not-applicable' | 'requested' | 'granted' | 'declined' | 'unavailable' | 'lost';

export interface HotkeyInfo {
  hotkey: string;
  default: string;
  error: string | null;
  backend: HotkeyBackend;
  registered: boolean;
  managedBySystem: boolean;
  triggerDescription: string | null;
  phase: HotkeyPhase;
  canConfigure: boolean;
  note: string | null;
}

interface HotkeyState {
  /** Canonical spelling, e.g. "Ctrl+Alt+Space". Format with `formatHotkey` before showing. */
  hotkey: string;
  defaultHotkey: string;
  /** Why the saved chord is not the one in effect, when Rust had to fall back at startup. */
  error: string | null;
  backend: HotkeyBackend;
  /** Whether pressing `hotkey` summons Peekaboo right now. */
  registered: boolean;
  /** The desktop owns the binding (GlobalShortcuts portal); the recorder does not apply. */
  managedBySystem: boolean;
  /** The desktop's own words for its binding, when it owns it. */
  triggerDescription: string | null;
  phase: HotkeyPhase;
  /** The desktop offers an editor for the binding (`configure`). */
  canConfigure: boolean;
  /** One or two sentences about the portal's state, for Settings. */
  note: string | null;
  /** True once Rust has answered; before that the values are the platform default. */
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Resolves to the failure reason, or null when the chord is now active and saved. */
  set: (hotkey: string) => Promise<string | null>;
  reset: () => Promise<string | null>;
  /** Ask the desktop to open its shortcut editor. Resolves to the failure reason, or null. */
  configure: () => Promise<string | null>;
}

const platformDefault = defaultHotkeyFor(detectPlatform());

function fromInfo(info: HotkeyInfo) {
  return {
    hotkey: info.hotkey,
    defaultHotkey: info.default,
    error: info.error,
    backend: info.backend,
    registered: info.registered,
    managedBySystem: info.managedBySystem,
    triggerDescription: info.triggerDescription,
    phase: info.phase,
    canConfigure: info.canConfigure,
    note: info.note,
    loaded: true,
  };
}

export const useHotkeyStore = create<HotkeyState>()((set, get) => ({
  hotkey: platformDefault,
  defaultHotkey: platformDefault,
  error: null,
  backend: 'native',
  registered: true,
  managedBySystem: false,
  triggerDescription: null,
  phase: 'not-applicable',
  canConfigure: false,
  note: null,
  loaded: false,

  refresh: async () => {
    try {
      const info = await invoke<HotkeyInfo>('get_hotkey');
      set(fromInfo(info));
    } catch {
      // No Tauri runtime (plain browser preview): keep the platform default.
    }
  },

  set: async (hotkey) => {
    try {
      const info = await invoke<HotkeyInfo>('set_hotkey', { hotkey });
      set(fromInfo(info));
      return null;
    } catch (err) {
      // Rust may have switched chords and only failed to save, so re-read
      // rather than trust the previous value.
      await get().refresh();
      return err instanceof Error ? err.message : String(err);
    }
  },

  reset: () => get().set(get().defaultHotkey),

  configure: async () => {
    try {
      const info = await invoke<HotkeyInfo>('configure_hotkey');
      set(fromInfo(info));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
}));

if (typeof window !== 'undefined') {
  void useHotkeyStore.getState().refresh();
  // Settings changes it, and so does the desktop when the portal owns it;
  // the overlay's legend and hint must follow.
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen('hotkey-changed', () => { void useHotkeyStore.getState().refresh(); }))
    .catch(() => { /* no Tauri runtime */ });
}
