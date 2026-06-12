import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore, LlamaProfile, DEFAULT_LLAMA_PROFILE } from '../store/settings';

interface Props {
  profile?: LlamaProfile;
  onSave?: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}

export const LlamaProfileEditor: React.FC<Props> = ({ profile, onSave, onCancel, cancelLabel = 'Cancel' }) => {
  const { addLlamaProfile, updateLlamaProfile, setActiveLlamaProfileId, llamaProfiles } = useSettingsStore();

  const isNew = !profile;
  const [form, setForm] = useState<Omit<LlamaProfile, 'id'>>({
    name: profile?.name ?? '',
    binaryPath: profile?.binaryPath ?? '',
    modelPath: profile?.modelPath ?? '',
    ...DEFAULT_LLAMA_PROFILE,
    ...(profile ?? {}),
  });

  const set = (key: keyof typeof form, value: any) =>
    setForm((f) => ({ ...f, [key]: value }));

  const pickFile = async (key: 'binaryPath' | 'modelPath' | 'mmprojPath', title: string, filterName: string, extensions: string[]) => {
    try {
      const path = await invoke<string | null>('pick_file', { title, filterName, extensions });
      if (path) set(key, path);
    } catch (e) {
      console.error('pick_file error', e);
    }
  };

  const handleSave = () => {
    if (!form.name.trim() || !form.binaryPath || !form.modelPath) return;
    if (isNew) {
      const id = crypto.randomUUID();
      const newProfile: LlamaProfile = { id, ...form };
      addLlamaProfile(newProfile);
      if (llamaProfiles.length === 0) {
        setActiveLlamaProfileId(id);
      }
    } else {
      updateLlamaProfile({ id: profile!.id, ...form });
    }
    onSave?.();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Profile Name" hint="e.g. gemma4 E4B, qwen2.5 14B">
        <input
          type="text"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="My Model"
          style={inputStyle}
        />
      </Field>

      <Field label="llama.cpp Binary" hint="llama-cli.exe or llama-server.exe">
        <FileRow
          value={form.binaryPath}
          onChange={(v) => set('binaryPath', v)}
          onBrowse={() => pickFile('binaryPath', 'Select llama binary', 'Executable', ['exe', ''])}
          placeholder="C:\path\to\llama-cli.exe"
        />
      </Field>

      <Field label="GGUF Model File">
        <FileRow
          value={form.modelPath}
          onChange={(v) => set('modelPath', v)}
          onBrowse={() => pickFile('modelPath', 'Select GGUF model', 'GGUF Model', ['gguf'])}
          placeholder="D:\models\model.gguf"
        />
      </Field>

      <Field label="mmproj File" hint="Optional — for vision/multimodal models">
        <FileRow
          value={form.mmprojPath}
          onChange={(v) => set('mmprojPath', v)}
          onBrowse={() => pickFile('mmprojPath', 'Select mmproj file', 'GGUF Model', ['gguf'])}
          placeholder="Optional — leave blank for text-only"
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Context Size (-c)">
          <input type="number" value={form.contextSize} onChange={(e) => set('contextSize', parseInt(e.target.value) || 0)} style={inputStyle} />
        </Field>
        <Field label="GPU Layers (-ngl)">
          <input type="number" value={form.nGpuLayers} onChange={(e) => set('nGpuLayers', parseInt(e.target.value) || 0)} style={inputStyle} />
        </Field>
        <Field label="Batch Size (-b)">
          <input type="number" value={form.batchSize} onChange={(e) => set('batchSize', parseInt(e.target.value) || 0)} style={inputStyle} />
        </Field>
        <Field label="Ubatch Size (-ub)">
          <input type="number" value={form.ubatchSize} onChange={(e) => set('ubatchSize', parseInt(e.target.value) || 0)} style={inputStyle} />
        </Field>
        <Field label="Parallel Slots">
          <input type="number" value={form.parallel} onChange={(e) => set('parallel', parseInt(e.target.value) || 1)} style={inputStyle} />
        </Field>
        <Field label="Temperature">
          <input type="number" step="0.1" value={form.temperature} onChange={(e) => set('temperature', parseFloat(e.target.value) || 0)} style={inputStyle} />
        </Field>
        <Field label="Host">
          <input type="text" value={form.host} onChange={(e) => set('host', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Port">
          <input type="number" value={form.port} onChange={(e) => set('port', parseInt(e.target.value) || 8080)} style={inputStyle} />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
          <ToggleSwitch checked={form.flashAttn} onChange={(v) => set('flashAttn', v)} />
          Flash Attention
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
        {onCancel && (
          <button onClick={onCancel} style={secondaryBtnStyle}>{cancelLabel}</button>
        )}
        <button
          onClick={handleSave}
          disabled={!form.name.trim() || !form.binaryPath || !form.modelPath}
          style={{
            ...primaryBtnStyle,
            opacity: (!form.name.trim() || !form.binaryPath || !form.modelPath) ? 0.5 : 1,
          }}
        >
          {isNew ? 'Add Profile' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <label style={{ fontSize: 13, color: 'var(--peek-text-secondary)' }}>{label}</label>
      {hint && <span style={{ fontSize: 11, color: 'var(--peek-text-muted)' }}>{hint}</span>}
    </div>
    {children}
  </div>
);

const FileRow: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
  placeholder?: string;
}> = ({ value, onChange, onBrowse, placeholder }) => (
  <div style={{ display: 'flex', gap: 8 }}>
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ ...inputStyle, flex: 1 }}
    />
    <button onClick={onBrowse} style={browseStyle}>Browse</button>
  </div>
);

const ToggleSwitch: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <button
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    style={{
      width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
      backgroundColor: checked ? '#4caf50' : 'rgba(255,255,255,0.15)',
      position: 'relative', transition: 'background-color 0.15s', flexShrink: 0,
    }}
  >
    <div style={{
      width: 16, height: 16, borderRadius: '50%', backgroundColor: '#fff',
      position: 'absolute', top: 2, left: checked ? 18 : 2,
      transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    }} />
  </button>
);

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.2)',
  border: '1px solid var(--peek-border)',
  color: 'var(--peek-text)',
  padding: '7px 10px',
  borderRadius: 6,
  fontSize: 13,
  outline: 'none',
  fontFamily: 'var(--peek-font-mono)',
  width: '100%',
  boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: '9px 0',
  background: '#4caf50',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--peek-font)',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '9px 20px',
  background: 'rgba(255,255,255,0.05)',
  color: 'var(--peek-text)',
  border: '1px solid var(--peek-border)',
  borderRadius: 6,
  fontSize: 14,
  cursor: 'pointer',
  fontFamily: 'var(--peek-font)',
};

const browseStyle: React.CSSProperties = {
  padding: '7px 12px',
  background: 'rgba(255,255,255,0.06)',
  color: 'var(--peek-text-secondary)',
  border: '1px solid var(--peek-border)',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'var(--peek-font)',
  whiteSpace: 'nowrap',
};
