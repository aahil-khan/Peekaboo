/**
 * The Tauri window label, resolved synchronously at module scope.
 *
 * `getCurrentWebviewWindow()` reads exactly this field, but going through the
 * API means the label is only available once the module graph has initialised.
 * The app previously resolved it in a `useEffect` and rendered `null` until it
 * arrived, which cost a frame of blank paint in every window. Reading the
 * global directly lets routing and window styling happen before React mounts.
 *
 * Kept in sync with the pre-paint script in index.html.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  }
}

export type WindowKind = 'peek' | 'settings' | 'setup';

function readWindowLabel(): string {
  try {
    const label = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    if (label) return label;
  } catch {
    /* Not running under Tauri — e.g. `vite dev` opened in a plain browser. */
  }
  return 'peekaboo';
}

/** Raw Tauri label: 'peekaboo' | 'settings' | 'setup'. */
export const windowLabel = readWindowLabel();

/**
 * Coarse window classification used for styling. Anything unrecognised falls
 * back to 'peek', matching the app's long-standing default.
 */
export const windowKind: WindowKind =
  windowLabel === 'settings' || windowLabel === 'setup' ? windowLabel : 'peek';
