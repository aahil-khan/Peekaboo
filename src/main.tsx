import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';

import './index.css';
import { PeekSurface } from './components/PeekSurface';
import { Settings } from './components/Settings';
import { Setup } from './components/Setup';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from './store/settings';

const App: React.FC = () => {
  const [windowLabel, setWindowLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      const appWindow = getCurrentWebviewWindow();
      console.log('[peekaboo] window label:', appWindow.label);
      setWindowLabel(appWindow.label);
    } catch (e) {
      console.warn('[peekaboo] label detection failed, defaulting to peekaboo:', e);
      setWindowLabel('peekaboo');
    }
  }, []);

  // ── Sync Settings to Rust Backend ──
  React.useEffect(() => {
    if (windowLabel !== 'peekaboo') return;

    const sync = async () => {
      try {
        const { autoCaptureSelection, setupCompleted } = useSettingsStore.getState();
        await invoke('update_settings', {
          settings: {
            auto_capture_selection: autoCaptureSelection,
            setup_completed: setupCompleted,
          }
        });
      } catch (err) {
        console.error('Failed to sync initial settings to Rust:', err);
      }
    };
    sync();

    // Subscribe to future settings changes
    const unsubscribe = useSettingsStore.subscribe((state) => {
      invoke('update_settings', {
        settings: {
          auto_capture_selection: state.autoCaptureSelection,
          setup_completed: state.setupCompleted,
        }
      }).catch(err => console.error('Failed to sync settings to Rust:', err));
    });

    return () => unsubscribe();
  }, [windowLabel]);

  if (!windowLabel) return null;

  if (windowLabel !== 'peekaboo') {
    document.body.style.background = '#18181b';
    document.documentElement.style.background = '#18181b';
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'auto';
  } else {
    // Clip the WebView2 painted area to rounded corners so DWM composites
    // the transparent window correctly — removes the rectangular window edge mismatch.
    document.documentElement.style.borderRadius = '16px';
  }

  if (windowLabel === 'settings') return <Settings />;
  if (windowLabel === 'setup') return <Setup />;
  return <PeekSurface />;
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
