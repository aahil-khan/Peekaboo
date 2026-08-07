import type { Provider, Message, ModelInfo } from './types';

const DEFAULT_BASE_URL = 'http://localhost:11434';
// Helper to route requests through Tauri's native Rust fetch client,
// bypassing WebKitGTK CORS and mixed-content restrictions in production.
async function secureFetch(input: string | URL, init?: any): Promise<Response> {
  let urlStr = input.toString();
  // Force IPv4 loopback to avoid reqwest IPv6 "Connection refused" issues on Linux
  urlStr = urlStr.replace('http://localhost', 'http://127.0.0.1');

  try {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    const tauriInit = { ...init };
    if (tauriInit.signal) {
      delete tauriInit.signal;
      tauriInit.connectTimeout = 2000;
    }
    return await tauriFetch(urlStr, tauriInit);
  } catch {
    return await window.fetch(input, init);
  }
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

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl;
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

    const res = await secureFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, messages: mappedMessages, stream: true, keep_alive: "5s" }),
    });

    if (signal?.aborted) {
      throw new DOMException('Aborted by user', 'AbortError');
    }

    if (!res.ok) {
      throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    if (signal) {
      signal.addEventListener('abort', () => {
        reader.cancel().catch(() => {});
      });
    }

    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted by user', 'AbortError');
      }

      const { done, value } = await reader.read();

      if (signal?.aborted) {
        throw new DOMException('Aborted by user', 'AbortError');
      }

      if (done) break;

      // Accumulate buffer to handle partial JSON lines across chunks
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          yield json.message?.content ?? '';
        } catch {
          // Skip malformed lines — can happen during high-speed streaming
          console.warn('Peekaboo: skipped malformed Ollama chunk:', trimmed);
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const json = JSON.parse(buffer.trim());
        yield json.message?.content ?? '';
      } catch {
        // Final incomplete chunk — ignore
      }
    }
  }

  async models(): Promise<ModelInfo[]> {
    // Return cached list if within TTL
    const cached = modelsListCache.get(this.baseUrl);
    if (cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const res = await secureFetch(`${this.baseUrl}/api/tags`);
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
            const showRes = await secureFetch(`${this.baseUrl}/api/show`, {
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
      const res = await secureFetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
