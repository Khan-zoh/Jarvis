import type {
  AccountsStatus,
  AgentEvent,
  AppConfig,
  AssistantState,
  BackendId,
  CapturedNote,
  CollaborationRequest,
  CollaborationSnapshot,
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
  collaboration: CollaborationSnapshot;
  calls: {
    sendText: [text: string, backend: BackendId | undefined][];
    setConfig: Partial<AppConfig>[];
    setSecret: [key: string, value: string][];
    minimize: number;
    newSession: number;
    pluginSetConfig: [id: string, patch: Record<string, unknown>][];
    pluginSetSecret: [id: string, key: string, value: string][];
    pluginAction: [id: string, key: string][];
    fetchModels: number;
    brainRemove: string[];
    collaborationStart: CollaborationRequest[];
    collaborationCancel: number;
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
  pushCollaborationEvent(event: import('../../shared/types').CollaborationEvent): void;
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
    codex: { model: null },
    access: { mode: 'restricted', workspaceRoot: 'C:\\dev' }
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
    collaboration: { id: null, status: 'idle', request: null, activeBackend: null, messages: [] },
    calls: {
      sendText: [],
      setConfig: [],
      setSecret: [],
      minimize: 0,
      newSession: 0,
      pluginSetConfig: [],
      pluginSetSecret: [],
      pluginAction: [],
      fetchModels: 0,
      brainRemove: [],
      collaborationStart: [],
      collaborationCancel: 0
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
    newSession: () => {
      api.calls.newSession += 1;
      return Promise.resolve();
    },
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
    startCollaboration: (request) => {
      api.calls.collaborationStart.push(request);
      api.collaboration = {
        id: 'demo-collaboration',
        status: 'running',
        request,
        activeBackend: request.firstSpeaker,
        messages: []
      };
      emit('collaboration:event', { kind: 'snapshot', snapshot: structuredClone(api.collaboration) });
      const order: BackendId[] =
        request.firstSpeaker === 'claude' ? ['claude', 'codex'] : ['codex', 'claude'];
      order.forEach((backend, index) => {
        setTimeout(() => {
          const message = {
            id: `demo-${backend}`,
            at: new Date().toISOString(),
            backend,
            role: backend === 'claude' ? request.claudeRole : request.codexRole,
            text:
              backend === 'claude'
                ? 'I’ll define the architecture, surface the riskiest assumptions, and give Codex a concrete implementation boundary.'
                : 'I checked that proposal against the code path. I’ll implement the smallest testable slice and report the verification evidence.',
            updates: [`${backend} inspected the task and prepared a handoff`],
            tools: [{ toolName: 'workspace_search', ok: true }]
          };
          api.collaboration.messages.push(message);
          emit('collaboration:event', { kind: 'message', message });
          if (index === order.length - 1) {
            api.collaboration.status = 'completed';
            api.collaboration.activeBackend = null;
            emit('collaboration:event', { kind: 'completed' });
            emit('collaboration:event', { kind: 'snapshot', snapshot: structuredClone(api.collaboration) });
          }
        }, 120 + index * 180);
      });
      return Promise.resolve({ id: 'demo-collaboration' });
    },
    cancelCollaboration: () => {
      api.calls.collaborationCancel += 1;
      return Promise.resolve();
    },
    collaborationSnapshot: () => Promise.resolve(api.collaboration),

    onStateChanged: (fn) => on('state:changed', fn as Listener),
    onTranscript: (fn) => on('transcript', fn as Listener),
    onAgentEvent: (fn) => on('agent:event', fn as Listener),
    onSessionUpdated: (fn) => on('session:updated', fn as Listener),
    onConfigChanged: (fn) => on('config:changed', fn as Listener),
    onMicLevel: (fn) => on('mic:level', fn as Listener),
    onModelsProgress: (fn) => on('models:progress', fn as Listener),
    onBrainCaptured: (fn) => on('brain:captured', fn as Listener),
    onBrainRemoved: (fn) => on('brain:removed', fn as Listener),
    onCollaborationEvent: (fn) => on('collaboration:event', fn as Listener),

    pushState: (s) => emit('state:changed', s),
    pushTranscript: (e) => emit('transcript', e),
    pushAgentEvent: (e) => emit('agent:event', e),
    pushTurn: (turn) => emit('session:updated', turn),
    pushConfig: (c) => emit('config:changed', c),
    pushMicLevel: (level) => emit('mic:level', level),
    pushModelsProgress: (line) => emit('models:progress', line),
    pushBrainCaptured: (note) => emit('brain:captured', note),
    pushBrainRemoved: (id) => emit('brain:removed', id),
    pushCollaborationEvent: (event) => emit('collaboration:event', event)
  };

  return api;
}
