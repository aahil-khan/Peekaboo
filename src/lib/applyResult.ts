import { invoke } from '@tauri-apps/api/core';

/**
 * Deliver a transform's result to where the text came from.
 *
 * This is the seam between the actions palette and the native platform layer
 * (src-tauri/src/platform/paste.rs). The native side puts the text on the
 * clipboard, hides the overlay so focus returns to the app the user came
 * from, checks that it is still the window that had focus when Peekaboo was
 * summoned, presses the platform's paste chord, and restores the old
 * clipboard afterwards.
 *
 * Resolves with what actually happened: `pasted`, or `copied` when the paste
 * was refused or failed, with the reason. In the copied case the overlay is
 * still open and the result is on the clipboard, so the caller should say so
 * rather than hide. Rejects only when the clipboard itself could not be
 * written.
 */
export type ApplyOutcome =
  | { outcome: 'pasted'; method: string }
  | { outcome: 'copied'; reason: string };

export async function applyResult(text: string): Promise<ApplyOutcome> {
  return invoke<ApplyOutcome>('paste_result', { text });
}

/** What pressing Enter will do, for the footer hint and the input placeholder. */
export const APPLY_VERB = 'pastes';

/** The platform's paste chord, for the "press it yourself" fallback message. */
export const PASTE_CHORD = /Mac/i.test(navigator.platform) ? 'Cmd+V' : 'Ctrl+V';

/** One line for the toast when the result was copied instead of pasted. */
export function copiedInsteadMessage(reason: string): string {
  return `Copied instead — press ${PASTE_CHORD} in your app. ${reason}`;
}
