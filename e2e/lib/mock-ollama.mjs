import http from 'node:http';

/**
 * Just enough of Ollama's HTTP API for the app to believe it, plus a control
 * API the tests use to read back what the app sent.
 *
 *   GET  /api/tags        the model list (one model, "mock-model")
 *   POST /api/show        model details
 *   POST /api/chat        a streamed NDJSON answer, one token per line
 *
 *   GET  /__mock/requests every request so far, with body, timing and whether
 *                         the app closed the connection before the end
 *   POST /__mock/reset    forget recorded requests and restore the defaults
 *   POST /__mock/config   {"tokens": [...], "delayMs": n} for the next answers
 *
 * Answers are deterministic by construction, which is what lets a test assert
 * on the transcript character for character.
 */
export const MOCK_MODEL = 'mock-model';
export const DEFAULT_TOKENS = ['The ', 'mock ', 'model ', 'says ', 'hello.'];

export function createMockOllama() {
  const state = {
    requests: [],
    tokens: DEFAULT_TOKENS,
    delayMs: 20,
    nextId: 1,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      handle(req, res, body);
    });
  });

  function record(req, body) {
    const entry = {
      id: state.nextId++,
      method: req.method,
      path: req.url,
      headers: req.headers,
      body,
      startedAt: Date.now(),
      finishedAt: null,
      /** True when the client went away before the response was complete. */
      aborted: false,
      tokensSent: 0,
    };
    state.requests.push(entry);
    return entry;
  }

  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }

  function handle(req, res, body) {
    const url = new URL(req.url, 'http://mock');

    if (url.pathname === '/__mock/requests') {
      return json(res, 200, state.requests);
    }
    if (url.pathname === '/__mock/reset') {
      state.requests = [];
      state.tokens = DEFAULT_TOKENS;
      state.delayMs = 20;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__mock/config') {
      if (Array.isArray(body?.tokens)) state.tokens = body.tokens;
      if (typeof body?.delayMs === 'number') state.delayMs = body.delayMs;
      return json(res, 200, { tokens: state.tokens, delayMs: state.delayMs });
    }

    const entry = record(req, body);
    const finish = () => { entry.finishedAt = Date.now(); };

    if (url.pathname === '/api/tags') {
      finish();
      return json(res, 200, {
        models: [{
          name: MOCK_MODEL,
          model: MOCK_MODEL,
          modified_at: '2026-10-11T00:00:00Z',
          size: 1,
          digest: 'mock',
          details: { family: 'mock', families: ['mock'], parameter_size: '1B', quantization_level: 'Q4_0' },
        }],
      });
    }
    if (url.pathname === '/api/show') {
      finish();
      return json(res, 200, {
        details: { family: 'mock', families: ['mock'], parameter_size: '1B', quantization_level: 'Q4_0' },
        capabilities: ['completion'],
      });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      return streamChat(entry, body, res, finish);
    }

    finish();
    json(res, 404, { error: `mock ollama has no ${req.method} ${url.pathname}` });
  }

  function streamChat(entry, body, res, finish) {
    const tokens = state.tokens;
    const delayMs = state.delayMs;
    const model = body?.model ?? MOCK_MODEL;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    let i = 0;
    let timer = null;
    const line = (value) => res.write(JSON.stringify(value) + '\n');

    // Node fires 'close' after a normal end as well, so the order of
    // `finishedAt` and `end()` is what tells an abort from a completion.
    res.on('close', () => {
      if (timer) clearTimeout(timer);
      if (!entry.finishedAt) {
        entry.aborted = true;
        entry.finishedAt = Date.now();
      }
    });

    const step = () => {
      if (i < tokens.length) {
        line({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: tokens[i] }, done: false });
        i += 1;
        entry.tokensSent = i;
        timer = setTimeout(step, delayMs);
        return;
      }
      finish();
      line({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' });
      res.end();
    };
    step();
  }

  return {
    state,
    listen: (port) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${port}`));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The test-side view of the mock, over its control API. */
export class MockClient {
  constructor(url) {
    this.url = url;
  }
  async requests() {
    const res = await fetch(`${this.url}/__mock/requests`);
    return res.json();
  }
  async reset() {
    await fetch(`${this.url}/__mock/reset`, { method: 'POST' });
  }
  async configure(config) {
    await fetch(`${this.url}/__mock/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  }
  /** Recorded requests whose path starts with `prefix`. */
  async to(prefix) {
    return (await this.requests()).filter((r) => r.path.startsWith(prefix));
  }
}

// Runnable on its own for poking at the app by hand: node e2e/lib/mock-ollama.mjs 20001
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 20001);
  createMockOllama().listen(port).then((url) => console.log(`mock ollama at ${url}`));
}
