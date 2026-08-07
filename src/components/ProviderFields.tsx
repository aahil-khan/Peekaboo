import React from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettingsStore } from '../store/settings';
import { findProvider } from '../lib/providerCatalog';

/**
 * The credential inputs for one provider.
 *
 * Shared by Settings and the setup wizard. Duplicating them is how the two
 * drift — the wizard previously had no cloud fields at all, so a user with an
 * API key could not get through onboarding.
 */

interface ProviderFieldsProps {
  provider: string;
  /** Called whenever a value changes, so callers can reset verification state. */
  onChange?: () => void;
}

const HelpLink: React.FC<{ provider: string }> = ({ provider }) => {
  const info = findProvider(provider);
  if (!info?.helpUrl) return null;
  return (
    <button
      type="button"
      className="peek-link-btn"
      onClick={() => openUrl(info.helpUrl!).catch(() => {})}
    >
      {info.helpLabel ?? 'Learn more'} ↗
    </button>
  );
};

export const ProviderFields: React.FC<ProviderFieldsProps> = ({ provider, onChange }) => {
  const {
    ollamaBaseUrl, setOllamaBaseUrl,
    openaiApiKey, setOpenaiApiKey,
    openaiBaseUrl, setOpenaiBaseUrl,
    anthropicApiKey, setAnthropicApiKey,
    geminiApiKey, setGeminiApiKey,
  } = useSettingsStore();

  const changed = () => onChange?.();

  if (provider === 'ollama') {
    return (
      <div className="peek-form">
        <div className="peek-form-row">
          <label className="peek-form-label">Ollama address</label>
          <span className="peek-form-hint">
            Where Ollama is listening. The default is right unless you changed it.
          </span>
          <input
            className="peek-field peek-field--mono"
            type="text"
            value={ollamaBaseUrl}
            placeholder="http://localhost:11434"
            onChange={(e) => { setOllamaBaseUrl(e.target.value); changed(); }}
          />
          <HelpLink provider={provider} />
        </div>
      </div>
    );
  }

  if (provider === 'openai') {
    return (
      <div className="peek-form">
        <div className="peek-form-row">
          <label className="peek-form-label">OpenAI API key</label>
          <input
            className="peek-field peek-field--mono"
            type="password"
            value={openaiApiKey}
            placeholder="sk-…"
            onChange={(e) => { setOpenaiApiKey(e.target.value); changed(); }}
          />
          <HelpLink provider={provider} />
        </div>
        <details className="peek-disclosure">
          <summary>Use a different endpoint</summary>
          <div className="peek-disclosure-body">
            <span className="peek-form-hint">
              For OpenAI-compatible services and proxies. Leave this alone otherwise.
            </span>
            <input
              className="peek-field peek-field--mono"
              type="text"
              value={openaiBaseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => { setOpenaiBaseUrl(e.target.value); changed(); }}
              style={{ marginTop: 6 }}
            />
          </div>
        </details>
      </div>
    );
  }

  if (provider === 'anthropic') {
    return (
      <div className="peek-form">
        <div className="peek-form-row">
          <label className="peek-form-label">Anthropic API key</label>
          <input
            className="peek-field peek-field--mono"
            type="password"
            value={anthropicApiKey}
            placeholder="sk-ant-…"
            onChange={(e) => { setAnthropicApiKey(e.target.value); changed(); }}
          />
          <HelpLink provider={provider} />
        </div>
      </div>
    );
  }

  if (provider === 'gemini') {
    return (
      <div className="peek-form">
        <div className="peek-form-row">
          <label className="peek-form-label">Google Gemini API key</label>
          <input
            className="peek-field peek-field--mono"
            type="password"
            value={geminiApiKey}
            placeholder="AIza…"
            onChange={(e) => { setGeminiApiKey(e.target.value); changed(); }}
          />
          <HelpLink provider={provider} />
        </div>
      </div>
    );
  }

  // llama.cpp configures through profiles, and plugin providers carry their own
  // configuration; neither has credential fields here.
  return null;
};
