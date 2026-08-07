/**
 * Keeps the theme attributes on <html> in step with the settings store and the
 * OS colour scheme.
 *
 * Three attributes are stamped:
 *   data-theme       which palette (see src/lib/themes.ts and index.css)
 *   data-appearance  light | dark — selects the structural values
 *   data-accent      only when the user overrode the palette's own accent
 *
 * The equivalent first-paint pass lives inline in index.html, which runs before
 * this module loads. Keep the two in sync.
 */

import { useSettingsStore } from '../store/settings';
import { findTheme, type ThemeAccent } from './themes';

const darkQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/**
 * The palette to actually use.
 *
 * When following the system, a theme whose appearance disagrees with the OS is
 * swapped for its counterpart — Mocha becomes Latte rather than becoming some
 * unrelated light theme.
 */
export function resolveThemeId(themeId: string, followSystem: boolean): string {
  const theme = findTheme(themeId);
  if (!followSystem) return theme.id;

  const systemAppearance = darkQuery?.matches ? 'dark' : 'light';
  if (theme.appearance === systemAppearance) return theme.id;
  return theme.pairedWith ?? theme.id;
}

export function applyTheme(themeId: string, followSystem: boolean, accent: ThemeAccent): void {
  const el = document.documentElement;
  const resolved = findTheme(resolveThemeId(themeId, followSystem));

  const key = `${resolved.id}|${accent}`;
  // The store fires on every settings change, not just theme ones, and every
  // window rehydrates on the storage event.
  if (el.dataset.themeKey === key) return;
  el.dataset.themeKey = key;

  el.dataset.theme = resolved.id;
  el.dataset.appearance = resolved.appearance;

  if (accent === 'auto') delete el.dataset.accent;
  else el.dataset.accent = accent;
}

/**
 * Starts syncing. Call once at module scope — not from a component — so React's
 * StrictMode double-mount doesn't subscribe twice.
 *
 * Cross-window propagation is free: the store already rehydrates on the
 * `storage` event, rehydrate() calls set(), and set() notifies this subscriber.
 */
export function initThemeRuntime(): () => void {
  const sync = () => {
    const { themeId, followSystem, themeAccent } = useSettingsStore.getState();
    applyTheme(themeId, followSystem, themeAccent);
  };

  sync();

  const unsubscribe = useSettingsStore.subscribe(sync);
  darkQuery?.addEventListener('change', sync);

  return () => {
    unsubscribe();
    darkQuery?.removeEventListener('change', sync);
  };
}
