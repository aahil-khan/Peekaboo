import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytes, streamOf, everySplit } from './testUtils';

const tauri = vi.hoisted(() => ({ inTauri: false, fetch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => tauri.inTauri }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: tauri.fetch }));

import { httpFetch, httpOk, readLines, sseData, apiError, errorMessageOf } from './http';

async function lines(res: Response, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(res, signal)) out.push(line);
  return out;
}

afterEach(() => {
  tauri.inTauri = false;
  tauri.fetch.mockReset();
  vi.unstubAllGlobals();
});

describe('readLines', () => {
  it('yields the same lines wherever the chunks are cut', async () => {
    const payload = 'data: {"a":1}\n\ndata: {"b":"héllo — 日本"}\r\n{"c":3}\n';
    const expected = ['data: {"a":1}', 'data: {"b":"héllo — 日本"}', '{"c":3}'];
    for (const chunks of everySplit(payload)) {
      expect(await lines(new Response(streamOf(chunks)))).toEqual(expected);
    }
  });

  it('yields a final line that has no trailing newline', async () => {
    expect(await lines(new Response(streamOf([bytes('one\ntw'), bytes('o')])))).toEqual(['one', 'two']);
  });

  it('throws when there is no body', async () => {
    await expect(lines(new Response(null, { status: 204 }))).rejects.toThrow('No response body');
  });

  it('turns an abort during a pending read into an AbortError', async () => {
    const controller = new AbortController();
    // Never delivers a second chunk, so the reader is waiting on the network
    // when the abort lands — the state a slow model leaves it in.
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes('first\n')); },
    });
    const seen: string[] = [];
    const run = (async () => {
      for await (const line of readLines(new Response(body), controller.signal)) seen.push(line);
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    // Cancelling the reader ends the pending read as "done"; that must not
    // pass for the answer completing.
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual(['first']);
  });

  it('turns an abort between reads into an AbortError', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes('first\n')); },
    });
    const run = (async () => {
      for await (const _line of readLines(new Response(body), controller.signal)) {
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports the native client\'s cancellation as an AbortError', async () => {
    const controller = new AbortController();
    // plugin-http errors the body with a bare string when the signal fires.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes('first\n'));
        controller.signal.addEventListener('abort', () => c.error('Request cancelled'));
      },
    });
    const run = lines(new Response(body), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps a timeout distinguishable from a user abort', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes('x\n')); } });
    const run = (async () => {
      for await (const _line of readLines(new Response(body), controller.signal)) {
        controller.abort(new DOMException('timed out', 'TimeoutError'));
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('wraps a non-Error stream failure so it has a message', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.error('connection reset'); } });
    await expect(lines(new Response(body))).rejects.toThrow('connection reset');
  });

  it('cancels the body when the consumer stops early', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes('a\nb\n')); },
      cancel,
    });
    for await (const line of readLines(new Response(body))) {
      if (line === 'a') break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('sseData', () => {
  it('returns the payload of data lines only', () => {
    expect(sseData('data: {"x":1}')).toBe('{"x":1}');
    expect(sseData('data:{"x":1}')).toBe('{"x":1}');
    expect(sseData('data: [DONE]')).toBe('[DONE]');
    expect(sseData('event: ping')).toBeNull();
    expect(sseData(': keep-alive')).toBeNull();
  });
});

describe('error messages', () => {
  it('finds the message in each provider\'s error shape', () => {
    expect(errorMessageOf({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
      .toBe('invalid x-api-key');
    expect(errorMessageOf({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }))
      .toBe('Incorrect API key provided');
    expect(errorMessageOf({ error: 'model "nope" not found' })).toBe('model "nope" not found');
    expect(errorMessageOf([{ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } }]))
      .toBe('API key not valid');
    expect(errorMessageOf({ message: { content: 'hi' } })).toBeNull();
  });

  it('puts the body\'s message in the Error, not just the status', async () => {
    const res = new Response(
      JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
      { status: 401 },
    );
    expect((await apiError('Anthropic', res)).message).toBe('Anthropic error (401): invalid x-api-key');
  });

  it('falls back to the raw body, then to the status text', async () => {
    expect((await apiError('X', new Response('upstream timed out', { status: 504 }))).message)
      .toBe('X error (504): upstream timed out');
    expect((await apiError('X', new Response('', { status: 502, statusText: 'Bad Gateway' }))).message)
      .toBe('X error (502): Bad Gateway');
  });

  it('truncates a long non-JSON body', async () => {
    const res = new Response(`<html>${'x'.repeat(5000)}</html>`, { status: 500 });
    expect((await apiError('X', res)).message.length).toBeLessThan(340);
  });
});

describe('httpFetch outside Tauri', () => {
  it('uses the global fetch and does not pass the native-only option on', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await httpFetch('http://localhost:11434/api/tags', { connectTimeout: 2000, method: 'GET' });
    expect(tauri.fetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/tags', { method: 'GET' });
  });
});

describe('httpFetch inside Tauri', () => {
  it('goes through the Rust client, with the signal, and never the webview fetch', async () => {
    tauri.inTauri = true;
    tauri.fetch.mockResolvedValue(new Response('ok'));
    const webviewFetch = vi.fn();
    vi.stubGlobal('fetch', webviewFetch);
    const controller = new AbortController();

    await httpFetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': 'k' },
      signal: controller.signal,
      connectTimeout: 2000,
    });

    expect(webviewFetch).not.toHaveBeenCalled();
    const [url, init] = tauri.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(init.signal).toBe(controller.signal);
    expect(init.connectTimeout).toBe(2000);
    expect(init.headers.get('x-api-key')).toBe('k');
    // Empty Origin is the plugin's cue to send no Origin header at all.
    expect(init.headers.get('origin')).toBe('');
  });

  it('rewrites localhost to the IPv4 loopback, and only as a whole hostname', async () => {
    tauri.inTauri = true;
    tauri.fetch.mockResolvedValue(new Response('ok'));
    await httpFetch('http://localhost:11434/api/tags');
    await httpFetch('http://localhost.example.com/v1/models');
    expect(tauri.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags');
    expect(tauri.fetch.mock.calls[1][0]).toBe('http://localhost.example.com/v1/models');
  });

  it('does not retry a failed native request through the webview', async () => {
    tauri.inTauri = true;
    // Tauri command errors reject with a string.
    tauri.fetch.mockRejectedValue('url not allowed on the configured scope: https://example.com/');
    const webviewFetch = vi.fn();
    vi.stubGlobal('fetch', webviewFetch);

    const failure = await httpFetch('https://example.com/').catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('url not allowed on the configured scope');
    expect(webviewFetch).not.toHaveBeenCalled();
  });

  it('reports the plugin\'s "Request cancelled" as an AbortError', async () => {
    tauri.inTauri = true;
    const controller = new AbortController();
    tauri.fetch.mockImplementation(async () => {
      controller.abort();
      throw new Error('Request cancelled');
    });
    await expect(httpFetch('https://example.com/', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('httpOk', () => {
  it('returns the status and releases the unread body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 401 })));
    expect(await httpOk('https://example.com/')).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
