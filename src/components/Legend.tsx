import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { usePeekStore } from '../store/peek';
import { useHotkeyStore } from '../store/hotkey';
import { historyVariants, panelRowVariants } from '../lib/motion';
import { formatHotkey, quitHotkey } from '../lib/hotkey';

interface LegendKey {
  key: string;
  description: string;
  /** A row that does the thing when clicked, for actions with no other button. */
  onActivate?: () => void;
}

/**
 * Grouped rather than listed flat: seventeen undifferentiated rows is a wall,
 * and the bindings a new user actually needs first are the four in Essentials.
 * Built per render because the summon chord is whatever the user configured.
 */
const hotkeyGroups = (summon: string): { title: string; keys: LegendKey[] }[] => [
  {
    title: 'Essentials',
    keys: [
      { key: formatHotkey(summon), description: 'Summon or hide Peekaboo' },
      { key: 'Enter', description: 'Send message' },
      { key: 'Shift+Enter', description: 'New line' },
      { key: 'Escape', description: 'Hide window, or dismiss a panel' },
      // Quit lives here rather than only in the tray because GNOME has no tray
      // without an extension. The row is clickable for the same reason.
      {
        key: formatHotkey(quitHotkey()),
        description: 'Quit Peekaboo',
        onActivate: () => { void invoke('quit_app'); },
      },
    ],
  },
  {
    title: 'Conversation',
    keys: [
      { key: 'Alt+N', description: 'New chat' },
      { key: 'Alt+Q', description: 'Stop the response' },
      { key: 'Alt+C', description: 'Copy the last answer' },
      { key: 'Alt+←', description: 'Jump to previous message' },
      { key: 'Alt+→', description: 'Jump to next message' },
    ],
  },
  {
    title: 'Add context',
    keys: [
      { key: '/', description: 'Plugin commands' },
      { key: 'Alt+S', description: 'Capture a screen region (vision models)' },
    ],
  },
  {
    title: 'Panels',
    keys: [
      { key: 'Alt+H', description: 'History' },
      { key: 'Alt+M', description: 'Switch model' },
      { key: 'Alt+R', description: 'Memories' },
      { key: 'Alt+,', description: 'Settings' },
      { key: 'Alt+/', description: 'This list' },
    ],
  },
];

export const Legend: React.FC = () => {
  const { isLegendOpen, setLegendOpen } = usePeekStore();
  const summonHotkey = useHotkeyStore((s) => s.hotkey);
  const groups = hotkeyGroups(summonHotkey);
  const totalShortcuts = groups.reduce((n, g) => n + g.keys.length, 0);

  React.useEffect(() => {
    if (!isLegendOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setLegendOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isLegendOpen, setLegendOpen]);

  return (
    <AnimatePresence>
      {isLegendOpen && (
        <motion.div
          className="peek-history"
          variants={historyVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          style={{ zIndex: 100 }} // Ensure it overlaps other panels if they are somehow open
        >
          <motion.div className="peek-history-header" variants={panelRowVariants}>
            <span className="peek-panel-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
              </svg>
            </span>
            <span className="peek-history-title">Shortcuts</span>
            <span className="peek-panel-count">{totalShortcuts}</span>
            <span className="peek-panel-spacer" />
            <span className="peek-panel-esc">esc</span>
            <button
              className="peek-panel-close"
              onClick={() => setLegendOpen(false)}
              aria-label="Close shortcuts"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </motion.div>
          <div className="peek-history-list">
            {groups.map((group) => (
              <motion.div key={group.title} variants={panelRowVariants}>
                <div className="peek-legend-group">{group.title}</div>
                {group.keys.map((hk) =>
                  hk.onActivate ? (
                    <button
                      key={hk.key}
                      type="button"
                      className="peek-legend-row peek-legend-row--action"
                      onClick={hk.onActivate}
                    >
                      <span className="peek-legend-desc">{hk.description}</span>
                      <kbd className="peek-kbd">{hk.key}</kbd>
                    </button>
                  ) : (
                    <div key={hk.key} className="peek-legend-row">
                      <span className="peek-legend-desc">{hk.description}</span>
                      <kbd className="peek-kbd">{hk.key}</kbd>
                    </div>
                  )
                )}
              </motion.div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
