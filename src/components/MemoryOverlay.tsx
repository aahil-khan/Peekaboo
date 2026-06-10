import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePeekStore } from '../store/peek';
import { historyVariants } from '../lib/motion';
import { saveMemory, deleteMemory, updateMemory, togglePinMemory, incrementMemoryUsage } from '../db/database';

function generateId(): string {
  return crypto.randomUUID();
}

function timeAgo(timestamp: number): string {
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

export const MemoryOverlay: React.FC = () => {
  const { memoryOverlay, setMemoryOverlay, input, setInput } = usePeekStore();
  const { isOpen, title, items, initialSearchQuery } = memoryOverlay;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLTextAreaElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Edit states
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  // Copy indicator state
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Reset state when opening/closing
  useEffect(() => {
    if (isOpen) {
      if (initialSearchQuery) {
        setSearchQuery(initialSearchQuery);
        setIsSearchVisible(true);
      } else {
        setSearchQuery('');
        setIsSearchVisible(false);
      }
      setSelectedIndex(0);
      setEditingId(null);
      setCopiedText(null);
    }
  }, [isOpen, initialSearchQuery]);

  const adjustHeight = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 120;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    adjustHeight(searchInputRef.current);
  }, [searchQuery, adjustHeight, isSearchVisible]);

  useEffect(() => {
    adjustHeight(editInputRef.current);
  }, [editContent, adjustHeight, editingId]);

  const exactMatch = items.find(i => i.content.toLowerCase() === searchQuery.trim().toLowerCase());
  const showSaveOption = searchQuery.trim() && !exactMatch;
  
  let filteredItems = items.filter(i => i.content.toLowerCase().includes(searchQuery.toLowerCase()));
  
  // Sort by search relevance client-side
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    filteredItems = [...filteredItems].sort((a, b) => {
      const aContent = a.content.toLowerCase();
      const bContent = b.content.toLowerCase();
      
      const aExact = aContent === q;
      const bExact = bContent === q;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      
      const aStarts = aContent.startsWith(q);
      const bStarts = bContent.startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      
      // Fallback to pinning, usage count, and recency
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      
      if (b.usageCount !== a.usageCount) {
        return b.usageCount - a.usageCount;
      }
      
      return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    });
  }
  
  const displayItems = showSaveOption 
    ? [
        { id: 'save-action', isSaveAction: true, content: searchQuery.trim(), isPinned: false, usageCount: 0, lastUsedAt: null, createdAt: Date.now() },
        ...filteredItems.map(item => ({ id: item.id, isSaveAction: false, content: item.content, isPinned: item.isPinned, usageCount: item.usageCount, lastUsedAt: item.lastUsedAt, createdAt: item.createdAt }))
      ]
    : filteredItems.map(item => ({ id: item.id, isSaveAction: false, content: item.content, isPinned: item.isPinned, usageCount: item.usageCount, lastUsedAt: item.lastUsedAt, createdAt: item.createdAt }));

  // Auto-focus edit input
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const reloadMemories = async () => {
    const { searchMemories: reload } = await import('../db/database');
    const memories = await reload('');
    setMemoryOverlay({ items: memories });
    return memories;
  };

  const handleExecuteAction = async (item: typeof displayItems[0], shiftKey: boolean) => {
    if (item.isSaveAction) {
      // Save it
      await saveMemory(generateId(), item.content);
      await reloadMemories();
      setSearchQuery('');
      setIsSearchVisible(false);
      setMemoryOverlay({ initialSearchQuery: undefined });
    } else {
      // Use it
      await incrementMemoryUsage(item.id);
      await reloadMemories();
      if (shiftKey) {
        // Insert into prompt
        const newInput = input + (input && !input.endsWith('\n') ? '\n' : '') + item.content;
        setInput(newInput);
        setMemoryOverlay({ isOpen: false });
      } else {
        // Copy
        navigator.clipboard.writeText(item.content);
        setCopiedText(item.content);
        setTimeout(() => setCopiedText(null), 2000);
      }
    }
  };

  useEffect(() => {
    if (!isOpen || editingId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      
      // Auto-show search on typing (ignore Shift, Enter, etc)
      if (!isSearchVisible && e.key.length === 1 && !e.shiftKey) {
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
          setMemoryOverlay({ initialSearchQuery: undefined });
        } else {
          e.preventDefault();
          e.stopPropagation();
          setMemoryOverlay({ isOpen: false, initialSearchQuery: undefined });
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, displayItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (displayItems.length > 0) {
          handleExecuteAction(displayItems[selectedIndex], e.shiftKey);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, setMemoryOverlay, isSearchVisible, searchQuery, displayItems, selectedIndex, items, editingId, input, setInput]);

  // Focus search input when it becomes visible
  useEffect(() => {
    if (isSearchVisible && searchInputRef.current) {
      searchInputRef.current.focus();
      // Move cursor to end
      searchInputRef.current.setSelectionRange(searchInputRef.current.value.length, searchInputRef.current.value.length);
    }
  }, [isSearchVisible]);

  // Scroll to selected item
  useEffect(() => {
    if (scrollContainerRef.current) {
      const selectedEl = scrollContainerRef.current.children[selectedIndex] as HTMLElement;
      if (selectedEl) {
        const container = scrollContainerRef.current;
        const top = selectedEl.offsetTop;
        const bottom = top + selectedEl.offsetHeight;
        if (top < container.scrollTop) {
          container.scrollTop = top;
        } else if (bottom > container.scrollTop + container.offsetHeight) {
          container.scrollTop = bottom - container.offsetHeight;
        }
      }
    }
  }, [selectedIndex]);

  const handleEditSubmit = async (e: React.FormEvent | React.KeyboardEvent, id: string) => {
    e.preventDefault();
    if (editContent.trim()) {
      await updateMemory(id, editContent.trim());
      await reloadMemories();
    }
    setEditingId(null);
    if (searchInputRef.current) searchInputRef.current.focus();
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteMemory(id);
    const memories = await reloadMemories();
    setSelectedIndex((i) => Math.max(0, Math.min(i, memories.length - 1)));
  };

  const handleTogglePin = async (e: React.MouseEvent, item: typeof displayItems[0]) => {
    e.stopPropagation();
    await togglePinMemory(item.id, !item.isPinned);
    await reloadMemories();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="peek-history"
          variants={historyVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          style={{ zIndex: 105, position: 'absolute' }}
        >
          <div className="peek-history-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="peek-history-title">{title}</span>
            </div>
            <button
              onClick={() => setMemoryOverlay({ isOpen: false, initialSearchQuery: undefined })}
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
          
          <AnimatePresence>
            {isSearchVisible && (
              <motion.div 
                className="peek-history-search"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
                style={{ overflow: 'hidden' }}
              >
                <textarea 
                  ref={searchInputRef}
                  placeholder="Search or save memory..." 
                  value={searchQuery}
                  rows={1}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.altKey || e.ctrlKey || e.metaKey) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                      // Handled by global listener to avoid duplicates
                    } else if (e.key === 'Enter' && e.shiftKey) {
                      // Handled by global listener
                    } else if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Escape') {
                      e.stopPropagation();
                    }
                  }}
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--peek-text)',
                    fontSize: '13px',
                    outline: 'none',
                    resize: 'none',
                    fontFamily: 'inherit',
                    lineHeight: '1.4'
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="peek-history-list" ref={scrollContainerRef} style={{ position: 'relative' }}>
            {displayItems.length === 0 ? (
              <div className="peek-history-empty" style={{ paddingTop: 16 }}>
                Nothing found
              </div>
            ) : (
              displayItems.map((item, idx) => (
                <div
                  key={item.id}
                  className="peek-history-item"
                  style={{
                    background: idx === selectedIndex && editingId !== item.id ? 'var(--peek-hover)' : 'transparent',
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    padding: '8px 12px',
                    gap: 4
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {editingId === item.id ? (
                    <form 
                      onSubmit={(e) => handleEditSubmit(e, item.id)}
                      style={{ width: '100%', display: 'flex' }}
                    >
                      <textarea
                        ref={editInputRef}
                        value={editContent}
                        rows={1}
                        onChange={(e) => setEditContent(e.target.value)}
                        onBlur={(e) => handleEditSubmit(e, item.id)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditingId(null);
                            if (searchInputRef.current) searchInputRef.current.focus();
                          } else if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleEditSubmit(e, item.id);
                          }
                        }}
                        style={{
                          width: '100%',
                          background: 'var(--peek-bg)',
                          border: '1px solid var(--peek-border)',
                          color: 'var(--peek-text)',
                          padding: '6px 8px',
                          borderRadius: '4px',
                          fontSize: '13px',
                          outline: 'none',
                          resize: 'none',
                          fontFamily: 'inherit',
                          lineHeight: '1.4'
                        }}
                      />
                    </form>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '8px', width: '100%' }}>
                      <button
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          margin: 0,
                          textAlign: 'left',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          flex: 1,
                          color: 'inherit',
                          fontFamily: 'inherit',
                        }}
                        onClick={(e) => handleExecuteAction(item, e.shiftKey)}
                      >
                        <div style={{ marginTop: 2 }}>
                          {item.isSaveAction ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                              <polyline points="17 21 17 13 7 13 7 21"></polyline>
                              <polyline points="7 3 7 8 15 8"></polyline>
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--peek-text-muted)', flexShrink: 0 }}>
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                          )}
                        </div>
                        <span className="peek-history-item-title" style={{ whiteSpace: 'pre-wrap', overflow: 'visible', textOverflow: 'clip', lineHeight: '1.4' }}>
                          {item.isSaveAction ? <><span style={{ color: 'var(--peek-text-muted)' }}>Save memory: </span>{item.content}</> : item.content}
                        </span>
                      </button>

                      {!item.isSaveAction && (
                        <div className="peek-history-item-actions" style={{ marginTop: 2 }}>
                          <div 
                            className="peek-history-action-btn"
                            title={item.isPinned ? "Unpin" : "Pin memory"}
                            onClick={(e) => handleTogglePin(e, item)}
                            style={{ color: item.isPinned ? '#e2b340' : 'inherit' }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill={item.isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                            </svg>
                          </div>
                          <div 
                            className="peek-history-action-btn"
                            title="Edit memory"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditContent(item.content);
                              setEditingId(item.id);
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9"></path>
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                            </svg>
                          </div>
                          <div 
                            className="peek-history-action-btn"
                            title="Delete memory"
                            onClick={(e) => handleDelete(e, item.id)}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6"></polyline>
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {!item.isSaveAction && !editingId && (
                    <div style={{ 
                      display: 'flex', 
                      gap: 12, 
                      paddingLeft: 22, 
                      fontSize: '10.5px', 
                      color: 'var(--peek-text-muted)',
                      opacity: 0.7 
                    }}>
                      {item.isPinned && <span style={{ color: '#e2b340' }}>Pinned</span>}
                      <span>{timeAgo(item.createdAt)}</span>
                      {item.usageCount > 0 && <span>Used {item.usageCount} time{item.usageCount !== 1 ? 's' : ''}</span>}
                      {item.lastUsedAt && <span>Active {timeAgo(item.lastUsedAt)}</span>}
                    </div>
                  )}
                </div>
              ))
            )}
            
            <AnimatePresence>
              {copiedText && (
                <motion.div
                  initial={{ opacity: 0, y: 10, x: '-50%' }}
                  animate={{ opacity: 1, y: 0, x: '-50%' }}
                  exit={{ opacity: 0, y: 10, x: '-50%' }}
                  style={{
                    position: 'absolute',
                    bottom: 12,
                    left: '50%',
                    backgroundColor: 'rgba(20, 20, 20, 0.95)',
                    border: '1px solid var(--peek-border)',
                    color: 'var(--peek-text)',
                    padding: '6px 14px',
                    borderRadius: '20px',
                    fontSize: '11px',
                    fontWeight: 500,
                    pointerEvents: 'none',
                    zIndex: 200,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                    backdropFilter: 'blur(4px)',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                  <span>Copied to clipboard!</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
