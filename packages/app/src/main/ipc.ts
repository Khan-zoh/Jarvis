import { ipcMain } from 'electron';
import type {
  AccountsStatus,
  AgentEvent,
  AppConfig,
  AssistantState,
  BackendId,
  ModelsFetchResult,
  ModelsStatus,
  PluginConfigDto,
  PluginManifest,
  SessionSummary,
  TranscriptEvent,
  TurnRecord,
  VoiceStatus
} from '../shared/types';
import type { ConfigStore } from './config';

/**
 * main → renderer messages (`webContents.send`). Config payloads are always redacted.
 */
export interface PushChannels {
  'state:changed': (s: AssistantState) => void;
  transcript: (e: TranscriptEvent) => void;
  'agent:event': (e: AgentEvent) => void;
  'session:updated': (turn: TurnRecord) => void;
  'config:changed': (c: AppConfig) => void;
  /** Instantaneous mic input level 0..1, emitted per frame while listening (absorbed from
   * shared/types.ts's MicLevelPush). Drives the overlay listening bars. */
  'mic:level': (level: number) => void;
  /** One human-readable progress line per model spec while `models:fetch` runs (settings-ui:
   * the "download models" button streams these into the voice section). */
  'models:progress': (line: string) => void;
}

/**
 * renderer → main requests (`ipcRenderer.invoke`).
 */
export interface InvokeChannels {
  'config:get': () => Promise<AppConfig>;
  'config:set': (patch: Partial<AppConfig>) => Promise<void>;
  'secret:set': (
    key: 'picovoiceAccessKey' | 'googleClientSecret',
    value: string
  ) => Promise<void>;
  'command:text': (text: string, backend?: BackendId) => Promise<void>;
  'pipeline:cancel': () => Promise<void>;
  'session:list': () => Promise<SessionSummary[]>;
  'session:load': (id: string) => Promise<TurnRecord[]>;
  'session:new': () => Promise<void>;
  'google:connect': () => Promise<{ email: string }>;
  'google:disconnect': () => Promise<void>;
  'audio:listInputs': () => Promise<{ id: string; label: string }[]>;
  /** Whether the voice pipeline is live, and (when it is not) the text-only-mode reason. */
  'voice:status': () => Promise<VoiceStatus>;
  /** Minimizes the main window (custom titlebar minimize glyph). */
  'window:minimize': () => Promise<void>;
  'app:quit': () => Promise<void>;
  /** The settings-ui extensibility payoff (amendments.md deferred note): one manifest per loaded
   * tools-mcp plugin, read directly from the workspace package — no hard-coded plugin list. */
  'plugin:listManifests': () => Promise<PluginManifest[]>;
  /** Non-secret config for one plugin, plus which secret keys are currently set (never values). */
  'plugin:getConfig': (id: string) => Promise<PluginConfigDto>;
  'plugin:setConfig': (id: string, patch: Record<string, unknown>) => Promise<void>;
  'plugin:setSecret': (id: string, key: string, value: string) => Promise<void>;
  /** Runs a plugin-declared `action`-kind setting (e.g. google connect/disconnect). The app
   * routes (id, key) to the matching handler; unknown pairs reject. */
  'plugin:action': (id: string, key: string) => Promise<void>;
  /** Both backends probed via their real `init()`, with per-backend fix-hint problems. */
  'accounts:status': () => Promise<AccountsStatus>;
  /** `resolveModelPaths` distilled: complete, or the list of missing artifacts. */
  'models:status': () => Promise<ModelsStatus>;
  /** Runs fetchModels in the main process; progress lines stream on `models:progress`. */
  'models:fetch': () => Promise<ModelsFetchResult>;
  /** Native open-file dialog filtered to Porcupine `.ppn` keyword files; null on cancel. */
  'dialog:pickKeywordFile': () => Promise<string | null>;
}

/** Canonical push (main → renderer) channel names. The single source of truth. */
export const PUSH = {
  stateChanged: 'state:changed',
  transcript: 'transcript',
  agentEvent: 'agent:event',
  sessionUpdated: 'session:updated',
  configChanged: 'config:changed',
  micLevel: 'mic:level',
  modelsProgress: 'models:progress'
} as const satisfies Record<string, keyof PushChannels>;

