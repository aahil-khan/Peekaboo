import type { Provider, Message, ModelInfo } from './types';
import { httpFetch, httpOk, readLines, sseData, apiError, errorMessageOf } from './http';

const API_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

/*
 * Current models think before answering, and thinking is billed against
 * `max_tokens` like any other output. A small cap can be spent entirely on
 * reasoning and leave a truncated or empty answer, so ask for a roomy budget
 * and clamp it to what the model allows.
 */
const PREFERRED_MAX_TOKENS = 64_000;
// Accepted by every model. Used only when the model's limit is unknown, i.e.
// the model list could not be fetched.
const FALLBACK_MAX_TOKENS = 4096;

// Output limit per model id, learned from the Models API. A request above a
// model's limit is rejected, and the limit differs between model generations.
const outputLimits = new Map<string, number>();

/** Map one page of `GET /v1/models` to the model picker's entries. */
export function mapAnthropicModels(page: any): ModelInfo[] {
  const entries: any[] = Array.isArray(page?.data) ? page.data : [];
  return entries
    .filter((m) => typeof m?.id === 'string' && m.id)
    .map((m) => {
      if (typeof m.max_tokens === 'number' && m.max_tokens > 0) {
        outputLimits.set(m.id, m.max_tokens);
      }
      return {
        name: m.id,
        // The API states this per model. `capabilities` can be null, in which
        // case nothing is known and nothing is claimed.
        isVision: m.capabilities?.image_input?.supported === true,
      };
    });
}

export function anthropicMaxTokens(model: string): number {
  const limit = outputLimits.get(model);
  return limit ? Math.min(limit, PREFERRED_MAX_TOKENS) : FALLBACK_MAX_TOKENS;
}

/** Peekaboo's OpenAI-style content parts as Messages API content blocks. */
export function toAnthropicContent(content: Message['content']): string | any[] {
  if (typeof content === 'string') return content;
  const blocks: any[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      blocks.push(match
        ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
        : { type: 'image', source: { type: 'url', url: part.image_url.url } });
    }
  }
  return blocks;
}

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('');
}

export class AnthropicProvider implements Provider {
  id = 'anthropic';
  name = 'Anthropic';

  constructor(private apiKey: string) {}

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': API_VERSION,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      // Listing models authenticates the key without generating anything, so
      // checking the connection is never a billed request.
      return await httpOk(`${API_BASE}/models?limit=1`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return false;
    }
  }

  async models(): Promise<ModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const models: ModelInfo[] = [];
      let afterId: string | null = null;
      // One page holds up to 1000 models, far more than exist; the bound only
      // stops a misbehaving cursor from looping forever.
      for (let page = 0; page < 5; page++) {
        const query: string = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
        const res = await httpFetch(`${API_BASE}/models?limit=1000${query}`, {
          headers: this.headers(),
        });
        if (!res.ok) return [];
        const data = await res.json();
        // The API lists newest first, which is the order wanted here.
        models.push(...mapAnthropicModels(data));
        if (!data.has_more || !data.last_id) break;
        afterId = data.last_id;
      }
      return models;
    } catch {
      return [];
    }
  }

  async *stream(messages: Message[], model: string, signal?: AbortSignal): AsyncGenerator<string> {
    // Anthropic API uses a system parameter instead of a 'system' message role
    const system = messages
      .filter(m => m.role === 'system')
      .map(m => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
    const anthropicMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: toAnthropicContent(m.content)
      }));

    const res = await httpFetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: anthropicMessages,
        system: system || undefined,
        max_tokens: anthropicMaxTokens(model),
        stream: true
      }),
      signal
    });

    if (!res.ok) {
      throw await apiError('Anthropic', res);
    }

    for await (const line of readLines(res, signal)) {
      const payload = sseData(line);
      if (payload === null) continue;

      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        // Ignore parse errors for non-JSON lines
        continue;
      }

      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
        yield data.delta.text;
      } else if (data.type === 'error') {
        // Sent inside a 200 response once streaming has begun, e.g. when the
        // API becomes overloaded partway through an answer.
        throw new Error(`Anthropic error: ${errorMessageOf(data) ?? 'the stream failed'}`);
      } else if (data.type === 'message_delta') {
        // Neither of these is an error to the API: both arrive as a normal
        // end of a 200 response. Say so, or the answer just looks empty or
        // unfinished.
        if (data.delta?.stop_reason === 'refusal') {
          yield '\n\n*(Claude declined to answer this request.)*';
        } else if (data.delta?.stop_reason === 'max_tokens') {
          yield '\n\n*(Cut off: the answer reached the output limit.)*';
        }
      }
    }
  }
}
