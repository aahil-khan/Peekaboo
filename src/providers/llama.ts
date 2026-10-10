import type { Provider, Message, ModelInfo } from './types';
import { httpFetch, httpOk, readLines, sseData, apiError } from './http';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

export class LlamaProvider implements Provider {
  id = 'llama';
  name = 'llama.cpp';
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
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
      const parts: any[] = [];
      for (const part of m.content) {
        if (part.type === 'text' && part.text) {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        }
      }
      return { role: m.role, content: parts };
    });

    const res = await httpFetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, messages: mappedMessages, stream: true }),
    });

    if (!res.ok) {
      throw await apiError('llama.cpp', res);
    }

    for await (const line of readLines(res, signal)) {
      const data = sseData(line);
      if (data === null) continue;
      if (data === '[DONE]') {
        return;
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        console.warn('Peekaboo: skipped malformed llama chunk:', data);
      }
    }
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const res = await httpFetch(`${this.baseUrl}/v1/models`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.data || []).map((m: any) => ({
        name: m.id,
        isVision: false,
      }));
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await httpOk(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
        connectTimeout: 2000,
      });
    } catch {
      return false;
    }
  }
}
