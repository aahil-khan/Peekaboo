import { vi } from 'vitest';

/*
 * Shared by the provider tests. Outside Tauri the HTTP helper falls back to
 * the global fetch, so stubbing that exercises the real helper and the real
 * line reader rather than a mock of them.
 */

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** A body that delivers exactly these chunks, one per read. */
export function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** Every way of cutting `payload` into two chunks, then one byte per chunk.
 *  A parser that is correct for all of these does not depend on where the
 *  network happens to split the stream. */
export function everySplit(payload: string): Uint8Array[][] {
  const all = bytes(payload);
  const cases: Uint8Array[][] = [];
  for (let i = 1; i < all.length; i++) {
    cases.push([all.slice(0, i), all.slice(i)]);
  }
  cases.push(Array.from(all, (b) => Uint8Array.of(b)));
  return cases;
}

export interface Call {
  url: string;
  init: RequestInit;
}

/**
 * Replace the global fetch. `respond` receives each request and returns the
 * Response for it; every call is recorded for assertions about what was sent.
 */
export function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }));
  return calls;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const piece of gen) out += piece;
  return out;
}

export function bodyOf(call: Call): any {
  return JSON.parse(String(call.init.body));
}
