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
 * Additive push channel (main → renderer): instantaneous microphone input level, 0..1,
 * emitted while listening. Drives the overlay listening-indicator bars. Declared here —
 * not in src/main/ipc.ts's PushChannels — because the renderer build cannot import
 * main-process modules; main's PushChannels should absorb this entry when the voice
 * pipeline wires the emitter (harmless if never emitted).
 */
export interface MicLevelPush {
  'mic:level': (level: number) => void;
}
