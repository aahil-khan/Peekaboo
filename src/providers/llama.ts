import type { Provider, StreamChunk, Message, ModelInfo } from './types';

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
  ): AsyncGenerator<StreamChunk> {
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

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, messages: mappedMessages, stream: true }),
    });

    if (!res.ok) {
      throw new Error(`llama.cpp error: ${res.status} ${res.statusText}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          const isDone = json.choices?.[0]?.finish_reason != null;
          yield { delta, done: isDone };
        } catch {
          console.warn('Peekaboo: skipped malformed llama chunk:', data);
        }
      }
    }
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`);
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
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
