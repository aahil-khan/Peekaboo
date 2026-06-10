import { useEffect } from 'react';
import { usePeekStore } from '../store/peek';
import { useHistoryStore } from '../store/history';
import { useSettingsStore } from '../store/settings';

type KeyHandler = (e: KeyboardEvent) => void;

interface ShortcutHandlers {
  onSubmit: () => void;
  onClear: () => void;
  onEscape: () => void;
  onStop: () => void;
}

export function useShortcuts(handlers: ShortcutHandlers) {
  const { visible } = usePeekStore();

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown: KeyHandler = (e) => {
      const isMod = e.altKey;

      // Enter → Submit (without Shift or Alt)
      if (e.key === 'Enter' && !e.shiftKey && !isMod) {
        e.preventDefault();
        handlers.onSubmit();
        return;
      }

      // Escape → Dismiss
      if (e.key === 'Escape') {
        e.preventDefault();
        handlers.onEscape();
        return;
      }

      // Alt+K → Clear conversation
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.onClear();
        return;
      }

      // Alt+Q → Stop streaming
      if (isMod && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        handlers.onStop();
        return;
      }

      // Alt+H → Toggle history
      if (isMod && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        const opening = !useHistoryStore.getState().isOpen;
        useHistoryStore.getState().setOpen(opening);
        if (opening) {
          useSettingsStore.getState().setModelsOpen(false);
          usePeekStore.getState().setLegendOpen(false);
          usePeekStore.getState().setMemoryOverlay({ isOpen: false });
        }
        return;
      }

      // Alt+R → Toggle memory overlay
      if (isMod && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        const opening = !usePeekStore.getState().memoryOverlay.isOpen;
        
        if (opening) {
          useHistoryStore.getState().setOpen(false);
          useSettingsStore.getState().setModelsOpen(false);
          usePeekStore.getState().setLegendOpen(false);
          
          const selectedText = window.getSelection()?.toString().trim();
          
          usePeekStore.getState().setMemoryOverlay({ 
            isOpen: true, 
            title: selectedText ? 'Remember Selection' : 'Recent Memories', 
            initialSearchQuery: selectedText || undefined,
            items: [] 
          });
          
          // Dynamically import database module to avoid circular dependency issues
          import('../db/database').then(({ searchMemories }) => {
            searchMemories('').then(memories => {
              // Check if it's still open before setting
              if (usePeekStore.getState().memoryOverlay.isOpen) {
                usePeekStore.getState().setMemoryOverlay({ items: memories });
              }
            });
          });
        } else {
          usePeekStore.getState().setMemoryOverlay({ isOpen: false });
        }
        return;
      }

      // Alt+M → Toggle models
      if (isMod && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        const opening = !useSettingsStore.getState().isModelsOpen;
        useSettingsStore.getState().setModelsOpen(opening);
        if (opening) {
          useHistoryStore.getState().setOpen(false);
          usePeekStore.getState().setLegendOpen(false);
          usePeekStore.getState().setMemoryOverlay({ isOpen: false });
        }
        return;
      }

      // Alt+, → Open settings
      if (isMod && e.key === ',') {
        e.preventDefault();
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('open_settings');
        });
        return;
      }

      // Alt+/ → Toggle legend
      if (isMod && e.key === '/') {
        e.preventDefault();
        const opening = !usePeekStore.getState().isLegendOpen;
        usePeekStore.getState().setLegendOpen(opening);
        if (opening) {
          useHistoryStore.getState().setOpen(false);
          useSettingsStore.getState().setModelsOpen(false);
          usePeekStore.getState().setMemoryOverlay({ isOpen: false });
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, handlers]);
}
