import { OllamaProvider } from '../providers/ollama';
import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { GeminiProvider } from '../providers/gemini';
import { useSettingsStore } from '../store/settings';

/**
 * One description of each provider, shared by Settings and the setup wizard.
 *
 * These used to be two separate lists: Settings offered five providers, the
 * wizard offered two, and neither explained what any of them were. A user with
 * an API key and no local models had no path through onboarding at all.
 */

export type ProviderKind = 'local' | 'cloud' | 'plugin';

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  /** One line aimed at someone who has not heard of any of these. */
  blurb: string;
  /** Opened externally — the app previously linked to nothing at all. */
  helpUrl?: string;
  helpLabel?: string;
}

export const BUILTIN_PROVIDERS: ProviderInfo[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'local',
    blurb: 'Runs models on this computer. Nothing leaves the machine. Easiest local option.',
    helpUrl: 'https://ollama.com/download',
    helpLabel: 'Install Ollama',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'cloud',
    blurb: 'Claude models, over the internet. Needs an API key.',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    helpLabel: 'Get an API key',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'cloud',
    blurb: 'GPT models, over the internet. Needs an API key.',
    helpUrl: 'https://platform.openai.com/api-keys',
    helpLabel: 'Get an API key',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'cloud',
    blurb: 'Gemini models, over the internet. Needs an API key.',
    helpUrl: 'https://aistudio.google.com/apikey',
    helpLabel: 'Get an API key',
  },
  {
    id: 'llama',
    label: 'llama.cpp',
    kind: 'local',
    blurb: 'Runs a model file through your own llama.cpp build. Most control, most setup.',
    helpUrl: 'https://github.com/ggml-org/llama.cpp',
    helpLabel: 'About llama.cpp',
  },
];

export function findProvider(id: string): ProviderInfo | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id);
}

export function providerLabel(id: string, pluginName?: string): string {
  return findProvider(id)?.label ?? pluginName ?? id;
}

/** Whether this provider still needs something typed in before it can work. */
export function providerNeedsConfig(id: string): boolean {
  const s = useSettingsStore.getState();
  switch (id) {
    case 'ollama':
      return !s.ollamaBaseUrl.trim();
    case 'openai':
      return !s.openaiApiKey.trim();
    case 'anthropic':
      return !s.anthropicApiKey.trim();
    case 'gemini':
      return !s.geminiApiKey.trim();
    case 'llama':
      return s.llamaProfiles.length === 0;
    default:
      return false;
  }
}

const FAILURE_HINTS: Record<string, string> = {
  ollama: 'Could not reach Ollama. Check that it is installed and running.',
  openai: 'OpenAI rejected the key. Check it and try again.',
  anthropic: 'Anthropic rejected the key. Check it and try again.',
  gemini: 'Google rejected the key. Check it and try again.',
};

export interface VerifyResult {
  ok: boolean;
  error?: string;
  /** Set when the check could not actually be performed. */
  note?: string;
}

/**
 * Test a provider's configuration. Reads the current settings itself so callers
 * don't have to thread five fields through.
 */
export async function verifyProvider(id: string): Promise<VerifyResult> {
  const s = useSettingsStore.getState();
  try {
    let available: boolean;
    switch (id) {
      case 'ollama':
        available = await new OllamaProvider(s.ollamaBaseUrl, s.ollamaKeepAlive).isAvailable();
        break;
      case 'openai':
        available = await new OpenAIProvider(s.openaiBaseUrl, s.openaiApiKey).isAvailable();
        break;
      case 'anthropic':
        available = await new AnthropicProvider(s.anthropicApiKey).isAvailable();
        break;
      case 'gemini':
        available = await new GeminiProvider(s.geminiApiKey).isAvailable();
        break;
      default:
        // Plugin-backed providers expose no connection to test. Report that
        // honestly rather than claiming a success nothing verified.
        return { ok: true, note: 'Plugin providers are not connection-tested.' };
    }
    return available
      ? { ok: true }
      : { ok: false, error: FAILURE_HINTS[id] ?? 'Could not connect. Check your configuration.' };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Verification failed.' };
  }
}

/** Model list for a provider, used by the wizard's model step. */
export async function listProviderModels(id: string) {
  const s = useSettingsStore.getState();
  switch (id) {
    case 'ollama':
      return new OllamaProvider(s.ollamaBaseUrl, s.ollamaKeepAlive).models();
    case 'openai':
      return new OpenAIProvider(s.openaiBaseUrl, s.openaiApiKey).models();
    case 'anthropic':
      return new AnthropicProvider(s.anthropicApiKey).models();
    case 'gemini':
      return new GeminiProvider(s.geminiApiKey).models();
    default:
      return [];
  }
}
