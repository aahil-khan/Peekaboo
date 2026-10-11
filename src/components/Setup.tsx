import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../store/settings';
import { usePluginsStore } from '../store/plugins';
import { LlamaProfileEditor } from './LlamaProfileEditor';
import { ProviderFields } from './ProviderFields';
import {
  BUILTIN_PROVIDERS,
  listProviderModels,
  providerLabel,
  verifyProvider,
  type ProviderInfo,
} from '../lib/providerCatalog';
import { useHotkeyStore } from '../store/hotkey';
import { hotkeyParts } from '../lib/hotkey';

/**
 * First-run wizard.
 *
 * The previous version offered only the two local backends, never tested the
 * configuration, and ended by closing its own window — leaving the user staring
 * at their desktop with no indication that Peekaboo was running or how to
 * summon it. All three are fixed here: every provider is offered, the
 * connection is checked before you can continue, a model is chosen up front,
 * and the last screen is the hotkey.
 */

type Step = 'provider' | 'configure' | 'model' | 'done';

const STEP_ORDER: Step[] = ['provider', 'configure', 'model', 'done'];

interface ModelChoice {
  name: string;
  isVision?: boolean;
  parameterSize?: string;
}

export const Setup: React.FC = () => {
  const {
    setSetupCompleted,
    activeProvider,
    setActiveProvider,
    activeModel,
    setActiveModel,
  } = useSettingsStore();
  const { manifests, refreshManifests } = usePluginsStore();
  const summonHotkey = useHotkeyStore((s) => s.hotkey);

  const [step, setStep] = useState<Step>('provider');
  const [chosen, setChosen] = useState<string>(activeProvider || 'ollama');

  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);

  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    refreshManifests().catch(() => {});
  }, [refreshManifests]);

  const modelPlugins = manifests.filter((m) => m.plugin.type === 'model');
  const providers: ProviderInfo[] = [
    ...BUILTIN_PROVIDERS,
    ...modelPlugins.map((mp) => ({
      id: mp.plugin.id,
      label: mp.plugin.name,
      kind: 'plugin' as const,
      blurb: 'Provided by an installed plugin.',
    })),
  ];

  const finish = useCallback(async () => {
    setSetupCompleted(true);
    try {
      await invoke('update_settings', { settings: { setup_completed: true } });
    } catch (err) {
      // Rust keeps its own copy of this flag; if the sync fails the hotkey will
      // reopen setup, so surface it rather than swallowing it silently.
      console.error('Failed to tell the backend setup is complete:', err);
    }
    invoke('hide_setup_mode');
  }, [setSetupCompleted]);

  const chooseProvider = (id: string) => {
    setChosen(id);
    setActiveProvider(id);
    setVerifyError(null);
    setVerifyNote(null);
    setStep('configure');
  };

  const runVerification = async () => {
    setVerifying(true);
    setVerifyError(null);
    setVerifyNote(null);
    const result = await verifyProvider(chosen);
    setVerifying(false);

    if (!result.ok) {
      setVerifyError(result.error ?? 'Could not connect.');
      return;
    }
    setVerifyNote(result.note ?? null);

    setModels(null);
    setModelsError(null);
    setStep('model');

    try {
      const found = await listProviderModels(chosen);
      setModels(found);
      // Pre-select so the step is a confirmation rather than a chore.
      if (found.length > 0 && !found.some((m) => m.name === activeModel)) {
        setActiveModel(found[0].name);
      }
    } catch (e: any) {
      setModelsError(e?.message || 'Could not list models.');
      setModels([]);
    }
  };

  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="peek-wizard">
      <div className="peek-wizard-inner">
        <div className="peek-wizard-progress" aria-label={`Step ${stepIndex + 1} of ${STEP_ORDER.length}`}>
          {STEP_ORDER.map((s, i) => (
            <span
              key={s}
              className={`peek-wizard-pip${i < stepIndex ? ' peek-wizard-pip--done' : i === stepIndex ? ' peek-wizard-pip--current' : ''}`}
            />
          ))}
        </div>

        {step === 'provider' && (
          <>
            <h1 className="peek-wizard-title">Welcome to Peekaboo</h1>
            <p className="peek-wizard-subtitle">
              Peekaboo needs somewhere to send your questions. Pick one — you can change it later.
            </p>
            <div className="peek-wizard-cards">
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="peek-provider-card"
                  aria-pressed={chosen === p.id}
                  onClick={() => chooseProvider(p.id)}
                >
                  <span className="peek-provider-card-head">
                    <span className="peek-provider-card-title">{p.label}</span>
                    <span
                      className={`peek-badge ${
                        p.kind === 'local' ? 'peek-badge--success' : p.kind === 'cloud' ? 'peek-badge--info' : ''
                      }`}
                    >
                      {p.kind === 'local' ? 'On this machine' : p.kind === 'cloud' ? 'Cloud' : 'Plugin'}
                    </span>
                  </span>
                  <span className="peek-provider-card-desc">{p.blurb}</span>
                </button>
              ))}
            </div>
            <div className="peek-wizard-actions">
              <span style={{ flex: 1 }} />
              <button className="peek-wizard-skip" onClick={finish}>
                Skip for now — Peekaboo won't answer until a provider is set up
              </button>
            </div>
          </>
        )}

        {step === 'configure' && chosen === 'llama' && (
          <>
            <h1 className="peek-wizard-title">Set up llama.cpp</h1>
            <p className="peek-wizard-subtitle">
              Point Peekaboo at your llama.cpp build and a model file. You can add more later in Settings.
            </p>
            <LlamaProfileEditor onSave={() => setStep('done')} onCancel={() => setStep('provider')} cancelLabel="Back" />
          </>
        )}

        {step === 'configure' && chosen !== 'llama' && (
          <>
            <h1 className="peek-wizard-title">Connect {providerLabel(chosen, providers.find((p) => p.id === chosen)?.label)}</h1>
            <p className="peek-wizard-subtitle">{providers.find((p) => p.id === chosen)?.blurb}</p>

            <ProviderFields provider={chosen} onChange={() => setVerifyError(null)} />

            {verifyError && (
              <div className="peek-wizard-result peek-tone-error">
                <span aria-hidden="true">✕</span>
                <span>{verifyError}</span>
              </div>
            )}

            <div className="peek-wizard-actions">
              <button className="peek-btn peek-btn--secondary" onClick={() => setStep('provider')}>
                Back
              </button>
              <button
                className="peek-btn peek-btn--primary"
                style={{ flex: 1 }}
                onClick={runVerification}
                disabled={verifying}
              >
                {verifying ? 'Checking…' : 'Check connection'}
              </button>
            </div>
          </>
        )}

        {step === 'model' && (
          <>
            <h1 className="peek-wizard-title">Pick a model</h1>
            <p className="peek-wizard-subtitle">
              {models === null
                ? 'Looking for available models…'
                : models.length > 0
                  ? 'This is what Peekaboo will use by default. Alt+M switches it any time.'
                  : `Connected, but ${providerLabel(chosen)} reported no models.`}
            </p>

            {verifyNote && (
              <div className="peek-wizard-result peek-tone-muted">
                <span aria-hidden="true">•</span>
                <span>{verifyNote}</span>
              </div>
            )}

            {models !== null && models.length > 0 && (
              <div className="peek-wizard-modellist">
                {models.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    className="peek-wizard-model"
                    aria-pressed={activeModel === m.name}
                    onClick={() => setActiveModel(m.name)}
                  >
                    <span style={{ flex: 1 }}>{m.name}</span>
                    {m.parameterSize && <span className="peek-form-hint">{m.parameterSize}</span>}
                    {m.isVision && <span className="peek-badge peek-badge--success">Vision</span>}
                  </button>
                ))}
              </div>
            )}

            {models !== null && models.length === 0 && (
              <div className="peek-wizard-result peek-tone-warn">
                <span aria-hidden="true">!</span>
                <span>
                  {modelsError ??
                    (chosen === 'ollama'
                      ? 'Ollama is running but has no models yet. Pull one (for example `ollama pull llama3.2`), then reopen Settings.'
                      : 'You can pick one later from the model switcher.')}
                </span>
              </div>
            )}

            <div className="peek-wizard-actions">
              <button className="peek-btn peek-btn--secondary" onClick={() => setStep('configure')}>
                Back
              </button>
              <button className="peek-btn peek-btn--primary" style={{ flex: 1 }} onClick={() => setStep('done')}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <div className="peek-wizard-done">
            <h1 className="peek-wizard-title">You're set</h1>
            <p className="peek-wizard-subtitle">
              Peekaboo lives in your tray and stays out of the way until you call it.
            </p>
            <div className="peek-wizard-keys">
              {hotkeyParts(summonHotkey).map((part, i) => (
                <React.Fragment key={`${i}-${part}`}>
                  {i > 0 && <span className="peek-form-hint">+</span>}
                  <kbd className="peek-kbd">{part}</kbd>
                </React.Fragment>
              ))}
            </div>
            <p className="peek-wizard-subtitle">
              Press that anywhere to summon it. <kbd className="peek-kbd">Alt</kbd>
              <span className="peek-form-hint"> + </span>
              <kbd className="peek-kbd">/</kbd> lists every shortcut.
            </p>
            <p className="peek-wizard-subtitle">
              Select text first and the overlay opens with actions ready: fix grammar, make shorter,
              translate, explain, summarise. Pick one with the arrow keys and Enter.
            </p>
            <button className="peek-btn peek-btn--primary" onClick={finish}>
              Start using Peekaboo
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
