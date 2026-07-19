import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
// preload/ipc import electron for contextBridge/ipcRenderer/ipcMain. Stub it so headless import
// works and the module-scope contextBridge guard is exercised (exposeInMainWorld here is a no-op).
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  ipcMain: { handle: vi.fn() }
}));
import { buildPreloadApi } from '../src/preload/index';
import { INVOKE, PUSH } from '../src/main/ipc';

/** A minimal mock of the pieces of ipcRenderer that buildPreloadApi touches. */
function makeMockIpc() {
  const invoke = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined));
  const on = vi.fn((..._args: unknown[]): void => {});
  const removeListener = vi.fn((..._args: unknown[]): void => {});
  const ipc = { invoke, on, removeListener } as unknown as IpcRenderer;
  return { ipc, invoke, on, removeListener };
}

describe('buildPreloadApi channel wiring', () => {
  it('routes every invoke method through the exact INVOKE constant', async () => {
    const { ipc, invoke } = makeMockIpc();
    const api = buildPreloadApi(ipc);

    await api.getConfig();
    await api.setConfig({ agentName: 'x' });
    await api.setSecret('googleClientSecret', 'v');
    await api.sendText('hi', 'codex');
    await api.cancel();
    await api.listSessions();
    await api.loadSession('id-1');
    await api.newSession();
    await api.connectGoogle();
    await api.disconnectGoogle();
    await api.listAudioInputs();
    await api.quit();

    const channels = invoke.mock.calls.map((c) => c[0]);
    expect(channels).toEqual([
      INVOKE.configGet,
      INVOKE.configSet,
      INVOKE.secretSet,
      INVOKE.commandText,
      INVOKE.pipelineCancel,
      INVOKE.sessionList,
      INVOKE.sessionLoad,
      INVOKE.sessionNew,
      INVOKE.googleConnect,
      INVOKE.googleDisconnect,
      INVOKE.audioListInputs,
      INVOKE.appQuit
    ]);

    // Arguments forwarded verbatim.
    expect(invoke).toHaveBeenCalledWith(INVOKE.configSet, { agentName: 'x' });
    expect(invoke).toHaveBeenCalledWith(INVOKE.secretSet, 'googleClientSecret', 'v');
    expect(invoke).toHaveBeenCalledWith(INVOKE.commandText, 'hi', 'codex');
    expect(invoke).toHaveBeenCalledWith(INVOKE.sessionLoad, 'id-1');
  });

  it('subscribes each on* method to the exact PUSH constant and unsubscribes', () => {
    const { ipc, on, removeListener } = makeMockIpc();
    const api = buildPreloadApi(ipc);

    const unsub = api.onStateChanged(() => {});
    api.onTranscript(() => {});
    api.onAgentEvent(() => {});
    api.onSessionUpdated(() => {});
    api.onConfigChanged(() => {});

    const channels = on.mock.calls.map((c) => c[0]);
    expect(channels).toEqual([
      PUSH.stateChanged,
      PUSH.transcript,
      PUSH.agentEvent,
      PUSH.sessionUpdated,
      PUSH.configChanged
    ]);

    unsub();
    expect(removeListener).toHaveBeenCalledWith(PUSH.stateChanged, expect.any(Function));
  });

  it('delivers the payload (dropping the IpcRendererEvent) to subscribers', () => {
    const { ipc, on } = makeMockIpc();
    const api = buildPreloadApi(ipc);
    const received: string[] = [];
    api.onStateChanged((s) => received.push(s));

    // Replay what ipcRenderer would do: (event, ...args)
    const listener = on.mock.calls[0]![1] as (e: unknown, s: string) => void;
    listener({ sender: 'fake' }, 'listening');
    expect(received).toEqual(['listening']);
  });

  it('minimize() invokes the window:minimize channel', async () => {
    const { ipc, invoke } = makeMockIpc();
    const api = buildPreloadApi(ipc);
    await api.minimize();
    expect(invoke).toHaveBeenCalledWith(INVOKE.windowMinimize);
  });

  it('channel constants equal their contractual string values', () => {
    expect(INVOKE.configGet).toBe('config:get');
    expect(INVOKE.secretSet).toBe('secret:set');
    expect(INVOKE.windowMinimize).toBe('window:minimize');
    expect(INVOKE.appQuit).toBe('app:quit');
    expect(PUSH.stateChanged).toBe('state:changed');
    expect(PUSH.agentEvent).toBe('agent:event');
    expect(PUSH.configChanged).toBe('config:changed');
  });
});
