// Wiring tests for the settings-ui task's new IPC surface: the plugin:* channels, the
// accounts/models channels and the models:progress push.
// Kept as its own file (same file-boundary convention as test/voice-ipc.test.ts); same
// mock-ipcRenderer pattern.

import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  ipcMain: { handle: vi.fn() }
}));
import { buildPreloadApi } from '../src/preload/index';
import { INVOKE, PUSH } from '../src/main/ipc';

function makeMockIpc() {
  const invoke = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined));
  const on = vi.fn((..._args: unknown[]): void => {});
  const removeListener = vi.fn((..._args: unknown[]): void => {});
  const ipc = { invoke, on, removeListener } as unknown as IpcRenderer;
  return { ipc, invoke, on, removeListener };
}

describe('settings-ui channel wiring', () => {
  it('channel constants equal their contractual string values', () => {
    expect(INVOKE.pluginListManifests).toBe('plugin:listManifests');
    expect(INVOKE.pluginGetConfig).toBe('plugin:getConfig');
    expect(INVOKE.pluginSetConfig).toBe('plugin:setConfig');
    expect(INVOKE.pluginSetSecret).toBe('plugin:setSecret');
    expect(INVOKE.pluginAction).toBe('plugin:action');
    expect(INVOKE.accountsStatus).toBe('accounts:status');
    expect(INVOKE.modelsStatus).toBe('models:status');
    expect(INVOKE.modelsFetch).toBe('models:fetch');
    expect(PUSH.modelsProgress).toBe('models:progress');
  });

  it('every new invoke method routes through its INVOKE constant with args verbatim', async () => {
    const { ipc, invoke } = makeMockIpc();
    const api = buildPreloadApi(ipc);

    await api.listPluginManifests();
    await api.getPluginConfig('system');
    await api.setPluginConfig('system', { allowUnsafePaths: true });
    await api.setPluginSecret('smarthome', 'apiKey', 'v');
    await api.pluginAction('google', 'connect');
    await api.accountsStatus();
    await api.modelsStatus();
    await api.fetchModels();

    expect(invoke.mock.calls).toEqual([
      [INVOKE.pluginListManifests],
      [INVOKE.pluginGetConfig, 'system'],
      [INVOKE.pluginSetConfig, 'system', { allowUnsafePaths: true }],
      [INVOKE.pluginSetSecret, 'smarthome', 'apiKey', 'v'],
      [INVOKE.pluginAction, 'google', 'connect'],
      [INVOKE.accountsStatus],
      [INVOKE.modelsStatus],
      [INVOKE.modelsFetch]
    ]);
  });

  it('onModelsProgress subscribes to models:progress, delivers lines, and unsubscribes', () => {
    const { ipc, on, removeListener } = makeMockIpc();
    const api = buildPreloadApi(ipc);

    const lines: string[] = [];
    const unsub = api.onModelsProgress((l) => lines.push(l));
    expect(on).toHaveBeenCalledWith(PUSH.modelsProgress, expect.any(Function));

    const listener = on.mock.calls[0]![1] as (e: unknown, line: string) => void;
    listener({ sender: 'fake' }, 'whisper-cli: already present, hash verified');
    expect(lines).toEqual(['whisper-cli: already present, hash verified']);

    unsub();
    expect(removeListener).toHaveBeenCalledWith(PUSH.modelsProgress, expect.any(Function));
  });
});
