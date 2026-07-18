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
} from '../../shared/types';

export type Unsubscribe = () => void;

/**
 * The typed preload surface (`window.jarvis`) as consumed by the renderer views.
 * Mirrors `JarvisApi` in src/preload/index.ts — declared here too because the renderer
 * build must not import main/preload modules (they pull in `electron`).
 *
 * `onMicLevel` subscribes to the additive `'mic:level'` push channel (see MicLevelPush
 * in src/shared/types.ts). It is optional until preload exposes it; the overlay
 * degrades gracefully when absent.
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
  /** Voice pipeline status: enabled, or the durable text-only-mode reason (setup notice). */
  voiceStatus(): Promise<VoiceStatus>;
  /** Minimizes the main window (titlebar minimize glyph → `window:minimize` invoke). */
  minimize(): Promise<void>;
  quit(): Promise<void>;
  /** One manifest per loaded tools-mcp plugin (settings UI extensibility payoff). */
  listPluginManifests(): Promise<PluginManifest[]>;
  getPluginConfig(id: string): Promise<PluginConfigDto>;
  setPluginConfig(id: string, patch: Record<string, unknown>): Promise<void>;
  setPluginSecret(id: string, key: string, value: string): Promise<void>;
  /** Runs a plugin-declared `action`-kind setting (rendered as a button). */
  pluginAction(id: string, key: string): Promise<void>;
  /** Both backends' init() probe results with fix-hint copy. */
  accountsStatus(): Promise<AccountsStatus>;
  /** Whether the voice-stack models/binaries are all on disk. */
  modelsStatus(): Promise<ModelsStatus>;
  /** Runs fetchModels in the main process; watch onModelsProgress for streamed lines. */
  fetchModels(): Promise<ModelsFetchResult>;
  /** Open-file dialog for a custom Porcupine `.ppn` keyword; null on cancel. */
  pickKeywordFile(): Promise<string | null>;
  onStateChanged(fn: (s: AssistantState) => void): Unsubscribe;
  onTranscript(fn: (e: TranscriptEvent) => void): Unsubscribe;
  onAgentEvent(fn: (e: AgentEvent) => void): Unsubscribe;
  onSessionUpdated(fn: (turn: TurnRecord) => void): Unsubscribe;
  onConfigChanged(fn: (c: AppConfig) => void): Unsubscribe;
  onMicLevel?(fn: (level: number) => void): Unsubscribe;
  /** Progress lines streamed while models:fetch runs. */
  onModelsProgress(fn: (line: string) => void): Unsubscribe;
}

declare global {
  interface Window {
    jarvis?: JarvisApi;
  }
}
