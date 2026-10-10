import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider, ollamaKeepAliveParam } from './ollama';
import { bodyOf, collect, everySplit, json, streamOf, stubFetch } from './testUtils';

afterEach(() => vi.unstubAllGlobals());

// The shape of /api/chat with stream: true — one JSON object per line.
const CHAT_NDJSON = [
  '{"model":"llama3.2","message":{"role":"assistant","content":"Hel"},"done":false}',
  '{"model":"llama3.2","message":{"role":"assistant","content":"lo — "},"done":false}',
  '{"model":"llama3.2","message":{"role":"assistant","content":"wörld"},"done":false}',
  '{"model":"llama3.2","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}',
].join('\n') + '\n';

describe('OllamaProvider.stream', () => {
  it('assembles the answer wherever the NDJSON is cut', async () => {
    for (const chunks of everySplit(CHAT_NDJSON)) {
      stubFetch(() => new Response(streamOf(chunks)));
      const out = await collect(new OllamaProvider('http://ollama.test').stream([{ role: 'user', content: 'hi' }], 'llama3.2'));
      expect(out).toBe('Hello — wörld');
    }
  });

  it('sends the configured keep_alive, not a hardcoded one', async () => {
    const calls = stubFetch(() => new Response(streamOf([])));
    await collect(new OllamaProvider('http://ollama.test', '30m').stream([{ role: 'user', content: 'hi' }], 'm'));
    expect(calls[0].url).toBe('http://ollama.test/api/chat');
    expect(bodyOf(calls[0]).keep_alive).toBe('30m');
  });

  it('defaults keep_alive to Ollama\'s own default', async () => {
    const calls = stubFetch(() => new Response(streamOf([])));
    await collect(new OllamaProvider('http://ollama.test').stream([{ role: 'user', content: 'hi' }], 'm'));
    expect(bodyOf(calls[0]).keep_alive).toBe('5m');
  });

  it('sends images as bare base64, separate from the text', async () => {
    const calls = stubFetch(() => new Response(streamOf([])));
    await collect(new OllamaProvider('http://ollama.test').stream([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    }], 'm'));
    expect(bodyOf(calls[0]).messages).toEqual([{ role: 'user', content: 'what is this', images: ['QUJD'] }]);
  });

  it('surfaces the body of a failed request', async () => {
    stubFetch(() => json({ error: 'model "nope" not found, try pulling it first' }, 404));
    await expect(collect(new OllamaProvider('http://ollama.test').stream([], 'nope')))
      .rejects.toThrow('Ollama error (404): model "nope" not found, try pulling it first');
  });

  it('surfaces an error reported after streaming began', async () => {
    const body = '{"message":{"content":"par"},"done":false}\n{"error":"llama runner process has terminated"}\n';
    stubFetch(() => new Response(streamOf([new TextEncoder().encode(body)])));
    await expect(collect(new OllamaProvider('http://ollama.test').stream([], 'm')))
      .rejects.toThrow('llama runner process has terminated');
  });

  it('stops with an AbortError when the user aborts mid-stream', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode('{"message":{"content":"one"}}\n')); },
    })));
    const seen: string[] = [];
    const run = (async () => {
      for await (const piece of new OllamaProvider('http://ollama.test').stream([], 'm', controller.signal)) {
        seen.push(piece);
      }
    })();
    // The stream is open and silent, as it is while a model is generating.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['one']);
  });
});

describe('ollamaKeepAliveParam', () => {
  it('sends durations as strings and the special values as numbers', () => {
    expect(ollamaKeepAliveParam('5m')).toBe('5m');
    expect(ollamaKeepAliveParam('1h')).toBe('1h');
    // Ollama rejects the string "-1": it is not a Go duration.
    expect(ollamaKeepAliveParam('-1')).toBe(-1);
    expect(ollamaKeepAliveParam('0')).toBe(0);
    expect(ollamaKeepAliveParam('')).toBe('5m');
  });
});

describe('OllamaProvider.models', () => {
  it('maps tags and reads vision support from /api/show', async () => {
    const calls = stubFetch(({ url, init }) => {
      if (url.endsWith('/api/tags')) {
        return json({
          models: [
            { name: 'llama3.2:latest', details: { parameter_size: '3.2B', family: 'llama', quantization_level: 'Q4_K_M' } },
            { name: 'gemma3:4b', details: { parameter_size: '4.3B', family: 'gemma3', quantization_level: 'Q4_K_M' } },
          ],
        });
      }
      const name = JSON.parse(String(init.body)).name;
      return json(name === 'gemma3:4b'
        ? { details: { families: ['gemma3'] }, capabilities: ['completion', 'vision'] }
        : { details: { families: ['llama'] }, capabilities: ['completion', 'tools'] });
    });

    const models = await new OllamaProvider('http://ollama-models.test/').models();
    expect(models).toEqual([
      { name: 'llama3.2:latest', isVision: false, parameterSize: '3.2B', family: 'llama', quantization: 'Q4_K_M' },
      { name: 'gemma3:4b', isVision: true, parameterSize: '4.3B', family: 'gemma3', quantization: 'Q4_K_M' },
    ]);
    // A trailing slash on the configured address must not produce "//api".
    expect(calls[0].url).toBe('http://ollama-models.test/api/tags');
  });

  it('returns an empty list when Ollama is unreachable', async () => {
    stubFetch(() => { throw new TypeError('fetch failed'); });
    expect(await new OllamaProvider('http://ollama-down.test').models()).toEqual([]);
  });
});

describe('OllamaProvider.isAvailable', () => {
  it('is a GET of the tag list', async () => {
    const calls = stubFetch(() => json({ models: [] }));
    expect(await new OllamaProvider('http://ollama.test').isAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://ollama.test/api/tags');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
  });

  it('is false when the connection fails', async () => {
    stubFetch(() => { throw new TypeError('fetch failed'); });
    expect(await new OllamaProvider('http://ollama.test').isAvailable()).toBe(false);
  });
});
