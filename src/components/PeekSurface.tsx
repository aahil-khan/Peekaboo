import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { Input } from './Input';
import { ExchangeView } from './ExchangeView';
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
import { useAttachments } from '../hooks/useAttachments';
import { OllamaProvider } from '../providers/ollama';
import { peekVariants } from '../lib/motion';
import {
  createSession,
  saveMessage,
  updateSessionTitle,
  getRecentSessions,
  getSessionMessages,
  searchMemories,
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

  const { activeModel, setActiveModel, ollamaBaseUrl } = useSettingsStore();
  const { setSessions } = useHistoryStore();
  const { attachments, add: addAttachment, remove: removeAttachment, clear: clearAttachments, buildMessageContent } = useAttachments();
  const { run: runStream, abort: abortStream } = useStream();
  const [showCleared, setShowCleared] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState<any | null>(null);
  const [hasActiveModalHeight, setHasActiveModalHeight] = useState(false);
  const viewingAttachmentRef = useRef<any | null>(null);
  const attachmentsRef = useRef<any[]>([]);

  useEffect(() => {
    viewingAttachmentRef.current = viewingAttachment;
  }, [viewingAttachment]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const provider = useMemo(
    () => new OllamaProvider(ollamaBaseUrl),
    [ollamaBaseUrl]
  );

  const surfaceRef = useRef<HTMLDivElement>(null);

  // ── Discover models on mount ──
  useEffect(() => {
    const discover = async () => {
      const models = await provider.models();
      if (models.length > 0 && !activeModel) {
        setActiveModel(models[0]);
      }
    };
    discover();
  }, [provider, activeModel, setActiveModel]);

  // ── Load history & memories on mount ──
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
    };
    loadHistoryAndMemories();
  }, [setSessions]);


  // Global shortcut registration is handled natively in Rust (lib.rs)
  // to avoid frontend loading lag or permission scope overhead.

  // ── Listen for visibility events from Rust ──
  useEffect(() => {
    const unlisten1 = listen<boolean>('peek-visibility', (event) => {
      setVisible(event.payload);
    });

    const unlisten2 = listen('peek-focus-lost', () => {
      // Only auto-hide if not streaming (background task takes over)
      if (!usePeekStore.getState().isStreaming) {
        invoke('hide_peek');
      }
    });

    const unlisten3 = listen<string>('peek-highlighted-text', (event) => {
      const text = event.payload;
      const trimmed = text.trim();
      if (trimmed) {
        if (attachmentsRef.current.some((att) => att.content === trimmed)) {
          return;
        }
        const preview = trimmed.replace(/\s+/g, ' ').slice(0, 20);
        const label = `Selected: "${preview}${trimmed.length > 20 ? '...' : ''}"`;
        addAttachment({
          type: 'selection',
          label,
          content: trimmed,
          mediaType: 'text/plain'
        });
      }
      setTimeout(() => {
        const ta = document.querySelector('.peek-input') as HTMLTextAreaElement;
        if (ta) {
          ta.focus();
        }
      }, 50);
    });

    return () => {
      unlisten1.then((fn) => fn());
      unlisten2.then((fn) => fn());
      unlisten3.then((fn) => fn());
    };
  }, [setVisible, setInput, addAttachment]);

  // ── Dynamic window resize based on content ──
  useEffect(() => {
    if (!visible) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = Math.min(Math.max(entry.contentRect.height + 16, 80), 520);
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
    
    if (!activeModel) return;

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
        await createSession(sessionId, activeModel, 'ollama', query.slice(0, 80));
      } catch (err) {
        console.warn('Failed to create session:', err);
      }
    }

    // Save user message
    try {
      await saveMessage(generateId(), sessionId, 'user', query, hasAttachments);
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
      const assistantMessage = { role: 'assistant' as const, content: full };
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
  const handleClear = useCallback(() => {
    abortStream();
    clear();
    clearAttachments();
    setShowCleared(true);
    setTimeout(() => setShowCleared(false), 2000);
  }, [abortStream, clear, clearAttachments]);



  // ── Load session from history ──
  const handleSelectSession = useCallback(
    async (session: Session) => {
      try {
        const msgs = await getSessionMessages(session.id);
        setMessages(
          msgs.map((m) => ({
            role: m.role,
            content: m.content,
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
  });

  // ── Ollama status check ──
  const [ollamaStatus, setOllamaStatus] = React.useState<
    'checking' | 'connected' | 'disconnected'
  >('checking');

  useEffect(() => {
    const check = async () => {
      const available = await provider.isAvailable();
      setOllamaStatus(available ? 'connected' : 'disconnected');
    };
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, [provider]);

  const hasConversation = isStreaming || messages.some((m) => m.role !== 'system');

  const handleExchangeChange = useCallback((_current: number, _total: number) => {
    // No-op
  }, []);

  const { isModelsOpen } = useSettingsStore();
  const { isLegendOpen, memoryOverlay } = usePeekStore();
  const { isOpen: isHistoryOpen } = useHistoryStore();
  const isMenuOpen = isModelsOpen || isLegendOpen || isHistoryOpen || memoryOverlay.isOpen || hasActiveModalHeight;
  const gridMinHeight = hasActiveModalHeight ? 350 : (isMenuOpen ? 280 : undefined);

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
                onAttachImage={(base64, mediaType) => {
                  // Determine a nice label based on type
                  const isPng = mediaType.includes('png');
                  addAttachment({
                    type: 'clipboard',
                    label: `Pasted Image${isPng ? ' (PNG)' : ''}`,
                    content: base64,
                    mediaType,
                  });
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

              {/* Status bar */}
              <div className="peek-statusbar">
                <div className="peek-status-left">
                  {ollamaStatus === 'disconnected' && (
                    <span className="peek-status-error">
                      Ollama not detected — is it running?
                    </span>
                  )}
                  {ollamaStatus === 'connected' && activeModel && (
                    <span className="peek-status-model">{activeModel}</span>
                  )}
                </div>
                <div className="peek-status-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AnimatePresence>
                    {showCleared && (
                      <motion.span
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="peek-bg-indicator"
                        style={{ color: '#4caf50', background: 'rgba(76, 175, 80, 0.1)' }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                          <polyline points="22 4 12 14.01 9 11.01"></polyline>
                        </svg>
                        Cleared
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Paged exchange view */}
              <AnimatePresence>
                {hasConversation && (
                  <ExchangeView
                    key={`peek-exchange-view-${activeSessionId || 'new'}`}
                    messages={messages}
                    streamingContent={streamingContent}
                    isStreaming={isStreaming}
                    onExchangeChange={handleExchangeChange}
                  />
                )}
              </AnimatePresence>
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
                    background: 'rgba(0, 0, 0, 0.4)',
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
                      boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.3)',
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
