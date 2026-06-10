import React from 'react';
import { useSettingsStore } from '../store/settings';

export const Settings: React.FC = () => {
  const { 
    hotkey, setHotkey, 
    activeProvider,
    ollamaBaseUrl, setOllamaBaseUrl,
    historyRetentionDays,
    systemPrompt, setSystemPrompt
  } = useSettingsStore();

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
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        
        {/* Hotkey Section */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>Global Shortcut</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>Summon Peekaboo</span>
              <kbd className="peek-kbd" style={{ fontSize: 12, padding: '4px 8px', height: 'auto' }}>{hotkey}</kbd>
            </div>
            <p style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 8, lineHeight: 1.4 }}>
              Note: Changing global hotkeys dynamically is not yet supported in this version. The default is Alt+Space.
            </p>
          </div>
        </section>

        {/* AI Provider Section */}
        <section style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 13, textTransform: 'uppercase', color: 'var(--peek-text-muted)', letterSpacing: '0.05em', marginBottom: 12 }}>AI Provider</h3>
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>Active Provider</span>
              <span style={{ fontSize: 13, color: 'var(--peek-text-secondary)', background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: 4, textTransform: 'capitalize' }}>
                {activeProvider}
              </span>
            </div>

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
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--peek-border)', borderRadius: 8, padding: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>History Retention</span>
              <span style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>{historyRetentionDays} Days</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--peek-text-muted)', marginTop: 8, lineHeight: 1.4 }}>
              All conversations are securely saved to your local SQLite database. Peekaboo operates with zero telemetry and 100% offline capability.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
};
