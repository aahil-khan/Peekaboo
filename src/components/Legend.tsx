import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePeekStore } from '../store/peek';
import { historyVariants } from '../lib/motion';

/**
 * Grouped rather than listed flat: seventeen undifferentiated rows is a wall,
 * and the bindings a new user actually needs first are the four in Essentials.
 */
const HOTKEY_GROUPS: { title: string; keys: { key: string; description: string }[] }[] = [
  {
    title: 'Essentials',
    keys: [
      { key: 'Ctrl+Space', description: 'Summon or hide Peekaboo' },
      { key: 'Alt+Space', description: 'Summon or hide (alternate)' },
      { key: 'Enter', description: 'Send message' },
      { key: 'Shift+Enter', description: 'New line' },
      { key: 'Escape', description: 'Hide window, or dismiss a panel' },
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
          <div className="peek-history-header">
            <span className="peek-history-title">Keyboard Shortcuts</span>
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
          </div>
          <div className="peek-history-list">
            {HOTKEY_GROUPS.map((group) => (
              <React.Fragment key={group.title}>
                <div className="peek-legend-group">{group.title}</div>
                {group.keys.map((hk) => (
                  <div key={hk.key} className="peek-legend-row">
                    <span className="peek-legend-desc">{hk.description}</span>
                    <kbd className="peek-kbd">{hk.key}</kbd>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
