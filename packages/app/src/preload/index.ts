import { contextBridge, ipcRenderer, type IpcRenderer } from 'electron';
import { INVOKE, PUSH } from '../main/ipc';
import type {
  AccountsStatus,
  AgentEvent,
  AppConfig,
  AssistantState,
  BackendId,
  CapturedNote,
  ModelsFetchResult,
  ModelsStatus,
  PluginConfigDto,
  PluginManifest,
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
  minimize(): Promise<void>;
  quit(): Promise<void>;
  listPluginManifests(): Promise<PluginManifest[]>;
  getPluginConfig(id: string): Promise<PluginConfigDto>;
  setPluginConfig(id: string, patch: Record<string, unknown>): Promise<void>;
  setPluginSecret(id: string, key: string, value: string): Promise<void>;
  pluginAction(id: string, key: string): Promise<void>;
  accountsStatus(): Promise<AccountsStatus>;
  modelsStatus(): Promise<ModelsStatus>;
  fetchModels(): Promise<ModelsFetchResult>;
  pickKeywordFile(): Promise<string | null>;
  /** Recently auto-captured notes (second brain) for the recently-captured strip. */
  brainRecent(): Promise<CapturedNote[]>;
  /** Delete a captured note by id (one-click undo). */
  brainRemove(id: string): Promise<void>;
  onStateChanged(fn: (s: AssistantState) => void): Unsubscribe;
  onTranscript(fn: (e: TranscriptEvent) => void): Unsubscribe;
  onAgentEvent(fn: (e: AgentEvent) => void): Unsubscribe;
  onSessionUpdated(fn: (turn: TurnRecord) => void): Unsubscribe;
  onConfigChanged(fn: (c: AppConfig) => void): Unsubscribe;
  /** Mic input level 0..1 per frame while listening (overlay listening bars). */
  onMicLevel(fn: (level: number) => void): Unsubscribe;
  /** Progress lines streamed while `models:fetch` runs. */
  onModelsProgress(fn: (line: string) => void): Unsubscribe;
  /** A durable fact was just auto-captured (second brain) — "noted:" toast + strip prepend. */
  onBrainCaptured(fn: (note: CapturedNote) => void): Unsubscribe;
  /** A captured note was removed — remove its strip row. */
  onBrainRemoved(fn: (id: string) => void): Unsubscribe;
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
    minimize: () => ipc.invoke(INVOKE.windowMinimize),
    quit: () => ipc.invoke(INVOKE.appQuit),
    listPluginManifests: () => ipc.invoke(INVOKE.pluginListManifests),
    getPluginConfig: (id) => ipc.invoke(INVOKE.pluginGetConfig, id),
    setPluginConfig: (id, patch) => ipc.invoke(INVOKE.pluginSetConfig, id, patch),
    setPluginSecret: (id, key, value) => ipc.invoke(INVOKE.pluginSetSecret, id, key, value),
    pluginAction: (id, key) => ipc.invoke(INVOKE.pluginAction, id, key),
    accountsStatus: () => ipc.invoke(INVOKE.accountsStatus),
    modelsStatus: () => ipc.invoke(INVOKE.modelsStatus),
    fetchModels: () => ipc.invoke(INVOKE.modelsFetch),
    pickKeywordFile: () => ipc.invoke(INVOKE.pickKeywordFile),
    brainRecent: () => ipc.invoke(INVOKE.brainRecent),
    brainRemove: (id) => ipc.invoke(INVOKE.brainRemove, id),
    onStateChanged: (fn) => subscribe(PUSH.stateChanged, fn),
    onTranscript: (fn) => subscribe(PUSH.transcript, fn),
    onAgentEvent: (fn) => subscribe(PUSH.agentEvent, fn),
    onSessionUpdated: (fn) => subscribe(PUSH.sessionUpdated, fn),
    onConfigChanged: (fn) => subscribe(PUSH.configChanged, fn),
    onMicLevel: (fn) => subscribe(PUSH.micLevel, fn),
    onModelsProgress: (fn) => subscribe(PUSH.modelsProgress, fn),
    onBrainCaptured: (fn) => subscribe(PUSH.brainCaptured, fn),
    onBrainRemoved: (fn) => subscribe(PUSH.brainRemoved, fn)
  };
}

// Only expose inside a real preload context; guarded so importing this module in a headless test
// (where `contextBridge` is undefined) does not throw.
if (contextBridge?.exposeInMainWorld) {
  contextBridge.exposeInMainWorld('jarvis', buildPreloadApi(ipcRenderer));
}
