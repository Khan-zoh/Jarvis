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
} from '../../shared/types';
import type { JarvisApi, Unsubscribe } from './api';

/**
 * In-renderer stand-in for `window.jarvis`, used by the demo driver (?demo=1) and the
 * jsdom unit tests. Push events are delivered synchronously; invoke calls are recorded
 * on `calls` so tests can assert against them.
 */
export interface FakeApi extends JarvisApi {
  config: AppConfig;
  sessions: SessionSummary[];
  turnsBySession: Record<string, TurnRecord[]>;
  /** What voiceStatus() resolves with; set before constructing a view to simulate text-only mode. */
  voice: VoiceStatus;
  /** Fixture manifest list returned by listPluginManifests(); set before constructing a view. */
  pluginManifests: PluginManifest[];
  /** Per-plugin-id config fixture returned by getPluginConfig(id); missing id → empty config. */
  pluginConfigs: Record<string, PluginConfigDto>;
  /** What modelsStatus() resolves with; set before constructing a view. */
  models: ModelsStatus;
  /** What accountsStatus() resolves with; set before constructing a view. */
  accounts: AccountsStatus;
  /** What fetchModels() resolves with. */
  fetchResult: ModelsFetchResult;
  /** What brainRecent() resolves with; set before constructing a view. */
  capturedNotes: CapturedNote[];
  calls: {
    sendText: [text: string, backend: BackendId | undefined][];
    setConfig: Partial<AppConfig>[];
    setSecret: [key: string, value: string][];
    minimize: number;
    pluginSetConfig: [id: string, patch: Record<string, unknown>][];
    pluginSetSecret: [id: string, key: string, value: string][];
    pluginAction: [id: string, key: string][];
    fetchModels: number;
    brainRemove: string[];
  };
  pushState(s: AssistantState): void;
  pushTranscript(e: TranscriptEvent): void;
  pushAgentEvent(e: AgentEvent): void;
  pushTurn(turn: TurnRecord): void;
  pushConfig(c: AppConfig): void;
  pushMicLevel(level: number): void;
  pushModelsProgress(line: string): void;
  pushBrainCaptured(note: CapturedNote): void;
  pushBrainRemoved(id: string): void;
}

export const FAKE_CONFIG: AppConfig = {
  agentName: 'jarvis',
  voice: {
    sensitivity: 0.6,
    inputDeviceId: null,
    listenTimeoutMs: 8000,
    sttModelPath: '',
    ttsVoicePath: '',
    ttsEnabled: true
  },
  agents: {
    defaultBackend: 'claude',
    claude: { systemPromptExtra: '' },
    codex: { model: null }
  },
  google: { clientId: '', clientSecret: '', connectedEmail: null },
  ui: { launchOnStartup: false, hotkey: 'Ctrl+Shift+Space' },
  secondBrain: {
    enabled: false,
    vaultDir: 'D:\\JarvisBrain',
    autoCapture: true,
    recallMode: 'hybrid'
  }
};

type Listener = (arg: never) => void;

export function createFakeApi(config: AppConfig = structuredClone(FAKE_CONFIG)): FakeApi {
  const listeners = new Map<string, Set<Listener>>();

  const on = (channel: string, fn: Listener): Unsubscribe => {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  };

  const emit = (channel: string, arg: unknown): void => {
    listeners.get(channel)?.forEach((fn) => fn(arg as never));
  };

  const api: FakeApi = {
    config,
    sessions: [],
    turnsBySession: {},
    voice: { enabled: true, reason: null },
    pluginManifests: [],
    pluginConfigs: {},
    models: { ok: true },
    accounts: { claude: { ok: true }, codex: { ok: true } },
    fetchResult: { ok: true, failed: [] },
    capturedNotes: [],
    calls: {
      sendText: [],
      setConfig: [],
      setSecret: [],
      minimize: 0,
      pluginSetConfig: [],
      pluginSetSecret: [],
      pluginAction: [],
      fetchModels: 0,
      brainRemove: []
    },

    getConfig: () => Promise.resolve(api.config),
    setConfig: (patch) => {
      api.calls.setConfig.push(patch);
      return Promise.resolve();
    },
    setSecret: (key, value) => {
      api.calls.setSecret.push([key, value]);
      return Promise.resolve();
    },
    sendText: (text, backend) => {
      api.calls.sendText.push([text, backend]);
      return Promise.resolve();
    },
    cancel: () => Promise.resolve(),
    listSessions: () => Promise.resolve(api.sessions),
    loadSession: (id) => Promise.resolve(api.turnsBySession[id] ?? []),
    newSession: () => Promise.resolve(),
    connectGoogle: () => Promise.resolve({ email: 'demo@example.com' }),
    disconnectGoogle: () => Promise.resolve(),
    listAudioInputs: () => Promise.resolve([{ id: 'default', label: 'default input' }]),
    voiceStatus: () => Promise.resolve(api.voice),
    minimize: () => {
      api.calls.minimize += 1;
      return Promise.resolve();
    },
    quit: () => Promise.resolve(),
    listPluginManifests: () => Promise.resolve(api.pluginManifests),
    getPluginConfig: (id) =>
      Promise.resolve(api.pluginConfigs[id] ?? { config: {}, secretsSet: [] }),
    setPluginConfig: (id, patch) => {
      api.calls.pluginSetConfig.push([id, patch]);
      return Promise.resolve();
    },
    setPluginSecret: (id, key, value) => {
      api.calls.pluginSetSecret.push([id, key, value]);
      return Promise.resolve();
    },
    pluginAction: (id, key) => {
      api.calls.pluginAction.push([id, key]);
      return Promise.resolve();
    },
    accountsStatus: () => Promise.resolve(api.accounts),
    modelsStatus: () => Promise.resolve(api.models),
    fetchModels: () => {
      api.calls.fetchModels += 1;
      return Promise.resolve(api.fetchResult);
    },
    brainRecent: () => Promise.resolve(api.capturedNotes),
    brainRemove: (id) => {
      api.calls.brainRemove.push(id);
      return Promise.resolve();
    },

    onStateChanged: (fn) => on('state:changed', fn as Listener),
    onTranscript: (fn) => on('transcript', fn as Listener),
    onAgentEvent: (fn) => on('agent:event', fn as Listener),
    onSessionUpdated: (fn) => on('session:updated', fn as Listener),
    onConfigChanged: (fn) => on('config:changed', fn as Listener),
    onMicLevel: (fn) => on('mic:level', fn as Listener),
    onModelsProgress: (fn) => on('models:progress', fn as Listener),
    onBrainCaptured: (fn) => on('brain:captured', fn as Listener),
    onBrainRemoved: (fn) => on('brain:removed', fn as Listener),

    pushState: (s) => emit('state:changed', s),
    pushTranscript: (e) => emit('transcript', e),
    pushAgentEvent: (e) => emit('agent:event', e),
    pushTurn: (turn) => emit('session:updated', turn),
    pushConfig: (c) => emit('config:changed', c),
    pushMicLevel: (level) => emit('mic:level', level),
    pushModelsProgress: (line) => emit('models:progress', line),
    pushBrainCaptured: (note) => emit('brain:captured', note),
    pushBrainRemoved: (id) => emit('brain:removed', id)
  };

  return api;
}
