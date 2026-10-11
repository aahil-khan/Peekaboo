import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock } from '../lib/app.mjs';

/*
 * Pinned memories (PR #10) ride along in the system message. The memory is
 * created through the real panel and pinned with its real button, so this
 * also covers the memory UI end to end.
 */

const MEMORY = 'The user prefers answers in British English.';

async function saveAndPinMemory(app) {
  await app.press('r', { alt: true });
  await app.waitFor('return document.querySelector(".peek-history-title")?.innerText === "Recent Memories"', { what: 'the memories panel' });
  // Typing with the panel open reveals the search box and seeds it.
  await app.press('T');
  await app.waitFor('return !!document.querySelector(".peek-history-search textarea")', { what: 'the memory search box' });
  await app.type('.peek-history-search textarea', MEMORY);
  await app.waitFor('return (document.querySelector(".peek-history-item")?.innerText ?? "").includes("Save")', { what: 'the save action' });
  await app.press('Enter', { css: '.peek-history-search textarea' });
  // Not "a title containing the text": the "Save …" suggestion row already
  // has one, so that passed before the save landed and the Pin click raced
  // the list refresh. The saved row is the one with a pin button.
  await app.waitFor(
    `return !!document.querySelector('[aria-label="Pin: send with every question"]')`,
    { what: 'the saved memory to be listed with its pin button' },
  );
  await app.clickLabelled('Pin: send with every question');
  await app.waitFor('return !!document.querySelector("[aria-label^=\\"Unpin\\"]")', { what: 'the memory to show as pinned' });
  await app.shot('memories-pinned');
  await app.press('Escape');
  await app.waitFor('return !document.querySelector(".peek-history")', { what: 'the panel to close' });
}

test('a pinned memory reaches the mock in the system message', withApp({ settings: seededSettings({ systemPrompt: 'Base prompt.' }) }, async (app) => {
  await mock.reset();
  await app.showOverlay();
  await saveAndPinMemory(app);
  await app.ask('what spelling should you use?');

  const [chat] = await mock.to('/api/chat');
  const system = chat.body.messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.startsWith('Base prompt.'), 'the base prompt comes first');
  assert.match(system.content, /pinned memories/, 'the pinned block has its heading');
  assert.ok(system.content.includes(`- ${MEMORY}`), 'the memory is in the block');
  assert.equal(chat.body.messages.filter((m) => m.role === 'system').length, 1, 'one system message, not one per memory');
  assert.equal(chat.body.messages[1].content, 'what spelling should you use?', 'the memory is not in the conversation itself');
}));

test('with the setting off, pinned memories stay out of the prompt', withApp({ settings: seededSettings({ systemPrompt: 'Base prompt.' }) }, async (app) => {
  await mock.reset();
  await app.showOverlay();
  await saveAndPinMemory(app);

  // Turn the setting off from the Settings window, the way a user would.
  await app.invoke('open_settings');
  await app.use('settings');
  await app.waitFor('return !!document.querySelector(".peek-settings-nav")', { what: 'the settings window' });
  await app.exec('[...document.querySelectorAll(".peek-settings-navbtn")].find((b) => b.innerText.trim() === "Assistant").click()');
  await app.waitFor('return document.querySelector("[aria-label=\\"Send pinned memories with every question\\"]")?.getAttribute("aria-checked") === "true"', { what: 'the toggle, on' });
  await app.clickLabelled('Send pinned memories with every question');
  await app.waitFor('return document.querySelector("[aria-label=\\"Send pinned memories with every question\\"]")?.getAttribute("aria-checked") === "false"', { what: 'the toggle, off' });
  await app.shot('memories-setting-off');

  await app.use('peekaboo');
  await app.waitFor('return JSON.parse(localStorage.getItem("peekaboo-settings")).state.includePinnedMemories === false', { what: 'the overlay to see the setting' });
  await app.showOverlay();
  await app.ask('and now?');

  const [chat] = await mock.to('/api/chat');
  assert.equal(chat.body.messages[0].role, 'system');
  assert.equal(chat.body.messages[0].content, 'Base prompt.', 'only the base prompt is sent');
  assert.doesNotMatch(JSON.stringify(chat.body), /British English/, 'the memory appears nowhere in the request');
}));
