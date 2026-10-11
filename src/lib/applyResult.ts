import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/**
 * Deliver a transform's result to where the text came from.
 *
 * This is the seam between the actions palette and the native platform layer.
 * Today it copies the result to the clipboard, so the user pastes it over the
 * original themselves. The native half (src-tauri/src/platform/paste.rs) will
 * make this paste into the previous app and restore the clipboard afterwards;
 * nothing above this function needs to change when it does.
 *
 * Rejects when the result could not be delivered, so the caller can keep the
 * overlay open and say so instead of hiding on a silent failure.
 */
export async function applyResult(text: string): Promise<void> {
  await writeText(text);
}

/** What pressing Enter will do, for the footer hint and the input placeholder. */
export const APPLY_VERB = 'copies';
