import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, mapOpenAIModels } from './openai';
import { bodyOf, collect, everySplit, json, streamOf, stubFetch } from './testUtils';

afterEach(() => vi.unstubAllGlobals());

const OPENAI = 'https://api.openai.com/v1';

const CHAT_SSE = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo — wörld"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  // With usage reporting on, the last chunk has an empty choices array.
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[],"usage":{"total_tokens":9}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

describe('OpenAIProvider.stream', () => {
  it('assembles the answer wherever the SSE is cut', async () => {
    for (const chunks of everySplit(CHAT_SSE)) {
      stubFetch(() => new Response(streamOf(chunks)));
      const out = await collect(new OpenAIProvider(OPENAI, 'sk-test').stream([{ role: 'user', content: 'hi' }], 'gpt-x'));
      expect(out).toBe('Hello — wörld');
    }
  });

  it('sends only role and content for each message', async () => {
    const calls = stubFetch(() => new Response(streamOf([])));
    await collect(new OpenAIProvider(OPENAI, 'sk-test').stream([
      { role: 'user', content: 'hi' },
      // Stored assistant messages remember which model wrote them.
      { role: 'assistant', content: 'hello', model: 'gpt-x' },
    ], 'gpt-x'));
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(bodyOf(calls[0]).messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('surfaces the message from an error body', async () => {
    stubFetch(() => json({ error: { message: 'The model `gpt-nope` does not exist', type: 'invalid_request_error', code: 'model_not_found' } }, 404));
    await expect(collect(new OpenAIProvider(OPENAI, 'sk-test').stream([], 'gpt-nope')))
      .rejects.toThrow('OpenAI error (404): The model `gpt-nope` does not exist');
  });

  it('surfaces an error sent as a stream event', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"par"}}]}\n\ndata: {"error":{"message":"Provider returned error","code":502}}\n\n';
    stubFetch(() => new Response(streamOf([new TextEncoder().encode(body)])));
    await expect(collect(new OpenAIProvider('https://openrouter.ai/api/v1', 'k').stream([], 'm')))
      .rejects.toThrow('Provider returned error');
  });
});

describe('mapOpenAIModels on api.openai.com', () => {
  const list = {
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', created: 1715367049, owned_by: 'system' },
      { id: 'gpt-5.1', object: 'model', created: 1762800000, owned_by: 'system' },
      { id: 'o4-mini', object: 'model', created: 1744225351, owned_by: 'system' },
      { id: 'chatgpt-4o-latest', object: 'model', created: 1723515131, owned_by: 'system' },
      { id: 'gpt-3.5-turbo', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'gpt-4', object: 'model', created: 1687882411, owned_by: 'openai' },
      { id: 'gpt-4-0613', object: 'model', created: 1686588896, owned_by: 'openai' },
      { id: 'gpt-4-turbo', object: 'model', created: 1712361441, owned_by: 'system' },
      { id: 'o3-mini', object: 'model', created: 1737146383, owned_by: 'system' },
      { id: 'text-embedding-3-small', object: 'model', created: 1705948997, owned_by: 'system' },
      { id: 'tts-1-hd', object: 'model', created: 1699046015, owned_by: 'system' },
      { id: 'gpt-4o-mini-tts', object: 'model', created: 1741915389, owned_by: 'system' },
      { id: 'whisper-1', object: 'model', created: 1677532384, owned_by: 'openai-internal' },
      { id: 'gpt-4o-transcribe', object: 'model', created: 1742068463, owned_by: 'system' },
      { id: 'dall-e-3', object: 'model', created: 1698785189, owned_by: 'system' },
      { id: 'gpt-image-1', object: 'model', created: 1745517030, owned_by: 'system' },
      { id: 'omni-moderation-latest', object: 'model', created: 1731689265, owned_by: 'system' },
      { id: 'gpt-4o-realtime-preview', object: 'model', created: 1727659998, owned_by: 'system' },
      { id: 'gpt-4o-audio-preview', object: 'model', created: 1727460443, owned_by: 'system' },
      { id: 'davinci-002', object: 'model', created: 1692634301, owned_by: 'system' },
      { id: 'gpt-3.5-turbo-instruct', object: 'model', created: 1692901427, owned_by: 'system' },
    ],
  };

  it('keeps chat models, including families the old prefix filter hid', () => {
    const names = mapOpenAIModels(list, OPENAI).map((m) => m.name);
    expect(names).toEqual([
      'gpt-5.1', 'o4-mini', 'o3-mini', 'chatgpt-4o-latest', 'gpt-4o',
      'gpt-4-turbo', 'gpt-4', 'gpt-4-0613', 'gpt-3.5-turbo',
    ]);
  });

  it('marks everything as vision except the text-only legacy models', () => {
    const vision = Object.fromEntries(mapOpenAIModels(list, OPENAI).map((m) => [m.name, m.isVision]));
    expect(vision).toEqual({
      'gpt-5.1': true,
      'o4-mini': true,
      'chatgpt-4o-latest': true,
      'gpt-4o': true,
      'gpt-4-turbo': true,
      'o3-mini': false,
      'gpt-4': false,
      'gpt-4-0613': false,
      'gpt-3.5-turbo': false,
    });
  });
});

