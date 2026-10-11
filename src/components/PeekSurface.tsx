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
import { ActionsPalette, type ActionSource } from './ActionsPalette';
import { usePeekStore } from '../store/peek';
import { useActionsStore, selectVisibleActions } from '../store/actions';
import { cleanTransformOutput, filterActions, previewText, type Action, type ActionKind } from '../lib/actions';
import { buildActionMessage, toModelMessage, wasStopped } from '../lib/messageUtils';
import { applyResult, APPLY_VERB } from '../lib/applyResult';
import type { ContentPart } from '../providers/types';
import { useSettingsStore } from '../store/settings';
import { useHistoryStore, type Session } from '../store/history';
import { useStream } from '../hooks/useStream';
import { useShortcuts } from '../hooks/useShortcuts';
import { useHotkeyStore } from '../store/hotkey';
import { formatHotkey } from '../lib/hotkey';
import { togglePanel, closePanels } from '../hooks/usePanels';
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
  getPinnedMemories,
  cleanOldSessions,
} from '../db/database';
import { composeSystemPrompt } from '../lib/pinnedMemories';

function generateId(): string {
  return crypto.randomUUID();
}

const PROVIDER_CHECK_INTERVAL_MS = 30_000;

/** One user turn, whether typed or produced by an action. */
interface SendOptions {
  /** What the transcript shows and history stores. */
  content: string | ContentPart[];
  /** Session title and notification text. */
  title: string;
  hasAttachments: boolean;
  /** Set when the turn runs an action, so a transform's result can be offered to Enter. */
  action?: { kind: ActionKind; name: string; sourceText: string };
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
    actionsOpen,
    setActionsOpen,
    actionsDismissed,
    setActionsDismissed,
    pendingResult,
    setPendingResult,
  } = usePeekStore();

  const { 
    activeModel, setActiveModel, 
    activeProvider,
    ollamaBaseUrl, ollamaKeepAlive, llamaBaseUrl,
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
      case 'ollama': return new OllamaProvider(ollamaBaseUrl, ollamaKeepAlive);
      case 'openai': return new OpenAIProvider(openaiBaseUrl, openaiApiKey);
      case 'anthropic': return new AnthropicProvider(anthropicApiKey);
      case 'gemini': return new GeminiProvider(geminiApiKey);
      default: return new ModelPluginProvider(activeProvider, activeProvider);
    }
  }, [activeProvider, ollamaBaseUrl, ollamaKeepAlive, llamaBaseUrl, openaiApiKey, openaiBaseUrl, anthropicApiKey, geminiApiKey]);

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
        // Debounce focus-loss to prevent spurious hides caused by Wayland command execution artifacts
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

  /*
   * The native window does not follow the content.
   *
   * It used to: a ResizeObserver sent every change in the surface's height to
   * Rust, which resized the window to fit. Any animated height change (a panel
   * opening, an answer streaming in, the actions palette) therefore cost an IPC
   * round-trip and a compositor resize per frame, and because the window always
   * trailed the content by a frame or two, the bottom of whatever was growing
   * was clipped until it caught up. That was the stutter.
   *
   * The window is now a fixed 660x520 (tauri.conf.json), transparent, with the
   * surface at its top, and everything animates inside it. The cost is that
   * the unused part of the window, though invisible, still sits over whatever
   * is underneath, so a press there is treated as the click-away it was meant
   * to be and dismisses the overlay.
   */
  useEffect(() => {
    if (!visible) return;
    const dismissOnOutsidePress = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.peek-surface')) return;
      // Same exemptions as losing focus: the attachment viewer is modal, and a
      // screen capture hides the overlay on purpose.
      if (viewingAttachmentRef.current || capturingRef.current) return;
      invoke('hide_peek').catch(console.warn);
    };
    window.addEventListener('pointerdown', dismissOnOutsidePress);
    return () => window.removeEventListener('pointerdown', dismissOnOutsidePress);
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
      // A result left unapplied when the overlay hid should not be applied by
      // a stray Enter an hour later. A transform that finishes while hidden
      // sets a fresh one after this runs, so Esc-and-come-back still works.
      usePeekStore.getState().setPendingResult(null);
      usePeekStore.getState().setActionsOpen(false);
    }
    // Showing the overlay is a new start for the palette: text attached on
    // this summon should bring it up even if it was dismissed last time.
    usePeekStore.getState().setActionsDismissed(false);
  }, [visible]);

  // ── Apply a finished transform ──
  // Set when Enter applied a result, so the copy-on-hide option below does
  // not overwrite the applied text with the raw answer a moment later.
  const appliedRef = useRef(false);
  const applyPendingResult = useCallback(async () => {
    const pending = usePeekStore.getState().pendingResult;
    if (!pending) return;
    try {
      await applyResult(pending.text);
    } catch {
      setToast({ type: 'error', text: 'Clipboard write failed — the result is still here' });
      setTimeout(() => setToast(null), 3000);
      return;
    }
    appliedRef.current = true;
    setPendingResult(null);
    invoke('hide_peek').catch(console.warn);
  }, [setPendingResult]);

  // ── Send one user turn and stream the reply ──
  const sendMessage = useCallback(async ({ content, title, hasAttachments, action }: SendOptions) => {
    if (!activeModel) {
      setToast({ type: 'error', text: 'No model selected — pick one from the model button' });
      setTimeout(() => setToast(null), 3000);
      return;
    }

    // Asking a question is proof the hint did its job; retire it so it doesn't
    // reappear on every new chat.
    useSettingsStore.getState().setOverlayTourSeen(true);

    const messageContent = content;
    const userMessage = { role: 'user' as const, content: messageContent };
    addMessage(userMessage);
    setInput('');
    clearAttachments();
    setPendingResult(null);
    setActionsOpen(false);
    setActionsDismissed(false);

    // Normal LLM Flow

    // Create session if needed
    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = generateId();
      setActiveSessionId(sessionId);
      try {
        await createSession(sessionId, activeModel, activeProvider, title.slice(0, 80));
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
    
    // Pinned memories ride along in the system message only. They are never
    // added to the conversation or the messages table, so reloading a session
    // from history cannot duplicate them.
    const { systemPrompt, includePinnedMemories } = useSettingsStore.getState();
    let pinnedMemories: Awaited<ReturnType<typeof getPinnedMemories>> = [];
    if (includePinnedMemories) {
      try {
        pinnedMemories = await getPinnedMemories();
      } catch (err) {
        console.warn('Failed to read pinned memories; sending the question without them:', err);
      }
    }
    const { systemPrompt: finalSystemPrompt } = composeSystemPrompt(systemPrompt, pinnedMemories);
    const streamPayload = [];
    if (finalSystemPrompt) {
      streamPayload.push({ role: 'system' as const, content: finalSystemPrompt });
    }
    // Action turns are stored as name + template + text and expanded here,
    // so a session reloaded from history sends the model the same prompt.
    streamPayload.push(...allMessages.map(toModelMessage));

    const onComplete = async (full: string) => {
      const assistantMessage = { role: 'assistant' as const, content: full, model: activeModel };
      addMessage(assistantMessage);

      // Save assistant message
      try {
        await saveMessage(generateId(), sessionId!, 'assistant', full);
        // Update session title if first exchange
        if (allMessages.length <= 1) {
          await updateSessionTitle(sessionId!, title.slice(0, 80));
        }
        // Refresh history
        const sessions = await getRecentSessions();
        setSessions(sessions);
      } catch (err) {
        console.warn('Failed to save response:', err);
      }

      // A transform's answer is the thing the user wants; offer it to Enter.
      // Not when they stopped it: a half-written replacement is not a result.
      if (action?.kind === 'transform' && !wasStopped(full)) {
        setPendingResult({ text: cleanTransformOutput(full, action.sourceText), actionName: action.name });
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
          body: title.slice(0, 100),
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
    clearAttachments,
    setPendingResult,
    setActionsOpen,
    setActionsDismissed,
  ]);

  // ── Submit the typed question ──
  const handleSubmit = useCallback(async () => {
    const query = input.trim();
    if (!query) {
      // Enter on an empty box after a transform applies its result. Otherwise
      // an empty box is a no-op, as before.
      if (pendingResult && !isStreaming) void applyPendingResult();
      return;
    }
    await sendMessage({
      content: buildMessageContent(query),
      title: query,
      hasAttachments: attachments.length > 0,
    });
  }, [input, pendingResult, isStreaming, applyPendingResult, sendMessage, buildMessageContent, attachments.length]);

  // ── Run an action from the palette ──
  const runAction = useCallback(
    (action: Action, source: ActionSource) => {
      void sendMessage({
        content: buildActionMessage({ name: action.name, kind: action.kind, template: action.prompt }, source.text),
        title: `${action.name}: ${previewText(source.text, 60)}`,
        hasAttachments: true,
        action: { kind: action.kind, name: action.name, sourceText: source.text },
      });
    },
    [sendMessage]
  );

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
    // Nothing to clear means nothing happened — confirming a no-op just
    // teaches the user the button lies.
    const { messages: current, isStreaming: streaming, input: draft } = usePeekStore.getState();
    const hadSomething =
      streaming || draft.trim().length > 0 || current.some((m) => m.role !== 'system');

    abortStream();
    clear();
    clearAttachments();
    // Starting a new chat means wanting to see it. Leaving History or Models
    // covering the surface makes the button look like it did nothing.
    closePanels();

    if (!hadSomething) return;
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
    const text = usePeekStore.getState().pendingResult?.text ?? lastAssistantText();
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
    if (appliedRef.current) {
      // Enter just put the applied result on the clipboard; keep it.
      appliedRef.current = false;
      return;
    }
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
        setPendingResult(null);
        useHistoryStore.getState().setOpen(false);
      } catch (err) {
        console.warn('Failed to load session:', err);
      }
    },
    [setMessages, setActiveSessionId, setPendingResult]
  );

  // ── Actions palette ──
  // Whether the palette is showing is computed further down, after the panel
  // state it depends on; the toggle only needs the latest value.
  const paletteOpenRef = useRef(false);
  const dismissActions = useCallback(() => {
    setActionsOpen(false);
    setActionsDismissed(true);
  }, [setActionsOpen, setActionsDismissed]);
  const toggleActions = useCallback(() => {
    if (usePeekStore.getState().isStreaming) return;
    if (paletteOpenRef.current) {
      dismissActions();
    } else {
      closePanels();
      setActionsOpen(true);
      setActionsDismissed(false);
    }
  }, [dismissActions, setActionsOpen, setActionsDismissed]);

  // ── Keyboard shortcuts ──
  useShortcuts({
    onSubmit: handleSubmit,
    onClear: handleClear,
    onEscape: handleEscape,
    onStop: abortStream,
    onCaptureRegion: handleCaptureRegion,
    onCopyLast: handleCopyLast,
    onQuit: () => { void invoke('quit_app'); },
    onActions: toggleActions,
  });

  // Generic Provider status check
  const [providerStatus, setProviderStatus] = React.useState<
    'checking' | 'connected' | 'disconnected'
  >('checking');
  // A status belongs to the provider it was measured for. Without this, the
  // footer would report the previous provider's result under the new one's
  // name until the next check came back — including "can't reach" right after
  // the user fixed their key in Settings.
  useEffect(() => {
    setProviderStatus('checking');
  }, [provider]);
  /*
   * Checked when the overlay appears (or the provider changes while it is up)
   * and every 30s after that, and not at all while hidden. The overlay spends
   * nearly all of its life hidden; polling through that was a request every
   * five seconds, all day, for a status nobody could see.
   */
  useEffect(() => {
    if (!visible) return;
    let mounted = true;
    const check = async () => {
      const available = await provider.isAvailable().catch(() => false);
      if (mounted) {
        setProviderStatus(available ? 'connected' : 'disconnected');
      }
    };
    check();
    const interval = setInterval(check, PROVIDER_CHECK_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [provider, visible]);

  const hasConversation = isStreaming || messages.some((m) => m.role !== 'system');

  const handleViewAttachment = useCallback((att: Attachment) => {
    setViewingAttachment(att);
    setHasActiveModalHeight(true);
  }, []);

  const { overlayTourSeen, setOverlayTourSeen } = useSettingsStore();
  const summonHotkey = useHotkeyStore((s) => s.hotkey);
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
  /*
   * Escape during a stream doesn't cancel it — the answer keeps generating in
   * the background and fires a desktop notification when it lands. Nothing
   * said so, so a slow answer just looked like the app had hung. Surfaced only
   * once the wait is long enough to be worth mentioning.
   */
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    if (!isStreaming) {
      setLongWait(false);
      return;
    }
    const timer = setTimeout(() => setLongWait(true), 9000);
    return () => clearTimeout(timer);
  }, [isStreaming]);

  const footerStatus = useMemo<FooterStatus | null>(() => {
    const openSettings = () => { invoke('open_settings'); };
    const pickModel = () => togglePanel('models');

    if (isStreaming && longWait) {
      return {
        tone: 'muted',
        text: 'Still writing — Esc to step away',
        hint: "Press Esc and Peekaboo keeps working in the background. You'll get a desktop notification when the answer is ready, and it'll be waiting in history.",
      };
    }

    if (pendingResult && !isStreaming) {
      return {
        tone: 'ok',
        text: `Enter ${APPLY_VERB} the result and closes`,
        hint: `Enter ${APPLY_VERB} the result of "${pendingResult.actionName}" to the clipboard and hides Peekaboo. Alt+C copies without closing; typing asks a follow-up.`,
        onClick: () => { void applyPendingResult(); },
      };
    }

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
  }, [activeProvider, serverStatus, providerStatus, activeModel, provider.name, isStreaming, longWait, pendingResult, applyPendingResult]);

  const { isModelsOpen } = useSettingsStore();
  const { isLegendOpen, memoryOverlay } = usePeekStore();
  const { isOpen: isHistoryOpen } = useHistoryStore();
  const isPanelOpen = isModelsOpen || isLegendOpen || isHistoryOpen || memoryOverlay.isOpen;
  // The attachment viewer is a true modal and covers the grid, input included.
  // A panel is not — it reserves height in the body below the input instead.
  const gridMinHeight = hasActiveModalHeight ? 350 : undefined;
  const bodyMinHeight = isPanelOpen ? 240 : undefined;

  /*
   * The palette shows itself when text is attached and something matches the
   * typed filter, or whenever it was opened explicitly. The filter is the
   * input box: a typed question stops matching after a word or two, the
   * palette drops away, and Enter sends the question as it always did. Esc
   * dismisses it until new text arrives or the overlay is summoned again.
   */
  const { hiddenBuiltIns, customActions } = useActionsStore();
  const visibleActions = useMemo(
    () => selectVisibleActions({ hiddenBuiltIns, customActions }),
    [hiddenBuiltIns, customActions]
  );
  const matchingActions = useMemo(() => filterActions(visibleActions, input), [visibleActions, input]);
  const attachedText = useMemo<ActionSource | null>(() => {
    const texts = attachments.filter((a) => !a.mediaType.startsWith('image/'));
    if (texts.length === 0) return null;
    return {
      origin: 'attachment',
      label: texts.length === 1 ? texts[0].label : `${texts.length} attachments`,
      text: texts.map((a) => a.content).join('\n\n'),
    };
  }, [attachments]);
  const autoShowActions =
    !!attachedText && !actionsDismissed && matchingActions.length > 0 && !input.startsWith('/');
  const paletteOpen = !isStreaming && !isPanelOpen && !viewingAttachment && (actionsOpen || autoShowActions);
  paletteOpenRef.current = paletteOpen;

  // New text is a reason to show the palette again after a dismissal.
  useEffect(() => {
    if (attachedText) setActionsDismissed(false);
  }, [attachedText, setActionsDismissed]);

  const inputPlaceholder =
    pendingResult && !isStreaming
      ? `Enter ${APPLY_VERB} the result · or ask a follow-up…`
      : paletteOpen
        ? 'Pick an action, or ask anything…'
        : undefined;

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
                placeholder={inputPlaceholder}
                onAbort={abortStream}
                onAttachFragment={(f) => {
                  // A fragment's type is its media type. Hardcoding text/plain
                  // here meant an image fragment — /file on a PNG — reached the
                  // model as a wall of base64 instead of a picture.
                  const mediaType = f.type?.includes('/') ? f.type : 'text/plain';

                  if (mediaType.startsWith('image/') && !isVisionModel) {
                    setToast({
                      type: 'error',
                      text: `${activeModel || 'This model'} can't read images — switch to a vision model with Alt+M.`,
                    });
                    setTimeout(() => setToast(null), 4000);
                    return;
                  }

                  addAttachment({
                    type: 'plugin',
                    label: f.label || f.id || 'Context',
                    content: f.content,
                    mediaType,
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

              <ActionsPalette
                open={paletteOpen}
                explicit={actionsOpen}
                actions={matchingActions}
                query={input}
                attachedText={attachedText}
                onRun={runAction}
                onClose={dismissActions}
              />

              {/* First-run orientation, dismissed for good once acknowledged. */}
              {showFirstRunHint && (
                <div className="peek-hint">
                  <div className="peek-hint-items">
                    <span className="peek-hint-item"><kbd className="peek-kbd">Enter</kbd> to ask</span>
                    <span className="peek-hint-item"><kbd className="peek-kbd">Alt+A</kbd> actions on selected text</span>
                    <span className="peek-hint-item"><kbd className="peek-kbd">Alt+/</kbd> all shortcuts</span>
                    <span className="peek-hint-item"><kbd className="peek-kbd">Esc</kbd> to hide</span>
                    <span className="peek-hint-item"><kbd className="peek-kbd">{formatHotkey(summonHotkey)}</kbd> to bring it back</span>
                  </div>
                  <button className="peek-hint-dismiss" onClick={() => setOverlayTourSeen(true)}>
                    Got it
                  </button>
                </div>
              )}

              {/* The transcript and the four panels share this box, and the
                  panels are positioned against it rather than the whole
                  surface. A panel therefore covers the conversation and
                  nothing else: what you were typing survives opening one, and
                  the footer's buttons stay reachable, so you can go from
                  History straight to Models without closing anything. */}
              <div
                className="peek-body"
                style={{
                  minHeight: bodyMinHeight,
                  transition: 'min-height 0.15s ease-out',
                }}
              >
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

                <History onSelectSession={handleSelectSession} />
                <Models />
                <Legend />
                <MemoryOverlay />
              </div>
            </div>

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

          {/*
            Outside the overlay grid on purpose. The panels are absolutely
            positioned within that grid, so anything inside it gets covered;
            keeping the bar here means it is always visible, always clickable,
            and genuinely pinned to the bottom edge of the surface rather than
            floating wherever the content above happens to end.
          */}
          <Footer
            onNewChat={handleClear}
            onActions={toggleActions}
            actionsOpen={paletteOpen}
            onCaptureRegion={handleCaptureRegion}
            captureDisabledReason={isVisionModel ? null : 'Screen capture needs a vision model'}
            onOpenSettings={() => invoke('open_settings')}
            status={footerStatus}
            toast={toast}
            modelLabel={activeModel || null}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
};
