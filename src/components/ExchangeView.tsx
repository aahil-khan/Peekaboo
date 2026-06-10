import React, { useEffect, useRef, useState, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Message } from '../providers/types';

const MarkdownWrapper = React.lazy(() => import('../lib/MarkdownWrapper'));

interface Exchange {
  user: string;
  assistant: string | null;
  index: number;
}

interface ExchangeViewProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  /** Controlled from parent so status bar can read it */
  onExchangeChange: (current: number, total: number) => void;
}

function getTextContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('');
}

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

const slideVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir > 0 ? 28 : -28 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] } },
  exit: (dir: number) => ({ opacity: 0, x: dir > 0 ? -28 : 28, transition: { duration: 0.12, ease: 'easeIn' } }),
};

export const ExchangeView: React.FC<ExchangeViewProps> = ({
  messages,
  streamingContent,
  isStreaming,
  onExchangeChange,
}) => {
  // Build exchange pairs from messages (exclude system)
  const exchanges: Exchange[] = [];
  const visible = messages.filter((m) => m.role !== 'system');
  for (let i = 0; i < visible.length; i++) {
    if (visible[i].role === 'user') {
      const hasAssistant = visible[i + 1] && visible[i + 1].role === 'assistant';
      exchanges.push({
        user: getTextContent(visible[i].content),
        assistant: hasAssistant ? getTextContent(visible[i + 1].content) : null,
        index: exchanges.length,
      });
      if (hasAssistant) i++;
    }
  }

  // If streaming, the final exchange is currently live. Override its assistant text with the streaming content.
  if (isStreaming && exchanges.length > 0) {
    exchanges[exchanges.length - 1].assistant = streamingContent || null;
  }

  const total = exchanges.length;

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

  const goTo = (idx: number, dir: number) => {
    if (idx < 0 || idx >= total) return;
    setDirection(dir);
    setCurrentIndex(idx);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(currentIndex - 1, -1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(currentIndex + 1, 1); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [currentIndex, total]);

  // Resolve which exchange to show
  const shown = exchanges[currentIndex];
  const isLive = isStreaming && currentIndex === exchanges.length - 1;
  const isLoading = isLive && !streamingContent;

  const isNavigating = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabled = useRef(true);

  // Scroll to bottom on card/page change
  useEffect(() => {
    if (cardRef.current) {
      cardRef.current.scrollTop = cardRef.current.scrollHeight;
      autoScrollEnabled.current = true;
    }
  }, [currentIndex]);

  // Scroll to bottom on stream updates
  useEffect(() => {
    if (isLive && autoScrollEnabled.current && cardRef.current) {
      cardRef.current.scrollTop = cardRef.current.scrollHeight;
    }
  }, [streamingContent, isLive]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    autoScrollEnabled.current = isAtBottom;
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
    <div className="peek-exchange-view" onWheel={handleWheel}>
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
              <span className="peek-exchange-user-bubble">{shown.user}</span>
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

          {/* Actions — only on completed responses */}
          {(() => {
            if (!shown.assistant || isLive) return null;
            const cleanedText = shown.assistant
              .replace(/\n\n\*\(Stopped by user\)\*/i, '')
              .replace(/^\*\(Stopped by user\)\*$/i, '')
              .trim();
            if (!cleanedText) return null;
            return (
              <div style={{ display: 'flex', gap: '8px', alignSelf: 'flex-start', marginTop: '8px' }}>
                <CopyButton text={cleanedText} label="Copy response" />
                <RememberButton text={cleanedText} />
              </div>
            );
          })()}
        </motion.div>
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
