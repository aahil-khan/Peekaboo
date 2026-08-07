/**
 * Keeps the `data-theme` / `data-accent` attributes on <html> in step with the
 * settings store and the OS colour scheme.
 *
 * The store's mode may be 'system', but the DOM only ever sees 'light' or
 * 'dark' — CSS therefore never has to reason about a third value.
 *
 * The equivalent of the first-paint pass lives inline in index.html, which runs
 * before this module is loaded. Keep the two in sync.
 */

import { useSettingsStore, type ThemeMode, type ThemeAccent } from '../store/settings';

const darkQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/** Collapse 'system' down to what the OS currently reports. */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return darkQuery?.matches ? 'dark' : 'light';
  return mode;
}

export function applyTheme(mode: ThemeMode, accent: ThemeAccent): void {
  const el = document.documentElement;
  const next = `${resolveTheme(mode)}|${accent}`;
  // Cheap guard: the store fires on every settings change, not just theme ones,
  // and every window rehydrates on the storage event.
  if (el.dataset.themeKey === next) return;
  el.dataset.themeKey = next;
  el.dataset.theme = resolveTheme(mode);
  el.dataset.accent = accent;
}

/**
 * Starts syncing. Call once at module scope — not from a component — so React's
 * StrictMode double-mount doesn't subscribe twice.
 *
 * Cross-window propagation comes for free: the store already rehydrates on the
 * `storage` event, rehydrate() calls set() internally, and set() notifies this
 * subscriber.
 */
export function initThemeRuntime(): () => void {
  const sync = () => {
    const { themeMode, themeAccent } = useSettingsStore.getState();
    applyTheme(themeMode, themeAccent);
  };

  sync();

  const unsubscribe = useSettingsStore.subscribe(sync);
  darkQuery?.addEventListener('change', sync);

  return () => {
    unsubscribe();
    darkQuery?.removeEventListener('change', sync);
  };
}
