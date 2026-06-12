import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../store/settings';
import { LlamaProfileEditor } from './LlamaProfileEditor';

type Step = 'provider' | 'llama-profile' | 'ollama-url';

export const Setup: React.FC = () => {
  const { setSetupCompleted, setActiveProvider, ollamaBaseUrl, setOllamaBaseUrl } = useSettingsStore();
  const [step, setStep] = useState<Step>('provider');

  const finish = async () => {
    setSetupCompleted(true);
    const { autoCaptureSelection } = useSettingsStore.getState();
    try {
      await invoke('update_settings', {
        settings: { auto_capture_selection: autoCaptureSelection, setup_completed: true },
      });
    } catch {}
    invoke('hide_setup_mode');
  };

  const chooseOllama = () => {
    setActiveProvider('ollama');
    setStep('ollama-url');
  };

  const chooseLlama = () => {
    setActiveProvider('llama');
    setStep('llama-profile');
  };

  const finishOllama = () => finish();

  const finishLlama = () => finish();

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: '#18181b',
      color: '#fafafa',
      fontFamily: 'Inter, -apple-system, system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      padding: '32px 32px 48px',
      overflowY: 'auto',
      overflowX: 'hidden',
    }}>
      {step === 'provider' && (
        <div style={{ maxWidth: 640, width: '100%' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8, textAlign: 'center' }}>Welcome to Peekaboo</h1>
          <p style={{ fontSize: 14, color: 'var(--peek-text-muted)', textAlign: 'center', marginBottom: 32 }}>
            Choose your AI backend to get started.
          </p>
          <div style={{ display: 'flex', gap: 16 }}>
            <ProviderCard
              title="Ollama"
              description="Already have Ollama running locally? Connect to it."
              badge="Easy"
              badgeColor="#4caf50"
              onClick={chooseOllama}
            />
            <ProviderCard
              title="llama.cpp"
              description="Run a GGUF model directly. Full control over context, GPU layers, and more."
              badge="Advanced"
              badgeColor="#ff9800"
              onClick={chooseLlama}
            />
          </div>
          <p style={{ fontSize: 12, color: 'var(--peek-text-muted)', textAlign: 'center', marginTop: 24 }}>
            You can change this later in Settings.
          </p>
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button onClick={finish} style={{ background: 'none', border: 'none', color: 'var(--peek-text-muted)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
              Skip setup
            </button>
          </div>
        </div>
      )}

      {step === 'ollama-url' && (
        <div style={{ maxWidth: 540, width: '100%' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Ollama Setup</h2>
          <p style={{ fontSize: 13, color: 'var(--peek-text-muted)', marginBottom: 24 }}>
            Enter your Ollama server URL.
          </p>
          <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)', display: 'block', marginBottom: 6 }}>
            Base URL
          </label>
          <input
            type="text"
            value={ollamaBaseUrl}
            onChange={(e) => setOllamaBaseUrl(e.target.value)}
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button onClick={() => setStep('provider')} style={secondaryBtnStyle}>Back</button>
            <button onClick={finishOllama} style={primaryBtnStyle}>Finish</button>
          </div>
        </div>
      )}

      {step === 'llama-profile' && (
        <div style={{ maxWidth: 680, width: '100%', marginTop: 'auto', marginBottom: 'auto', paddingTop: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Add your first model</h2>
          <p style={{ fontSize: 13, color: 'var(--peek-text-muted)', marginBottom: 20 }}>
            Configure your GGUF model. You can add more profiles in Settings later.
          </p>
          <LlamaProfileEditor
            onSave={finishLlama}
            onCancel={() => setStep('provider')}
            cancelLabel="Back"
          />
        </div>
      )}
    </div>
  );
};

const ProviderCard: React.FC<{
  title: string;
  description: string;
  badge: string;
  badgeColor: string;
  onClick: () => void;
}> = ({ title, description, badge, badgeColor, onClick }) => (
  <button
    onClick={onClick}
    style={{
      flex: 1,
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--peek-border)',
      borderRadius: 12,
      padding: '20px 16px',
      cursor: 'pointer',
      color: 'var(--peek-text)',
      fontFamily: 'var(--peek-font)',
      textAlign: 'left',
      transition: 'border-color 0.15s, background 0.15s',
    }}
    onMouseOver={(e) => {
      (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.2)';
      (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
    }}
    onMouseOut={(e) => {
      (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--peek-border)';
      (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)';
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
      <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: `${badgeColor}22`, color: badgeColor }}>
        {badge}
      </span>
    </div>
    <p style={{ fontSize: 13, color: 'var(--peek-text-muted)', lineHeight: 1.5, margin: 0 }}>{description}</p>
  </button>
);

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(0,0,0,0.2)',
  border: '1px solid var(--peek-border)',
  color: 'var(--peek-text)',
  padding: '8px 12px',
  borderRadius: 6,
  fontSize: 14,
  outline: 'none',
  fontFamily: 'var(--peek-font-mono)',
  boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '9px 0',
  background: '#4caf50',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--peek-font)',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '9px 20px',
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--peek-text)',
  border: '1px solid var(--peek-border)',
  borderRadius: 6,
  fontSize: 14,
  cursor: 'pointer',
  fontFamily: 'var(--peek-font)',
};
