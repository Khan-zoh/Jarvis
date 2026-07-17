import type {
  AgentEvent,
  AppConfig,
  AssistantState,
  BackendId,
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
  onStateChanged(fn: (s: AssistantState) => void): Unsubscribe;
  onTranscript(fn: (e: TranscriptEvent) => void): Unsubscribe;
  onAgentEvent(fn: (e: AgentEvent) => void): Unsubscribe;
  onSessionUpdated(fn: (turn: TurnRecord) => void): Unsubscribe;
  onConfigChanged(fn: (c: AppConfig) => void): Unsubscribe;
  onMicLevel?(fn: (level: number) => void): Unsubscribe;
}

declare global {
  interface Window {
    jarvis?: JarvisApi;
  }
}
