export interface PluginManifest {
  api_version: number;
  plugin: {
    id: string;
    name: string;
    version: string;
    type: 'input' | 'output' | 'model' | 'context';
    /** Set by the backend: true for a plugin compiled into the app. */
    builtin?: boolean;
    /** Set by the backend when api_version is one this build cannot honour. */
    unsupported?: boolean;
    /** Why it was rejected. Shown in Settings; present with `unsupported`. */
    error?: string;
  };
  context?: {
    command: string;
  };
  settings?: Record<string, any>;
}

export interface ContextFragment {
  id: string;
  type: string;
  content: string;
  label?: string;
  metadata?: Record<string, any>;
}

export interface MenuItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  kind?: 'item' | 'group';
}

export interface SystemInfo {
  cpu: {
    usage: number;
    cores: number;
    brand: string;
    /** null where the platform has no load average (Windows). */
    load_average: [number, number, number] | null;
  };
  memory: { total: number; used: number; swap_total: number; swap_used: number };
  disks: { mount_point: string; file_system: string; total: number; available: number }[];
}

export interface FileMatch {
  path: string;
  name: string;
}

export interface LoadedFile {
  /** 'image/png', 'text/plain', … — pass straight through as a fragment type. */
  media_type: string;
  encoding: 'utf8' | 'base64';
  content: string;
  truncated: boolean;
  /** Present when the text was derived rather than read, e.g. 'pdf'. */
  extracted_from?: string;
}

export interface PluginContext {
  pluginId: string;
  settings: Record<string, any>;
  logger: {
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
    warn: (...args: any[]) => void;
  };
  getSelection: () => Promise<string>;
  getClipboard: () => Promise<string>;
  writeClipboard: (text: string) => Promise<void>;
  getActiveWindow: () => Promise<{ title: string; app: string }>;
  captureRegion: () => Promise<string>;
  typeText: (text: string) => Promise<void>;
  notify: (title: string, body: string) => Promise<void>;
  getSystemInfo: () => Promise<SystemInfo>;
  /** Filename search under $HOME. Hidden paths are never returned. */
  searchFiles: (query: string) => Promise<FileMatch[]>;
  /**
   * Read a UTF-8 file. Restricted to $HOME excluding dot-paths, plus this
   * plugin's own data directory; rejects on anything else.
   */
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  /**
   * Load a file for attachment, choosing its representation by type: images
   * base64-encoded for vision models, PDFs as extracted text, everything else
   * as UTF-8. Rejects with a human-readable reason for formats it cannot
   * handle, so a plugin can say why rather than fail silently.
   */
  loadFile: (path: string) => Promise<LoadedFile>;
}

export interface InputPluginModule {
  type: 'input';
  run: (context: PluginContext) => Promise<ContextFragment | null>;
}

export interface OutputPluginModule {
  type: 'output';
  run: (context: PluginContext, result: string) => Promise<void>;
}

export interface ContextPluginModule {
  type: 'context';
  search: (query: string, context: PluginContext) => Promise<MenuItem[]>;
  resolve: (itemId: string, context: PluginContext) => Promise<ContextFragment[]>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | any[]; // keeping it flexible for multimodal
}

export interface ModelOptions {
  temperature?: number;
  [key: string]: any;
}

export interface ModelPluginModule {
  type: 'model';
  stream: (messages: ChatMessage[], options?: ModelOptions) => AsyncGenerator<string>;
}

export type PluginModule = InputPluginModule | OutputPluginModule | ContextPluginModule | ModelPluginModule;

export interface RegisteredPlugin {
  manifest: PluginManifest;
  module?: PluginModule;
  loaded: boolean;
  error?: string;
}
