import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import { Input } from './Input';
import { Transcript } from './Transcript';
import { Footer, type FooterStatus } from './Footer';
import { History } from './History';
import { Models } from './Models';
import { Legend } from './Legend';
import { MemoryOverlay } from './MemoryOverlay';
import { Attachments } from './Attachments';
import { usePeekStore } from '../store/peek';
import { useSettingsStore } from '../store/settings';
import { useHistoryStore, type Session } from '../store/history';
import { useStream } from '../hooks/useStream';
import { useShortcuts } from '../hooks/useShortcuts';
import { togglePanel } from '../hooks/usePanels';
import { useAttachments, type Attachment } from '../hooks/useAttachments';
import { registry } from '../lib/plugins/registry';
import { usePluginsStore } from '../store/plugins';
import { useLlamaServer } from '../hooks/useLlamaServer';
import { OllamaProvider } from '../providers/ollama';
import { LlamaProvider } from '../providers/llama';
import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { GeminiProvider } from '../providers/gemini';
import { ModelPluginProvider } from '../providers/plugin';
import { peekVariants } from '../lib/motion';
import {
  createSession,
  saveMessage,
  updateSessionTitle,
  getRecentSessions,
  getSessionMessages,
  searchMemories,
  cleanOldSessions,
} from '../db/database';

function generateId(): string {
  return crypto.randomUUID();
}

