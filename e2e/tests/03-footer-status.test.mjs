import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock, env } from '../lib/app.mjs';
import { sleep } from '../lib/procs.mjs';

/*
 * The provider status in the footer, and the polling fix from PR #8: the
 * availability check runs while the overlay is up and not at all while it is
 * hidden, where it used to fire every five seconds all day.
 */

test('footer: a reachable server shows no warning and names the model', withApp({ settings: seededSettings() }, async (app) => {
  await mock.reset();
  await app.showOverlay();
  // "Connecting…" first, then nothing: the healthy state is the model pill alone.
  await app.waitFor(
    `const s = document.querySelector(".peek-footer-statustext");
     return s === null || !/Connecting/.test(s.innerText);`,
    { what: 'the availability check to finish' },
  );
  assert.equal(await app.text('.peek-footer-statustext'), null, 'no status text when the server is reachable');
  assert.equal(await app.text('.peek-footer-model'), 'mock-model');
  const tags = await mock.to('/api/tags');
  assert.ok(tags.length >= 1, 'the overlay checked availability when it appeared');
  await app.shot('footer-reachable');
}));

test('footer: an unreachable server is reported and clickable', withApp({
  settings: seededSettings({ ollamaBaseUrl: env.deadUrl }),
}, async (app) => {
  await app.showOverlay();
  const text = await app.waitFor(
    `const s = document.querySelector(".peek-footer-statustext");
     return s && /not detected/.test(s.innerText) ? s.innerText : null;`,
    { what: 'the unreachable status' },
  );
  assert.equal(text, 'Ollama not detected — is it running?');
  assert.ok(await app.exec('return document.querySelector(".peek-footer-statustext").classList.contains("peek-tone-error")'));
  assert.equal(await app.exec('return document.querySelector(".peek-footer-statustext").disabled'), false, 'the status is a button that opens Settings');
  await app.shot('footer-unreachable');
}));

test('no availability requests arrive while the overlay is hidden', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  await app.waitFor(
    `const s = document.querySelector(".peek-footer-statustext");
     return s === null || !/Connecting/.test(s.innerText);`,
    { what: 'the first availability check' },
  );
  await app.hideOverlay();
  // Anything already in flight lands now, not during the quiet window.
  await sleep(500);
  await mock.reset();
  // The old poll was every 5 s; 8 s of silence would have seen it fire.
  await sleep(8000);
  const requests = await mock.requests();
  assert.deepEqual(requests.map((r) => r.path), [], 'the hidden overlay made no requests at all');

  await app.showOverlay();
  await app.waitFor('return (await (await fetch(arguments[0] + "/__mock/requests")).json()).some((r) => r.path === "/api/tags")', { what: 'an availability check on reappearing' }).catch(() => {});
  const after = await mock.to('/api/tags');
  assert.ok(after.length >= 1, 'showing the overlay again checks availability');
  await app.shot('footer-polling-fix');
}));
