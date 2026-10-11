import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Message } from '../providers/types';
import type { Attachment } from '../hooks/useAttachments';
import { getTextContent, parseUserContent, stripStopMarker, toModelText } from '../lib/messageUtils';
import { useSettingsStore } from '../store/settings';
import { usePeekStore } from '../store/peek';

const MarkdownWrapper = React.lazy(() => import('../lib/MarkdownWrapper'));

/** How close to the bottom still counts as "pinned", in px. */
const NEAR_BOTTOM = 32;

interface Exchange {
  user: string;
  images?: string[];
  assistant: string | null;
  model?: string;
  index: number;
}

interface TranscriptProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  onClickAttachment?: (att: Attachment) => void;
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
    const selectedText = window.getSelection()?.toString().trim();
    const textToRemember = selectedText || text;
    if (!textToRemember) return;
    usePeekStore.getState().setMemoryOverlay({
      isOpen: true,
      title: selectedText ? 'Remember Selection' : 'Remember Response',
      initialSearchQuery: textToRemember,
    });
  };
  return (
    <button className="peek-copy-response-btn" onClick={remember} title="Save to Memory" aria-label="Save to Memory">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
        <polyline points="17 21 17 13 7 13 7 21"></polyline>
        <polyline points="7 3 7 8 15 8"></polyline>
      </svg>
      Remember
    </button>
  );
}

interface ExchangeBlockProps {
  exchange: Exchange;
  isLive: boolean;
  onClickAttachment?: (att: Attachment) => void;
}

/**
 * One user + assistant turn.
 *
 * Memoised deliberately, and this is load-bearing. The stream pushes a new
 * `streamingContent` roughly once per animation frame; only the last block's
 * text actually changes. Without this, every block in the transcript re-parses
 * its markdown on every frame, and a long conversation visibly stalls the
 * stream. `onClickAttachment` is stabilised by the parent so the shallow
 * compare holds.
 */
