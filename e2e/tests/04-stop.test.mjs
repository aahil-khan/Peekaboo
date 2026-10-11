import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock } from '../lib/app.mjs';
import { waitUntil } from '../lib/procs.mjs';

/*
 * Stopping a stream. The frontend aborting its reader is not enough: the
 * request has to end at the server, or the model keeps generating for an
 * answer nobody will read. The mock knows whether the connection closed
 * before it finished, so that is what is asserted.
 */

const LONG = Array.from({ length: 60 }, (_, i) => `token${i} `);

test('stopping a stream part-way ends the request at the server', withApp({ settings: seededSettings() }, async (app) => {
  await mock.reset();
  await mock.configure({ tokens: LONG, delayMs: 200 });
  await app.showOverlay();
  await app.type('.peek-surface textarea', 'tell me a long story');
  await app.press('Enter', { css: '.peek-surface textarea' });

  await app.waitFor(
    `const el = document.querySelector(".peek-thread-assistant");
     return el && (el.innerText.match(/token/g) || []).length >= 3;`,
    { what: 'three tokens on screen' },
  );
  await app.shot('stop-mid-stream');
  await app.press('q', { alt: true });

  const chat = await waitUntil(async () => {
    const [c] = await mock.to('/api/chat');
    return c?.aborted ? c : null;
  }, { timeout: 5000, what: 'the mock to see the connection close' });
  assert.ok(chat.tokensSent < LONG.length, `the server stopped early (${chat.tokensSent} of ${LONG.length} tokens)`);

  await app.waitFor('return !document.querySelector("[aria-label=\\"Stop generating\\"]")', { what: 'streaming to end in the UI' });
  const text = await app.text('.peek-thread-assistant');
  assert.match(text, /^token0 token1/, 'the partial answer stays on screen');
  assert.equal(await app.exec('return document.querySelector(".peek-surface textarea").disabled'), false, 'the input is usable again');
  await app.shot('stop-after');
}));

test('the stop button in the input does the same as Alt+Q', withApp({ settings: seededSettings() }, async (app) => {
  await mock.reset();
  await mock.configure({ tokens: LONG, delayMs: 200 });
  await app.showOverlay();
  await app.type('.peek-surface textarea', 'another long one');
  await app.press('Enter', { css: '.peek-surface textarea' });
  await app.waitFor('return !!document.querySelector("[aria-label=\\"Stop generating\\"]")', { what: 'the stop button' });
  await app.waitFor('const el = document.querySelector(".peek-thread-assistant"); return el && el.innerText.includes("token1")', { what: 'tokens on screen' });
  await app.clickLabelled('Stop generating');
  await waitUntil(async () => (await mock.to('/api/chat'))[0]?.aborted, { timeout: 5000, what: 'the server to see the abort' });
}));
