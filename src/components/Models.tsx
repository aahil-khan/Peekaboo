import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettingsStore } from '../store/settings';
import { historyVariants } from '../lib/motion';
import { OllamaProvider } from '../providers/ollama';
import { LlamaProvider } from '../providers/llama';
import { ModelInfo } from '../providers/types';

export const Models: React.FC = () => {
  const { activeModel, setActiveModel, isModelsOpen, setModelsOpen, activeProvider, ollamaBaseUrl, llamaBaseUrl } = useSettingsStore();
  const [availableModels, setAvailableModels] = React.useState<ModelInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [isSearchVisible, setIsSearchVisible] = React.useState(false);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const filteredModels = availableModels.filter(m => 
    m.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Fetch models when opened
  React.useEffect(() => {
    if (isModelsOpen) {
      const provider = activeProvider === 'llama' ? new LlamaProvider(llamaBaseUrl) : new OllamaProvider(ollamaBaseUrl);
      provider.models().then(setAvailableModels);
    }
  }, [isModelsOpen, activeProvider, ollamaBaseUrl, llamaBaseUrl]);

  // Reset selection when opened
  React.useEffect(() => {
    if (isModelsOpen) {
      setSelectedIndex(0);
      setSearchQuery('');
      setIsSearchVisible(false);
    }
  }, [isModelsOpen]);

  // Focus search input when it becomes visible
  React.useEffect(() => {
    if (isModelsOpen && isSearchVisible && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isModelsOpen, isSearchVisible]);

  // Scroll active item into view
  React.useEffect(() => {
    if (!scrollContainerRef.current) return;
    const activeEl = scrollContainerRef.current.children[selectedIndex] as HTMLElement;
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  React.useEffect(() => {
    if (!isModelsOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      
      // Auto-show search on typing
      if (!isSearchVisible && e.key.length === 1 && availableModels.length > 0) {
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
          setModelsOpen(false);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredModels.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (filteredModels.length > 0) {
          setActiveModel(filteredModels[selectedIndex].name);
          setModelsOpen(false);
        }
      }
    };
    // Use capturing phase so it runs before generic app escape handlers
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isModelsOpen, setModelsOpen, filteredModels, selectedIndex, setActiveModel, isSearchVisible, searchQuery, availableModels.length]);

  return (
    <AnimatePresence>
      {isModelsOpen && (
        <motion.div
          className="peek-history" // Reusing the history CSS class for consistent styling
          variants={historyVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <div className="peek-history-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="peek-history-title">Models</span>
            </div>
            <button
              onClick={() => setModelsOpen(false)}
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
            {isSearchVisible && availableModels.length > 0 && (
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
                  placeholder="Search models..." 
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.altKey || e.ctrlKey || e.metaKey) return;
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Escape') {
                      e.stopPropagation();
                    }
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="peek-history-list" ref={scrollContainerRef}>
            {filteredModels.length === 0 ? (
              <div className="peek-history-empty">
                {searchQuery ? 'No matching models' : 'No models available'}
              </div>
            ) : (
              filteredModels.map((model, idx) => (
                <button
                  key={model.name}
                  className="peek-history-item"
                  style={{
                    background: idx === selectedIndex ? 'var(--peek-hover)' : 'transparent',
                    display: 'flex',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                  }}
                  onClick={() => {
                    setActiveModel(model.name);
                    setModelsOpen(false);
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span className="peek-history-item-title" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {model.name}
                      {model.isVision ? (
                        <span style={{ fontSize: 10, padding: '2px 4px', background: 'rgba(76, 175, 80, 0.15)', color: '#4caf50', borderRadius: 4 }}>Vision</span>
                      ) : (
                        <span style={{ fontSize: 10, padding: '2px 4px', background: 'rgba(150, 150, 150, 0.15)', color: '#9e9e9e', borderRadius: 4 }}>Text</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--peek-text-muted)', marginTop: 4, display: 'flex', gap: 8, fontWeight: 'normal' }}>
                      {model.parameterSize && <span>{model.parameterSize}</span>}
                      {model.quantization && <span>{model.quantization}</span>}
                    </div>
                  </span>
                  {activeModel === model.name && <span style={{ fontSize: 12, color: '#4caf50' }}>Active</span>}
                </button>
              ))
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
