import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, anthropicMaxTokens, mapAnthropicModels, toAnthropicContent } from './anthropic';
import { bodyOf, collect, everySplit, json, streamOf, stubFetch } from './testUtils';

afterEach(() => vi.unstubAllGlobals());

const encoder = new TextEncoder();

// Event sequence from the Messages streaming docs, with a thinking block
// first, as current models produce by default.
const MESSAGE_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5-5","stop_reason":null}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"not shown"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQB"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}',
  '',
  'event: content_block_delta',
  'data: {"type": "content_block_delta","index": 1,"delta": {"type": "text_delta", "text": "lo — wörld"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

function sse(...events: object[]): Response {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(streamOf([encoder.encode(text)]));
}

describe('AnthropicProvider.stream', () => {
  it('assembles the text deltas wherever the SSE is cut, ignoring thinking', async () => {
    for (const chunks of everySplit(MESSAGE_SSE)) {
      stubFetch(() => new Response(streamOf(chunks)));
      const out = await collect(new AnthropicProvider('sk-ant-test').stream([{ role: 'user', content: 'hi' }], 'claude-opus-5-5'));
      expect(out).toBe('Hello — wörld');
    }
  });

  it('sends the system prompt separately and converts images to image blocks', async () => {
    const calls = stubFetch(() => sse({ type: 'message_stop' }));
    await collect(new AnthropicProvider('sk-ant-test').stream([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      },
      { role: 'assistant', content: 'a cat', model: 'claude-opus-5-5' },
      { role: 'user', content: 'sure?' },
    ], 'claude-opus-5-5'));

    const call = calls[0];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = bodyOf(call);
    expect(body.system).toBe('Be brief.');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        ],
      },
      { role: 'assistant', content: 'a cat' },
      { role: 'user', content: 'sure?' },
    ]);
  });

  it('omits `system` when there is no system prompt', async () => {
    const calls = stubFetch(() => sse({ type: 'message_stop' }));
    await collect(new AnthropicProvider('k').stream([{ role: 'user', content: 'hi' }], 'm'));
    expect('system' in bodyOf(calls[0])).toBe(false);
  });

  it('surfaces the message from an error body, not just the status', async () => {
    stubFetch(() => json({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-3-haiku-20240307' }, request_id: 'req_1' }, 404));
    await expect(collect(new AnthropicProvider('k').stream([{ role: 'user', content: 'hi' }], 'claude-3-haiku-20240307')))
      .rejects.toThrow('Anthropic error (404): model: claude-3-haiku-20240307');
  });

  it('surfaces an error event sent inside a 200 stream', async () => {
    stubFetch(() => sse(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ));
    await expect(collect(new AnthropicProvider('k').stream([{ role: 'user', content: 'hi' }], 'm')))
      .rejects.toThrow('Anthropic error: Overloaded');
  });

  it('says so when the model declines or runs out of output', async () => {
    stubFetch(() => sse({ type: 'message_delta', delta: { stop_reason: 'refusal' } }));
    expect(await collect(new AnthropicProvider('k').stream([{ role: 'user', content: 'hi' }], 'm')))
      .toContain('declined');

    stubFetch(() => sse(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    ));
    const out = await collect(new AnthropicProvider('k').stream([{ role: 'user', content: 'hi' }], 'm'));
    expect(out.startsWith('half an ans')).toBe(true);
    expect(out).toContain('output limit');
  });
});

// Shape from the List Models reference: newest first, capabilities per model.
const MODELS_PAGE = {
  data: [
    {
      type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z',
      lifecycle: 'active', max_input_tokens: 1000000, max_tokens: 128000,
      capabilities: { image_input: { supported: true }, pdf_input: { supported: true } },
    },
    {
      type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z',
      lifecycle: 'active', max_input_tokens: 200000, max_tokens: 64000,
      capabilities: { image_input: { supported: true } },
    },
    {
      type: 'model', id: 'claude-text-only-test', display_name: 'Text only', created_at: '2025-01-01T00:00:00Z',
      lifecycle: 'deprecated', max_input_tokens: 200000, max_tokens: 8192,
      capabilities: { image_input: { supported: false } },
    },
    {
      type: 'model', id: 'claude-unknown-test', display_name: 'No capability data', created_at: '2025-01-01T00:00:00Z',
      lifecycle: 'active', max_input_tokens: null, max_tokens: null, capabilities: null,
    },
  ],
  first_id: 'claude-opus-5-5',
  has_more: false,
  last_id: 'claude-unknown-test',
};

describe('mapAnthropicModels', () => {
  it('keeps the API\'s order and reads vision from capabilities.image_input', () => {
    expect(mapAnthropicModels(MODELS_PAGE)).toEqual([
      { name: 'claude-opus-5-5', isVision: true },
      { name: 'claude-haiku-4-5-20251001', isVision: true },
      { name: 'claude-text-only-test', isVision: false },
      { name: 'claude-unknown-test', isVision: false },
    ]);
  });

  it('survives a response with no usable data', () => {
    expect(mapAnthropicModels({})).toEqual([]);
    expect(mapAnthropicModels({ data: [null, { type: 'model' }] })).toEqual([]);
  });
});

describe('max_tokens', () => {
  it('is clamped to the model\'s own limit once the model list is known', () => {
    mapAnthropicModels(MODELS_PAGE);
    expect(anthropicMaxTokens('claude-opus-5-5')).toBe(64000);
    expect(anthropicMaxTokens('claude-haiku-4-5-20251001')).toBe(64000);
    expect(anthropicMaxTokens('claude-text-only-test')).toBe(8192);
  });

  it('falls back to a value every model accepts when the limit is unknown', () => {
    expect(anthropicMaxTokens('claude-unknown-test')).toBe(4096);
    expect(anthropicMaxTokens('never-listed')).toBe(4096);
  });

  it('is what the request carries', async () => {
    mapAnthropicModels(MODELS_PAGE);
    const calls = stubFetch(() => sse({ type: 'message_stop' }));
    await collect(new AnthropicProvider('k').stream([{ role: 'user', content: 'hi' }], 'claude-text-only-test'));
    expect(bodyOf(calls[0]).max_tokens).toBe(8192);
  });
});

describe('toAnthropicContent', () => {
  it('passes plain strings through and maps remote images to url sources', () => {
    expect(toAnthropicContent('hi')).toBe('hi');
    expect(toAnthropicContent([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]))
      .toEqual([{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }]);
  });
});

describe('AnthropicProvider.models', () => {
  it('lists what the key can use, following pagination', async () => {
    const calls = stubFetch(({ url }) => url.includes('after_id=')
      ? json({ data: MODELS_PAGE.data.slice(2), has_more: false, first_id: 'claude-text-only-test', last_id: 'claude-unknown-test' })
      : json({ data: MODELS_PAGE.data.slice(0, 2), has_more: true, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-4-5-20251001' }));

    const models = await new AnthropicProvider('sk-ant-test').models();
    expect(models.map((m) => m.name)).toEqual([
      'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-text-only-test', 'claude-unknown-test',
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-haiku-4-5-20251001',
    ]);
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
  });

  it('returns an empty list on a rejected key or without one', async () => {
    const calls = stubFetch(() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
    expect(await new AnthropicProvider('bad').models()).toEqual([]);
    expect(await new AnthropicProvider('').models()).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('AnthropicProvider.isAvailable', () => {
  it('is a GET of the model list — never a billed /v1/messages request', async () => {
    const calls = stubFetch(() => json({ data: [], has_more: false, first_id: null, last_id: null }));
    expect(await new AnthropicProvider('sk-ant-test').isAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(calls[0].init.method ?? 'GET').toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('is false on a rejected key, and makes no request without a key', async () => {
    const calls = stubFetch(() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
    expect(await new AnthropicProvider('bad').isAvailable()).toBe(false);
    expect(await new AnthropicProvider('').isAvailable()).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
