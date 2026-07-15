import { ipcMain } from 'electron';
import type {
  AgentEvent,
  AppConfig,
  AssistantState,
  BackendId,
  SessionSummary,
  TranscriptEvent,
  TurnRecord
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
  'app:quit': () => Promise<void>;
}

/** Canonical push (main → renderer) channel names. The single source of truth. */
export const PUSH = {
  stateChanged: 'state:changed',
  transcript: 'transcript',
  agentEvent: 'agent:event',
  sessionUpdated: 'session:updated',
  configChanged: 'config:changed'
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
  appQuit: 'app:quit'
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
  quit(): Promise<void>;
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
  ipcMain.handle(INVOKE.appQuit, async () => deps.quit());
}
