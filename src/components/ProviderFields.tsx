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
  /** Also show tuning that is not needed to get connected. Settings sets this;
   *  the setup wizard does not, to keep first run to the one field that matters. */
  advanced?: boolean;
}

// Values are Ollama's `keep_alive`: a duration, 0 to unload at once, -1 for never.
const KEEP_ALIVE_CHOICES: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Unload now' },
  { value: '5m', label: '5 min' },
  { value: '30m', label: '30 min' },
  { value: '1h', label: '1 hour' },
  { value: '-1', label: 'Keep loaded' },
];

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

export const ProviderFields: React.FC<ProviderFieldsProps> = ({ provider, onChange, advanced }) => {
  const {
    ollamaBaseUrl, setOllamaBaseUrl,
    ollamaKeepAlive, setOllamaKeepAlive,
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
        {advanced && (
          <div className="peek-form-row">
            <label className="peek-form-label">Keep model loaded</label>
            <span className="peek-form-hint">
              How long the model stays in memory after an answer. Longer makes the next
              question start faster; the model's RAM or VRAM stays in use until then.
            </span>
            {/* Five labels are wider than the card at the window's minimum size. */}
            <div className="peek-segmented" style={{ alignSelf: 'flex-start', flexWrap: 'wrap', maxWidth: '100%' }}>
              {KEEP_ALIVE_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={ollamaKeepAlive === choice.value}
                  onClick={() => setOllamaKeepAlive(choice.value)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        )}
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
