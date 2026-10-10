import { isTauri } from '@tauri-apps/api/core';

/*
 * One HTTP path for every built-in provider.
 *
 * Inside the app, requests go through Tauri's Rust client rather than the
 * webview's fetch. The webview enforces CORS and mixed-content rules, which is
 * wrong for a desktop client: a remote Ollama over plain HTTP, or any API that
 * does not send CORS headers, is unreachable from it.
 *
 * Outside Tauri (the UI loaded in a plain browser under `vite dev`) there is no
 * Rust side, so it falls back to the browser's fetch. The choice is made up
 * front, never by catching a failure: retrying a failed native request through
 * the webview would send every refused or aborted request twice.
 */

export interface HttpInit extends RequestInit {
  /** Milliseconds allowed for establishing the connection. Native client only. */
  connectTimeout?: number;
}

function toError(e: unknown): Error {
  // Tauri command failures reject with a bare string, which has no `.message`
  // for the callers that report it.
  return e instanceof Error ? e : new Error(typeof e === 'string' ? e : String(e));
}

/** What an aborted request should throw: the signal's own reason, so a user
 *  abort stays an AbortError and a timeout stays a TimeoutError. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted by user', 'AbortError');
}

function nativeUrl(url: string): string {
  // reqwest resolves `localhost` to ::1 first on Linux and reports
  // "connection refused" for servers that only listen on IPv4.
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL — let the client report it.
  }
  return url;
}

export async function httpFetch(url: string, init: HttpInit = {}): Promise<Response> {
  const { connectTimeout, ...rest } = init;
  const signal = rest.signal ?? undefined;

  if (!isTauri()) {
    return globalThis.fetch(url, rest);
  }

  const headers = new Headers(rest.headers);
  // The plugin stamps every request with the webview's Origin, which makes the
  // app look like a web page: Anthropic refuses such requests outright, and
  // Ollama rejects origins it does not recognise. An empty Origin tells the
  // plugin to send none (needs its `unsafe-headers` feature, see Cargo.toml).
  headers.set('Origin', '');

  try {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return await tauriFetch(nativeUrl(url), { ...rest, headers, connectTimeout });
  } catch (e) {
    // The plugin reports a cancelled request as a plain Error('Request
    // cancelled'), which callers would mistake for a network failure.
    if (signal?.aborted) throw abortReason(signal);
    throw toError(e);
  }
}

/**
 * Whether a GET-style probe succeeds. The body is discarded explicitly: the
 * native client keeps an unread response (and its connection) alive on the
 * Rust side until someone reads or cancels it.
 */
export async function httpOk(url: string, init: HttpInit = {}): Promise<boolean> {
  const res = await httpFetch(url, init);
  res.body?.cancel().catch(() => {});
  return res.ok;
}

/**
 * The response body as trimmed, non-empty lines.
 *
 * Both wire formats in use here (NDJSON and SSE) are line-oriented, and both
 * break the same way: a network chunk ends wherever TCP puts it, so a line —
 * or a multi-byte character — can be split across two reads. Parsing chunks
 * independently silently drops whatever straddled the boundary.
 */
export async function* readLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Wakes a read that is waiting on the network, so a stop takes effect now
  // rather than when the next token happens to arrive.
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted) throw abortReason(signal);
        throw toError(e);
      }

      // A cancelled reader resolves its pending read as "done", which must not
      // be mistaken for the response finishing normally.
      if (signal?.aborted) throw abortReason(signal);
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
    }

    // A final line with no trailing newline is still a complete line.
    const rest = (buffer + decoder.decode()).trim();
    if (rest) yield rest;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Releases the connection when the consumer stops early. For the native
    // client this is what drops the response on the Rust side.
    reader.cancel().catch(() => {});
  }
}

/** The payload of an SSE `data:` line, or null for any other line. */
export function sseData(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  return line.slice(5).trim();
}

/** The human-readable message from a provider's JSON error object, if any.
 *  Covers `{error: {message}}` (OpenAI, Anthropic, Gemini) and `{error: "…"}`
 *  (Ollama). */
export function errorMessageOf(json: any): string | null {
  const err = Array.isArray(json) ? json[0]?.error : json?.error;
  if (typeof err === 'string' && err) return err;
  if (typeof err?.message === 'string' && err.message) return err.message;
  return null;
}

/**
 * Build an Error for a non-2xx response. The status alone rarely says what is
 * wrong; these APIs put the useful part ("invalid x-api-key", "model not
 * found") in the body.
 */
export async function apiError(provider: string, res: Response): Promise<Error> {
  let detail = '';
  try {
    const text = (await res.text()).trim();
    if (text) {
      try {
        detail = errorMessageOf(JSON.parse(text)) ?? text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // Body unreadable — the status is all there is.
  }
  // An HTML error page from a proxy is not worth showing in full.
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  return new Error(`${provider} error (${res.status}): ${detail || res.statusText || 'request failed'}`);
}
