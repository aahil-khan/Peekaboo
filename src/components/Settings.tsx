import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore, LlamaProfile } from '../store/settings';
import { LlamaProfileEditor } from './LlamaProfileEditor';
import { useLlamaServer } from '../hooks/useLlamaServer';
import { usePluginsStore } from '../store/plugins';


const smallBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--peek-text-secondary)',
  border: '1px solid var(--peek-border)',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'var(--peek-font)',
};

import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { GeminiProvider } from '../providers/gemini';
import { OllamaProvider } from '../providers/ollama';

export const Settings: React.FC = () => {
  const {
    activeProvider, setActiveProvider,
    ollamaBaseUrl, setOllamaBaseUrl,
    llamaBaseUrl, setLlamaBaseUrl,
    openaiApiKey, setOpenaiApiKey,
    openaiBaseUrl, setOpenaiBaseUrl,
    anthropicApiKey, setAnthropicApiKey,
    geminiApiKey, setGeminiApiKey,
    llamaProfiles, deleteLlamaProfile,
    activeLlamaProfileId, setActiveLlamaProfileId,
    historyRetentionDays,
    systemPrompt, setSystemPrompt,
    autoCopyOnHide, setAutoCopyOnHide
  } = useSettingsStore();
  const { status: serverStatus, launch, stop, activeProfile } = useLlamaServer();
  const { 
    manifests, refreshManifests,
    enabledInputPlugins, toggleInputPlugin,
    enabledOutputPlugins, toggleOutputPlugin
  } = usePluginsStore();
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState<LlamaProfile | null>(null);

  // Verification state
  const [draftProvider, setDraftProvider] = useState<string>(activeProvider);
  const [verificationStatus, setVerificationStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [verificationError, setVerificationError] = useState<string>('');

  React.useEffect(() => {
    refreshManifests();
  }, []);

  const modelPlugins = manifests.filter(m => m.plugin.type === 'model');

  React.useEffect(() => {
    // Basic focus to allow immediate ESC key binding to work natively
    window.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
          getCurrentWebviewWindow().close();
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div style={{
      width: '100%',
      height: '100vh',
      backgroundColor: 'var(--peek-bg-solid)',
      color: 'var(--peek-text)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'var(--peek-font)',
      userSelect: 'none',
      borderTop: '1px solid rgba(255,255,255,0.05)',
    }}>


      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        
        {/* Hotkey Section */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>Global Shortcut</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>Summon Peekaboo</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <kbd className="peek-kbd" style={{ fontSize: 12, padding: '4px 8px', height: 'auto' }}>Alt+Space</kbd>
                <span style={{ fontSize: 11, color: 'var(--peek-text-muted)' }}>or</span>
                <kbd className="peek-kbd" style={{ fontSize: 12, padding: '4px 8px', height: 'auto' }}>Ctrl+Space</kbd>
              </div>
            </div>

            <div style={{ height: '1px', background: 'var(--peek-border)', margin: '4px 0' }} />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ paddingRight: 16 }}>
                <span style={{ fontSize: 14, display: 'block' }}>Copy Answer on Dismiss</span>
                <span style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 4, display: 'block' }}>
                  Put the last completed answer on the clipboard when you hide the overlay.
                  Off by default — it replaces whatever you had copied. <kbd className="peek-kbd" style={{ fontSize: 10, padding: '1px 4px', height: 'auto' }}>Alt+C</kbd> always copies on demand.
                </span>
              </div>
              <button
                role="switch"
                aria-checked={autoCopyOnHide}
                onClick={() => setAutoCopyOnHide(!autoCopyOnHide)}
                style={{
                  flexShrink: 0,
                  width: 36, height: 20, borderRadius: 10,
                  background: autoCopyOnHide ? '#4caf50' : 'rgba(255,255,255,0.1)',
                  border: 'none', cursor: 'pointer', position: 'relative',
                  transition: 'background 0.2s', padding: 0
                }}
              >
                <div style={{
                  position: 'absolute', top: 2, left: autoCopyOnHide ? 18 : 2,
                  width: 16, height: 16, borderRadius: 8, background: '#fff',
                  transition: 'left 0.2s'
                }} />
              </button>
            </div>
          </div>
        </section>

        {/* AI Provider Section */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>AI Provider</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>Select Provider</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['ollama', 'llama', 'openai', 'anthropic', 'gemini', ...modelPlugins.map(mp => mp.plugin.id)].map((p) => {
                  const label = p === 'ollama' ? 'Ollama' : p === 'llama' ? 'llama.cpp' : p === 'openai' ? 'OpenAI' : p === 'anthropic' ? 'Anthropic' : p === 'gemini' ? 'Google Gemini' : (modelPlugins.find(mp => mp.plugin.id === p)?.plugin.name || p);
                  return (
                    <button
                      key={p}
                      onClick={() => {
                        setDraftProvider(p);
                        setVerificationStatus('idle');
                        setVerificationError('');
                      }}
                      style={{
                        fontSize: 13,
                        padding: '2px 10px',
                        borderRadius: 4,
                        border: 'none',
                        cursor: 'pointer',
                        background: draftProvider === p ? (activeProvider === p ? 'rgba(76,175,80,0.2)' : 'rgba(255,255,255,0.15)') : 'rgba(255,255,255,0.05)',
                        color: draftProvider === p ? (activeProvider === p ? '#4caf50' : 'var(--peek-text)') : 'var(--peek-text-secondary)',
                        fontFamily: 'var(--peek-font)',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {draftProvider === 'ollama' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>Ollama Base URL</label>
                <input
                  type="text"
                  value={ollamaBaseUrl}
                  onChange={(e) => { setOllamaBaseUrl(e.target.value); setVerificationStatus('idle'); }}
                  style={{
                    background: 'rgba(0,0,0,0.2)',
                    border: '1px solid var(--peek-border)',
                    color: 'var(--peek-text)',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 14,
                    outline: 'none',
                    fontFamily: 'var(--peek-font-mono)'
                  }}
                />
              </div>
            )}

            {draftProvider === 'openai' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>OpenAI API Key</label>
                <input
                  type="password"
                  value={openaiApiKey}
                  placeholder="sk-..."
                  onChange={(e) => { setOpenaiApiKey(e.target.value); setVerificationStatus('idle'); }}
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--peek-border)', color: 'var(--peek-text)', padding: '8px 12px', borderRadius: 6, fontSize: 14, outline: 'none', fontFamily: 'var(--peek-font-mono)' }}
                />
                <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)', marginTop: 4 }}>OpenAI Base URL</label>
                <input
                  type="text"
                  value={openaiBaseUrl}
                  onChange={(e) => { setOpenaiBaseUrl(e.target.value); setVerificationStatus('idle'); }}
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--peek-border)', color: 'var(--peek-text)', padding: '8px 12px', borderRadius: 6, fontSize: 14, outline: 'none', fontFamily: 'var(--peek-font-mono)' }}
                />
              </div>
            )}

            {draftProvider === 'anthropic' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>Anthropic API Key</label>
                <input
                  type="password"
                  value={anthropicApiKey}
                  placeholder="sk-ant-..."
                  onChange={(e) => { setAnthropicApiKey(e.target.value); setVerificationStatus('idle'); }}
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--peek-border)', color: 'var(--peek-text)', padding: '8px 12px', borderRadius: 6, fontSize: 14, outline: 'none', fontFamily: 'var(--peek-font-mono)' }}
                />
              </div>
            )}

            {draftProvider === 'gemini' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>Google Gemini API Key</label>
                <input
                  type="password"
                  value={geminiApiKey}
                  placeholder="AIza..."
                  onChange={(e) => { setGeminiApiKey(e.target.value); setVerificationStatus('idle'); }}
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--peek-border)', color: 'var(--peek-text)', padding: '8px 12px', borderRadius: 6, fontSize: 14, outline: 'none', fontFamily: 'var(--peek-font-mono)' }}
                />
              </div>
            )}

            {draftProvider !== 'llama' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                {verificationStatus === 'success' ? (
                  <span style={{ fontSize: 13, color: '#4caf50' }}>✓ Connection verified, {draftProvider} is active</span>
                ) : verificationStatus === 'error' ? (
                  <span style={{ fontSize: 13, color: '#f44336' }}>✗ {verificationError || 'Connection failed'}</span>
                ) : (
                  <span style={{ fontSize: 13, color: 'var(--peek-text-muted)' }}>
                    {draftProvider === activeProvider ? 'Currently active' : 'Click verify to test and switch'}
                  </span>
                )}
                <button
                  disabled={verificationStatus === 'testing'}
                  onClick={async () => {
                    setVerificationStatus('testing');
                    setVerificationError('');
                    let isAvailable = false;
                    try {
                      if (draftProvider === 'ollama') {
                        isAvailable = await new OllamaProvider(ollamaBaseUrl).isAvailable();
                      } else if (draftProvider === 'openai') {
                        isAvailable = await new OpenAIProvider(openaiBaseUrl, openaiApiKey).isAvailable();
                      } else if (draftProvider === 'anthropic') {
                        isAvailable = await new AnthropicProvider(anthropicApiKey).isAvailable();
                      } else if (draftProvider === 'gemini') {
                        isAvailable = await new GeminiProvider(geminiApiKey).isAvailable();
                      } else {
                        // Assuming it's a plugin provider (which we didn't mock for isAvailable natively yet in Settings, but plugins generally skip connection validation)
                        isAvailable = true; 
                      }
                      
                      if (isAvailable) {
                        setVerificationStatus('success');
                        setActiveProvider(draftProvider);
                      } else {
                        setVerificationStatus('error');
                        setVerificationError('Could not connect. Check your configuration.');
                      }
                    } catch (e: any) {
                      setVerificationStatus('error');
                      setVerificationError(e.message || 'Verification failed');
                    }
                  }}
                  style={{
                    padding: '6px 14px',
                    background: verificationStatus === 'testing' ? 'rgba(255,255,255,0.1)' : 'rgba(76,175,80,0.15)',
                    color: verificationStatus === 'testing' ? 'var(--peek-text-muted)' : '#4caf50',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 13,
                    cursor: verificationStatus === 'testing' ? 'wait' : 'pointer',
                    fontFamily: 'var(--peek-font)',
                    fontWeight: 500
                  }}
                >
                  {verificationStatus === 'testing' ? 'Verifying...' : draftProvider === activeProvider ? 'Verify Connection' : 'Verify & Switch'}
                </button>
              </div>
            )}

            {draftProvider === 'llama' && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>Server URL</label>
                    <span style={{ fontSize: 12, color: serverStatus === 'running' ? '#4caf50' : serverStatus === 'starting' ? '#ff9800' : 'var(--peek-text-muted)' }}>
                      {serverStatus === 'running' ? '● Running' : serverStatus === 'starting' ? '● Starting…' : serverStatus === 'error' ? '● Error' : '○ Stopped'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={llamaBaseUrl}
                      onChange={(e) => setLlamaBaseUrl(e.target.value)}
                      style={{
                        flex: 1,
                        background: 'rgba(0,0,0,0.2)',
                        border: '1px solid var(--peek-border)',
                        color: 'var(--peek-text)',
                        padding: '8px 12px',
                        borderRadius: 6,
                        fontSize: 14,
                        outline: 'none',
                        fontFamily: 'var(--peek-font-mono)'
                      }}
                    />
                    {serverStatus === 'running' ? (
                      <button onClick={stop} style={{ padding: '8px 14px', background: 'rgba(244,67,54,0.12)', color: '#f44336', border: '1px solid rgba(244,67,54,0.3)', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'var(--peek-font)', whiteSpace: 'nowrap' }}>Stop</button>
                    ) : activeProfile ? (
                      <button onClick={() => launch(activeProfile)} style={{ padding: '8px 14px', background: 'rgba(76,175,80,0.12)', color: '#4caf50', border: '1px solid rgba(76,175,80,0.3)', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'var(--peek-font)', whiteSpace: 'nowrap' }}>Start</button>
                    ) : null}
                  </div>
                </div>

                {/* Model Profiles */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>Model Profiles</label>
                    <button
                      onClick={() => { setShowAddProfile(true); setEditingProfile(null); }}
                      style={{ fontSize: 12, padding: '3px 10px', background: 'rgba(255,255,255,0.06)', color: 'var(--peek-text-secondary)', border: '1px solid var(--peek-border)', borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--peek-font)' }}
                    >
                      + Add
                    </button>
                  </div>

                  {llamaProfiles.length === 0 && !showAddProfile && (
                    <p style={{ fontSize: 12, color: 'var(--peek-text-muted)', margin: 0 }}>No profiles yet. Add one to launch a model.</p>
                  )}

                  {llamaProfiles.map((p) => (
                    <div key={p.id} style={{
                      background: activeLlamaProfileId === p.id ? 'rgba(76,175,80,0.06)' : 'rgba(0,0,0,0.15)',
                      border: `1px solid ${activeLlamaProfileId === p.id ? 'rgba(76,175,80,0.3)' : 'var(--peek-border)'}`,
                      borderRadius: 8, padding: '10px 12px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--peek-text-muted)', marginTop: 2 }}>
                          {p.modelPath.split(/[\\/]/).pop()} · {p.contextSize.toLocaleString()} ctx · {p.nGpuLayers} layers
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {activeLlamaProfileId !== p.id && (
                          <button onClick={() => setActiveLlamaProfileId(p.id)} style={smallBtnStyle}>Use</button>
                        )}
                        {activeLlamaProfileId === p.id && (
                          <span style={{ fontSize: 11, color: '#4caf50', padding: '3px 8px' }}>Active</span>
                        )}
                        <button onClick={() => { setEditingProfile(p); setShowAddProfile(false); }} style={smallBtnStyle}>Edit</button>
                        <button onClick={() => deleteLlamaProfile(p.id)} style={{ ...smallBtnStyle, color: '#f44336' }}>✕</button>
                      </div>
                    </div>
                  ))}

                  {(showAddProfile || editingProfile) && (
                    <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: 16 }}>
                      <LlamaProfileEditor
                        profile={editingProfile ?? undefined}
                        onSave={() => { setShowAddProfile(false); setEditingProfile(null); }}
                        onCancel={() => { setShowAddProfile(false); setEditingProfile(null); }}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </section>

        {/* AI Persona Section */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>AI Persona & Instructions</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>System Prompt</label>
            <textarea 
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a helpful assistant..."
              style={{
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid var(--peek-border)',
                color: 'var(--peek-text)',
                padding: '12px',
                borderRadius: 6,
                fontSize: 14,
                outline: 'none',
                fontFamily: 'var(--peek-font)',
                minHeight: '100px',
                resize: 'vertical'
              }}
            />
            <p style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 4, lineHeight: 1.4 }}>
              This prompt will be injected as hidden context into every new conversation you start.
            </p>
          </div>
        </section>

        {/* Plugins */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>Plugins</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(() => {
              const ioPlugins = manifests.filter(m => m.plugin.type === 'input' || m.plugin.type === 'output');
              const contextPlugins = manifests.filter(m => m.plugin.type === 'context');

              if (ioPlugins.length === 0 && contextPlugins.length === 0) {
                return (
                  <p style={{ fontSize: 13, color: 'var(--peek-text-muted)', margin: 0 }}>
                    No input, output, or context plugins found in <code>~/.config/peekaboo/plugins/</code>.
                  </p>
                );
              }

              return (
                <>
                  {ioPlugins.map((m) => {
                    const isInput = m.plugin.type === 'input';
                    const isEnabled = isInput
                      ? enabledInputPlugins.includes(m.plugin.id)
                      : enabledOutputPlugins.includes(m.plugin.id);

                    return (
                      <div key={m.plugin.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 500 }}>{m.plugin.name}</span>
                            <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: 4, color: 'var(--peek-text-muted)' }}>
                              {m.plugin.type}
                            </span>
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 4, display: 'block' }}>
                            Version {m.plugin.version} • ID: {m.plugin.id}
                          </span>
                        </div>

                        <button
                          onClick={() => {
                            if (isInput) {
                              toggleInputPlugin(m.plugin.id, !isEnabled);
                            } else {
                              toggleOutputPlugin(m.plugin.id, !isEnabled);
                            }
                          }}
                          style={{
                            width: 36, height: 20, borderRadius: 10,
                            background: isEnabled ? '#4caf50' : 'rgba(255,255,255,0.1)',
                            border: 'none', cursor: 'pointer', position: 'relative',
                            transition: 'background 0.2s', padding: 0
                          }}
                        >
                          <div style={{
                            position: 'absolute', top: 2, left: isEnabled ? 18 : 2,
                            width: 16, height: 16, borderRadius: 8, background: '#fff',
                            transition: 'left 0.2s'
                          }} />
                        </button>
                      </div>
                    );
                  })}

                  {contextPlugins.length > 0 && (
                    <>
                      {ioPlugins.length > 0 && (
                        <div style={{ height: '1px', background: 'var(--peek-border)', margin: '4px 0' }} />
                      )}
                      <p style={{ fontSize: 12, color: 'var(--peek-text-muted)', margin: 0 }}>
                        Context plugins are available via <code>/</code> commands.
                      </p>
                      {contextPlugins.map((m) => (
                        <div key={m.plugin.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 14, fontWeight: 500 }}>{m.plugin.name}</span>
                              <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: 4, color: 'var(--peek-text-muted)' }}>
                                context
                              </span>
                              {m.context?.command && (
                                <span style={{ fontSize: 11, color: 'var(--peek-text-muted)' }}>
                                  /{m.context.command}
                                </span>
                              )}
                            </div>
                            <span style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 4, display: 'block' }}>
                              Version {m.plugin.version} • ID: {m.plugin.id}
                            </span>
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--peek-text-muted)' }}>Available</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </section>

        {/* Data & Privacy */}
        <section>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>Data & Privacy</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>History Retention</span>
              <span style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>{historyRetentionDays} Days</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--peek-text-muted)', lineHeight: 1.4 }}>
              All conversations are securely saved to your local SQLite database. Peekaboo operates with zero telemetry and 100% offline capability.
            </p>
            <div style={{ height: 1, background: 'var(--peek-border)' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: 14, display: 'block' }}>Reset App</span>
                <span style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 2, display: 'block' }}>
                  Clears all settings and re-runs setup on next launch.
                </span>
              </div>
              <button
                onClick={async () => {
                  if (window.confirm('Reset all settings? This cannot be undone.')) {
                    localStorage.clear();
                    await invoke('reset_and_show_setup');
                    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                    getCurrentWebviewWindow().close();
                  }
                }}
                style={{ padding: '6px 14px', background: 'rgba(244,67,54,0.1)', color: '#f44336', border: '1px solid rgba(244,67,54,0.3)', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--peek-font)', whiteSpace: 'nowrap' }}
              >
                Reset
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
