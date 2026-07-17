export type BackendId = 'claude' | 'codex';

export type AssistantState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface AppConfig {
  agentName: string;                       // display + wake name, default "Jarvis"
  voice: {
    picovoiceAccessKey: string;            // secret (safeStorage)
    builtinKeyword: string | null;         // e.g. "jarvis" (Porcupine built-in)
    customKeywordPath: string | null;      // .ppn file for custom names
    sensitivity: number;                   // 0..1, default 0.6
    inputDeviceId: string | null;          // null = system default
    listenTimeoutMs: number;               // default 8000
    sttModelPath: string;                  // whisper model file
    ttsVoicePath: string;                  // piper .onnx voice
    ttsEnabled: boolean;
  };
  agents: {
    defaultBackend: BackendId;             // default 'claude'
    claude: { systemPromptExtra: string };
    codex: { model: string | null };       // null = codex default
  };
  google: { clientId: string; clientSecret: string; connectedEmail: string | null };
  ui: { launchOnStartup: boolean; hotkey: string /* e.g. "Ctrl+Shift+Space" */ };
}

export interface TranscriptEvent { text: string; final: boolean }

export type AgentEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_start'; toolName: string; summary: string }
  | { kind: 'tool_end'; toolName: string; ok: boolean }
  | { kind: 'done'; finalText: string }
  | { kind: 'error'; message: string };

export interface TurnRecord {
  id: string;
  at: string;                              // ISO timestamp
  backend: BackendId;
  userText: string;
  assistantText: string;
  tools: { toolName: string; ok: boolean }[];
}

export interface SessionSummary { id: string; title: string; updatedAt: string; backend: BackendId }

/**
 * Push channel (main → renderer): instantaneous microphone input level, 0..1, emitted while
 * listening. Drives the overlay listening-indicator bars. ABSORBED into src/main/ipc.ts's
 * PushChannels by the voice-pipeline task (which wires the emitter); this declaration remains
 * for the renderer build, which cannot import main-process modules.
 */
export interface MicLevelPush {
  'mic:level': (level: number) => void;
}

/**
 * Result of the `voice:status` invoke channel: whether the voice pipeline is actually running,
 * and — when it is not — a human-readable reason (missing models/binaries or an unconfigured
 * Picovoice access key/keyword). Missing prerequisites are NOT a transient error; they put the
 * app in text-only mode until the user fixes the named cause (cdd/plan/amendments.md A6, error
 * policy nuance).
 */
export interface VoiceStatus {
  /** True when the wake-word + voice pipeline is live; false in text-only mode. */
  enabled: boolean;
  /** Why voice is off (for the settings/setup UI), or null when enabled. */
  reason: string | null;
}
