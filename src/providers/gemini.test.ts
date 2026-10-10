import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider, mapGeminiModels, toGeminiParts } from './gemini';
import { bodyOf, collect, everySplit, json, streamOf, stubFetch } from './testUtils';

afterEach(() => vi.unstubAllGlobals());

const encoder = new TextEncoder();

// streamGenerateContent?alt=sse: one GenerateContentResponse per data line.
const STREAM_SSE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"},"index":0}],"modelVersion":"gemini-x"}',
  '',
  'data: {"candidates":[{"content":{"parts":[{"text":"reasoning","thought":true},{"text":"lo — "},{"text":"wörld"}],"role":"model"},"index":0}]}',
  '',
  'data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"totalTokenCount":9}}',
  '',
  '',
].join('\r\n');

describe('GeminiProvider.stream', () => {
  it('assembles every text part wherever the SSE is cut, skipping thoughts', async () => {
    for (const chunks of everySplit(STREAM_SSE)) {
      stubFetch(() => new Response(streamOf(chunks)));
      const out = await collect(new GeminiProvider('AIza-test').stream([{ role: 'user', content: 'hi' }], 'gemini-x'));
      expect(out).toBe('Hello — wörld');
    }
  });

  it('maps roles, the system prompt and images to Gemini\'s request shape', async () => {
    const calls = stubFetch(() => new Response(streamOf([])));
    await collect(new GeminiProvider('AIza-test').stream([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
        ],
      },
      { role: 'assistant', content: 'a cat' },
    ], 'gemini-x'));

    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse&key=AIza-test'
    );
    expect(bodyOf(calls[0])).toEqual({
      systemInstruction: { role: 'user', parts: [{ text: 'Be brief.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'what is this' }, { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } }] },
        { role: 'model', parts: [{ text: 'a cat' }] },
      ],
    });
  });

  it('surfaces the message from an error body', async () => {
    stubFetch(() => json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, 400));
    await expect(collect(new GeminiProvider('bad').stream([{ role: 'user', content: 'hi' }], 'gemini-x')))
      .rejects.toThrow('Gemini error (400): API key not valid. Please pass a valid API key.');
  });

  it('says so when the prompt is blocked', async () => {
    const body = 'data: {"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{}}\n\n';
    stubFetch(() => new Response(streamOf([encoder.encode(body)])));
    expect(await collect(new GeminiProvider('k').stream([{ role: 'user', content: 'hi' }], 'gemini-x')))
      .toContain('blocked this request: SAFETY');
  });
});

describe('mapGeminiModels', () => {
  // Fields per the models.list reference; ids are illustrative.
  const page = {
    models: [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens', 'createCachedContent', 'batchGenerateContent'] },
      { name: 'models/gemma-3-27b-it', displayName: 'Gemma 3 27B', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-embedding-001', displayName: 'Gemini Embedding', supportedGenerationMethods: ['embedContent', 'countTextTokens'] },
      { name: 'models/imagen-4.0-generate-001', displayName: 'Imagen 4', supportedGenerationMethods: ['predict'] },
      { name: 'models/veo-3.0-generate-001', displayName: 'Veo 3', supportedGenerationMethods: ['predictLongRunning'] },
      { name: 'models/aqa', displayName: 'Attributed QA', supportedGenerationMethods: ['generateAnswer'] },
      { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-2.5-flash-image', displayName: 'Gemini 2.5 Flash Image', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-live-test', displayName: 'Live only', supportedGenerationMethods: ['bidiGenerateContent'] },
      { name: 'models/no-methods-field', displayName: 'Missing field' },
    ],
  };

  it('keeps only models that generate text content', () => {
    expect(mapGeminiModels(page).map((m) => m.name)).toEqual(['gemini-2.5-flash', 'gemma-3-27b-it']);
  });

  it('marks the Gemini family as vision and nothing else', () => {
    expect(mapGeminiModels(page)).toEqual([
      { name: 'gemini-2.5-flash', isVision: true },
      { name: 'gemma-3-27b-it', isVision: false },
    ]);
  });

  it('survives a response with no usable data', () => {
    expect(mapGeminiModels({})).toEqual([]);
    expect(mapGeminiModels({ models: [null, {}] })).toEqual([]);
  });
});

describe('toGeminiParts', () => {
  it('wraps a plain string as one text part', () => {
    expect(toGeminiParts('hi')).toEqual([{ text: 'hi' }]);
  });
});

describe('GeminiProvider network calls', () => {
  it('lists models across pages', async () => {
    const calls = stubFetch(({ url }) => url.includes('pageToken=')
      ? json({ models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }] })
      : json({ models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'tok/2' }));

    expect(await new GeminiProvider('AIza-test').models()).toEqual([
      { name: 'gemini-b', isVision: true },
      { name: 'gemini-a', isVision: true },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=AIza-test',
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=AIza-test&pageToken=tok%2F2',
    ]);
  });

  it('checks availability with a GET of the model list, never a generation', async () => {
    const calls = stubFetch(() => json({ models: [] }));
    expect(await new GeminiProvider('AIza-test').isAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=AIza-test');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('is unavailable on a rejected key, and without a key makes no request', async () => {
    const calls = stubFetch(() => json({ error: { code: 400, message: 'API key not valid' } }, 400));
    expect(await new GeminiProvider('bad').isAvailable()).toBe(false);
    expect(await new GeminiProvider('').isAvailable()).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
