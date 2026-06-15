// Provider interface — thin abstraction for future multi-provider support

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentPart[];
  model?: string;
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string }; // base64 data URI
}


export interface ModelInfo {
  name: string;
  isVision: boolean;
  parameterSize?: string;
  family?: string;
  quantization?: string;
}

export interface Provider {
  id: string;
  name: string;
  models: () => Promise<ModelInfo[]>;
  isAvailable: () => Promise<boolean>;
  stream: (messages: Message[], model: string, signal?: AbortSignal) => AsyncGenerator<string>;
}
