import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePeekStore } from '../store/peek';
import { historyVariants } from '../lib/motion';

const HOTKEYS = [
  { key: 'Alt+Space', description: 'Summon or Hide Peekaboo' },
  { key: 'Enter', description: 'Send Message' },
  { key: 'Shift+Enter', description: 'Line Break (Multi-line)' },
  { key: 'Alt+K', description: 'Clear Conversation' },
  { key: 'Alt+H', description: 'Toggle History Panel' },
  { key: 'Alt+M', description: 'Toggle Model Switcher' },
  { key: 'Alt+,', description: 'Open Settings Window' },
  { key: 'Alt+/', description: 'Toggle this Shortcuts Legend' },
  { key: 'Alt+←', description: 'Previous Exchange in Session' },
  { key: 'Alt+→', description: 'Next Exchange in Session' },
  { key: 'Escape', description: 'Hide Window / Dismiss Menu' },
  { key: 'Up Arrow', description: 'Load Previous Query (when input empty)' },
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="peek-history-title">Keyboard Shortcuts</span>
              <kbd className="peek-kbd">Alt+/</kbd>
            </div>
            <button
              onClick={() => setLegendOpen(false)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--peek-text-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 4,
                borderRadius: 4,
              }}
              onMouseOver={(e) => (e.currentTarget.style.color = 'var(--peek-text)')}
              onMouseOut={(e) => (e.currentTarget.style.color = 'var(--peek-text-muted)')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div className="peek-history-list" style={{ padding: '8px' }}>
            {HOTKEYS.map((hk) => (
              <div 
                key={hk.key} 
                style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center', 
                  padding: '8px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.02)'
                }}
              >
                <span style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>
                  {hk.description}
                </span>
                <kbd className="peek-kbd" style={{ fontSize: 11, padding: '3px 6px', height: 'auto', background: 'rgba(255,255,255,0.05)' }}>
                  {hk.key}
                </kbd>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
