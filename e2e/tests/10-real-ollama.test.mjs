import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, seededSettings } from '../lib/app.mjs';
import { portOpen } from '../lib/procs.mjs';

/*
 * One question to a real Ollama, if there is one and the run asks for it:
 *
 *   E2E_REAL_OLLAMA=1 npm run e2e -- real
 *
 * Local only. The suite never depends on it, and CI has no Ollama.
 */

const url = process.env.E2E_REAL_OLLAMA_URL || 'http://127.0.0.1:11434';
const model = process.env.E2E_REAL_OLLAMA_MODEL || 'llama3.2';
const wanted = process.env.E2E_REAL_OLLAMA === '1';
const reachable = wanted && await portOpen(Number(new URL(url).port));

test(`a real Ollama (${model}) answers through the real app`, { skip: wanted ? (reachable ? false : `${url} is not listening`) : 'set E2E_REAL_OLLAMA=1' }, withApp({
  settings: seededSettings({ ollamaBaseUrl: url, activeModel: model }),
}, async (app) => {
  await app.showOverlay();
  await app.waitFor('return !document.querySelector(".peek-footer-statustext")', { what: 'Ollama to be reported reachable', timeout: 20000 });
  const answer = await app.ask('Reply with the single word PONG and nothing else.', { timeout: 120000 });
  assert.ok(answer.length > 0, 'got an answer');
  assert.match(answer, /pong/i, `the model followed the instruction: ${answer}`);
  await app.shot('real-ollama-answer');
}));
