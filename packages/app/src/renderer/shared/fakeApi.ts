import type {
  AgentEvent,
  AppConfig,
  AssistantState,
  BackendId,
  SessionSummary,
  TranscriptEvent,
  TurnRecord
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
  calls: {
    sendText: [text: string, backend: BackendId | undefined][];
    setConfig: Partial<AppConfig>[];
    setSecret: [key: string, value: string][];
  };
  pushState(s: AssistantState): void;
  pushTranscript(e: TranscriptEvent): void;
  pushAgentEvent(e: AgentEvent): void;
  pushTurn(turn: TurnRecord): void;
  pushConfig(c: AppConfig): void;
  pushMicLevel(level: number): void;
}

export const FAKE_CONFIG: AppConfig = {
  agentName: 'jarvis',
  voice: {
    picovoiceAccessKey: '',
    builtinKeyword: 'jarvis',
    customKeywordPath: null,
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
  ui: { launchOnStartup: false, hotkey: 'Ctrl+Shift+Space' }
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
    calls: { sendText: [], setConfig: [], setSecret: [] },

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
    quit: () => Promise.resolve(),

    onStateChanged: (fn) => on('state:changed', fn as Listener),
    onTranscript: (fn) => on('transcript', fn as Listener),
    onAgentEvent: (fn) => on('agent:event', fn as Listener),
    onSessionUpdated: (fn) => on('session:updated', fn as Listener),
    onConfigChanged: (fn) => on('config:changed', fn as Listener),
    onMicLevel: (fn) => on('mic:level', fn as Listener),

    pushState: (s) => emit('state:changed', s),
    pushTranscript: (e) => emit('transcript', e),
    pushAgentEvent: (e) => emit('agent:event', e),
    pushTurn: (turn) => emit('session:updated', turn),
    pushConfig: (c) => emit('config:changed', c),
    pushMicLevel: (level) => emit('mic:level', level)
  };

  return api;
}
