import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings } from '../lib/app.mjs';
import { sleep } from '../lib/procs.mjs';

/*
 * Summoning and dismissing.
 *
 * Dismissal is two steps: Rust tells the page, the page fades the surface out
 * and says so, and only then is the window unmapped. It used to be unmapped at
 * once, and a hidden webview gets no animation frames, so the fade-out never
 * ran, the surface stayed in the DOM frozen at fully visible, and the next
 * summon had nothing to fade in from. Both directions just popped.
 *
 * None of this can be seen from vitest: it is about what a real, hidden
 * WebKitGTK window does.
 */

const SURFACE_IN_DOM = 'return !!document.querySelector(".peek-surface")';
const PAGE_HIDDEN = 'return document.visibilityState === "hidden"';

test('dismissing lets the surface finish fading out before the window hides', withApp({ settings: seededSettings() }, async (app, t) => {
  await app.showOverlay();
  const started = Date.now();
  await app.invoke('hide_peek');
  await app.waitFor(PAGE_HIDDEN, { what: 'the overlay window to hide' });
  t.diagnostic(`window hidden ${Date.now() - started} ms after hide_peek (the fallback is 400 ms)`);
  // The whole point: by the time the window is gone the exit has completed,
  // so nothing is left half-dismissed to pop back on the next summon.
  assert.equal(await app.exec(SURFACE_IN_DOM), false, 'the surface was removed, so the fade-out ran to completion');
}));

test('the next summon mounts a fresh surface', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  await app.exec('document.querySelector(".peek-surface").dataset.e2eMark = "first"');
  await app.hideOverlay();
  await app.showOverlay();
  assert.equal(
    await app.exec('return document.querySelector(".peek-surface").dataset.e2eMark ?? null'),
    null,
    'the surface is a new element, so its fade-in starts from hidden instead of resuming a frozen one',
  );
  assert.equal(await app.exec('return document.visibilityState'), 'visible');
}));

test('summoning again during the fade-out brings the overlay back and keeps it', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  // The summon key is a toggle. Two presses in quick succession are a
  // dismissal and a change of mind; the second must win, and the first's
  // pending unmap (or its fallback timer) must not hide the window afterwards.
  await app.invoke('toggle_peek');
  await app.invoke('toggle_peek');
  await sleep(900);
  assert.equal(await app.exec('return document.visibilityState'), 'visible', 'the window is still shown well after the fallback would have fired');
  await app.waitFor('return !!document.querySelector(".peek-surface textarea")', { what: 'the surface to be back' });
}));

test('a dismissal still completes when the page never acknowledges it', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  // Stand in for a hung page: swallow the acknowledgement.
  await app.exec(
    `const internals = window.__TAURI_INTERNALS__;
     const original = internals.invoke.bind(internals);
     internals.invoke = (cmd, ...rest) => (cmd === "finish_hide" ? Promise.resolve() : original(cmd, ...rest));`,
  );
  await app.invoke('hide_peek');
  await app.waitFor(PAGE_HIDDEN, { what: 'the fallback to hide the window', timeout: 5000 });
}));
