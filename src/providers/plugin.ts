import type { Provider, Message, ModelInfo } from './types';
import { registry } from '../lib/plugins/registry';

export class ModelPluginProvider implements Provider {
  id: string;
  name: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  async models(): Promise<ModelInfo[]> {
    // Return the plugin ID as the only available model name
    return [{ name: this.id, isVision: false }];
  }

  async isAvailable(): Promise<boolean> {
    const plugin = await registry.getModelPlugin(this.id);
    return plugin !== null;
  }

  async *stream(messages: Message[], _model: string, signal?: AbortSignal): AsyncGenerator<string> {
    const plugin = await registry.getModelPlugin(this.id);
    if (!plugin) throw new Error(`Model plugin ${this.id} not found`);

    const manifests = registry.getManifests();
    const manifest = manifests.find(m => m.plugin.id === this.id);
    const settings = manifest?.settings || {};

    const chatMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }));

    for await (const chunk of plugin.stream(chatMessages, settings)) {
      if (signal?.aborted) break;
      yield chunk;
    }
  }
}