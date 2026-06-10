import React, { useRef, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../store/settings';
import { usePeekStore } from '../store/peek';
import { OllamaProvider } from '../providers/ollama';
import { motion, AnimatePresence } from 'framer-motion';

interface InputProps {
  onSubmit: () => void;
  onAttachImage?: (base64: string, mediaType: string) => void;
  onAbort?: () => void;
}

export const Input: React.FC<InputProps> = ({ onSubmit, onAttachImage, onAbort }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { input, setInput, isStreaming, visible } = usePeekStore();
  const { activeModel, isModelsOpen, setModelsOpen } = useSettingsStore();

  // Auto-focus when overlay becomes visible
  useEffect(() => {
    if (visible && textareaRef.current) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 96;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [input, adjustHeight]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (input.trim() && !isStreaming) {
        onSubmit();
      }
    }
  };

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAttachImage) return;
    
    try {
      const base64 = await invoke<string>('read_clipboard_image');
      if (base64) {
        e.preventDefault();
        onAttachImage(base64, 'image/png');
      }
    } catch (err) {
      console.log('No image in clipboard or failed to read:', err);
    }
  }, [onAttachImage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="peek-input-container">
        <div className="peek-input-icon">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </div>
        <textarea
          ref={textareaRef}
          className="peek-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Ask anything..."
          rows={1}
          disabled={isStreaming}
          spellCheck={false}
          autoComplete="off"
        />
        {isStreaming && (
          <button className="peek-input-status" onClick={onAbort} style={{ background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none' }} title="Stop generation">
            <div className="peek-stop-icon" style={{ width: 12, height: 12, background: 'currentColor', borderRadius: 2 }} />
          </button>
        )}
        {!isStreaming && input.trim() && (
          <div className="peek-input-hint">
            <kbd>↵</kbd>
          </div>
        )}
      </div>


    </div>
  );
};
