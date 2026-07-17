import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import { INVOKE, PUSH } from '../main/ipc';
import type {
  AgentEvent,
  AppConfig,
  AssistantState,
  BackendId,
  SessionSummary,
  TranscriptEvent,
  TurnRecord,
  VoiceStatus
} from '../shared/types';

type Unsubscribe = () => void;

/**
 * The typed surface exposed to the renderer as `window.jarvis`. Invoke methods are one call each;
 * `on*` methods subscribe to a push channel and return an unsubscribe function.
 */
export interface JarvisApi {
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<void>;
  setSecret(key: 'picovoiceAccessKey' | 'googleClientSecret', value: string): Promise<void>;
  sendText(text: string, backend?: BackendId): Promise<void>;
  cancel(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<TurnRecord[]>;
  newSession(): Promise<void>;
  connectGoogle(): Promise<{ email: string }>;
  disconnectGoogle(): Promise<void>;
  listAudioInputs(): Promise<{ id: string; label: string }[]>;
  voiceStatus(): Promise<VoiceStatus>;
  quit(): Promise<void>;
  onStateChanged(fn: (s: AssistantState) => void): Unsubscribe;
  onTranscript(fn: (e: TranscriptEvent) => void): Unsubscribe;
  onAgentEvent(fn: (e: AgentEvent) => void): Unsubscribe;
  onSessionUpdated(fn: (turn: TurnRecord) => void): Unsubscribe;
  onConfigChanged(fn: (c: AppConfig) => void): Unsubscribe;
  /** Mic input level 0..1 per frame while listening (overlay listening bars). */
  onMicLevel(fn: (level: number) => void): Unsubscribe;
}

/**
 * Builds the `window.jarvis` API against a given `ipcRenderer`. Taking it as a parameter keeps the
 * function unit-testable with a mock (see test/ipc.test.ts).
 */
export function buildPreloadApi(ipc: IpcRenderer): JarvisApi {
  const subscribe = <T>(channel: string, fn: (arg: T) => void): Unsubscribe => {
    const listener = (_event: unknown, arg: T): void => fn(arg);
    ipc.on(channel, listener as never);
    return () => {
      ipc.removeListener(channel, listener as never);
    };
  };

  return {
    getConfig: () => ipc.invoke(INVOKE.configGet),
    setConfig: (patch) => ipc.invoke(INVOKE.configSet, patch),
    setSecret: (key, value) => ipc.invoke(INVOKE.secretSet, key, value),
    sendText: (text, backend) => ipc.invoke(INVOKE.commandText, text, backend),
    cancel: () => ipc.invoke(INVOKE.pipelineCancel),
    listSessions: () => ipc.invoke(INVOKE.sessionList),
    loadSession: (id) => ipc.invoke(INVOKE.sessionLoad, id),
    newSession: () => ipc.invoke(INVOKE.sessionNew),
    connectGoogle: () => ipc.invoke(INVOKE.googleConnect),
    disconnectGoogle: () => ipc.invoke(INVOKE.googleDisconnect),
    listAudioInputs: () => ipc.invoke(INVOKE.audioListInputs),
    voiceStatus: () => ipc.invoke(INVOKE.voiceStatus),
    quit: () => ipc.invoke(INVOKE.appQuit),
    onStateChanged: (fn) => subscribe(PUSH.stateChanged, fn),
    onTranscript: (fn) => subscribe(PUSH.transcript, fn),
    onAgentEvent: (fn) => subscribe(PUSH.agentEvent, fn),
    onSessionUpdated: (fn) => subscribe(PUSH.sessionUpdated, fn),
    onConfigChanged: (fn) => subscribe(PUSH.configChanged, fn),
    onMicLevel: (fn) => subscribe(PUSH.micLevel, fn)
  };
}

// Only expose inside a real preload context; guarded so importing this module in a headless test
// (where `contextBridge` is undefined) does not throw.
if (contextBridge?.exposeInMainWorld) {
  contextBridge.exposeInMainWorld('jarvis', buildPreloadApi(ipcRenderer));
}