const ExchangeBlock = React.memo<ExchangeBlockProps>(function ExchangeBlock({ exchange, isLive, onClickAttachment }) {
  const { contexts, prompt, action } = useMemo(() => parseUserContent(exchange.user), [exchange.user]);
  const isWaiting = isLive && !exchange.assistant;
  const cleaned = exchange.assistant ? stripStopMarker(exchange.assistant) : '';

  return (
    <div className="peek-thread-exchange">
      <div className="peek-thread-user">
        {contexts.length > 0 && (
          <div className="peek-thread-user-contexts">
            {contexts.map((ctx, i) => {
              const short = ctx.replace(/\s+/g, ' ').slice(0, 30);
              const isClickable = ctx.length > 30;
              return (
                <div
                  key={i}
                  className={`peek-user-context-chip${isClickable ? ' peek-clickable' : ''}`}
                  title={isClickable ? 'Click to view full context' : undefined}
                  onClick={
                    isClickable
                      ? () =>
                          onClickAttachment?.({
                            id: `ctx-${exchange.index}-${i}`,
                            type: 'selection',
                            label: `Context: "${short}..."`,
                            content: ctx,
                            mediaType: 'text/plain',
                          })
                      : undefined
                  }
                >
                  ▤ {short}
                  {isClickable ? '...' : ''}
                </div>
              );
            })}
          </div>
        )}

        {exchange.images && exchange.images.length > 0 && (
          <div className="peek-turn-images">
            {exchange.images.map((img, i) => {
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
                  className="peek-turn-image"
                  src={img}
                  alt={`Attachment ${i + 1}`}
                  onClick={() =>
                    onClickAttachment?.({
                      id: `img-${exchange.index}-${i}`,
                      type: 'screenshot',
                      label: `Image ${i + 1}`,
                      content: base64,
                      mediaType,
                    })
                  }
                />
              );
            })}
          </div>
        )}

        {/* An action shows its name, not the template it expanded to; the
            chip above carries the text it ran on. */}
        {action ? (
          <span className="peek-thread-user-bubble peek-thread-user-bubble--action" title={`Action · ${action.kind === 'transform' ? 'replaces the text' : 'answers'}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            {action.name}
          </span>
        ) : (
          <span className="peek-thread-user-bubble">{prompt}</span>
        )}
        <CopyButton text={action ? toModelText(exchange.user) : exchange.user} label="Copy prompt" alignRight />
      </div>

      {/*
        The caret is a ::after on the last rendered block rather than its own
        element. Markdown renders block-level children, so a sibling <span>
        landed on a line of its own and read as a stray pipe under the answer.
      */}
      <div className="peek-thread-assistant peek-md" data-live={isLive && exchange.assistant ? 'true' : undefined}>
        {isWaiting ? (
          <div className="peek-loading-dots" aria-label="Thinking…">
            <span /><span /><span />
          </div>
        ) : exchange.assistant ? (
          <MarkdownWrapper>{exchange.assistant}</MarkdownWrapper>
        ) : null}
      </div>

      {exchange.assistant && (
        <div className="peek-turn-actions">
          {!isLive && cleaned && (
            <>
              <CopyButton text={cleaned} label="Copy response" />
              <RememberButton text={cleaned} />
            </>
          )}
          <span className="peek-turn-actions-spacer" />
          {exchange.model && <span className="peek-turn-model">{exchange.model}</span>}
        </div>
      )}
    </div>
  );
});

export const Transcript: React.FC<TranscriptProps> = ({
  messages,
  streamingContent,
  isStreaming,
  onClickAttachment,
}) => {
  // Pair user messages with their answers. Memoised on `messages` so it does
  // not rerun for every streamed token.
  const exchanges = useMemo<Exchange[]>(() => {
    const result: Exchange[] = [];
    const visible = messages.filter((m) => m.role !== 'system');
    for (let i = 0; i < visible.length; i++) {
      if (visible[i].role === 'user') {
        const hasAssistant = visible[i + 1] && visible[i + 1].role === 'assistant';

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
              // Not a structured multimodal payload; treat it as plain text.
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

  // Overlay the in-flight response onto the last turn.
  const displayExchanges = useMemo<Exchange[]>(() => {
    if (!isStreaming || exchanges.length === 0) return exchanges;
    const copy = [...exchanges];
    copy[copy.length - 1] = {
      ...copy[copy.length - 1],
      assistant: streamingContent || null,
      model: activeModel,
    };
    return copy;
  }, [exchanges, isStreaming, streamingContent, activeModel]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  /*
   * Whether new content should drag the view down with it.
   *
   * Intent and position are deliberately separate. The scroller's height is
   * still changing while an answer streams in, so a position-only heuristic
   * can read one frame of lag as "the user scrolled up" and abandon
   * auto-scroll mid-answer. So only a real gesture unsticks; position may
   * only re-arm.
   *
   * A ref rather than state: this changes on every wheel event and must never
   * cause a render.
   */
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const syncJumpButton = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const overflowing = el.scrollHeight > el.clientHeight + 8;
    setShowJump(overflowing && !stickRef.current);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < NEAR_BOTTOM) stickRef.current = true; // re-arm only, never release
    syncJumpButton();
  }, [syncJumpButton]);

  const unstick = useCallback(() => {
    stickRef.current = false;
    syncJumpButton();
  }, [syncJumpButton]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.deltaY < 0) unstick();
    },
    [unstick]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') unstick();
    },
    [unstick]
  );

  /*
   * Before paint, not after. Scheduling this in requestAnimationFrame — as the
   * paged view did — means every streamed frame briefly paints at the previous
   * scroll position, which reads as jitter.
   */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [streamingContent, displayExchanges.length]);

  useEffect(() => {
    syncJumpButton();
  }, [streamingContent, displayExchanges.length, syncJumpButton]);

  // Asking a question always brings you back to the bottom.
  const previousLength = useRef(displayExchanges.length);
  useEffect(() => {
    if (displayExchanges.length > previousLength.current) stickRef.current = true;
    previousLength.current = displayExchanges.length;
  }, [displayExchanges.length]);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const start = el.scrollTop;
    const end = el.scrollHeight - el.clientHeight;
    const distance = end - start;
    stickRef.current = true;
    if (distance <= 0) {
      syncJumpButton();
      return;
    }
    const duration = Math.min(300, Math.max(120, distance * 0.4));
    const startTime = performance.now();
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = (now: number) => {
      const progress = Math.min((now - startTime) / duration, 1);
      el.scrollTop = start + distance * easeOut(progress);
      if (progress < 1) requestAnimationFrame(step);
      else syncJumpButton();
    };
    requestAnimationFrame(step);
  }, [syncJumpButton]);

  /*
   * Alt+←/→ used to page between exchanges. With a transcript there is nothing
   * to page, so they jump between messages instead — the binding and the
   * muscle memory survive, the paging model doesn't.
   *
   * This stays local rather than moving into useShortcuts because it needs the
   * scroller and its children; it takes the same defaultPrevented guard so a
   * key already handled by a child doesn't fire it twice.
   */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.defaultPrevented) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = scrollerRef.current;
      if (!el) return;

      const anchors = Array.from(el.querySelectorAll<HTMLElement>('.peek-thread-exchange'));
      if (anchors.length === 0) return;

      e.preventDefault();
      const scrollerTop = el.getBoundingClientRect().top;
      // Offsets relative to the scroller's current scroll position, measured
      // from rects so this doesn't depend on which ancestor is the offsetParent.
      const offsets = anchors.map((a) => el.scrollTop + (a.getBoundingClientRect().top - scrollerTop));

      const target =
        e.key === 'ArrowLeft'
          ? [...offsets].reverse().find((top) => top < el.scrollTop - 4)
          : offsets.find((top) => top > el.scrollTop + 4);

      if (target === undefined) return;
      stickRef.current = false;
      el.scrollTo({ top: Math.max(0, target - 8), behavior: 'smooth' });
      syncJumpButton();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [syncJumpButton]);

  /*
   * Keep a stable identity for the attachment callback so ExchangeBlock's memo
   * isn't defeated by the parent re-creating the prop each render.
   */
  const attachmentHandler = useRef(onClickAttachment);
  useEffect(() => {
    attachmentHandler.current = onClickAttachment;
  });
  const stableOnClickAttachment = useCallback((att: Attachment) => {
    attachmentHandler.current?.(att);
  }, []);

  if (displayExchanges.length === 0) return null;

  const lastIndex = displayExchanges.length - 1;

  return (
    <div className="peek-transcript-wrap">
      <div
        ref={scrollerRef}
        className="peek-transcript"
        tabIndex={-1}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      >
        {/* Hoisted out of the map: one boundary for the whole list, not one per turn. */}
        <Suspense
          fallback={
            <div className="peek-loading-dots">
              <span /><span /><span />
            </div>
          }
        >
          {displayExchanges.map((exchange, i) => (
            <ExchangeBlock
              key={exchange.index}
              exchange={exchange}
              isLive={isStreaming && i === lastIndex}
              onClickAttachment={stableOnClickAttachment}
            />
          ))}
        </Suspense>
      </div>

      {showJump && (
        <button
          type="button"
          className="peek-scroll-bottom-btn"
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          title="Scroll to latest"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        </button>
      )}
    </div>
  );
};
