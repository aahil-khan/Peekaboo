import React, { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Message } from '../providers/types';
import type { Attachment } from '../hooks/useAttachments';
import { getTextContent, parseUserContent } from '../lib/messageUtils';
import { useSettingsStore } from '../store/settings';

const MarkdownWrapper = React.lazy(() => import('../lib/MarkdownWrapper'));

interface Exchange {
  user: string;
  images?: string[];
  assistant: string | null;
  model?: string;
  index: number;
}

interface ExchangeViewProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  /** Controlled from parent so status bar can read it */
  onExchangeChange: (current: number, total: number) => void;
  onClickAttachment?: (att: Attachment) => void;
}

// getTextContent and parseUserContent imported from ../lib/messageUtils

function CopyButton({ text, label = 'Copy', alignRight = false }: { text: string; label?: string; alignRight?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button 
      className="peek-copy-response-btn" 
      style={alignRight ? { alignSelf: 'flex-end' } : undefined}
      onClick={copy} 
      title={label} 
      aria-label={label}
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

function RememberButton({ text }: { text: string }) {
  const remember = (e: React.MouseEvent) => {
    e.stopPropagation();
    let selectedText = window.getSelection()?.toString().trim();
    const textToRemember = selectedText || text;
    if (!textToRemember) return;
    
    // We dynamically import usePeekStore since it's already used but not imported
    // Wait, usePeekStore isn't imported in ExchangeView.tsx! We must import it at the top or dynamically.
    import('../store/peek').then(({ usePeekStore }) => {
      usePeekStore.getState().setMemoryOverlay({
        isOpen: true,
        title: selectedText ? 'Remember Selection' : 'Remember Response',
        initialSearchQuery: textToRemember
      });
    });
  };
  return (
    <button 
      className="peek-copy-response-btn" 
      onClick={remember} 
      title="Save to Memory" 
      aria-label="Save to Memory"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
        <polyline points="17 21 17 13 7 13 7 21"></polyline>
        <polyline points="7 3 7 8 15 8"></polyline>
      </svg>
      Remember
    </button>
  );
}

const slideVariants: any = {
  enter: (dir: number) => ({ opacity: 0, x: dir > 0 ? 28 : -28 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } },
  exit: (dir: number) => ({ opacity: 0, x: dir > 0 ? -28 : 28, transition: { duration: 0.12, ease: 'easeIn' } }),
};

export const ExchangeView: React.FC<ExchangeViewProps> = ({
  messages,
  streamingContent,
  isStreaming,
  onExchangeChange,
  onClickAttachment,
}) => {
  // Build exchange pairs from messages — memoized so it doesn't rerun on every streaming token
  const exchanges = useMemo<Exchange[]>(() => {
    const result: Exchange[] = [];
    const visible = messages.filter((m) => m.role !== 'system');
    for (let i = 0; i < visible.length; i++) {
      if (visible[i].role === 'user') {
        const hasAssistant = visible[i + 1] && visible[i + 1].role === 'assistant';
        
        // Extract images from content
        const content = visible[i].content;
        let images: string[] = [];
        if (typeof content === 'string') {
          const trimmed = content.trim();
          if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (Array.isArray(parsed)) {
                images = parsed
                  .filter((p: any) => p.type === 'image_url' && p.image_url?.url)
                  .map((p: any) => p.image_url.url);
              }
            } catch {
              // Ignore
            }
          }
        } else if (Array.isArray(content)) {
          images = content
            .filter((p) => p.type === 'image_url' && p.image_url?.url)
            .map((p) => p.image_url!.url);
        }

        result.push({
          user: getTextContent(visible[i].content),
          images: images.length > 0 ? images : undefined,
          assistant: hasAssistant ? getTextContent(visible[i + 1].content) : null,
          model: hasAssistant ? visible[i + 1].model : undefined,
          index: result.length,
        });
        if (hasAssistant) i++;
      }
    }
    return result;
  }, [messages]);

  const { activeModel } = useSettingsStore();

  // Mutable streaming overlay — doesn't need to be in useMemo since it's ephemeral
  const displayExchanges = useMemo<Exchange[]>(() => {
    if (!isStreaming || exchanges.length === 0) return exchanges;
    const copy = [...exchanges];
    copy[copy.length - 1] = { 
      ...copy[copy.length - 1], 
      assistant: streamingContent || null,
      model: activeModel
    };
    return copy;
  }, [exchanges, isStreaming, streamingContent, activeModel]);

  const total = displayExchanges.length;

  const [currentIndex, setCurrentIndex] = useState(total > 0 ? total - 1 : 0);
  const [direction, setDirection] = useState(0);
  const prevTotal = useRef(total);

  // Auto-advance to newest exchange when a new one arrives
  useEffect(() => {
    if (total > prevTotal.current) {
      setDirection(1);
      setCurrentIndex(total - 1);
    }
    prevTotal.current = total;
  }, [total]);

  // Notify parent of current position for status bar
  useEffect(() => {
    onExchangeChange(currentIndex + 1, total);
  }, [currentIndex, total, onExchangeChange]);

  const [isScrollable, setIsScrollable] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // useCallback prevents stale closure in the keyboard effect below
  const goTo = useCallback((idx: number, dir: number) => {
    setCurrentIndex((prev) => {
      if (idx < 0 || idx >= total) return prev;
      setDirection(dir);
      return idx;
    });
  }, [total]);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(currentIndex - 1, -1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(currentIndex + 1, 1); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [currentIndex, goTo]);

  // Resolve which exchange to show
  const shown = displayExchanges[currentIndex];
  const isLive = isStreaming && currentIndex === displayExchanges.length - 1;
  const isLoading = isLive && !streamingContent;

  const isNavigating = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabled = useRef(true);

  const updateScrollState = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight > el.clientHeight + 10;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 25;
    setIsScrollable(scrollable);
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = () => {
    const el = cardRef.current ?? document.querySelector<HTMLElement>('.peek-exchange-card');
    if (!el) return;
    const start = el.scrollTop;
    const end = el.scrollHeight - el.clientHeight;
    const distance = end - start;
    if (distance <= 0) return;
    const duration = Math.min(300, Math.max(120, distance * 0.4)); // scale with distance
    const startTime = performance.now();
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3); // cubic ease-out
    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      el.scrollTop = start + distance * easeOut(progress);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        autoScrollEnabled.current = true;
        updateScrollState();
      }
    };
    requestAnimationFrame(step);
  };

  // Scroll to bottom on card/page change
  useEffect(() => {
    if (cardRef.current) {
      const el = cardRef.current;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        autoScrollEnabled.current = true;
        setTimeout(updateScrollState, 80);
      });
    }
  }, [currentIndex, updateScrollState]);

  // Scroll to bottom on stream updates
  useEffect(() => {
    if (isLive && autoScrollEnabled.current && cardRef.current) {
      const el = cardRef.current;
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
    updateScrollState();
  }, [streamingContent, isLive, updateScrollState]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const scrollable = el.scrollHeight > el.clientHeight + 10;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 25;
    setIsScrollable(scrollable);
    setIsAtBottom(atBottom);
    autoScrollEnabled.current = atBottom;
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (isNavigating.current) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20) {
      if (e.deltaX > 0) {
        goTo(currentIndex + 1, 1);
      } else {
        goTo(currentIndex - 1, -1);
      }
      isNavigating.current = true;
      setTimeout(() => {
        isNavigating.current = false;
      }, 400);
    }
  };

  if (!shown) return null;

  return (
    <div className="peek-exchange-view" onWheel={handleWheel} style={{ position: 'relative' }}>
      <AnimatePresence mode="popLayout" custom={direction}>
        <motion.div
          key={currentIndex}
          ref={cardRef}
          onScroll={handleScroll}
          custom={direction}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          className="peek-exchange-card"
        >
          {/* User question */}
          <div className="peek-exchange-user">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '88%' }}>
              {(() => {
                const { contexts, prompt } = parseUserContent(shown.user);
                return (
                  <>
                    {contexts.length > 0 && (
                      <div className="peek-thread-user-contexts">
                        {contexts.map((ctx, i) => {
                          const short = ctx.replace(/\s+/g, ' ').slice(0, 30);
                          const isClickable = ctx.length > 30;
                          return (
                            <div 
                              key={i} 
                              className={`peek-user-context-chip${isClickable ? ' peek-clickable' : ''}`} 
                              title={isClickable ? "Click to view full context" : undefined}
                              onClick={isClickable ? () => onClickAttachment?.({
                                id: `ctx-${i}-${Date.now()}`,
                                type: 'selection',
                                label: `Context: "${short}..."`,
                                content: ctx,
                                mediaType: 'text/plain'
                              }) : undefined}
                            >
                              ▤ {short}{isClickable ? '...' : ''}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {shown.images && shown.images.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8, justifyContent: 'flex-end', width: '100%' }}>
                        {shown.images.map((img, i) => {
                          let base64 = img;
                          let mediaType = 'image/png';
                          const match = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
                          if (match) {
                            mediaType = match[1];
                            base64 = match[2];
                          }
                          return (
                            <img 
                              key={i} 
                              src={img} 
                              alt={`Attachment ${i + 1}`} 
                              style={{ 
                                maxWidth: '140px', 
                                maxHeight: '100px', 
                                borderRadius: '6px', 
                                border: '1px solid var(--peek-border)', 
                                objectFit: 'cover',
                                cursor: 'pointer' 
                              }} 
                              onClick={() => {
                                onClickAttachment?.({
                                  id: `img-${i}-${Date.now()}`,
                                  type: 'screenshot',
                                  label: `Image ${i + 1}`,
                                  content: base64,
                                  mediaType: mediaType
                                });
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                    <span className="peek-exchange-user-bubble">{prompt}</span>
                  </>
                );
              })()}
              <CopyButton text={shown.user} label="Copy prompt" alignRight />
            </div>
          </div>

          {/* Assistant response */}
          <div className="peek-exchange-assistant">
            {isLoading ? (
              <div className="peek-loading-dots" aria-label="Thinking...">
                <span /><span /><span />
              </div>
            ) : shown.assistant ? (
              <Suspense fallback={<div className="peek-loading-dots"><span /><span /><span /></div>}>
                <MarkdownWrapper>{shown.assistant}</MarkdownWrapper>
                {isLive && <span className="peek-cursor" aria-hidden="true" />}
              </Suspense>
            ) : null}
          </div>

          {/* Actions & Model Indicator */}
          {(() => {
            if (!shown.assistant) return null;
            const cleanedText = shown.assistant
              .replace(/\n\n\*\(Stopped by user\)\*/i, '')
              .replace(/^\*\(Stopped by user\)\*$/i, '')
              .trim();
            
            return (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginTop: '8px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {!isLive && cleanedText && (
                    <>
                      <CopyButton text={cleanedText} label="Copy response" />
                      <RememberButton text={cleanedText} />
                    </>
                  )}
                </div>
                {shown.model && (
                  <span style={{ 
                    fontSize: 10, 
                    color: 'var(--peek-text-muted)', 
                    fontFamily: 'var(--peek-font-mono)',
                    background: 'rgba(255,255,255,0.02)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    border: '1px solid var(--peek-border)',
                    letterSpacing: '0.02em',
                    textTransform: 'lowercase',
                    opacity: 0.85
                  }}>
                    {shown.model}
                  </span>
                )}
              </div>
            );
          })()}
        </motion.div>
      </AnimatePresence>

      {/* Floating Bottom Center Indicator / Arrow */}
      <AnimatePresence>
        {isScrollable && (isLive ? true : !isAtBottom) && (
          <div
            style={{
              position: 'absolute',
              bottom: total > 1 ? 52 : 20,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 20,
              pointerEvents: 'auto',
            }}
          >
            <motion.div
              key="scroll-indicator"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
            >
              {isLive ? (
                <div
                  onClick={scrollToBottom}
                  style={{
                    background: 'rgba(30, 30, 30, 0.9)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid var(--peek-border)',
                    borderRadius: '20px',
                    padding: '6px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    color: 'var(--peek-text)',
                    fontSize: '11px',
                    fontWeight: 500,
                    letterSpacing: '0.02em',
                    cursor: 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <div style={{ display: 'inline-flex', gap: '3px', alignItems: 'center' }}>
                    <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--peek-text)', display: 'inline-block', animation: 'peek-dot-pulse 1.4s infinite both 0s' }} />
                    <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--peek-text)', display: 'inline-block', animation: 'peek-dot-pulse 1.4s infinite both 0.2s' }} />
                    <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--peek-text)', display: 'inline-block', animation: 'peek-dot-pulse 1.4s infinite both 0.4s' }} />
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label="Scroll to bottom"
                  onClick={scrollToBottom}
                  style={{
                    background: 'rgba(30, 30, 30, 0.9)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid var(--peek-border)',
                    borderRadius: '50%',
                    width: '32px',
                    height: '32px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    color: 'var(--peek-text)',
                    cursor: 'pointer',
                    outline: 'none',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.background = 'rgba(60, 60, 60, 0.95)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.background = 'rgba(30, 30, 30, 0.9)';
                    e.currentTarget.style.borderColor = 'var(--peek-border)';
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <polyline points="19 12 12 19 5 12" />
                  </svg>
                </button>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Navigation — only visible when there's more than 1 exchange */}
      {total > 1 && (
        <div className="peek-exchange-nav">
          <button
            className="peek-nav-btn"
            onClick={() => goTo(currentIndex - 1, -1)}
            disabled={currentIndex === 0}
            aria-label="Previous exchange"
            title="Alt+←"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="peek-exchange-counter">{currentIndex + 1} / {total}</span>
          <button
            className="peek-nav-btn"
            onClick={() => goTo(currentIndex + 1, 1)}
            disabled={currentIndex === total - 1}
            aria-label="Next exchange"
            title="Alt+→"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};