/** Canonical invoke (renderer → main) channel names. The single source of truth. */
export const INVOKE = {
  configGet: 'config:get',
  configSet: 'config:set',
  secretSet: 'secret:set',
  commandText: 'command:text',
  pipelineCancel: 'pipeline:cancel',
  sessionList: 'session:list',
  sessionLoad: 'session:load',
  sessionNew: 'session:new',
  googleConnect: 'google:connect',
  googleDisconnect: 'google:disconnect',
  audioListInputs: 'audio:listInputs',
  voiceStatus: 'voice:status',
  windowMinimize: 'window:minimize',
  appQuit: 'app:quit',
  pluginListManifests: 'plugin:listManifests',
  pluginGetConfig: 'plugin:getConfig',
  pluginSetConfig: 'plugin:setConfig',
  pluginSetSecret: 'plugin:setSecret',
  pluginAction: 'plugin:action',
  accountsStatus: 'accounts:status',
  modelsStatus: 'models:status',
  modelsFetch: 'models:fetch',
  pickKeywordFile: 'dialog:pickKeywordFile'
} as const satisfies Record<string, keyof InvokeChannels>;

/**
 * Everything `registerInvokeHandlers` needs to service the InvokeChannels. `config` is real from
 * day one; the voice/agent/session/google members are stubbed by app-core and replaced with real
 * implementations by later tasks, which inject them through this same interface.
 */
export interface IpcDeps {
  config: ConfigStore;
  sendTextCommand(text: string, backend?: BackendId): Promise<void>;
  cancelPipeline(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string): Promise<TurnRecord[]>;
  newSession(): Promise<void>;
  connectGoogle(): Promise<{ email: string }>;
  disconnectGoogle(): Promise<void>;
  listAudioInputs(): Promise<{ id: string; label: string }[]>;
  voiceStatus(): Promise<VoiceStatus>;
  minimizeWindow(): Promise<void>;
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
}

/** Wires every InvokeChannel to its handler on `ipcMain`. Call once, after `app.whenReady()`. */
export function registerInvokeHandlers(deps: IpcDeps): void {
  ipcMain.handle(INVOKE.configGet, async () => deps.config.getRedacted());
  ipcMain.handle(INVOKE.configSet, async (_e, patch: Partial<AppConfig>) => {
    deps.config.set(patch);
  });
  ipcMain.handle(
    INVOKE.secretSet,
    async (_e, key: 'picovoiceAccessKey' | 'googleClientSecret', value: string) => {
      deps.config.setSecret(key, value);
    }
  );
  ipcMain.handle(INVOKE.commandText, async (_e, text: string, backend?: BackendId) =>
    deps.sendTextCommand(text, backend)
  );
  ipcMain.handle(INVOKE.pipelineCancel, async () => deps.cancelPipeline());
  ipcMain.handle(INVOKE.sessionList, async () => deps.listSessions());
  ipcMain.handle(INVOKE.sessionLoad, async (_e, id: string) => deps.loadSession(id));
  ipcMain.handle(INVOKE.sessionNew, async () => deps.newSession());
  ipcMain.handle(INVOKE.googleConnect, async () => deps.connectGoogle());
  ipcMain.handle(INVOKE.googleDisconnect, async () => deps.disconnectGoogle());
  ipcMain.handle(INVOKE.audioListInputs, async () => deps.listAudioInputs());
  ipcMain.handle(INVOKE.voiceStatus, async () => deps.voiceStatus());
  ipcMain.handle(INVOKE.windowMinimize, async () => deps.minimizeWindow());
  ipcMain.handle(INVOKE.appQuit, async () => deps.quit());
  ipcMain.handle(INVOKE.pluginListManifests, async () => deps.listPluginManifests());
  ipcMain.handle(INVOKE.pluginGetConfig, async (_e, id: string) => deps.getPluginConfig(id));
  ipcMain.handle(
    INVOKE.pluginSetConfig,
    async (_e, id: string, patch: Record<string, unknown>) => deps.setPluginConfig(id, patch)
  );
  ipcMain.handle(
    INVOKE.pluginSetSecret,
    async (_e, id: string, key: string, value: string) => deps.setPluginSecret(id, key, value)
  );
  ipcMain.handle(INVOKE.pluginAction, async (_e, id: string, key: string) =>
    deps.pluginAction(id, key)
  );
  ipcMain.handle(INVOKE.accountsStatus, async () => deps.accountsStatus());
  ipcMain.handle(INVOKE.modelsStatus, async () => deps.modelsStatus());
  ipcMain.handle(INVOKE.modelsFetch, async () => deps.fetchModels());
  ipcMain.handle(INVOKE.pickKeywordFile, async () => deps.pickKeywordFile());
}
