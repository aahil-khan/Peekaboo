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

/*
 * The overlay's window is one fixed size and the surface grows and shrinks
 * inside it. It used to be resized from the page to follow the content, one
 * IPC call and one compositor resize per frame of every height change, with
 * the content clipped until the window caught up; that was the stutter in
 * every panel, palette and streaming answer. These two tests hold the new
 * arrangement in place: the window must not move while the content does, and
 * the invisible remainder of the window must not become a dead zone.
 */
test('the overlay window keeps one size while its content grows and shrinks', withApp({ settings: seededSettings() }, async (app, t) => {
  await app.showOverlay();
  await app.waitFor('return !document.querySelector(".peek-footer-statustext")', { what: 'the footer to settle' });
  // Layout sizes, not getBoundingClientRect: the surface scales in and out
  // as it appears, and a rect measured mid-animation is a few percent small.
  const measure = () => app.exec(
    `const surface = document.querySelector(".peek-surface");
     return { windowHeight: innerHeight, windowWidth: innerWidth, surfaceHeight: surface.offsetHeight, surfaceBottom: surface.offsetTop + surface.offsetHeight };`,
  );

  const empty = await measure();
  await app.press('h', { alt: true });
  await app.waitFor('return !!document.querySelector(".peek-history")', { what: 'the history panel' });
  await sleep(500);
  const withPanel = await measure();
  await app.shot('overlay-window-fixed-size');
  await app.press('h', { alt: true });
  await app.waitFor('return !document.querySelector(".peek-history")', { what: 'the panel to close' });
  await sleep(500);
  const closed = await measure();
  t.diagnostic(`window ${empty.windowWidth}x${empty.windowHeight}; surface ${empty.surfaceHeight} -> ${withPanel.surfaceHeight} -> ${closed.surfaceHeight}`);

  assert.ok(withPanel.surfaceHeight > empty.surfaceHeight + 100, 'opening a panel makes the surface taller');
  assert.equal(closed.surfaceHeight, empty.surfaceHeight, 'and closing it brings the surface back');
  assert.equal(withPanel.windowHeight, empty.windowHeight, 'the window did not resize when the panel opened');
  assert.equal(closed.windowHeight, empty.windowHeight, 'nor when it closed');
  assert.ok(empty.windowHeight >= 518, `the window is tall enough for the tallest surface (it is ${empty.windowHeight})`);
  assert.ok(withPanel.surfaceBottom <= withPanel.windowHeight, 'the open panel fits inside the window, so nothing is clipped');
}));

test('a press on the empty part of the window dismisses the overlay', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  // A press inside the surface is ordinary use and must not dismiss.
  await app.exec('document.querySelector(".peek-surface textarea").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))');
  await sleep(300);
  assert.equal(await app.exec('return document.visibilityState'), 'visible', 'a press inside the surface leaves the overlay open');

  // Below the surface the window is transparent but still there. A press on
  // it is the click-away the user meant.
  await app.exec('document.documentElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))');
  // Not "until .peek-surface is gone": a hidden webview gets no animation
  // frames, so the exit animation never finishes and the element lingers.
  await app.waitFor('return document.visibilityState === "hidden"', { what: 'the overlay window to hide' });
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
