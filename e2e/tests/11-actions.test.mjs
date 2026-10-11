import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock } from '../lib/app.mjs';

/*
 * The actions loop end to end: text to act on, one key to open the palette,
 * a transform run from the keyboard, and Enter to apply the result.
 *
 * The text goes in through the clipboard, by the palette's own clipboard
 * path, which does not depend on any plugin having loaded. The
 * mock answers with the quoted form a small model tends to produce, so the
 * assertion on the clipboard also covers the output cleanup.
 */

const TEXT = 'i recieved you\'re email yesterday';
const ANSWER_TOKENS = ['"I received ', 'your email ', 'yesterday."'];
const CLEANED = 'I received your email yesterday.';

const ANSWER_DONE = `
  const turns = document.querySelectorAll(".peek-thread-assistant");
  const last = turns[turns.length - 1];
  return !!last && !last.dataset.live && !last.querySelector(".peek-loading-dots") && last.innerText.trim().length > 0;`;

/**
 * Puts `text` on the display's clipboard through the same plugin command the
 * app's writeText() uses (its arguments are `{ label, text }`); false, with
 * the reason on the test log, when this display has no clipboard.
 */
async function seedClipboard(app, text, t) {
  try {
    await app.invoke('plugin:clipboard-manager|write_text', { text });
    return true;
  } catch (err) {
    t.diagnostic(`clipboard write failed: ${err.message ?? err}`);
    return false;
  }
}

/** Opens the palette with Alt+A and returns what it says it will act on. */
async function openPalette(app) {
  await app.press('a', { alt: true, css: '.peek-surface textarea' });
  return app.waitFor(
    `const name = document.querySelector(".peek-actions-source-name");
     const empty = document.querySelector(".peek-actions-source-empty");
     return name ? name.innerText.trim() : empty ? "empty" : null;`,
    { what: 'the actions palette' },
  );
}

test('a transform runs from the keyboard and Enter copies the cleaned result', withApp({ settings: seededSettings() }, async (app, t) => {
  await mock.reset();
  await mock.configure({ tokens: ANSWER_TOKENS, delayMs: 20 });
  await app.showOverlay();

  if (!(await seedClipboard(app, TEXT, t))) {
    t.skip('this display has no clipboard to seed');
    return;
  }
  const source = await openPalette(app);
  if (source === 'empty') {
    t.skip('the clipboard write did not come back through this display');
    return;
  }
  assert.match(source, /Clipboard/, 'the palette names the clipboard as its source');
  assert.match(await app.text('.peek-actions-source-preview'), /i recieved you're email/, 'and previews it');
  await app.shot('actions-palette-clipboard');

  // Arrow keys move the selection; the first transform is the default.
  assert.equal(await app.text('[aria-selected="true"] .peek-slash-item-title'), 'Fix spelling and grammar');
  await app.press('ArrowDown', { css: '.peek-surface textarea' });
  assert.equal(await app.text('[aria-selected="true"] .peek-slash-item-title'), 'Rewrite more clearly');
  await app.press('ArrowUp', { css: '.peek-surface textarea' });
  assert.equal(await app.text('[aria-selected="true"] .peek-slash-item-title'), 'Fix spelling and grammar');

  await app.press('Enter', { css: '.peek-surface textarea' });
  await app.waitFor(ANSWER_DONE, { what: 'the transform to finish' });

  // The transcript shows the action and the text it ran on, not the template.
  assert.equal(await app.text('.peek-thread-user-bubble'), 'Fix spelling and grammar');
  assert.match(await app.text('.peek-user-context-chip'), /i recieved you're email/);
  assert.equal(await app.exec('return !document.querySelector(".peek-actions")'), true, 'the palette is gone once the action ran');
  assert.match(await app.text('.peek-footer-statustext'), /Enter copies the result/, 'the footer says what Enter will do');
  await app.shot('actions-transform-result');

  // The model got the rendered template, with the text inside it.
  const [chat] = await mock.to('/api/chat');
  const user = chat.body.messages.find((m) => m.role === 'user');
  assert.match(user.content, /^You are a text editor\. Fix the spelling/, 'the prompt starts with the action template');
  assert.ok(user.content.includes(`<text>\n${TEXT}\n</text>`), 'with the clipboard text in it');
  assert.doesNotMatch(user.content, /<action|<context>/, 'and none of the stored markup');

  // Enter on the empty input applies the result and hides the overlay.
  assert.equal(await app.exec('return document.querySelector(".peek-surface textarea").value'), '');
  await app.press('Enter', { css: '.peek-surface textarea' });
  await app.waitFor('return document.visibilityState === "hidden"', { what: 'the overlay to hide after applying' });
  const clipboard = await app.invoke('plugin:clipboard-manager|read_text');
  assert.equal(clipboard, CLEANED, 'the clipboard holds the result with the wrapping quotes removed');
}));

test('a follow-up after an action sends the rendered prompt as history', withApp({ settings: seededSettings() }, async (app, t) => {
  await mock.reset();
  await app.showOverlay();
  if (!(await seedClipboard(app, TEXT, t)) || (await openPalette(app)) === 'empty') {
    t.skip('no clipboard on this display');
    return;
  }
  await app.press('Enter', { css: '.peek-surface textarea' });
  await app.waitFor(ANSWER_DONE, { what: 'the transform to finish' });

  await app.ask('why that change?');
  const chats = await mock.to('/api/chat');
  assert.equal(chats.length, 2);
  const roles = chats[1].body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
  assert.match(chats[1].body.messages[1].content, /^You are a text editor\./, 'the action turn is re-rendered for the model');
  assert.equal(chats[1].body.messages[3].content, 'why that change?');
}));

test('a typed question keeps Enter while the palette is open', withApp({ settings: seededSettings() }, async (app, t) => {
  await mock.reset();
  await app.showOverlay();
  if (!(await seedClipboard(app, TEXT, t)) || (await openPalette(app)) === 'empty') {
    t.skip('no clipboard on this display');
    return;
  }
  // "fix" still matches an action; a sentence matches none.
  await app.type('.peek-surface textarea', 'fix');
  assert.equal(await app.text('[aria-selected="true"] .peek-slash-item-title'), 'Fix spelling and grammar');
  await app.type('.peek-surface textarea', 'fix the meeting time please');
  await app.waitFor('return !!document.querySelector(".peek-slash-empty")', { what: 'the no-match state' });
  assert.match(await app.text('.peek-slash-empty'), /Enter sends your question/);

  await app.press('Enter', { css: '.peek-surface textarea' });
  await app.waitFor(ANSWER_DONE, { what: 'the answer' });
  const [chat] = await mock.to('/api/chat');
  const user = chat.body.messages.find((m) => m.role === 'user');
  assert.equal(user.content, 'fix the meeting time please', 'the question went as typed, with nothing attached');
  assert.equal(await app.text('.peek-thread-user-bubble'), 'fix the meeting time please');
}));
