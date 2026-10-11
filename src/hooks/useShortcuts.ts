import { useEffect } from 'react';
import { usePeekStore } from '../store/peek';
import { togglePanel } from './usePanels';
import { isQuitChord } from '../lib/hotkey';

type KeyHandler = (e: KeyboardEvent) => void;

interface ShortcutHandlers {
  onSubmit: () => void;
  onClear: () => void;
  onEscape: () => void;
  onStop: () => void;
  onCaptureRegion: () => void;
  onCopyLast: () => void;
  onQuit: () => void;
  onActions: () => void;
}

export function useShortcuts(handlers: ShortcutHandlers) {
  const { visible } = usePeekStore();
  const { onSubmit, onClear, onEscape, onStop, onCaptureRegion, onCopyLast, onQuit, onActions } = handlers;

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown: KeyHandler = (e) => {
      // React's delegated listener sits on the root container, so a key already
      // handled by a child (Input's Enter, the slash menu's Enter/Escape) still
      // bubbles to window and would fire the global binding a second time.
      // preventDefault() alone does not stop that — check for it explicitly.
      if (e.defaultPrevented) return;

      const isMod = e.altKey;

      // Enter → Submit (without Shift or Alt)
      if (e.key === 'Enter' && !e.shiftKey && !isMod) {
        e.preventDefault();
        onSubmit();
        return;
      }

      // Escape → Dismiss
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
      }

      // Ctrl+Q (⌘Q on a Mac) → quit, for desktops with no tray to quit from.
      if (isQuitChord(e)) {
        e.preventDefault();
        onQuit();
        return;
      }

      if (!isMod) return;

      switch (e.key.toLowerCase()) {
        case 'n': // New chat
          e.preventDefault();
          onClear();
          return;
        case 'q': // Stop streaming
          e.preventDefault();
          onStop();
          return;
        case 's': // Capture a screen region into the conversation
          e.preventDefault();
          onCaptureRegion();
          return;
        case 'c': // Copy the last answer
          e.preventDefault();
          onCopyLast();
          return;
        case 'a': // Actions palette: act on the selected or copied text
          e.preventDefault();
          onActions();
          return;
        case 'h':
          e.preventDefault();
          togglePanel('history');
          return;
        case 'r':
          e.preventDefault();
          togglePanel('memory');
          return;
        case 'm':
          e.preventDefault();
          togglePanel('models');
          return;
        case ',':
          e.preventDefault();
          import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_settings'));
          return;
        case '/':
          e.preventDefault();
          togglePanel('legend');
          return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, onSubmit, onClear, onEscape, onStop, onCaptureRegion, onCopyLast, onQuit, onActions]);
}
