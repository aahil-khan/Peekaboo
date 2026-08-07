import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { registry } from '../lib/plugins/registry';
import type { PluginManifest } from '../lib/plugins/types';

interface PluginsState {
  enabledInputPlugins: string[];
  enabledOutputPlugins: string[];
  manifests: PluginManifest[];
  /** Discovered but refused for an unsupported api_version. Display only. */
  incompatible: PluginManifest[];

  // Actions
  toggleInputPlugin: (id: string, enabled: boolean) => void;
  toggleOutputPlugin: (id: string, enabled: boolean) => void;
  refreshManifests: () => Promise<void>;
}

export const usePluginsStore = create<PluginsState>()(
  persist(
    (set) => ({
      enabledInputPlugins: [],
      enabledOutputPlugins: [],
      manifests: [],
      incompatible: [],

      toggleInputPlugin: (id, enabled) => {
        set((state) => ({
          enabledInputPlugins: enabled
            ? [...state.enabledInputPlugins.filter((x) => x !== id), id]
            : state.enabledInputPlugins.filter((x) => x !== id)
        }));
      },

      toggleOutputPlugin: (id, enabled) => {
        set((state) => ({
          enabledOutputPlugins: enabled
            ? [...state.enabledOutputPlugins.filter((x) => x !== id), id]
            : state.enabledOutputPlugins.filter((x) => x !== id)
        }));
      },

      refreshManifests: async () => {
        await registry.discover(true);
        set({
          manifests: registry.getManifests(),
          incompatible: registry.getIncompatible(),
        });
      }
    }),
    {
      name: 'peekaboo-plugins-config',
      partialize: (state) => ({
        enabledInputPlugins: state.enabledInputPlugins,
        enabledOutputPlugins: state.enabledOutputPlugins,
      })
    }
  )
);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'peekaboo-plugins-config' || e.key === null) {
      usePluginsStore.persist.rehydrate();
    }
  });
}

