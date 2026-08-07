/**
 * Any OpenAI-compatible chat-completions endpoint, as a model provider.
 *
 * This is the reference model plugin: it is what someone copies when adding a
 * backend Peekaboo does not ship. The host passes the manifest's [settings]
 * table through as the second argument to stream().
 *
 * Two things here are easy to get wrong and worth copying rather than
 * reinventing — buffering partial SSE lines across chunk boundaries, and
 * releasing the reader when the consumer stops early.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

async function readErrorBody(res) {
  // The status alone rarely says what is wrong; these APIs put the useful part
  // ("model not found", "insufficient quota") in the body.
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      return parsed?.error?.message || text;
    } catch {
      return text;
    }
  } catch {
    return '';
  }
}

export default {
  type: 'model',

  async *stream(messages, options) {
    const baseUrl = (options?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = options?.model || DEFAULT_MODEL;
    const apiKey = options?.apiKey || '';

    const headers = { 'Content-Type': 'application/json' };
    // A local server (vLLM, LM Studio, Ollama's OpenAI shim) usually wants no
    // auth at all, and some reject a bare "Bearer " outright.
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true }),
    });

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new Error(
        `${baseUrl} returned ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`
      );
    }
    if (!res.body) throw new Error(`${baseUrl} returned no response body`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // A network chunk boundary falls wherever TCP puts it, not on a line
    // ending. Parsing each chunk independently drops whichever event was
    // split across two of them — which shows up as text going missing from
    // long answers, intermittently, and never in short ones.
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Keep the trailing fragment: it is the start of the next event.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;

          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // A malformed event is not worth aborting a good stream over.
          }
        }
      }
    } finally {
      // Reached on early return too — the host stops consuming on abort, and
      // without this the connection stays open until the socket times out.
      reader.releaseLock();
      await res.body.cancel().catch(() => {});
    }
  },
};
