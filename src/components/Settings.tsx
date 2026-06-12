import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore, LlamaProfile } from '../store/settings';
import { LlamaProfileEditor } from './LlamaProfileEditor';
import { useLlamaServer } from '../hooks/useLlamaServer';

const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void }> = ({ checked, onChange }) => (
  <button
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    style={{
      width: 40,
      height: 24,
      borderRadius: 12,
      backgroundColor: checked ? '#4caf50' : 'rgba(255,255,255,0.2)',
      position: 'relative',
      border: 'none',
      cursor: 'pointer',
      transition: 'background-color 0.2s',
      padding: 0,
    }}
  >
    <div
      style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        backgroundColor: '#fff',
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        transition: 'left 0.2s',
        boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
      }}
    />
  </button>
);



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

export const Settings: React.FC = () => {
  const {
    activeProvider, setActiveProvider,
    ollamaBaseUrl, setOllamaBaseUrl,
    llamaBaseUrl, setLlamaBaseUrl,
    llamaProfiles, deleteLlamaProfile,
    activeLlamaProfileId, setActiveLlamaProfileId,
    historyRetentionDays,
    systemPrompt, setSystemPrompt,
    autoCaptureSelection, setAutoCaptureSelection
  } = useSettingsStore();
  const { status: serverStatus, launch, stop, activeProfile } = useLlamaServer();
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState<LlamaProfile | null>(null);

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
      {/* Title Bar Area */}
      <div style={{
        padding: '20px 24px',
        borderBottom: '1px solid var(--peek-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, letterSpacing: '0.02em' }}>Settings</h2>
        <button
          onClick={() => {
            import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
              getCurrentWebviewWindow().close();
            });
          }}
          style={{ background: 'none', border: 'none', color: 'var(--peek-text-muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '4px 6px', borderRadius: 4 }}
          onMouseOver={(e) => (e.currentTarget.style.color = 'var(--peek-text)')}
          onMouseOut={(e) => (e.currentTarget.style.color = 'var(--peek-text-muted)')}
          title="Close (Esc)"
        >✕</button>
      </div>

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
              <div>
                <span style={{ fontSize: 14, display: 'block' }}>Capture Highlighted Text</span>
                <span style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 4, display: 'block' }}>
                  Automatically fill the input with currently selected text when summoning.
                </span>
              </div>
              <Toggle checked={autoCaptureSelection} onChange={setAutoCaptureSelection} />
            </div>

          </div>
        </section>

        {/* Keyboard Shortcuts Section */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>Keyboard Shortcuts</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, overflow: 'hidden' }}>
            {[
              { label: 'Send message', keys: ['Enter'] },
              { label: 'New line', keys: ['Shift', 'Enter'] },
              { label: 'Dismiss overlay', keys: ['Esc'] },
              { label: 'New chat / clear conversation', keys: ['Alt', 'N'] },
              { label: 'Stop streaming', keys: ['Alt', 'Q'] },
              { label: 'Toggle history', keys: ['Alt', 'H'] },
              { label: 'Toggle memory', keys: ['Alt', 'R'] },
              { label: 'Switch model', keys: ['Alt', 'M'] },
              { label: 'Open settings', keys: ['Alt', ','] },
              { label: 'Show shortcuts legend', keys: ['Alt', '/'] },
            ].map((row, i, arr) => (
              <div key={row.label} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 16px',
                borderBottom: i < arr.length - 1 ? '1px solid var(--peek-border)' : 'none',
              }}>
                <span style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>{row.label}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {row.keys.map((k, ki) => (
                    <React.Fragment key={ki}>
                      {ki > 0 && <span style={{ fontSize: 11, color: 'var(--peek-text-muted)', alignSelf: 'center' }}>+</span>}
                      <kbd className="peek-kbd" style={{ fontSize: 11, padding: '2px 6px', height: 'auto' }}>{k}</kbd>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* AI Provider Section */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>AI Provider</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>Active Provider</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['ollama', 'llama'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setActiveProvider(p)}
                    style={{
                      fontSize: 13,
                      padding: '2px 10px',
                      borderRadius: 4,
                      border: 'none',
                      cursor: 'pointer',
                      background: activeProvider === p ? 'rgba(76,175,80,0.2)' : 'rgba(255,255,255,0.05)',
                      color: activeProvider === p ? '#4caf50' : 'var(--peek-text-secondary)',
                      fontFamily: 'var(--peek-font)',
                    }}
                  >
                    {p === 'ollama' ? 'Ollama' : 'llama.cpp'}
                  </button>
                ))}
              </div>
            </div>

            {activeProvider === 'ollama' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>Ollama Base URL</label>
                <input
                  type="text"
                  value={ollamaBaseUrl}
                  onChange={(e) => setOllamaBaseUrl(e.target.value)}
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

            {activeProvider === 'llama' && (
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