describe('mapOpenAIModels on other endpoints', () => {
  it('shows everything a compatible endpoint lists', () => {
    // Groq-style ids: none start with gpt-, and one has "whisper" in it.
    const list = { object: 'list', data: [
      { id: 'llama-3.3-70b-versatile', object: 'model', created: 1733447754, owned_by: 'Meta' },
      { id: 'whisper-large-v3', object: 'model', created: 1693721698, owned_by: 'OpenAI' },
      { id: 'qwen/qwen3-32b', object: 'model', created: 1748396646, owned_by: 'Alibaba Cloud' },
    ] };
    expect(mapOpenAIModels(list, 'https://api.groq.com/openai/v1').map((m) => m.name))
      .toEqual(['qwen/qwen3-32b', 'llama-3.3-70b-versatile', 'whisper-large-v3']);
  });

  it('uses the modalities an endpoint reports (OpenRouter)', () => {
    const list = { data: [
      { id: 'anthropic/claude-opus-5.5', created: 2, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] } },
      { id: 'meta-llama/llama-3.3-70b-instruct', created: 1, architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] } },
    ] };
    expect(mapOpenAIModels(list, 'https://openrouter.ai/api/v1')).toEqual([
      { name: 'anthropic/claude-opus-5.5', isVision: true },
      // "instruct" is only a non-chat marker on api.openai.com.
      { name: 'meta-llama/llama-3.3-70b-instruct', isVision: false },
    ]);
  });

  it('assumes vision when the endpoint says nothing, and orders by name without dates', () => {
    // LM Studio-style: no `created`, no modality metadata.
    const list = { data: [{ id: 'gemma-3-4b-it' }, { id: 'qwen2.5-7b-instruct' }] };
    expect(mapOpenAIModels(list, 'http://localhost:1234/v1')).toEqual([
      { name: 'qwen2.5-7b-instruct', isVision: true },
      { name: 'gemma-3-4b-it', isVision: true },
    ]);
  });

  it('survives a response with no usable data', () => {
    expect(mapOpenAIModels({}, OPENAI)).toEqual([]);
    expect(mapOpenAIModels({ data: [{ object: 'model' }, null] }, OPENAI)).toEqual([]);
  });
});

describe('OpenAIProvider network calls', () => {
  it('lists models from the configured base URL with the bearer key', async () => {
    const calls = stubFetch(() => json({ data: [{ id: 'gpt-5.1', created: 1 }] }));
    expect(await new OpenAIProvider(OPENAI, 'sk-test').models()).toEqual([{ name: 'gpt-5.1', isVision: true }]);
    expect(calls[0].url).toBe('https://api.openai.com/v1/models');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('checks availability with a GET of the model list, never a completion', async () => {
    const calls = stubFetch(() => json({ data: [] }));
    expect(await new OpenAIProvider(OPENAI, 'sk-test').isAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/models');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('is unavailable on a rejected key, and without a key makes no request', async () => {
    const calls = stubFetch(() => json({ error: { message: 'Incorrect API key provided' } }, 401));
    expect(await new OpenAIProvider(OPENAI, 'sk-bad').isAvailable()).toBe(false);
    expect(await new OpenAIProvider(OPENAI, '').isAvailable()).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