export const PeekSurface: React.FC = () => {
  const {
    visible,
    setVisible,
    input,
    setInput,
    messages,
    addMessage,
    setMessages,
    activeSessionId,
    setActiveSessionId,
    streamingContent,
    isStreaming,
    addBackgroundTask,
    updateBackgroundTask,
    clear,
  } = usePeekStore();

  const { 
    activeModel, setActiveModel, 
    activeProvider,
    ollamaBaseUrl, llamaBaseUrl,
    openaiApiKey, openaiBaseUrl,
    anthropicApiKey, geminiApiKey,
    setupCompleted
  } = useSettingsStore();
  const { status: serverStatus } = useLlamaServer();
  const { setSessions } = useHistoryStore();
  const { attachments, add: addAttachment, remove: removeAttachment, clear: clearAttachments, buildMessageContent } = useAttachments();
  const { run: runStream, abort: abortStream } = useStream();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [viewingAttachment, setViewingAttachment] = useState<any | null>(null);
  const [hasActiveModalHeight, setHasActiveModalHeight] = useState(false);
  const viewingAttachmentRef = useRef<any | null>(null);
  const attachmentsRef = useRef<any[]>([]);
  // Set while a screen capture is in flight. capture_region hides the overlay so
  // it isn't in the shot, which fires peek-focus-lost — without this the
  // auto-hide would tear the React tree down and the window would come back empty.
  const capturingRef = useRef(false);
  const [isVisionModel, setIsVisionModel] = useState(false);
  const { enabledInputPlugins } = usePluginsStore();

  useEffect(() => {
    viewingAttachmentRef.current = viewingAttachment;
  }, [viewingAttachment]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const provider = useMemo(() => {
    switch (activeProvider) {
      case 'llama': return new LlamaProvider(llamaBaseUrl);
      case 'ollama': return new OllamaProvider(ollamaBaseUrl);
      case 'openai': return new OpenAIProvider(openaiBaseUrl, openaiApiKey);
      case 'anthropic': return new AnthropicProvider(anthropicApiKey);
      case 'gemini': return new GeminiProvider(geminiApiKey);
      default: return new ModelPluginProvider(activeProvider, activeProvider);
    }
  }, [activeProvider, ollamaBaseUrl, llamaBaseUrl, openaiApiKey, openaiBaseUrl, anthropicApiKey, geminiApiKey]);

  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    const discover = async () => {
      try {
        const models = await provider.models();
        if (!mounted) return;
        
        const modelNames = models.map(m => m.name);
        if (models.length > 0 && (!activeModel || !modelNames.includes(activeModel))) {
          setActiveModel(models[0].name);
        } else if (activeModel) {
          const info = models.find(m => m.name === activeModel);
          setIsVisionModel(info?.isVision ?? false);
        }
      } catch (e) {
        console.warn('Failed to fetch provider models:', e);
      }
    };
    discover();
    return () => {
      mounted = false;
    };
  }, [provider, activeModel, setActiveModel, serverStatus]);

  // ── Load history & memories on mount + cleanup old sessions ──
  useEffect(() => {
    const loadHistoryAndMemories = async () => {
      try {
        const sessions = await getRecentSessions();
        setSessions(sessions);
      } catch {
        // DB not ready yet — will load on next visibility
      }
      try {
        const memories = await searchMemories('');
        usePeekStore.getState().setMemoryOverlay({ items: memories });
      } catch {
        // DB not ready yet
      }
      // Prune old sessions according to the configured retention period
      try {
        const { historyRetentionDays } = useSettingsStore.getState();
        await cleanOldSessions(historyRetentionDays);
      } catch {
        // Non-critical — ignore
      }
    };
    loadHistoryAndMemories();
  }, [setSessions]);


  // Global shortcut registration is handled natively in Rust (lib.rs)
  // to avoid frontend loading lag or permission scope overhead.

  // ── Run Input Plugins on Open ──
  useEffect(() => {
    if (visible) {
      registry.runInputPlugins(enabledInputPlugins).then(fragments => {
        fragments.forEach(f => {
          if (!attachmentsRef.current.some(a => a.content === f.content)) {
            addAttachment({
              type: 'plugin',
              label: f.label || f.id || 'Context',
              content: f.content,
              mediaType: 'text/plain'
            });
          }
        });
      });
    }
  }, [visible, enabledInputPlugins, addAttachment]);

  // ── Listen for visibility events from Rust ──
  useEffect(() => {
    const unlisten1 = listen<boolean>('peek-visibility', (event) => {
      setVisible(event.payload);
    });

    const unlisten2 = listen('peek-focus-lost', () => {
      // Only auto-hide if not streaming (background task takes over)
      if (!usePeekStore.getState().isStreaming) {
        // Debounce focus-loss to prevent spurious hides caused by Wayland resize/command execution artifacts
        setTimeout(() => {
          if (!document.hasFocus() && !viewingAttachmentRef.current && !capturingRef.current) {
            invoke('hide_peek').catch(console.warn);
          }
        }, 150);
      }
    });

    return () => {
      unlisten1.then((fn) => fn());
      unlisten2.then((fn) => fn());
    };
  }, [setVisible, setInput, addAttachment]);

  // ── Dynamic window resize based on content ──
  useEffect(() => {
    if (!visible) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Floor 86 = input 52 + footer 34, the height of an empty overlay, and
        // the same value as tauri.conf.json's window height. Ceiling 520 pairs
        // with .peek-surface's 518px cap and --peek-transcript-max; see the
        // height-budget note in index.css before changing any of them.
        const height = Math.min(Math.max(entry.contentRect.height + 2, 86), 520);
        invoke('resize_peek', { width: 660, height });
      }
    });

    if (surfaceRef.current) {
      resizeObserver.observe(surfaceRef.current);
    }

    return () => resizeObserver.disconnect();
  }, [visible]);

  // ── Reset menus on blur/hide ──
  useEffect(() => {
    if (!visible) {
      useHistoryStore.getState().setOpen(false);
      useSettingsStore.getState().setModelsOpen(false);
      usePeekStore.getState().setLegendOpen(false);
      usePeekStore.getState().setMemoryOverlay({ isOpen: false });
      setViewingAttachment(null);
      setHasActiveModalHeight(false);
    }
  }, [visible]);

  // ── Submit query ──
  const handleSubmit = useCallback(async () => {
    const query = input.trim();
    if (!query) return;
    
    if (!activeModel) {
      setToast({ type: 'error', text: 'No model selected — check Settings or wait for server' });
      setTimeout(() => setToast(null), 3000);
      return;
    }

    const messageContent = buildMessageContent(query);
    const hasAttachments = attachments.length > 0;
    const userMessage = { role: 'user' as const, content: messageContent };
    addMessage(userMessage);
    setInput('');
    clearAttachments();

    // Normal LLM Flow

    // Create session if needed
    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = generateId();
      setActiveSessionId(sessionId);
      try {
        await createSession(sessionId, activeModel, activeProvider, query.slice(0, 80));
      } catch (err) {
        console.warn('Failed to create session:', err);
      }
    }

    // Save user message
    try {
      const serializedContent = typeof messageContent === 'string' ? messageContent : JSON.stringify(messageContent);
      await saveMessage(generateId(), sessionId, 'user', serializedContent, hasAttachments);
    } catch (err) {
      console.warn('Failed to save message:', err);
    }

    const allMessages = [...messages, userMessage];
    
    const { systemPrompt } = useSettingsStore.getState();
    const streamPayload = [];
    if (systemPrompt && systemPrompt.trim()) {
      streamPayload.push({ role: 'system' as const, content: systemPrompt.trim() });
    }
    streamPayload.push(...allMessages);

    const onComplete = async (full: string) => {
      const assistantMessage = { role: 'assistant' as const, content: full, model: activeModel };
      addMessage(assistantMessage);

      // Save assistant message
      try {
        await saveMessage(generateId(), sessionId!, 'assistant', full);
        // Update session title if first exchange
        if (allMessages.length <= 1) {
          await updateSessionTitle(sessionId!, query.slice(0, 80));
        }
        // Refresh history
        const sessions = await getRecentSessions();
        setSessions(sessions);
      } catch (err) {
        console.warn('Failed to save response:', err);
      }

      // Check if this was a background task completion
      const bgTask = usePeekStore
        .getState()
        .backgroundTasks.find(
          (t) => t.sessionId === sessionId && t.status === 'running'
        );
      if (bgTask) {
        updateBackgroundTask(bgTask.id, { status: 'complete', result: full });
        invoke('show_notification', {
          title: 'Peekaboo — Answer Ready',
          body: query.slice(0, 100),
        });
      }

      // Run output plugins
      registry.runOutputPlugins(usePluginsStore.getState().enabledOutputPlugins, full).catch(err => {
        console.warn('Output plugins failed:', err);
      });
    };

    const onError = (err: Error) => {
      const errorMessage = {
        role: 'assistant' as const,
        content: `⚠️ Error: ${err.message}`,
      };
      addMessage(errorMessage);
    };

    await runStream(provider, streamPayload, activeModel, onComplete, onError);
  }, [
    input,
    activeModel,
    activeProvider,
    messages,
    activeSessionId,
    addMessage,
    setInput,
    setActiveSessionId,
    provider,
    runStream,
    setSessions,
    updateBackgroundTask,
    attachments,
    buildMessageContent,
    clearAttachments,
  ]);

  // ── Escape handling ──
  const handleEscape = useCallback(() => {
    if (viewingAttachmentRef.current) {
      setViewingAttachment(null);
      return;
    }
    if (isStreaming) {
      // Dismiss to background — streaming continues
      const sessionId = activeSessionId;
      if (sessionId) {
        addBackgroundTask({
          id: generateId(),
          question: messages.find((m) => m.role === 'user')
            ? String(
                messages.filter((m) => m.role === 'user').pop()?.content ?? ''
              ).slice(0, 100)
            : 'Query',
          startedAt: Date.now(),
          status: 'running',
          sessionId,
        });
      }
      invoke('hide_peek');
    } else {
      invoke('hide_peek');
    }
  }, [isStreaming, activeSessionId, messages, addBackgroundTask]);

  // ── Clear conversation ──
  const handleClear = useCallback(async () => {
    abortStream();
    clear();
    clearAttachments();
    setToast({ type: 'success', text: 'New chat' });
    setTimeout(() => setToast(null), 2000);
  }, [abortStream, clear, clearAttachments]);



  // ── Copy the most recent answer ──
  const lastAssistantText = useCallback((): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && typeof m.content === 'string') return m.content;
    }
    return null;
  }, [messages]);

  const handleCopyLast = useCallback(async () => {
    const text = lastAssistantText();
    if (!text) {
      setToast({ type: 'error', text: 'No answer to copy yet' });
      setTimeout(() => setToast(null), 2000);
      return;
    }
    try {
      await writeText(text);
      setToast({ type: 'success', text: 'Answer copied' });
      setTimeout(() => setToast(null), 2000);
    } catch {
      setToast({ type: 'error', text: 'Clipboard write failed' });
      setTimeout(() => setToast(null), 3000);
    }
  }, [lastAssistantText]);

  // Opt-in only. Firing on every dismiss would clobber whatever the user
  // already had on their clipboard, so this is off unless explicitly enabled
  // and only ever copies a *completed* response.
  useEffect(() => {
    if (visible) return;
    if (!useSettingsStore.getState().autoCopyOnHide) return;
    if (usePeekStore.getState().isStreaming) return;
    const msgs = usePeekStore.getState().messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'assistant' && typeof m.content === 'string') {
        writeText(m.content).catch(() => {});
        break;
      }
    }
  }, [visible]);

  // ── Capture a screen region and attach it ──
  const handleCaptureRegion = useCallback(async () => {
    if (!isVisionModel) {
      setToast({ type: 'error', text: 'Active model has no vision support — switch models first' });
      setTimeout(() => setToast(null), 3000);
      return;
    }
    capturingRef.current = true;
    try {
      const base64 = await invoke<string>('capture_region');
      if (base64) {
        addAttachment({
          type: 'screenshot',
          label: 'Screen Region',
          content: base64,
          mediaType: 'image/png',
        });
        setToast({ type: 'success', text: 'Region attached' });
        setTimeout(() => setToast(null), 2000);
      }
    } catch (err) {
      const msg = String(err);
      // Dismissing the portal picker is a normal outcome, not a failure.
      if (!/cancel/i.test(msg)) {
        setToast({ type: 'error', text: msg.replace(/^Error:\s*/, '').slice(0, 90) });
        setTimeout(() => setToast(null), 4000);
      }
    } finally {
      // Hold the guard briefly past the Rust-side show() so a trailing
      // focus event from the portal closing can't re-trigger the auto-hide.
      setTimeout(() => { capturingRef.current = false; }, 400);
      // Belt and braces: if anything did manage to flip us hidden, come back.
      if (!usePeekStore.getState().visible) {
        invoke('show_peek').catch(console.warn);
      }
    }
  }, [isVisionModel, addAttachment]);

  // ── Load session from history ──
  const handleSelectSession = useCallback(
    async (session: Session) => {
      try {
        const msgs = await getSessionMessages(session.id);
        setMessages(
          msgs.map((m) => ({
            role: m.role,
            content: m.content,
            model: m.role === 'assistant' ? session.model : undefined
          }))
        );
        setActiveSessionId(session.id);
        useHistoryStore.getState().setOpen(false);
      } catch (err) {
        console.warn('Failed to load session:', err);
      }
    },
    [setMessages, setActiveSessionId]
  );

  // ── Keyboard shortcuts ──
  useShortcuts({
    onSubmit: handleSubmit,
    onClear: handleClear,
    onEscape: handleEscape,
    onStop: abortStream,
    onCaptureRegion: handleCaptureRegion,
    onCopyLast: handleCopyLast,
  });

  // Generic Provider status check
  const [providerStatus, setProviderStatus] = React.useState<
    'checking' | 'connected' | 'disconnected'
  >('checking');
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      const available = await provider.isAvailable();
      if (mounted) {
        setProviderStatus(available ? 'connected' : 'disconnected');
      }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [provider]);

  const hasConversation = isStreaming || messages.some((m) => m.role !== 'system');

  const handleViewAttachment = useCallback((att: Attachment) => {
    setViewingAttachment(att);
    setHasActiveModalHeight(true);
  }, []);

  const { overlayTourSeen, setOverlayTourSeen } = useSettingsStore();
  const showFirstRunHint = !overlayTourSeen && !hasConversation && attachments.length === 0;

  /*
   * What the footer says about the current provider.
   *
   * The old status bar rendered nothing for 'checking' and nothing for
   * "connected but no model" — the two states a fresh install spends most of
   * its time in — so the user's first signal that anything was wrong was a
   * three-second toast after they'd already typed a question. Every state now
   * says something, and the ones the user can act on are clickable.
   *
   * Returning null is deliberate for the healthy case: the model pill beside
   * it already carries that information.
   */
  const footerStatus = useMemo<FooterStatus | null>(() => {
    const openSettings = () => { invoke('open_settings'); };
    const pickModel = () => togglePanel('models');

    if (activeProvider === 'llama') {
      if (serverStatus === 'starting') return { tone: 'warn', text: 'Starting llama.cpp server…' };
      if (serverStatus === 'error') return { tone: 'error', text: 'llama.cpp server failed to start', onClick: openSettings };
      if (serverStatus === 'stopped') return { tone: 'muted', text: 'llama.cpp server stopped', onClick: openSettings };
      if (!activeModel) return { tone: 'warn', text: 'No model selected', onClick: pickModel };
      return null;
    }

    if (providerStatus === 'checking') {
      return { tone: 'muted', text: `Connecting to ${provider.name}…` };
    }
    if (providerStatus === 'disconnected') {
      return {
        tone: 'error',
        text: activeProvider === 'ollama'
          ? 'Ollama not detected — is it running?'
          : `Can't reach ${provider.name} — check your API key`,
        onClick: openSettings,
      };
    }
    if (!activeModel) {
      return { tone: 'warn', text: 'No model selected', onClick: pickModel };
    }
    return null;
  }, [activeProvider, serverStatus, providerStatus, activeModel, provider.name]);

  const { isModelsOpen } = useSettingsStore();
  const { isLegendOpen, memoryOverlay } = usePeekStore();
  const { isOpen: isHistoryOpen } = useHistoryStore();
  const isMenuOpen = isModelsOpen || isLegendOpen || isHistoryOpen || memoryOverlay.isOpen || hasActiveModalHeight;
  const gridMinHeight = hasActiveModalHeight ? 350 : (isMenuOpen ? 280 : undefined);

  useEffect(() => {
    if (!setupCompleted) {
      invoke('show_setup_mode');
    }
  }, [setupCompleted]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="peek-surface"
          ref={surfaceRef}
          variants={peekVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          role="dialog"
          aria-modal="true"
          aria-label="Peekaboo AI Assistant"
        >
          <div style={{ 
            position: 'relative', 
            display: 'grid', 
            gridTemplateColumns: '1fr', 
            gridTemplateRows: '1fr',
            minHeight: gridMinHeight,
            transition: 'min-height 0.15s ease-out'
          }}>
            {/* Main content */}
            <div className="peek-main" style={{ gridArea: '1 / 1' }}>
              {/* Input */}
              <Input
                onSubmit={handleSubmit}
                onAbort={abortStream}
                onAttachFragment={(f) => {
                  addAttachment({
                    type: 'plugin',
                    label: f.label || f.id || 'Context',
                    content: f.content,
                    mediaType: 'text/plain',
                  });
                }}
                onAttachImage={isVisionModel ? (base64, mediaType) => {
                  // Determine a nice label based on type
                  const isPng = mediaType.includes('png');
                  addAttachment({
                    type: 'clipboard',
                    label: `Pasted Image${isPng ? ' (PNG)' : ''}`,
                    content: base64,
                    mediaType,
                  });
                } : undefined}
                onPasteReject={(message) => {
                  setToast({ type: 'error', text: message });
                  setTimeout(() => setToast(null), 3000);
                }}
              />

              {/* Attachment chips */}
              <Attachments 
                attachments={attachments} 
                onRemove={removeAttachment} 
                onClickAttachment={(att) => {
                  setViewingAttachment(att);
                  setHasActiveModalHeight(true);
                }}
              />

              {/* First-run orientation, dismissed for good once acknowledged. */}
              {showFirstRunHint && (
                <div className="peek-hint">
                  <div className="peek-hint-items">
                    <span className="peek-hint-item"><kbd className="peek-kbd">Enter</kbd> to ask</span>
                    <span className="peek-hint-item"><kbd className="peek-kbd">Alt+/</kbd> all shortcuts</span>
                    <span className="peek-hint-item"><kbd className="peek-kbd">Esc</kbd> to hide</span>
                  </div>
                  <button className="peek-hint-dismiss" onClick={() => setOverlayTourSeen(true)}>
                    Got it
                  </button>
                </div>
              )}

              {/* Conversation transcript. Keyed on the session so switching
                  history entries remounts cleanly at the bottom. */}
              <AnimatePresence>
                {hasConversation && (
                  <Transcript
                    key={`peek-transcript-${activeSessionId || 'new'}`}
                    messages={messages}
                    streamingContent={streamingContent}
                    isStreaming={isStreaming}
                    onClickAttachment={handleViewAttachment}
                  />
                )}
              </AnimatePresence>

              {/* Persistent action bar. Absorbed the old status bar, which
                  rendered nothing at all during the provider check or when no
                  model was picked — a blank band on the cold-start path. */}
              <Footer
                onNewChat={handleClear}
                onCaptureRegion={handleCaptureRegion}
                captureDisabledReason={isVisionModel ? null : 'Screen capture needs a vision model'}
                onOpenSettings={() => invoke('open_settings')}
                status={footerStatus}
                toast={toast}
                modelLabel={activeModel || null}
              />
            </div>

            {/* History Panel */}
            <History onSelectSession={handleSelectSession} />
            
            {/* Models Panel */}
            <Models />
            
            {/* Shortcuts Legend */}
            <Legend />
            
            {/* Memory Overlay */}
            <MemoryOverlay />

            {/* Attachment Viewer Modal */}
            <AnimatePresence onExitComplete={() => {
              if (!viewingAttachmentRef.current) {
                setHasActiveModalHeight(false);
              }
            }}>
              {viewingAttachment && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setViewingAttachment(null)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'var(--peek-scrim)',
                    backdropFilter: 'blur(4px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1000,
                    borderRadius: '12px',
                  }}
                >
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    transition={{ type: 'spring', duration: 0.3 }}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: 'var(--peek-bg)',
                      border: '1px solid var(--peek-border)',
                      borderRadius: '8px',
                      width: '85%',
                      maxWidth: '500px',
                      maxHeight: '80%',
                      display: 'flex',
                      flexDirection: 'column',
                      boxShadow: 'var(--peek-shadow-modal)',
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      borderBottom: '1px solid var(--peek-border)',
                    }}>
                      <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--peek-text)' }}>
                        {viewingAttachment.label}
                      </span>
                      <button
                        onClick={() => setViewingAttachment(null)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--peek-text-muted)',
                          cursor: 'pointer',
                          fontSize: '16px',
                          padding: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div style={{
                      padding: '16px',
                      overflowY: 'auto',
                      flex: 1,
                    }}>
                      {viewingAttachment.type === 'screenshot' || (viewingAttachment.type === 'clipboard' && viewingAttachment.mediaType?.startsWith('image/')) ? (
                        <img 
                          src={`data:${viewingAttachment.mediaType};base64,${viewingAttachment.content}`} 
                          alt="Attachment preview"
                          style={{
                            maxWidth: '100%',
                            maxHeight: '300px',
                            objectFit: 'contain',
                            borderRadius: '4px',
                            display: 'block',
                            margin: '0 auto',
                          }}
                        />
                      ) : (
                        <pre style={{
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                          fontSize: '12px',
                          color: 'var(--peek-text-secondary)',
                          fontFamily: 'var(--peek-font-mono)',
                          lineHeight: '1.5',
                          textAlign: 'left',
                        }}>
                          {viewingAttachment.content}
                        </pre>
                      )}
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
