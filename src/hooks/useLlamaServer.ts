import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore, LlamaProfile } from '../store/settings';

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

function buildArgs(p: LlamaProfile): string[] {
  const args: string[] = [
    '-m', p.modelPath,
    '--host', p.host,
    '--port', String(p.port),
    '-ngl', String(p.nGpuLayers),
    '-c', String(p.contextSize),
    '-b', String(p.batchSize),
    '-ub', String(p.ubatchSize),
    '--parallel', String(p.parallel),
    '--temp', String(p.temperature),
    '--jinja',
  ];
  if (p.mmprojPath) args.push('--mmproj', p.mmprojPath);
  if (p.flashAttn) args.push('--flash-attn', 'on');
  return args;
}

export function useLlamaServer() {
  const { activeProvider, llamaProfiles, activeLlamaProfileId } = useSettingsStore();
  const [status, setStatus] = useState<ServerStatus>('stopped');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeProfile = llamaProfiles.find((p) => p.id === activeLlamaProfileId) ?? null;

  const pollStatus = useCallback(async () => {
    try {
      const running = await invoke<boolean>('get_server_status');
      setStatus(running ? 'running' : 'stopped');
    } catch {
      setStatus('stopped');
    }
  }, []);

  const launch = useCallback(async (profile: LlamaProfile) => {
    setStatus('starting');
    try {
      await invoke('launch_llama_server', {
        binaryPath: profile.binaryPath,
        args: buildArgs(profile),
      });
      // Poll until the HTTP endpoint is reachable
      let attempts = 0;
      const check = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch(`http://${profile.host}:${profile.port}/v1/models`);
          if (res.ok) {
            clearInterval(check);
            setStatus('running');
          }
        } catch {
          if (attempts > 60) { // 30s timeout
            clearInterval(check);
            setStatus('error');
          }
        }
      }, 500);
    } catch (e) {
      console.error('launch_llama_server error', e);
      setStatus('error');
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await invoke('stop_llama_server');
    } catch { /* ignore */ }
    setStatus('stopped');
  }, []);

  // Auto-launch when llama provider + profile selected
  useEffect(() => {
    if (activeProvider !== 'llama' || !activeProfile) {
      if (activeProvider !== 'llama') {
        stop();
      }
      return;
    }
    // Check if already running first
    invoke<boolean>('get_server_status').then((running) => {
      if (!running) {
        launch(activeProfile);
      } else {
        setStatus('running');
      }
    });
  }, [activeProvider, activeLlamaProfileId]);

  // Periodic health check
  useEffect(() => {
    if (activeProvider !== 'llama') return;
    pollRef.current = setInterval(pollStatus, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeProvider, pollStatus]);

  return { status, activeProfile, launch, stop };
}
