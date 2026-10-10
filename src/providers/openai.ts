import type { Provider, Message, ModelInfo } from './types';
import { httpFetch, httpOk, readLines, sseData, apiError, errorMessageOf } from './http';

/*
 * `/models` on api.openai.com lists everything the key can touch, most of
 * which cannot hold a chat. Named by family rather than by model so the list
 * does not need editing each time a model ships.
 */
const NON_CHAT_FAMILIES = [
  'embedding', 'tts', 'whisper', 'transcribe', 'dall-e', 'image', 'sora',
  'moderation', 'realtime', 'audio',
  // Completions-only: these reject /chat/completions.
  'davinci', 'babbage', 'instruct',
];

/*
 * OpenAI's list says nothing about image input. Every chat family since
 * gpt-4-turbo accepts images, so the stable thing to name is the short, frozen
 * set that does not, rather than the growing set that does.
 */
const TEXT_ONLY = /^(gpt-3\.5|gpt-4(-\d{4}(-preview)?|-32k.*|-turbo-preview)?$|o1-mini|o1-preview|o3-mini)/;

export function isOfficialOpenAI(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Turn a `/models` response into the model picker's list.
 *
 * On api.openai.com the non-chat families are dropped. Any other base URL is
 * someone else's catalogue (OpenRouter, Groq, a local server) with its own
 * naming, so nothing is filtered there.
 *
 * Vision, in order: what the endpoint itself reports (OpenRouter's
 * `architecture.input_modalities`); on api.openai.com, everything except the
 * known text-only legacy models; anywhere else, assumed. A wrong "yes" costs
 * one clear error from the endpoint, while a wrong "no" locks screen capture
 * with nothing the user can do about it.
 */
export function mapOpenAIModels(data: any, baseUrl: string): ModelInfo[] {
  const official = isOfficialOpenAI(baseUrl);
  const entries: any[] = (Array.isArray(data?.data) ? data.data : [])
    .filter((m: any) => typeof m?.id === 'string' && m.id);

  return entries
    .filter((m) => !official || !NON_CHAT_FAMILIES.some((family) => m.id.includes(family)))
    // Newest first. Compatible endpoints often omit `created`; those fall back
    // to descending name order, which keeps higher versions on top.
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || b.id.localeCompare(a.id))
    .map((m) => {
      const inputs = m.architecture?.input_modalities;
      const isVision = Array.isArray(inputs)
        ? inputs.includes('image')
        : !(official && TEXT_ONLY.test(m.id));
      return { name: m.id, isVision };
    });
}

export class OpenAIProvider implements Provider {
  id = 'openai';
  name = 'OpenAI';

  constructor(private baseUrl: string, private apiKey: string) {
    if (!this.baseUrl.endsWith('/')) {
      this.baseUrl += '/';
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      return await httpOk(`${this.baseUrl}models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return false;
    }
  }

  async models(): Promise<ModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const res = await httpFetch(`${this.baseUrl}models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });
      if (!res.ok) return [];
      return mapOpenAIModels(await res.json(), this.baseUrl);
    } catch {
      return [];
    }
  }

  async *stream(messages: Message[], model: string, signal?: AbortSignal): AsyncGenerator<string> {
    const res = await httpFetch(`${this.baseUrl}chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        // Only the fields the API defines: stored messages also carry which
        // model wrote them, and strict endpoints reject unknown properties.
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true
      }),
      signal
    });

    if (!res.ok) {
      throw await apiError('OpenAI', res);
    }

    for await (const line of readLines(res, signal)) {
      const payload = sseData(line);
      if (payload === null) continue;
      if (payload === '[DONE]') return;

      let data: any;
      try {
        data = JSON.parse(payload);
      } catch (e) {
        console.warn('OpenAI stream parse error:', e, payload);
        continue;
      }
      // Compatible endpoints report a failure mid-stream as an event with no
      // choices; without this the answer just stops.
      const failure = errorMessageOf(data);
      if (failure) throw new Error(`OpenAI error: ${failure}`);
      const content = data.choices?.[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }
}
