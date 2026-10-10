import type { Provider, Message, ModelInfo } from './types';
import { httpFetch, httpOk, readLines, apiError, errorMessageOf } from './http';

const DEFAULT_BASE_URL = 'http://localhost:11434';
// Ollama's own default. The model stays in memory this long after an answer,
// so a follow-up question does not pay for loading it again.
export const DEFAULT_OLLAMA_KEEP_ALIVE = '5m';

/**
 * The stored setting as Ollama's `keep_alive` expects it. Durations go as
 * strings ("5m"), but the two special values must be numbers: Ollama parses a
 * string as a Go duration, and "-1" has no unit, so it is rejected.
 */
export function ollamaKeepAliveParam(value: string): string | number {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_OLLAMA_KEEP_ALIVE;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

// Per-model metadata cache: survives the lifetime of the app instance
const metadataCache = new Map<string, { isVision: boolean; parameterSize?: string; family?: string; quantization?: string }>();

// Full model-list TTL cache: keyed by baseUrl, invalidates after 60s
const modelsListCache = new Map<string, { data: ModelInfo[]; fetchedAt: number }>();
const MODELS_CACHE_TTL_MS = 60_000;

export class OllamaProvider implements Provider {
  id = 'ollama';
  name = 'Ollama';
  private baseUrl: string;
  private keepAlive: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL, keepAlive: string = DEFAULT_OLLAMA_KEEP_ALIVE) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.keepAlive = keepAlive;
  }

  async *stream(
    messages: Message[],
    model: string,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    const mappedMessages = messages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content };
      }
      let text = '';
      const images: string[] = [];
      for (const part of m.content) {
        if (part.type === 'text' && part.text) {
          text += part.text;
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const match = part.image_url.url.match(/^data:image\/[^;]+;base64,(.+)$/);
          if (match) {
            images.push(match[1]);
          } else {
            images.push(part.image_url.url);
          }
        }
      }
      return {
        role: m.role,
        content: text,
        images: images.length > 0 ? images : undefined,
      };
    });

    const res = await httpFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages: mappedMessages,
        stream: true,
        keep_alive: ollamaKeepAliveParam(this.keepAlive),
      }),
    });

    if (!res.ok) {
      throw await apiError('Ollama', res);
    }

    for await (const line of readLines(res, signal)) {
      let json: any;
      try {
        json = JSON.parse(line);
      } catch {
        // Skip malformed lines — can happen during high-speed streaming
        console.warn('Peekaboo: skipped malformed Ollama chunk:', line);
        continue;
      }
      // Ollama reports a failure after the stream has started (the model
      // crashing, running out of memory) as a line of its own.
      const failure = errorMessageOf(json);
      if (failure) throw new Error(`Ollama error: ${failure}`);
      const content = json.message?.content;
      if (content) yield content;
    }
  }

  async models(): Promise<ModelInfo[]> {
    // Return cached list if within TTL
    const cached = modelsListCache.get(this.baseUrl);
    if (cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const res = await httpFetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json();

      const result = await Promise.all(
        (data.models || []).map(async (m: any) => {
          if (metadataCache.has(m.name)) {
            return { name: m.name, ...metadataCache.get(m.name)! };
          }

          let isVision = false;
          const parameterSize = m.details?.parameter_size;
          const family = m.details?.family;
          const quantization = m.details?.quantization_level;

          try {
            const showRes = await httpFetch(`${this.baseUrl}/api/show`, {
              method: 'POST',
              body: JSON.stringify({ name: m.name }),
              headers: { 'Content-Type': 'application/json' },
            });
            if (showRes.ok) {
              const showData = await showRes.json();
              const families = showData.details?.families || [];
              const capabilities = showData.capabilities || [];
              isVision = families.includes('clip') ||
                         families.includes('mllama') ||
                         families.includes('llava') ||
                         capabilities.includes('vision') ||
                         m.name.toLowerCase().includes('vision') ||
                         m.name.toLowerCase().includes('-vl') ||
                         m.name.toLowerCase().includes('llava');
            }
          } catch {
            // Ignore individual show errors
          }

          const metadata = { isVision, parameterSize, family, quantization };
          metadataCache.set(m.name, metadata);
          return { name: m.name, ...metadata };
        })
      );

      modelsListCache.set(this.baseUrl, { data: result, fetchedAt: Date.now() });
      return result;
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await httpOk(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
        connectTimeout: 2000,
      });
    } catch {
      return false;
    }
  }
}
