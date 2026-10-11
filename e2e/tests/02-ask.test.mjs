import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock, MOCK_MODEL } from '../lib/app.mjs';
import { DEFAULT_TOKENS } from '../lib/mock-ollama.mjs';
import { sleep } from '../lib/procs.mjs';

/*
 * The core loop: show the overlay, ask, read the answer. The mock records
 * every request, so the assertions are on what the app actually sent, not on
 * what the provider code looks like it would send.
 */

const SYSTEM_PROMPT = 'You are the e2e system prompt. Answer tersely.';

test('showing the overlay renders the input and the footer', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  assert.ok(await app.isShown('.peek-surface textarea'), 'the input is visible');
  assert.ok(await app.isShown('.peek-footer'), 'the footer is visible');
  assert.equal(await app.text('.peek-footer-model'), MOCK_MODEL, 'the footer names the configured model');
  for (const label of ['New chat', 'History', 'Memories', 'Settings', 'Keyboard shortcuts']) {
    assert.ok(await app.exec('return !!document.querySelector(`.peek-footer [aria-label="${arguments[0]}"]`)', label), `footer has ${label}`);
  }
  await app.shot('overlay-input-and-footer');
}));

// The window is sized to its content by the overlay's ResizeObserver (floor
// 86 px: input plus footer). A taller window is invisible on a desktop, being
// transparent, but it still covers whatever is under it. Reproduction of bug
// 3 in the harness PR.
test('the overlay window is no taller than its content', { todo: 'the overlay window opens taller than its content (harness PR, bug 3)' }, withApp({ settings: seededSettings() }, async (app, t) => {
  await app.showOverlay();
  await app.waitFor('return !document.querySelector(".peek-footer-statustext")', { what: 'the footer to settle' });
  await sleep(600);
  const size = await app.exec(
    `const surface = document.querySelector(".peek-surface").getBoundingClientRect();
     return { windowHeight: innerHeight, windowWidth: innerWidth, surfaceHeight: Math.round(surface.height), surfaceWidth: Math.round(surface.width) };`,
  );
  t.diagnostic(`window ${size.windowWidth}x${size.windowHeight}, surface ${size.surfaceWidth}x${size.surfaceHeight}`);
  await app.shot('overlay-window-size');
  assert.ok(size.windowHeight <= size.surfaceHeight + 4, `window height ${size.windowHeight} should match the surface height ${size.surfaceHeight}`);
}));

test('asking a question streams the mock answer into the transcript', withApp({
  settings: seededSettings({ systemPrompt: SYSTEM_PROMPT, ollamaKeepAlive: '10m' }),
}, async (app) => {
  await mock.reset();
  await mock.configure({ tokens: ['Streamed ', 'answer ', 'from ', 'the ', 'mock.'], delayMs: 150 });
  await app.showOverlay();
  await app.type('.peek-surface textarea', 'What is the e2e question?');
  await app.press('Enter', { css: '.peek-surface textarea' });

  // Mid-stream: the partial answer is on screen while the mock is still
  // sending, which is what "streams" means from the user's side.
  const partial = await app.waitFor(
    `const el = document.querySelector(".peek-thread-assistant");
     const text = el ? el.innerText.trim() : "";
     return text.length > 0 && text.length < "Streamed answer from the mock.".length ? text : null;`,
    { what: 'a partial answer while streaming' },
  );
  assert.ok('Streamed answer from the mock.'.startsWith(partial), `partial "${partial}" is a prefix of the answer`);
  assert.ok(await app.exec('return !!document.querySelector("[aria-label=\\"Stop generating\\"]")'), 'the stop control shows while streaming');

  const answer = await app.waitFor(
    `const el = document.querySelector(".peek-thread-assistant");
     return el && !el.dataset.live && el.innerText.trim() === "Streamed answer from the mock." ? el.innerText.trim() : null;`,
    { what: 'the complete answer' },
  );
  assert.equal(answer, 'Streamed answer from the mock.');
  assert.equal(await app.text('.peek-thread-user-bubble'), 'What is the e2e question?');
  assert.equal(await app.exec('return !!document.querySelector("[aria-label=\\"Stop generating\\"]")'), false, 'the stop control goes away');

  const chats = await mock.to('/api/chat');
  assert.equal(chats.length, 1, 'exactly one chat request');
  const body = chats[0].body;
  assert.equal(body.model, MOCK_MODEL);
  assert.equal(body.stream, true);
  assert.equal(body.keep_alive, '10m', 'the configured keep_alive is sent');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, SYSTEM_PROMPT, 'the system prompt is the configured one');
  assert.deepEqual(body.messages[1], { role: 'user', content: 'What is the e2e question?' });
  assert.equal(body.messages.length, 2);
  assert.equal(chats[0].aborted, false, 'the app read the whole stream');
  // The native client must not announce the webview as a web page.
  assert.equal(chats[0].headers.origin, undefined, 'no Origin header on the request');
  await app.shot('ask-streamed-answer');
}));

test('keep_alive -1 goes out as a number, as Ollama requires', withApp({
  settings: seededSettings({ ollamaKeepAlive: '-1' }),
}, async (app) => {
  await mock.reset();
  await app.showOverlay();
  const answer = await app.ask('keep me loaded');
  assert.equal(answer, DEFAULT_TOKENS.join(''));
  const [chat] = await mock.to('/api/chat');
  assert.strictEqual(chat.body.keep_alive, -1);
}));

test('a follow-up question carries the conversation so far', withApp({ settings: seededSettings() }, async (app) => {
  await mock.reset();
  await app.showOverlay();
  await app.ask('first');
  await app.ask('second');
  const chats = await mock.to('/api/chat');
  assert.equal(chats.length, 2);
  const roles = chats[1].body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
  assert.equal(chats[1].body.messages[2].content, DEFAULT_TOKENS.join(''), 'the first answer is sent back as context');
  assert.equal(chats[1].body.messages[3].content, 'second');
  await app.shot('ask-follow-up');
}));
