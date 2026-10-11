import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { PluginManifest, RegisteredPlugin, PluginContext, ContextFragment, ModelPluginModule, MenuItem, ContextPluginModule, SystemInfo, FileMatch, LoadedFile } from './types';

/** Must match SCHEME in src-tauri/src/plugins/protocol.rs and script-src in tauri.conf.json. */
const PLUGIN_SCHEME = 'peekaboo-plugin';

export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private incompatible: PluginManifest[] = [];
  private manifestsLoaded = false;

  async discover(force = false) {
    if (this.manifestsLoaded && !force) return;
    if (force) {
      this.plugins.clear();
      this.incompatible = [];
    }
    try {
      const manifests = await invoke<PluginManifest[]>('discover_plugins');
      for (const manifest of manifests) {
        if (!manifest.plugin || !manifest.plugin.id || !manifest.plugin.type) continue;

        // Held aside rather than registered: it must not appear in the / menu
        // or run on the send path, but Settings still shows it with the reason
        // so an incompatible plugin does not simply vanish.
        if (manifest.plugin.unsupported) {
          this.incompatible.push(manifest);
          continue;
        }

        this.plugins.set(manifest.plugin.id, {
          manifest,
          loaded: false
        });
      }
      this.manifestsLoaded = true;
    } catch (err) {
      console.warn('Failed to discover plugins:', err);
    }
  }

  getManifests(): PluginManifest[] {
    return Array.from(this.plugins.values()).map(p => p.manifest);
  }

  /** Discovered but refused — wrong plugin API version. Display only. */
  getIncompatible(): PluginManifest[] {
    return [...this.incompatible];
  }

  async loadPlugin(id: string): Promise<void> {
    const p = this.plugins.get(id);
    if (!p) return;
    if (p.loaded || p.error) return;

    try {
      // Plugin code is served by the app over its own URI scheme (see
      // src-tauri/src/plugins/protocol.rs) and imported as an ES module. It
      // is not passed through a data: or blob: URL: the Content Security
      // Policy refuses data: scripts in a built app, and blob: modules crash
      // WebKitGTK. convertFileSrc spells the URL the way this platform's
      // webview expects. The query string makes each load a distinct module,
      // so a plugin edited on disk is picked up by a rediscovery instead of
      // being answered from the page's module map.
      const url = `${convertFileSrc(id, PLUGIN_SCHEME)}?v=${Date.now()}`;

      let module;
      try {
        module = await import(/* @vite-ignore */ url);
      } catch (importError) {
        // import() reports a missing file, a syntax error and a refused
        // request identically. Ask the backend whether the file is the
        // problem, so the message is one a plugin author can act on.
        await invoke('check_plugin_js', { pluginId: id });
        throw importError;
      }
      if (!module?.default || typeof module.default !== 'object') {
        throw new Error('Plugin does not default export a valid object');
      }
      p.module = module.default;
      p.loaded = true;
    } catch (err) {
      p.error = String(err);
      console.warn(`Failed to load plugin ${id}:`, err);
    }
  }

  private createContext(manifest: PluginManifest): PluginContext {
    return {
      pluginId: manifest.plugin.id,
      settings: manifest.settings || {},
      logger: {
        info: (...args) => console.log(`[Plugin:${manifest.plugin.id}]`, ...args),
        warn: (...args) => console.warn(`[Plugin:${manifest.plugin.id}]`, ...args),
        error: (...args) => console.error(`[Plugin:${manifest.plugin.id}]`, ...args),
      },
      getSelection: async () => invoke<string>('plugin_get_selection').catch(() => ''),
      // Not navigator.clipboard: WebKitGTK rejects reads outside a user
      // gesture, so a plugin asking for the clipboard from search() always got
      // a NotAllowedError. The Tauri plugin talks to the system clipboard
      // directly and has no such restriction.
      getClipboard: async () => readText(),
      writeClipboard: async (text: string) => writeText(text),
      getActiveWindow: async () => invoke<{ title: string; app: string }>('get_active_window'),
      captureRegion: async () => invoke<string>('capture_region'),
      typeText: async (text: string) => invoke<void>('type_text', { text }),
      notify: async (title: string, body: string) => invoke<void>('show_notification', { title, body }),
      getSystemInfo: async () => invoke<SystemInfo>('plugin_system_info'),
      searchFiles: async (query: string) => invoke<FileMatch[]>('plugin_search_files', { query }),
      // The plugin id is passed rather than trusted from the caller so the
      // backend can scope filesystem access per plugin — a plugin cannot name
      // someone else's data directory.
      readFile: async (path: string) =>
        invoke<string>('plugin_read_file', { pluginId: manifest.plugin.id, path }),
      writeFile: async (path: string, text: string) =>
        invoke<void>('plugin_write_file', { pluginId: manifest.plugin.id, path, text }),
      loadFile: async (path: string) =>
        invoke<LoadedFile>('plugin_load_file', { pluginId: manifest.plugin.id, path }),
    };
  }

  async runInputPlugins(enabledIds: string[]): Promise<ContextFragment[]> {
    const promises = enabledIds.map(async (id) => {
      let p = this.plugins.get(id);
      if (!p) {
        await this.discover(true);
        p = this.plugins.get(id);
      }
      if (!p || p.manifest.plugin.type !== 'input') return null;
      
      await this.loadPlugin(id);
      if (!p.module || p.module.type !== 'input') return null;

      try {
        const ctx = this.createContext(p.manifest);
        // Timeout 200ms
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 200));
        const result = await Promise.race([
          p.module.run(ctx),
          timeout
        ]);
        return result;
      } catch (err) {
        console.warn(`Input plugin ${id} failed:`, err);
        return null;
      }
    });

    const results = await Promise.all(promises);
    return results.filter((r): r is ContextFragment => r !== null && r !== undefined);
  }

  async runOutputPlugins(enabledIds: string[], output: string): Promise<void> {
    const promises = enabledIds.map(async (id) => {
      let p = this.plugins.get(id);
      if (!p) {
        await this.discover(true);
        p = this.plugins.get(id);
      }
      if (!p || p.manifest.plugin.type !== 'output') return;

      await this.loadPlugin(id);
      if (!p.module || p.module.type !== 'output') return;

      try {
        const ctx = this.createContext(p.manifest);
        // Timeout 2s
        const timeout = new Promise<void>((resolve) => setTimeout(() => resolve(), 2000));
        await Promise.race([
          p.module.run(ctx, output),
          timeout
        ]);
      } catch (err) {
        console.warn(`Output plugin ${id} failed:`, err);
      }
    });

    await Promise.all(promises);
  }

  async getModelPlugin(id: string): Promise<ModelPluginModule | null> {
    let p = this.plugins.get(id);
    if (!p) {
      await this.discover(true);
      p = this.plugins.get(id);
    }
    if (!p || p.manifest.plugin.type !== 'model') return null;
    
    await this.loadPlugin(id);
    if (!p.module || p.module.type !== 'model') return null;
    return p.module as ModelPluginModule;
  }

  getContextPlugins(): PluginManifest[] {
    return this.getManifests().filter(m => m.plugin.type === 'context');
  }

  async searchContextPlugin(id: string, query: string): Promise<MenuItem[]> {
    let p = this.plugins.get(id);
    if (!p) {
      await this.discover(true);
      p = this.plugins.get(id);
    }
    if (!p || p.manifest.plugin.type !== 'context') return [];
    
    await this.loadPlugin(id);
    if (!p.module || p.module.type !== 'context') return [];

    try {
      const ctx = this.createContext(p.manifest);
      const timeout = new Promise<MenuItem[]>((resolve) => setTimeout(() => resolve([]), 800));
      return await Promise.race([
        (p.module as ContextPluginModule).search(query, ctx).catch(() => []),
        timeout
      ]);
    } catch (err) {
      console.warn(`Context plugin ${id} search failed:`, err);
      return [];
    }
  }

  async resolveContextPlugin(id: string, itemId: string): Promise<ContextFragment[]> {
    let p = this.plugins.get(id);
    if (!p) {
      await this.discover(true);
      p = this.plugins.get(id);
    }
    if (!p || p.manifest.plugin.type !== 'context') return [];
    
    await this.loadPlugin(id);
    if (!p.module || p.module.type !== 'context') return [];

    try {
      const ctx = this.createContext(p.manifest);
      const timeout = new Promise<ContextFragment[]>((resolve) => setTimeout(() => resolve([]), 2000));
      return await Promise.race([
        (p.module as ContextPluginModule).resolve(itemId, ctx).catch(() => []),
        timeout
      ]);
    } catch (err) {
      console.warn(`Context plugin ${id} resolve failed:`, err);
      return [];
    }
  }
}

export const registry = new PluginRegistry();
