import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useHistoryStore, type Session } from '../store/history';
import { usePeekStore } from '../store/peek';
import { historyVariants, panelRowVariants } from '../lib/motion';
import { updateSessionTitle, deleteSession, getRecentSessions } from '../db/database';

interface HistoryProps {
  onSelectSession: (session: Session) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export const History: React.FC<HistoryProps> = ({ onSelectSession }) => {
  const { sessions, isOpen, setOpen, setSessions } = useHistoryStore();
  const activeSessionId = usePeekStore((state) => state.activeSessionId);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const filteredSessions = sessions.filter(s => 
    (s.title || 'Untitled').toLowerCase().includes(searchQuery.toLowerCase())
  );
  
  // Bring active session to top
  const activeSessionIndex = filteredSessions.findIndex(s => s.id === activeSessionId);
  if (activeSessionIndex > 0) {
    const [activeSession] = filteredSessions.splice(activeSessionIndex, 1);
    filteredSessions.unshift(activeSession);
  }

  // Reset selection when opened
  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
      setSearchQuery('');
      setIsSearchVisible(false);
      setEditingId(null);
    }
  }, [isOpen]);

  // Focus search input when it becomes visible
  useEffect(() => {
    if (isOpen && isSearchVisible && searchInputRef.current && !editingId) {
      searchInputRef.current.focus();
    }
  }, [isOpen, isSearchVisible, editingId]);

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // Scroll active item into view
  useEffect(() => {
    if (!scrollContainerRef.current) return;
    const activeEl = scrollContainerRef.current.children[selectedIndex] as HTMLElement;
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, filteredSessions.length]);

  const refreshSessions = async () => {
    try {
      const recent = await getRecentSessions();
      setSessions(recent);
    } catch (err) {
      console.error('Failed to refresh sessions:', err);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent, session: Session) => {
    e.preventDefault();
    if (editTitle.trim() && editTitle.trim() !== session.title) {
      await updateSessionTitle(session.id, editTitle.trim());
      await refreshSessions();
    }
    setEditingId(null);
    if (searchInputRef.current) searchInputRef.current.focus();
  };

  const handleDelete = async (e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    await deleteSession(session.id);
    await refreshSessions();
    const { activeSessionId, clear } = usePeekStore.getState();
    if (activeSessionId === session.id) {
      clear();
    }
  };

  useEffect(() => {
    if (!isOpen || editingId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      
      // Auto-show search on typing
      if (!isSearchVisible && e.key.length === 1 && sessions.length > 0) {
        setIsSearchVisible(true);
        setSearchQuery((prev) => prev + e.key);
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        if (isSearchVisible && searchQuery) {
          e.preventDefault();
          e.stopPropagation();
          setSearchQuery('');
          setIsSearchVisible(false);
        } else {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredSessions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (filteredSessions.length > 0) {
          onSelectSession(filteredSessions[selectedIndex]);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, setOpen, filteredSessions, selectedIndex, onSelectSession, editingId, isSearchVisible, searchQuery, sessions.length]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="peek-history"
          variants={historyVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <motion.div className="peek-history-header" variants={panelRowVariants}>
            <span className="peek-panel-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
            </span>
            <span className="peek-history-title">Recent</span>
            {sessions.length > 0 && <span className="peek-panel-count">{filteredSessions.length}</span>}
            <span className="peek-panel-spacer" />
            <span className="peek-panel-esc">type to search · esc</span>
            <button
              className="peek-panel-close"
              onClick={() => setOpen(false)}
              aria-label="Close history"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </motion.div>
          
          <AnimatePresence>
            {isSearchVisible && sessions.length > 0 && (
              <motion.div 
                className="peek-history-search"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
                style={{ overflow: 'hidden' }}
              >
                <input 
                  ref={searchInputRef}
                  type="text" 
                  placeholder="Search conversations..." 
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={(e) => {
                    // Let keyboard shortcuts bubble up to global handlers
                    if (e.altKey || e.ctrlKey || e.metaKey) return;
                    
                    // Prevent normal typing keys from bubbling up
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Escape') {
                      e.stopPropagation();
                    }
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="peek-history-list" ref={scrollContainerRef}>
            {filteredSessions.length === 0 ? (
              <div className="peek-empty">
                <span className="peek-empty-icon" aria-hidden="true">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <polyline points="12 7 12 12 15 14" />
                  </svg>
                </span>
                <span className="peek-empty-title">
                  {searchQuery ? 'Nothing matches that' : 'No conversations yet'}
                </span>
                <span className="peek-empty-hint">
                  {searchQuery
                    ? 'Try a shorter search, or clear it to see everything.'
                    : 'Every conversation you have is saved here automatically, so you can pick one back up later.'}
                </span>
              </div>
            ) : (
              filteredSessions.map((session, idx) => (
                <button
                  key={session.id}
                  className="peek-history-item"
                  data-active={session.id === activeSessionId ? 'true' : undefined}
                  style={{
                    background:
                      idx === selectedIndex && editingId !== session.id && session.id !== activeSessionId
                        ? 'var(--peek-hover)'
                        : undefined,
                  }}
                  onClick={() => {
                    if (editingId !== session.id) {
                      onSelectSession(session);
                    }
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div className="peek-history-item-top">
                    {editingId === session.id ? (
                      <form 
                        onSubmit={(e) => handleEditSubmit(e, session)}
                        style={{ width: '100%' }}
                      >
                        <input
                          ref={editInputRef}
                          className="peek-history-edit-input"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onBlur={(e) => handleEditSubmit(e, session)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingId(null);
                              if (searchInputRef.current) searchInputRef.current.focus();
                            }
                          }}
                        />
                      </form>
                    ) : (
                      <>
                        <span className="peek-history-item-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {session.id === activeSessionId && (
                            <span 
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                backgroundColor: 'var(--peek-accent)',
                                display: 'inline-block',
                                flexShrink: 0
                              }} 
                              title="Active chat"
                            />
                          )}
                          {session.title || 'Untitled'}
                        </span>
                        <div className="peek-history-item-actions">
                          <div 
                            className="peek-history-action-btn"
                            title="Rename"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditTitle(session.title || 'Untitled');
                              setEditingId(session.id);
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9"></path>
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                            </svg>
                          </div>
                          <div 
                            className="peek-history-action-btn"
                            title="Delete"
                            onClick={(e) => handleDelete(e, session)}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6"></polyline>
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  <span className="peek-history-item-meta">
                    <span className="peek-history-item-model">
                      {session.model}
                    </span>
                    <span className="peek-history-item-time">
                      {formatRelativeTime(session.updatedAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
