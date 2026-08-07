import React, { useRef, useEffect, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePeekStore } from '../store/peek';
import { registry } from '../lib/plugins/registry';
import type { PluginManifest, MenuItem, ContextFragment } from '../lib/plugins/types';

interface InputProps {
  onSubmit: () => void;
  onAttachImage?: (base64: string, mediaType: string) => void;
  onAttachFragment?: (fragment: ContextFragment) => void;
  onPasteReject?: (message: string) => void;
  onAbort?: () => void;
}

function firstSelectableIndex(items: MenuItem[]): number {
  const idx = items.findIndex((item) => item.kind !== 'group');
  return idx >= 0 ? idx : 0;
}

function nextSelectableIndex(items: MenuItem[], from: number, direction: 1 | -1): number {
  if (items.length === 0) return 0;
  let idx = from;
  for (let i = 0; i < items.length; i++) {
    idx = (idx + direction + items.length) % items.length;
    if (items[idx].kind !== 'group') return idx;
  }
  return from;
}

export const Input: React.FC<InputProps> = ({ onSubmit, onAttachImage, onAttachFragment, onPasteReject, onAbort }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { input, setInput, isStreaming, visible } = usePeekStore();

  const [slashState, setSlashState] = useState<{
    active: boolean;
    phase: 1 | 2;
    query: string;
    pluginId?: string;
    pluginQuery?: string;
    menuItems: MenuItem[];
    selectedIndex: number;
    manifests: PluginManifest[];
  }>({
    active: false,
    phase: 1,
    query: '',
    menuItems: [],
    selectedIndex: 0,
    manifests: []
  });

  // Ensure context plugin manifests are discovered for slash commands
  useEffect(() => {
    if (visible) {
      registry.discover().then(() => {
        // Re-sync phase-1 list if slash menu is already open with empty results
        setSlashState((s) => {
          if (!s.active || s.phase !== 1) return s;
          const ctxPlugins = registry.getContextPlugins();
          return {
            ...s,
            manifests: ctxPlugins.filter(
              (p) => !s.query || p.context?.command?.startsWith(s.query)
            ),
          };
        });
      });
    }
  }, [visible]);

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

  const enterPhase2 = useCallback((manifest: PluginManifest) => {
    if (!manifest.context) return;
    const command = manifest.context.command;
    setInput(`/${command} `);
    setSlashState({
      active: true,
      phase: 2,
      query: command,
      pluginId: manifest.plugin.id,
      pluginQuery: '',
      menuItems: [],
      selectedIndex: 0,
      manifests: registry.getContextPlugins(),
    });
    textareaRef.current?.focus();
  }, [setInput]);

  const resolveAndAttach = useCallback(async (pluginId: string, item: MenuItem) => {
    if (item.kind === 'group') return;
    const fragments = await registry.resolveContextPlugin(pluginId, item.id);
    if (onAttachFragment) {
      fragments.forEach((f) => onAttachFragment(f));
    }
    setInput('');
    setSlashState((s) => ({ ...s, active: false }));
    textareaRef.current?.focus();
  }, [onAttachFragment, setInput]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    if (val.startsWith('/')) {
      const match = val.match(/^\/([^\s]+)?(?:\s+(.*))?$/);
      const ctxPlugins = registry.getContextPlugins();

      if (match) {
        const cmdName = match[1] || '';
        const pluginQuery = match[2];
        const exactPlugin = ctxPlugins.find((p) => p.context?.command === cmdName);

        if (exactPlugin && pluginQuery !== undefined) {
          // Phase 2: query inside a selected plugin
          setSlashState((s) => ({
            ...s,
            active: true,
            phase: 2,
            query: cmdName,
            pluginId: exactPlugin.plugin.id,
            pluginQuery: pluginQuery,
            manifests: ctxPlugins,
          }));
        } else {
          // Phase 1: command discovery
          setSlashState((s) => ({
            ...s,
            active: true,
            phase: 1,
            query: cmdName,
            pluginId: undefined,
            pluginQuery: undefined,
            manifests: ctxPlugins.filter(
              (p) => !cmdName || p.context?.command?.startsWith(cmdName)
            ),
            selectedIndex: 0,
            menuItems: [],
          }));
        }
      } else {
        setSlashState((s) => ({
          ...s,
          active: true,
          phase: 1,
          query: '',
          manifests: ctxPlugins,
          selectedIndex: 0,
        }));
      }
    } else {
      setSlashState((s) => ({ ...s, active: false }));
    }
  };

  // Phase 2 Async search (debounced ~150ms)
  useEffect(() => {
    if (slashState.active && slashState.phase === 2 && slashState.pluginId) {
      let active = true;
      const timer = setTimeout(() => {
        registry.searchContextPlugin(slashState.pluginId!, slashState.pluginQuery || '').then((items) => {
          if (active) {
            setSlashState((s) => ({
              ...s,
              menuItems: items,
              selectedIndex: firstSelectableIndex(items),
            }));
          }
        });
      }, 150);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }
  }, [slashState.active, slashState.phase, slashState.pluginId, slashState.pluginQuery]);

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (slashState.active) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (slashState.phase === 1) {
          setSlashState((s) => ({
            ...s,
            selectedIndex: Math.min(s.selectedIndex + 1, Math.max(s.manifests.length - 1, 0)),
          }));
        } else {
          setSlashState((s) => ({
            ...s,
            selectedIndex: nextSelectableIndex(s.menuItems, s.selectedIndex, 1),
          }));
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (slashState.phase === 1) {
          setSlashState((s) => ({
            ...s,
            selectedIndex: Math.max(s.selectedIndex - 1, 0),
          }));
        } else {
          setSlashState((s) => ({
            ...s,
            selectedIndex: nextSelectableIndex(s.menuItems, s.selectedIndex, -1),
          }));
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashState((s) => ({ ...s, active: false }));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (slashState.phase === 1 && slashState.manifests.length > 0) {
          const selectedManifest = slashState.manifests[slashState.selectedIndex];
          if (selectedManifest) {
            enterPhase2(selectedManifest);
          }
        } else if (slashState.phase === 2 && slashState.menuItems.length > 0 && slashState.pluginId) {
          const selectedItem = slashState.menuItems[slashState.selectedIndex];
          if (selectedItem && selectedItem.kind !== 'group') {
            await resolveAndAttach(slashState.pluginId, selectedItem);
          }
        }
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (input.trim() && !isStreaming) {
        onSubmit();
      }
    }
  };

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    try {
      const base64 = await invoke<string>('read_clipboard_image');
      if (base64) {
        e.preventDefault();
        if (onAttachImage) {
          onAttachImage(base64, 'image/png');
        } else if (onPasteReject) {
          onPasteReject('Images are not supported by the active text-only model.');
        }
      }
    } catch (err) {
      console.log('No image in clipboard or failed to read:', err);
    }
  }, [onAttachImage, onPasteReject]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
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
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Ask anything..."
          rows={1}
          disabled={isStreaming}
          spellCheck={false}
          autoComplete="off"
        />
        {isStreaming && (
          <button className="peek-input-status" onClick={onAbort} title="Stop generating (Alt+Q)" aria-label="Stop generating">
            <div className="peek-stop-icon" />
          </button>
        )}
        {!isStreaming && input.trim() && !slashState.active && (
          <div className="peek-input-hint">
            <kbd>↵</kbd>
          </div>
        )}
      </div>

      {/* Shared Command Menu UI */}
      {slashState.active && (
        <div className="peek-slash-menu" role="listbox">
          {slashState.phase === 1 &&
            (slashState.manifests.length === 0 ? (
              <div className="peek-slash-empty">
                {registry.getContextPlugins().length === 0
                  ? 'No context plugins installed.'
                  : 'No matching command.'}
              </div>
            ) : (
              slashState.manifests.map((m, idx) => (
                <button
                  key={m.plugin.id}
                  type="button"
                  role="option"
                  aria-selected={idx === slashState.selectedIndex}
                  className="peek-slash-item"
                  onMouseEnter={() => setSlashState((s) => ({ ...s, selectedIndex: idx }))}
                  onClick={() => enterPhase2(m)}
                >
                  <span className="peek-slash-item-title">/{m.context?.command}</span>
                  {m.plugin.name && (
                    <span className="peek-slash-item-subtitle">{m.plugin.name}</span>
                  )}
                </button>
              ))
            ))}

          {slashState.phase === 2 &&
            (slashState.menuItems.length === 0 ? (
              <div className="peek-slash-empty">
                {slashState.pluginQuery ? 'Nothing found.' : 'Type to search.'}
              </div>
            ) : (
              slashState.menuItems.map((item, idx) => {
                if (item.kind === 'group') {
                  return (
                    <div key={item.id} className="peek-slash-group">
                      {item.title}
                    </div>
                  );
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={idx === slashState.selectedIndex}
                    className="peek-slash-item"
                    onMouseEnter={() => setSlashState((s) => ({ ...s, selectedIndex: idx }))}
                    onClick={() => {
                      if (slashState.pluginId) {
                        resolveAndAttach(slashState.pluginId, item);
                      }
                    }}
                  >
                    <span className="peek-slash-item-title">{item.title}</span>
                    {item.subtitle && (
                      <span className="peek-slash-item-subtitle">{item.subtitle}</span>
                    )}
                  </button>
                );
              })
            ))}
        </div>
      )}
    </div>
  );
};
