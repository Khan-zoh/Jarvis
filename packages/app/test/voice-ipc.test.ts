// Wiring tests for the voice-pipeline task's new IPC surface: the 'voice:status' invoke channel
// and the 'mic:level' push channel (absorbed into PushChannels from shared/types.ts's
// MicLevelPush). Kept as its own file (rather than editing test/ipc.test.ts) per the task's file
// boundary; follows the same mock-ipcRenderer pattern.

import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  ipcMain: { handle: vi.fn() }
}));
import { buildPreloadApi } from '../src/preload/index';
import { INVOKE, PUSH } from '../src/main/ipc';
import type { VoiceStatus } from '../src/shared/types';

function makeMockIpc() {
  const invoke = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined));
  const on = vi.fn((..._args: unknown[]): void => {});
  const removeListener = vi.fn((..._args: unknown[]): void => {});
  const ipc = { invoke, on, removeListener } as unknown as IpcRenderer;
  return { ipc, invoke, on, removeListener };
}

describe('voice:status + mic:level channel wiring', () => {
  it('channel constants equal their contractual string values', () => {
    expect(INVOKE.voiceStatus).toBe('voice:status');
    expect(PUSH.micLevel).toBe('mic:level');
  });

  it('voiceStatus() invokes the voice:status channel and returns its payload', async () => {
    const { ipc, invoke } = makeMockIpc();
    const status: VoiceStatus = { enabled: false, reason: 'Picovoice access key is not set' };
    invoke.mockResolvedValueOnce(status);

    const api = buildPreloadApi(ipc);
    const result = await api.voiceStatus();

    expect(invoke).toHaveBeenCalledWith(INVOKE.voiceStatus);
    expect(result).toEqual(status);
  });

  it('onMicLevel subscribes to mic:level, delivers the level, and unsubscribes', () => {
    const { ipc, on, removeListener } = makeMockIpc();
    const api = buildPreloadApi(ipc);

    const levels: number[] = [];
    const unsub = api.onMicLevel((l) => levels.push(l));
    expect(on).toHaveBeenCalledWith(PUSH.micLevel, expect.any(Function));

    // Replay what ipcRenderer would do: (event, ...args).
    const listener = on.mock.calls[0]![1] as (e: unknown, level: number) => void;
    listener({ sender: 'fake' }, 0.42);
    expect(levels).toEqual([0.42]);

    unsub();
    expect(removeListener).toHaveBeenCalledWith(PUSH.micLevel, expect.any(Function));
  });
});
