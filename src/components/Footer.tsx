import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { togglePanel, useOpenPanel } from '../hooks/usePanels';

/**
 * The always-visible action bar.
 *
 * Every feature in the overlay used to be keyboard-only, with no clickable
 * equivalent anywhere — including the shortcut legend that documented the
 * keys. This bar is the mouse-discoverable path to all of it, and each button
 * names its shortcut in the tooltip so it also teaches the keyboard.
 *
 * It absorbed the old status bar, which rendered nothing at all while the
 * provider check was in flight or when no model was selected — an empty 28px
 * band on exactly the cold-start path a new user sees first.
 */

export interface FooterStatus {
  tone: 'ok' | 'warn' | 'error' | 'muted';
  text: string;
  /** Fuller explanation for the tooltip; the slot is too narrow for long text. */
  hint?: string;
  /** Makes the status clickable — used to route a config problem somewhere useful. */
  onClick?: () => void;
}

interface FooterProps {
  onNewChat: () => void;
  onCaptureRegion: () => void;
  /** When set, capture is unavailable and this explains why. */
  captureDisabledReason?: string | null;
  onOpenSettings: () => void;
  status: FooterStatus | null;
  toast: { type: 'success' | 'error'; text: string } | null;
  modelLabel: string | null;
}

const IconButton: React.FC<{
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  children: React.ReactNode;
}> = ({ label, shortcut, onClick, active, disabled, disabledReason, children }) => (
  <button
    type="button"
    className="peek-icon-btn peek-footer-btn"
    onClick={onClick}
    disabled={disabled}
    aria-pressed={active}
    aria-label={label}
    title={disabled && disabledReason ? disabledReason : shortcut ? `${label} (${shortcut})` : label}
  >
    {children}
  </button>
);

const svg = (children: React.ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const Footer: React.FC<FooterProps> = ({
  onNewChat,
  onCaptureRegion,
  captureDisabledReason,
  onOpenSettings,
  status,
  toast,
  modelLabel,
}) => {
  const openPanel = useOpenPanel();

  return (
    <div className="peek-footer">
      {/* A plus, not a pencil. The pencil read as "edit this", which is not
          what the button does. */}
      <IconButton label="New chat" shortcut="Alt+N" onClick={onNewChat}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </IconButton>

      <IconButton label="History" shortcut="Alt+H" active={openPanel === 'history'} onClick={() => togglePanel('history')}>
        {svg(
          <>
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
          </>
        )}
      </IconButton>

      <IconButton label="Memories" shortcut="Alt+R" active={openPanel === 'memory'} onClick={() => togglePanel('memory')}>
        {svg(<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />)}
      </IconButton>

      <IconButton
        label="Capture a screen region"
        shortcut="Alt+S"
        onClick={onCaptureRegion}
        disabled={!!captureDisabledReason}
        disabledReason={captureDisabledReason}
      >
        {svg(
          <>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </>
        )}
      </IconButton>

      {/* Status and transient toasts share this slot; a toast wins while it's up. */}
      <div className="peek-footer-status">
        <AnimatePresence mode="wait">
          {toast ? (
            <motion.span
              key="toast"
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.12 }}
              className={`peek-toast ${toast.type === 'success' ? 'peek-toast--success' : 'peek-toast--error'}`}
            >
              {toast.type === 'success'
                ? svg(
                    <>
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </>
                  )
                : svg(
                    <>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </>
                  )}
              {toast.text}
            </motion.span>
          ) : status ? (
            <motion.button
              key={`status-${status.text}`}
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className={`peek-footer-statustext peek-tone-${status.tone}`}
              onClick={status.onClick}
              disabled={!status.onClick}
              title={status.hint ?? status.text}
            >
              <span className="peek-status-dot" />
              {status.text}
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>

      <button
        type="button"
        className={`peek-footer-model${modelLabel ? '' : ' peek-footer-model--empty'}`}
        onClick={() => togglePanel('models')}
        aria-pressed={openPanel === 'models'}
        title={modelLabel ? `Switch model (Alt+M) — currently ${modelLabel}` : 'Choose a model (Alt+M)'}
      >
        {modelLabel ?? 'Choose a model'}
      </button>

      <IconButton label="Settings" shortcut="Alt+," onClick={onOpenSettings}>
        {svg(
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </>
        )}
      </IconButton>

      <IconButton label="Keyboard shortcuts" shortcut="Alt+/" active={openPanel === 'legend'} onClick={() => togglePanel('legend')}>
        {svg(
          <>
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </>
        )}
      </IconButton>
    </div>
  );
};
