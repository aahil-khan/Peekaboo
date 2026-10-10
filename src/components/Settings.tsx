import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettingsStore, LlamaProfile } from '../store/settings';
import { THEME_ACCENTS, findTheme, themesByFamily } from '../lib/themes';
import { LlamaProfileEditor } from './LlamaProfileEditor';
import { ProviderFields } from './ProviderFields';
import { useLlamaServer } from '../hooks/useLlamaServer';
import { usePluginsStore } from '../store/plugins';
import { BUILTIN_PROVIDERS, providerLabel, verifyProvider } from '../lib/providerCatalog';

/**
 * The settings window.
 *
 * Previously a single 480x520 pane holding five sections in one undifferentiated
 * scroll — four to six screenfuls with no header, navigation or search. Now a
 * left rail, so each area is one screen and reachable in a click.
 */

type SectionId = 'general' | 'provider' | 'assistant' | 'plugins' | 'data';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'provider', label: 'AI provider' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'data', label: 'Data & privacy' },
];

const RETENTION_CHOICES = [7, 30, 90, 365];

export const Settings: React.FC = () => {
  const {
    activeProvider, setActiveProvider,
    llamaBaseUrl, setLlamaBaseUrl,
    llamaProfiles, deleteLlamaProfile,
    activeLlamaProfileId, setActiveLlamaProfileId,
    historyRetentionDays, setHistoryRetentionDays,
    systemPrompt, setSystemPrompt,
    includePinnedMemories, setIncludePinnedMemories,
    autoCopyOnHide, setAutoCopyOnHide,
    themeId, setThemeId,
    followSystem, setFollowSystem,
    themeAccent, setThemeAccent,
  } = useSettingsStore();

  const { status: serverStatus, launch, stop, activeProfile } = useLlamaServer();
  const {
    manifests, incompatible, refreshManifests,
    enabledInputPlugins, toggleInputPlugin,
    enabledOutputPlugins, toggleOutputPlugin,
  } = usePluginsStore();

  const [section, setSection] = useState<SectionId>('general');
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [editingProfile, setEditingProfile] = useState<LlamaProfile | null>(null);

  const [draftProvider, setDraftProvider] = useState<string>(activeProvider);
  const [verifyState, setVerifyState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [verifyMessage, setVerifyMessage] = useState('');

  useEffect(() => {
    refreshManifests();
  }, [refreshManifests]);

  useEffect(() => {
    // Focus so the Escape binding below works without a click first.
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

  const modelPlugins = manifests.filter((m) => m.plugin.type === 'model');
  const providerIds = [...BUILTIN_PROVIDERS.map((p) => p.id), ...modelPlugins.map((mp) => mp.plugin.id)];

  const runVerification = async () => {
    setVerifyState('testing');
    setVerifyMessage('');
    const result = await verifyProvider(draftProvider);
    if (result.ok) {
      setActiveProvider(draftProvider);
      setVerifyState('success');
      setVerifyMessage(result.note ?? `Connected. ${providerLabel(draftProvider)} is now active.`);
    } else {
      setVerifyState('error');
      setVerifyMessage(result.error ?? 'Could not connect.');
    }
  };

  return (
    <div className="peek-settings">
      <nav className="peek-settings-nav">
        <div className="peek-settings-brand">Peekaboo</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className="peek-settings-navbtn"
            aria-current={section === s.id ? 'page' : undefined}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="peek-settings-body">
        {section === 'general' && (
          <>
            <h2 className="peek-settings-h2">General</h2>
            <p className="peek-settings-intro">How Peekaboo looks and behaves when you summon it.</p>

            <div className="peek-settings-card">
              <span className="peek-settings-rowtext">
                <span className="peek-settings-label">Theme</span>
                <span className="peek-settings-desc">
                  Each one is a complete palette. Cards preview their own colours.
                </span>
              </span>

              {themesByFamily().map(({ family, themes }) => (
                <div key={family}>
                  <div className="peek-theme-family">{family}</div>
                  <div className="peek-theme-grid">
                    {themes.map((t) => (
                      <button
                        key={t.id}
                        className="peek-theme-card"
                        data-theme={t.id}
                        data-appearance={t.appearance}
                        aria-pressed={themeId === t.id}
                        onClick={() => setThemeId(t.id)}
                      >
                        <span className="peek-theme-dots"><i /><i /><i /></span>
                        <span className="peek-theme-name">{t.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <div className="peek-settings-divider" />

              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Match my system</span>
                  <span className="peek-settings-desc">
                    Switch to {findTheme(themeId).pairedWith
                      ? findTheme(findTheme(themeId).pairedWith!).label
                      : 'the counterpart'}{' '}
                    when the desktop is set to{' '}
                    {findTheme(themeId).appearance === 'dark' ? 'light' : 'dark'} mode.
                  </span>
                </span>
                <button
                  className="peek-switch"
                  role="switch"
                  aria-checked={followSystem}
                  aria-label="Match my system light or dark setting"
                  onClick={() => setFollowSystem(!followSystem)}
                />
              </div>

              <div className="peek-settings-divider" />

              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Accent</span>
                  <span className="peek-settings-desc">
                    Overrides the palette's own highlight colour. “Auto” keeps it.
                  </span>
                </span>
                <div className="peek-swatches">
                  {THEME_ACCENTS.map((accent) =>
                    accent === 'auto' ? (
                      <button
                        key={accent}
                        className="peek-btn peek-btn--sm"
                        aria-pressed={themeAccent === 'auto'}
                        onClick={() => setThemeAccent('auto')}
                        style={
                          themeAccent === 'auto'
                            ? { borderColor: 'var(--peek-accent)', color: 'var(--peek-accent)' }
                            : undefined
                        }
                      >
                        Auto
                      </button>
                    ) : (
                      <button
                        key={accent}
                        className="peek-swatch"
                        data-accent={accent}
                        data-appearance={findTheme(themeId).appearance}
                        aria-pressed={themeAccent === accent}
                        aria-label={accent}
                        title={accent}
                        onClick={() => setThemeAccent(accent)}
                      />
                    )
                  )}
                </div>
              </div>
            </div>

            <div className="peek-settings-card">
              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Summon Peekaboo</span>
                  <span className="peek-settings-desc">
                    Works from any app. Not currently rebindable.
                  </span>
                </span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  <kbd className="peek-kbd">Ctrl+Space</kbd>
                  <span className="peek-form-hint">or</span>
                  <kbd className="peek-kbd">Alt+Space</kbd>
                </span>
              </div>

              <div className="peek-settings-divider" />

              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Copy the answer when I hide the window</span>
                  <span className="peek-settings-desc">
                    Off by default — it replaces whatever you had copied.{' '}
                    <kbd className="peek-kbd">Alt+C</kbd> copies on demand instead.
                  </span>
                </span>
                <button
                  className="peek-switch"
                  role="switch"
                  aria-checked={autoCopyOnHide}
                  aria-label="Copy the answer when I hide the window"
                  onClick={() => setAutoCopyOnHide(!autoCopyOnHide)}
                />
              </div>
            </div>
          </>
        )}

        {section === 'provider' && (
          <>
            <h2 className="peek-settings-h2">AI provider</h2>
            <p className="peek-settings-intro">
              Where your questions get answered. Local providers keep everything on this machine;
              cloud providers send your messages to that company's servers.
            </p>

            <div className="peek-settings-card">
              <div className="peek-provider-pills">
                {providerIds.map((id) => {
                  const label = providerLabel(id, modelPlugins.find((mp) => mp.plugin.id === id)?.plugin.name);
                  return (
                    <button
                      key={id}
                      className="peek-provider-pill"
                      aria-pressed={draftProvider === id}
                      data-active={activeProvider === id ? 'true' : undefined}
                      onClick={() => {
                        setDraftProvider(id);
                        setVerifyState('idle');
                        setVerifyMessage('');
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {draftProvider !== 'llama' && (
                <>
                  <ProviderFields provider={draftProvider} onChange={() => setVerifyState('idle')} advanced />

                  <div className="peek-settings-row">
                    <span
                      className={
                        verifyState === 'success'
                          ? 'peek-settings-desc peek-tone-ok'
                          : verifyState === 'error'
                            ? 'peek-settings-desc peek-tone-error'
                            : 'peek-settings-desc'
                      }
                    >
                      {verifyState === 'success' || verifyState === 'error'
                        ? verifyMessage
                        : draftProvider === activeProvider
                          ? 'Currently active.'
                          : 'Check the connection to switch to this provider.'}
                    </span>
                    <button
                      className="peek-btn peek-btn--secondary"
                      style={{ flexShrink: 0 }}
                      disabled={verifyState === 'testing'}
                      onClick={runVerification}
                    >
                      {verifyState === 'testing'
                        ? 'Checking…'
                        : draftProvider === activeProvider
                          ? 'Check connection'
                          : 'Check & switch'}
                    </button>
                  </div>
                </>
              )}

              {draftProvider === 'llama' && (
                <>
                  <div className="peek-form-row">
                    <div className="peek-settings-row">
                      <label className="peek-form-label">Server address</label>
                      <span
                        className={
                          serverStatus === 'running'
                            ? 'peek-form-hint peek-tone-ok'
                            : serverStatus === 'starting'
                              ? 'peek-form-hint peek-tone-warn'
                              : serverStatus === 'error'
                                ? 'peek-form-hint peek-tone-error'
                                : 'peek-form-hint'
                        }
                      >
                        <span className="peek-status-dot" />
                        {serverStatus === 'running'
                          ? 'Running'
                          : serverStatus === 'starting'
                            ? 'Starting…'
                            : serverStatus === 'error'
                              ? 'Failed to start'
                              : 'Stopped'}
                      </span>
                    </div>
                    <div className="peek-file-row">
                      <input
                        className="peek-field peek-field--mono"
                        type="text"
                        value={llamaBaseUrl}
                        onChange={(e) => setLlamaBaseUrl(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      {serverStatus === 'running' ? (
                        <button className="peek-btn peek-btn--danger peek-btn--sm" onClick={stop}>Stop</button>
                      ) : activeProfile ? (
                        <button className="peek-btn peek-btn--sm" onClick={() => launch(activeProfile)}>Start</button>
                      ) : null}
                    </div>
                  </div>

                  <div className="peek-form-row">
                    <div className="peek-settings-row">
                      <label className="peek-form-label">Models</label>
                      <button
                        className="peek-btn peek-btn--sm"
                        onClick={() => { setShowAddProfile(true); setEditingProfile(null); }}
                      >
                        Add a model
                      </button>
                    </div>

                    {llamaProfiles.length === 0 && !showAddProfile && (
                      <span className="peek-form-hint">No models set up yet. Add one to get started.</span>
                    )}

                    {llamaProfiles.map((p) => (
                      <div
                        key={p.id}
                        className="peek-profile-row"
                        data-active={activeLlamaProfileId === p.id ? 'true' : undefined}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div className="peek-settings-label">{p.name}</div>
                          <div className="peek-form-hint">
                            {p.modelPath.split(/[\\/]/).pop()} · {p.contextSize.toLocaleString()} token context
                            {p.nGpuLayers > 0 ? ` · ${p.nGpuLayers} GPU layers` : ''}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                          {activeLlamaProfileId === p.id ? (
                            <span className="peek-form-hint peek-tone-ok">In use</span>
                          ) : (
                            <button className="peek-btn peek-btn--sm" onClick={() => setActiveLlamaProfileId(p.id)}>Use</button>
                          )}
                          <button className="peek-btn peek-btn--sm" onClick={() => { setEditingProfile(p); setShowAddProfile(false); }}>Edit</button>
                          <button
                            className="peek-btn peek-btn--sm peek-btn--danger"
                            aria-label={`Delete ${p.name}`}
                            onClick={() => deleteLlamaProfile(p.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}

                    {(showAddProfile || editingProfile) && (
                      <div className="peek-settings-card" style={{ marginBottom: 0 }}>
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
          </>
        )}

        {section === 'assistant' && (
          <>
            <h2 className="peek-settings-h2">Assistant</h2>
            <p className="peek-settings-intro">
              Standing instructions the assistant follows in every new conversation. You won't see
              these in the transcript.
            </p>

            <div className="peek-settings-card">
              <div className="peek-form-row">
                <label className="peek-form-label">Instructions</label>
                <textarea
                  className="peek-field peek-field--textarea"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="e.g. Answer briefly. Prefer examples over explanation."
                  style={{ minHeight: 140 }}
                />
              </div>

              <div className="peek-settings-divider" />

              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Send pinned memories</span>
                  <span className="peek-settings-desc">
                    Pinned memories are sent to the selected model with every question, including
                    cloud models such as OpenAI, Anthropic and Gemini. Unpinned memories stay on
                    this machine until you insert one yourself.
                  </span>
                </span>
                <button
                  className="peek-switch"
                  role="switch"
                  aria-checked={includePinnedMemories}
                  aria-label="Send pinned memories with every question"
                  onClick={() => setIncludePinnedMemories(!includePinnedMemories)}
                />
              </div>
            </div>
          </>
        )}

        {section === 'plugins' && (
          <>
            <h2 className="peek-settings-h2">Plugins</h2>
            <p className="peek-settings-intro">
              Add-ons that pull in context, act on answers, or add a model provider. Some ship with
              Peekaboo; you can add your own by dropping a folder containing a{' '}
              <code>plugin.toml</code> into <code>~/.config/peekaboo/plugins/</code>. Giving yours
              the same id as a built-in replaces it.
            </p>

            <div className="peek-settings-card">
              {manifests.length === 0 ? (
                <>
                  <span className="peek-settings-desc">
                    No plugins were found — not even the built-in ones, which means discovery
                    failed rather than that nothing is installed.
                  </span>
                  <span className="peek-settings-desc peek-tone-warn">
                    Plugins can read your clipboard, your screen, and files in your home directory
                    outside hidden folders. Only install ones you trust.
                  </span>
                </>
              ) : (
                manifests.map((m, i) => {
                  const type = m.plugin.type;
                  const isInput = type === 'input';
                  const isOutput = type === 'output';
                  const isEnabled = isInput
                    ? enabledInputPlugins.includes(m.plugin.id)
                    : enabledOutputPlugins.includes(m.plugin.id);

                  return (
                    <React.Fragment key={m.plugin.id}>
                      {i > 0 && <div className="peek-settings-divider" />}
                      <div className="peek-settings-row">
                        <span className="peek-settings-rowtext">
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="peek-settings-label">{m.plugin.name}</span>
                            <span className="peek-badge">{type}</span>
                            {m.plugin.builtin === false && <span className="peek-badge">installed</span>}
                            {type === 'context' && m.context?.command && (
                              <span className="peek-form-hint">/{m.context.command}</span>
                            )}
                          </span>
                          <span className="peek-settings-desc">
                            {type === 'context'
                              ? `Type /${m.context?.command ?? ''} in the overlay to use it.`
                              : type === 'model'
                                ? 'Selectable as a provider above.'
                                : `Runs ${isInput ? 'before' : 'after'} each message.`}
                            {' '}v{m.plugin.version}
                          </span>
                        </span>
                        {(isInput || isOutput) && (
                          <button
                            className="peek-switch"
                            role="switch"
                            aria-checked={isEnabled}
                            aria-label={`Enable ${m.plugin.name}`}
                            onClick={() =>
                              isInput
                                ? toggleInputPlugin(m.plugin.id, !isEnabled)
                                : toggleOutputPlugin(m.plugin.id, !isEnabled)
                            }
                          />
                        )}
                      </div>
                    </React.Fragment>
                  );
                })
              )}
            </div>

            {incompatible.length > 0 && (
              <div className="peek-settings-card">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Not loaded</span>
                  <span className="peek-settings-desc">
                    Found in your plugins folder but written against a different version of
                    the plugin API, so Peekaboo will not run them.
                  </span>
                </span>

                {incompatible.map((m) => (
                  <React.Fragment key={m.plugin.id}>
                    <div className="peek-settings-divider" />
                    <div className="peek-settings-row">
                      <span className="peek-settings-rowtext">
                        <span className="peek-settings-label">{m.plugin.name || m.plugin.id}</span>
                        <span className="peek-settings-desc peek-tone-warn">{m.plugin.error}</span>
                      </span>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </>
        )}

        {section === 'data' && (
          <>
            <h2 className="peek-settings-h2">Data & privacy</h2>
            <p className="peek-settings-intro">
              Conversations are stored in a database file on this machine. Peekaboo collects no
              telemetry. Note that if you pick a cloud provider, your messages are sent to that
              provider to be answered.
            </p>

            <div className="peek-settings-card">
              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Keep history for</span>
                  <span className="peek-settings-desc">Older conversations are removed automatically.</span>
                </span>
                <div className="peek-segmented">
                  {RETENTION_CHOICES.map((days) => (
                    <button
                      key={days}
                      aria-pressed={historyRetentionDays === days}
                      onClick={() => setHistoryRetentionDays(days)}
                    >
                      {days === 365 ? '1 year' : `${days} days`}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="peek-settings-card">
              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Run setup again</span>
                  <span className="peek-settings-desc">
                    Walks through choosing a provider and model. Keeps everything you've configured.
                  </span>
                </span>
                <button
                  className="peek-btn peek-btn--secondary"
                  style={{ flexShrink: 0 }}
                  onClick={() => invoke('show_setup_mode')}
                >
                  Open setup
                </button>
              </div>

              <div className="peek-settings-divider" />

              <div className="peek-settings-row">
                <span className="peek-settings-rowtext">
                  <span className="peek-settings-label">Reset everything</span>
                  <span className="peek-settings-desc">
                    Erases all settings, API keys and model profiles, then reopens setup. Cannot be
                    undone.
                  </span>
                </span>
                <button
                  className="peek-btn peek-btn--danger"
                  style={{ flexShrink: 0 }}
                  onClick={async () => {
                    if (!window.confirm('Erase all settings, API keys and model profiles? This cannot be undone.')) return;
                    localStorage.clear();
                    await invoke('reset_and_show_setup');
                    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                    getCurrentWebviewWindow().close();
                  }}
                >
                  Reset
                </button>
              </div>
            </div>

            <button
              className="peek-link-btn"
              onClick={() => openUrl('https://github.com/aahil-khan/peekaboo').catch(() => {})}
            >
              Peekaboo on GitHub ↗
            </button>
          </>
        )}
      </div>
    </div>
  );
};
