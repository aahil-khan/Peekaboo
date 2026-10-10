import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlamaProvider } from './llama';
import { collect, everySplit, json, streamOf, stubFetch } from './testUtils';

afterEach(() => vi.unstubAllGlobals());

// llama-server speaks the OpenAI chat-completions SSE format.
const CHAT_SSE = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{"content":"lo — wörld"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

describe('LlamaProvider.stream', () => {
  it('assembles the answer wherever the SSE is cut', async () => {
    for (const chunks of everySplit(CHAT_SSE)) {
      stubFetch(() => new Response(streamOf(chunks)));
      const out = await collect(new LlamaProvider('http://llama.test').stream([{ role: 'user', content: 'hi' }], 'm'));
      expect(out).toBe('Hello — wörld');
    }
  });

  it('releases the connection once [DONE] arrives', async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      // Stays open after [DONE], as a keep-alive connection would.
      start(c) { c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n')); },
      cancel,
    })));
    expect(await collect(new LlamaProvider('http://llama.test').stream([], 'm'))).toBe('x');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('surfaces the body of a failed request', async () => {
    stubFetch(() => json({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }, 503));
    await expect(collect(new LlamaProvider('http://llama.test').stream([], 'm')))
      .rejects.toThrow('llama.cpp error (503): Loading model');
  });
});

describe('LlamaProvider.models', () => {
  it('lists the server\'s models', async () => {
    const calls = stubFetch(() => json({ object: 'list', data: [{ id: 'qwen2.5-7b-instruct-q4_k_m.gguf', object: 'model' }] }));
    expect(await new LlamaProvider('http://llama.test/').models())
      .toEqual([{ name: 'qwen2.5-7b-instruct-q4_k_m.gguf', isVision: false }]);
    expect(calls[0].url).toBe('http://llama.test/v1/models');
  });

  it('returns an empty list when the server is down', async () => {
    stubFetch(() => { throw new TypeError('fetch failed'); });
    expect(await new LlamaProvider('http://llama.test').models()).toEqual([]);
  });
});
