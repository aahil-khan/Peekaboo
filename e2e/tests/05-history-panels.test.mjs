import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings, mock } from '../lib/app.mjs';
import { DEFAULT_TOKENS } from '../lib/mock-ollama.mjs';

/*
 * History and the four panels. The panel-scoping fix (PR #7) is the point of
 * the "input stays visible" assertions: a panel covers the conversation area,
 * never the input.
 */

const PANELS = [
  { id: 'history', key: 'h', label: 'History', title: 'Recent' },
  { id: 'models', key: 'm', css: '.peek-footer-model', title: 'Models' },
  { id: 'legend', key: '/', label: 'Keyboard shortcuts', title: 'Shortcuts' },
  { id: 'memory', key: 'r', label: 'Memories', title: 'Recent Memories' },
];

test('the exchange is in history after a new chat', withApp({ settings: seededSettings() }, async (app) => {
  await mock.reset();
  await app.showOverlay();
  const answer = await app.ask('remember this question');
  assert.equal(answer, DEFAULT_TOKENS.join(''));

  await app.clickLabelled('New chat');
  await app.waitFor('return !document.querySelector(".peek-thread-exchange")', { what: 'the transcript to clear' });
  assert.equal(await app.exec('return document.querySelector(".peek-surface textarea").value'), '');

  await app.press('h', { alt: true });
  await app.waitFor('return document.querySelector(".peek-history-title")?.innerText === "Recent"', { what: 'the history panel' });
  const items = await app.exec('return [...document.querySelectorAll(".peek-history-item-title")].map((el) => el.innerText.trim())');
  assert.ok(items.some((t) => t.includes('remember this question')), `history lists the exchange: ${JSON.stringify(items)}`);
  await app.shot('history-after-new-chat');

  // Reopen it: the transcript comes back from SQLite, not from memory.
  await app.click('.peek-history-item');
  await app.waitFor('return !!document.querySelector(".peek-thread-exchange")', { what: 'the session to load' });
  assert.equal(await app.text('.peek-thread-user-bubble'), 'remember this question');
  assert.equal((await app.text('.peek-thread-assistant')).trim(), DEFAULT_TOKENS.join(''));
  await app.shot('history-reopened');
}));

for (const panel of PANELS) {
  test(`the ${panel.id} panel opens and the input stays visible`, withApp({ settings: seededSettings() }, async (app) => {
    await app.showOverlay();
    await app.ask('a question so the body has content');

    // Keyboard first, then the footer button toggles it back off and on.
    await app.press(panel.key, { alt: true });
    await app.waitFor(`return document.querySelector(".peek-history-title")?.innerText === ${JSON.stringify(panel.title)}`, { what: `the ${panel.id} panel` });
    assert.ok(await app.isShown('.peek-surface textarea'), 'the input is still visible with the panel open');
    assert.ok(await app.isShown('.peek-footer'), 'the footer is still visible with the panel open');
    const [inputBox, panelBox] = await app.exec(
      `const r = (css) => document.querySelector(css).getBoundingClientRect();
       return [r(".peek-input-container"), r(".peek-history")];`,
    );
    assert.ok(panelBox.top >= inputBox.bottom - 1, `the panel (top ${panelBox.top}) sits below the input (bottom ${inputBox.bottom}), not over it`);
    await app.shot(`panel-${panel.id}`);

    await app.press(panel.key, { alt: true });
    await app.waitFor('return !document.querySelector(".peek-history")', { what: 'the panel to close' });

    if (panel.css) await app.click(panel.css); else await app.clickLabelled(panel.label);
    await app.waitFor(`return document.querySelector(".peek-history-title")?.innerText === ${JSON.stringify(panel.title)}`, { what: `the ${panel.id} panel from the footer` });
    await app.press('Escape');
    await app.waitFor('return !document.querySelector(".peek-history")', { what: 'Escape to close the panel' });
    assert.ok(await app.isShown('.peek-surface textarea'), 'Escape closed the panel, not the overlay');
  }));
}

test('the models panel lists the mock model and the legend shows the summon hotkey', withApp({ settings: seededSettings() }, async (app) => {
  await app.showOverlay();
  await app.press('m', { alt: true });
  await app.waitFor('return document.querySelector(".peek-history-title")?.innerText === "Models"', { what: 'the models panel' });
  const models = await app.waitFor('const t = document.querySelector(".peek-history-list").innerText; return t.includes("mock-model") ? t : null', { what: 'the model list' });
  assert.match(models, /mock-model/);
  await app.press('Escape');

  await app.press('/', { alt: true });
  await app.waitFor('return document.querySelector(".peek-history-title")?.innerText === "Shortcuts"', { what: 'the legend' });
  const legend = await app.text('.peek-history');
  assert.match(legend, /Ctrl\+Alt\+Space/, 'the legend names the configured summon hotkey');
  assert.match(legend, /Ctrl\+Q/, 'the legend names the quit chord');
  await app.shot('panel-legend-hotkeys');
}));
