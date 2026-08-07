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
import { windowKind } from './lib/windowLabel';
import { initThemeRuntime } from './lib/theme';

import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from './store/settings';
import { usePluginsStore } from './store/plugins';

// Module scope, not a component effect: this must survive StrictMode's
// double-mount, and it applies to every window equally.
initThemeRuntime();

const App: React.FC = () => {
  // ── Background Plugin Discovery ──
  React.useEffect(() => {
    if (windowKind !== 'peek') return;
    usePluginsStore.getState().refreshManifests().catch(err => {
      console.warn('Failed to discover plugins on startup:', err);
    });
  }, []);

  // ── Sync Settings to Rust Backend ──
  React.useEffect(() => {
    if (windowKind !== 'peek') return;

    const sync = async () => {
      try {
        const { setupCompleted } = useSettingsStore.getState();
        await invoke('update_settings', {
          settings: {
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
          setup_completed: state.setupCompleted,
        }
      }).catch(err => console.error('Failed to sync settings to Rust:', err));
    });

    return () => unsubscribe();
  }, []);

  // Window backgrounds and the overlay's corner clipping are handled in CSS via
  // the data-window attribute that index.html stamps before first paint.
  if (windowKind === 'settings') return <Settings />;
  if (windowKind === 'setup') return <Setup />;
  return <PeekSurface />;
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
