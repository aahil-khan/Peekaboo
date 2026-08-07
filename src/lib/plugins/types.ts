export interface PluginManifest {
  api_version: number;
  plugin: {
    id: string;
    name: string;
    version: string;
    type: 'input' | 'output' | 'model' | 'context';
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
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
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
