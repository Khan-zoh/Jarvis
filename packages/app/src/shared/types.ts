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
    sensitivity: number;                   // 0..1, default 0.6; higher = easier to trigger
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
  /**
   * Second brain (cdd/plan/second-brain.md, amended by amendments.md A8). `enabled` is the master
   * toggle — false until the user turns it on and the embedding model is fetched; it gates the
   * app-side recall provider + auto-capture observer (and the model download). `vaultDir` is the
   * markdown vault location (kept off OneDrive by default). `recallMode`: hybrid = profile +
   * above-threshold notes; on-demand = profile only (notes only when the model searches);
   * proactive = profile + all notes with a hit.
   */
  secondBrain: {
    enabled: boolean;
    vaultDir: string;
    autoCapture: boolean;
    recallMode: 'hybrid' | 'on-demand' | 'proactive';
  };
}

/**
 * One auto-captured note surfaced to the renderer: the "noted: <title>" overlay toast and the
 * main-window "recently captured" strip (with one-click undo). A trimmed view of a BrainStore
 * Note — the renderer never imports the store (it pulls in Node/better-sqlite3).
 */
export interface CapturedNote {
  id: string;
  title: string;
  /** ISO timestamp the note was captured/updated. */
  at: string;
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
 * and — when it is not — a human-readable reason (usually missing models/binaries). Missing
 * prerequisites are NOT a transient error; they put the
 * app in text-only mode until the user fixes the named cause (cdd/plan/amendments.md A6, error
 * policy nuance).
 */
export interface VoiceStatus {
  /** True when the wake-word + voice pipeline is live; false in text-only mode. */
  enabled: boolean;
  /** Why voice is off (for the settings/setup UI), or null when enabled. */
  reason: string | null;
}

/**
 * Renderer-facing mirror of `@jarvis/tools-mcp`'s `PluginSetting` (src/plugin.ts). Duplicated
 * here — same pattern as `JarvisApi` in renderer/shared/api.ts — because the renderer build must
 * never import a package that pulls in Node/Electron internals. Keep the `kind` union in sync by
 * hand; the settings UI renders one control per kind and ignores kinds it does not recognize.
 */
export interface PluginSettingDto {
  key: string;
  label: string;
  kind: 'text' | 'secret' | 'toggle' | 'number' | 'action';
  placeholder?: string;
  help?: string;
}

/** One entry per loaded tools-mcp plugin — the settings UI renders one section per manifest,
 * fields from `settings` (amendments.md's deferred "generic plugin settings IPC"). */
export interface PluginManifest {
  id: string;
  displayName: string;
  settings: PluginSettingDto[];
}

/** Result of `plugin:getConfig` — the plugin's non-secret config plus which secret keys are
 * currently set (never their values). */
export interface PluginConfigDto {
  config: Record<string, unknown>;
  secretsSet: string[];
}

/** One backend's `init()` probe result (agents/types.ts `AgentBackend.init`), as returned per
 * backend by the `accounts:status` invoke. */
export interface BackendProbe {
  ok: boolean;
  problem?: string;
}

/** Result of the `accounts:status` invoke: both backends probed via their real `init()`. */
export interface AccountsStatus {
  claude: BackendProbe;
  codex: BackendProbe;
}

/** Result of the `models:status` invoke — `resolveModelPaths` distilled for the settings UI. */
export type ModelsStatus = { ok: true } | { ok: false; missing: string[] };

/** Result of the `models:fetch` invoke (progress arrives separately on `models:progress`). */
export interface ModelsFetchResult {
  ok: boolean;
  /** Names of specs that failed to fetch (empty when ok). */
  failed: string[];
}

/**
 * The factory-default AppConfig. Lives in shared/ (pure data, no Electron) so BOTH the main
 * process (ConfigStore's baseline) and the renderer (first-run detection for the setup
 * checklist) use the same source of truth.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  agentName: 'Jarvis',
  voice: {
    sensitivity: 0.6,
    inputDeviceId: null,
    listenTimeoutMs: 8000,
    sttModelPath: '',
    ttsVoicePath: '',
    ttsEnabled: false
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

/**
 * True when `c` is indistinguishable from the factory default. Works on the REDACTED config the
 * renderer sees, because an unset secret redacts to `''` — exactly the default value — while a
 * set one redacts to `'•set'` (≠ default), which is the correct "not default anymore" signal.
 */
export function isDefaultConfig(c: AppConfig): boolean {
  return JSON.stringify(c) === JSON.stringify(DEFAULT_APP_CONFIG);
}
