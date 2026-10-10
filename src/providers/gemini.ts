import type { Provider, Message, ModelInfo } from './types';
import { httpFetch, httpOk, readLines, sseData, apiError, errorMessageOf } from './http';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/*
 * `generateContent` is also how Gemini's speech and image models are called,
 * so the method list alone still lets through models that answer with audio
 * or pictures. The list has no field for output type; the name is all there is.
 */
const NON_TEXT_OUTPUT = /tts|image|audio|embedding|aqa/;

/**
 * Map one page of `models.list` to the model picker's entries.
 *
 * Kept: models whose `supportedGenerationMethods` includes `generateContent`,
 * minus the ones that do not answer in text.
 *
 * Vision: the list endpoint has no field for input types. Every model in the
 * Gemini family accepts images; the other families served here (Gemma and so
 * on) vary by size, so only `gemini-*` is marked.
 */
export function mapGeminiModels(page: any): ModelInfo[] {
  const entries: any[] = Array.isArray(page?.models) ? page.models : [];
  return entries
    .filter((m) => typeof m?.name === 'string'
      && Array.isArray(m.supportedGenerationMethods)
      && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, '') as string)
    .filter((name) => !NON_TEXT_OUTPUT.test(name))
    .map((name) => ({ name, isVision: name.startsWith('gemini-') }));
}

/** Peekaboo's OpenAI-style content parts as Gemini `parts`. */
export function toGeminiParts(content: Message['content']): any[] {
  if (typeof content === 'string') return [{ text: content }];
  const parts: any[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      parts.push({ text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
    }
  }
  return parts;
}

export class GeminiProvider implements Provider {
  id = 'gemini';
  name = 'Google Gemini';
  
  constructor(private apiKey: string) {}

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      return await httpOk(`${API_BASE}/models?pageSize=1&key=${encodeURIComponent(this.apiKey)}`, {
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
      let pageToken = '';
      // The default page is 50 models, fewer than the API serves. The bound
      // only stops a misbehaving cursor from looping forever.
      for (let page = 0; page < 5; page++) {
        const query = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const res = await httpFetch(
          `${API_BASE}/models?pageSize=1000&key=${encodeURIComponent(this.apiKey)}${query}`
        );
        if (!res.ok) return [];

        const data = await res.json();
        models.push(...mapGeminiModels(data));
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return models.sort((a: ModelInfo, b: ModelInfo) => b.name.localeCompare(a.name));
    } catch {
      return [];
    }
  }

  async *stream(messages: Message[], model: string, signal?: AbortSignal): AsyncGenerator<string> {
    // Gemini maps roles to 'user' or 'model'. System instructions are passed separately.
    const systemParts = messages
      .filter(m => m.role === 'system')
      .flatMap(m => toGeminiParts(m.content))
      .filter(p => p.text);
    const geminiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(m.content)
      }));

    const payload: any = { contents: geminiMessages };
    if (systemParts.length > 0) {
      payload.systemInstruction = {
        role: 'user',
        parts: systemParts
      };
    }

    const res = await httpFetch(`${API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });

    if (!res.ok) {
      throw await apiError('Gemini', res);
    }

    for await (const line of readLines(res, signal)) {
      const event = sseData(line);
      if (event === null) continue;

      let data: any;
      try {
        data = JSON.parse(event);
      } catch {
        // Ignore parse errors for non-JSON lines
        continue;
      }

      const failure = errorMessageOf(data);
      if (failure) throw new Error(`Gemini error: ${failure}`);

      // A chunk can carry several parts, and a thinking model interleaves
      // its reasoning as parts flagged `thought`; only the answer is shown.
      for (const part of data?.candidates?.[0]?.content?.parts ?? []) {
        if (part?.text && !part.thought) {
          yield part.text;
        }
      }

      // A blocked prompt comes back as a 200 with no candidates at all.
      const blocked = data?.promptFeedback?.blockReason;
      if (blocked) {
        yield `\n\n*(Gemini blocked this request: ${blocked}.)*`;
      }
    }
  }
}
