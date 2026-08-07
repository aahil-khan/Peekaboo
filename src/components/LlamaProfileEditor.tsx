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

  // Named so the button can say what is missing rather than just sitting dimmed.
  const missing = [
    !form.name.trim() && 'a name',
    !form.binaryPath && 'the server binary',
    !form.modelPath && 'a model file',
  ].filter(Boolean) as string[];

  const handleSave = () => {
    if (missing.length > 0) return;
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
    <div className="peek-form">
      <Field label="Profile name" hint="However you want to refer to this model">
        <input
          className="peek-field"
          type="text"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Qwen 2.5 14B"
        />
      </Field>

      <Field label="Server binary" hint="The llama-server executable from your llama.cpp build">
        <FileRow
          value={form.binaryPath}
          onChange={(v) => set('binaryPath', v)}
          onBrowse={() => pickFile('binaryPath', 'Select llama binary', 'Executable', ['exe', ''])}
          placeholder="/path/to/llama-server"
        />
      </Field>

      <Field label="Model file" hint="A .gguf model file">
        <FileRow
          value={form.modelPath}
          onChange={(v) => set('modelPath', v)}
          onBrowse={() => pickFile('modelPath', 'Select GGUF model', 'GGUF Model', ['gguf'])}
          placeholder="/path/to/model.gguf"
        />
      </Field>

      <Field label="Vision projector" hint="Optional. Only needed for models that can read images (mmproj)">
        <FileRow
          value={form.mmprojPath}
          onChange={(v) => set('mmprojPath', v)}
          onBrowse={() => pickFile('mmprojPath', 'Select mmproj file', 'GGUF Model', ['gguf'])}
          placeholder="Leave blank for text-only models"
        />
      </Field>

      {/*
        Eight numeric tuning fields used to sit inline, which made this form the
        steepest screen in the app — and it is step two of onboarding. The
        defaults are fine for almost everyone, so they start collapsed.
      */}
      <details className="peek-disclosure">
        <summary>Advanced tuning</summary>
        <div className="peek-disclosure-body peek-form">
          <div className="peek-form-grid">
            <Field label="Context size" hint="Tokens in view at once (-c)">
              <input className="peek-field" type="number" value={form.contextSize} onChange={(e) => set('contextSize', parseInt(e.target.value) || 0)} />
            </Field>
            <Field label="GPU layers" hint="Layers offloaded to the GPU (-ngl)">
              <input className="peek-field" type="number" value={form.nGpuLayers} onChange={(e) => set('nGpuLayers', parseInt(e.target.value) || 0)} />
            </Field>
            <Field label="Batch size" hint="Tokens per batch (-b)">
              <input className="peek-field" type="number" value={form.batchSize} onChange={(e) => set('batchSize', parseInt(e.target.value) || 0)} />
            </Field>
            <Field label="Micro-batch size" hint="Tokens per sub-batch (-ub)">
              <input className="peek-field" type="number" value={form.ubatchSize} onChange={(e) => set('ubatchSize', parseInt(e.target.value) || 0)} />
            </Field>
            <Field label="Parallel requests" hint="Concurrent slots the server keeps">
              <input className="peek-field" type="number" value={form.parallel} onChange={(e) => set('parallel', parseInt(e.target.value) || 1)} />
            </Field>
            <Field label="Temperature" hint="Higher is more random. 0–2">
              <input className="peek-field" type="number" step="0.1" value={form.temperature} onChange={(e) => set('temperature', parseFloat(e.target.value) || 0)} />
            </Field>
            <Field label="Host" hint="Address the server binds to">
              <input className="peek-field" type="text" value={form.host} onChange={(e) => set('host', e.target.value)} />
            </Field>
            <Field label="Port" hint="Port the server listens on">
              <input className="peek-field" type="number" value={form.port} onChange={(e) => set('port', parseInt(e.target.value) || 8080)} />
            </Field>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <button
              type="button"
              className="peek-switch"
              role="switch"
              aria-checked={form.flashAttn}
              onClick={() => set('flashAttn', !form.flashAttn)}
            />
            <span>
              <span className="peek-form-label">Flash attention</span>
              <span className="peek-form-hint" style={{ display: 'block' }}>
                Faster and lighter on memory, on GPUs that support it
              </span>
            </span>
          </label>
        </div>
      </details>

      {missing.length > 0 && (
        <div className="peek-form-error">
          Still needs {missing.join(', ').replace(/, ([^,]*)$/, ' and $1')}.
        </div>
      )}

      <div className="peek-form-actions">
        {onCancel && (
          <button className="peek-btn peek-btn--secondary" onClick={onCancel}>{cancelLabel}</button>
        )}
        <button
          className="peek-btn peek-btn--primary"
          style={{ flex: 1 }}
          onClick={handleSave}
          disabled={missing.length > 0}
        >
          {isNew ? 'Add profile' : 'Save changes'}
        </button>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="peek-form-row">
    <label className="peek-form-label">{label}</label>
    {hint && <span className="peek-form-hint">{hint}</span>}
    {children}
  </div>
);

const FileRow: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
  placeholder?: string;
}> = ({ value, onChange, onBrowse, placeholder }) => (
  <div className="peek-file-row">
    <input
      className="peek-field peek-field--mono"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ flex: 1 }}
    />
    <button className="peek-btn peek-btn--sm" onClick={onBrowse}>Browse</button>
  </div>
);
