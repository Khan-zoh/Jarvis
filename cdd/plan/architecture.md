# Architecture

## Process model

```
┌────────────────────────────── Electron main process ─────────────────────────────┐
│  bootstrap (tray, windows, autostart)                                             │
│  ConfigStore ── AppConfig (JSON on disk + safeStorage for secrets)                │
│  VoicePipeline ── AudioCapture → WakeWord → VAD → STT   ┐                         │
│                                          TTS ◄──────────┤                         │
│  AgentRouter ── ClaudeBackend (Claude Agent SDK)        │ events                  │
│             └── CodexBackend  (@openai/codex-sdk)       │                         │
│  SessionStore (conversation persistence)                ▼                         │
│  IPC bridge  ───────────────────────────────► renderer windows                    │
└───────────────────────────────────────────────────────────────────────────────────┘
        │ stdio (MCP)                                    │ spawned child processes
        ▼                                                ▼
  packages/tools-mcp server                    whisper.cpp / piper executables
  (google, system, web tools)
```

- All audio and agent logic lives in the **main process**. Renderer windows are dumb views fed
  by IPC events.
- `tools-mcp` is a separate Node package started as a stdio MCP server. ClaudeBackend attaches
  it via the SDK `mcpServers` option; CodexBackend registers it in Codex config (see
  agent-backends.md).
- whisper.cpp and piper run as short-lived child processes; their binaries and models live under
  `models/` and are fetched by `scripts/fetch-models.ts` (never committed).

## Core state machine (owned by VoicePipeline)

```
idle ──wake word──► listening ──VAD end──► transcribing ──text──► thinking ──reply──► speaking ──► idle
  ▲                     │ (timeout/cancel)                            │ (error)          │ (barge-in wake word → listening)
  └─────────────────────┴─────────────────────────────────────────────┴─────────────────┘
```

```ts
export type AssistantState =
  | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';
```

Rules:
- Wake word detection is active in `idle` AND `speaking` (barge-in: saying the name while it
  talks cancels TTS and starts listening).
- `listening` times out to `idle` after `config.voice.listenTimeoutMs` of silence with no speech.
- A push-to-talk global hotkey and the text command bar enter the same machine at
  `transcribing`-equivalent (text is injected as a final transcript).

## Shared types (packages/app/src/shared/types.ts)

These types are imported by main and renderer; the IPC layer is typed against them.

```ts
export type BackendId = 'claude' | 'codex';

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
```

## IPC contract (packages/app/src/main/ipc.ts)

One module owns every channel name; renderer accesses them only through a preload-exposed
`window.jarvis` API. No `nodeIntegration` in renderers.

```ts
// main → renderer (webContents.send)
export interface PushChannels {
  'state:changed': (s: AssistantState) => void;
  'transcript': (e: TranscriptEvent) => void;
  'agent:event': (e: AgentEvent) => void;
  'session:updated': (turn: TurnRecord) => void;
  'config:changed': (c: AppConfig) => void;   // secrets redacted
}

// renderer → main (ipcRenderer.invoke)
export interface InvokeChannels {
  'config:get': () => Promise<AppConfig>;                    // secrets redacted
  'config:set': (patch: Partial<AppConfig>) => Promise<void>;
  'secret:set': (key: 'picovoiceAccessKey'|'googleClientSecret', value: string) => Promise<void>;
  'command:text': (text: string, backend?: BackendId) => Promise<void>; // text command bar
  'pipeline:cancel': () => Promise<void>;                    // stop listening/speaking/turn
  'session:list': () => Promise<SessionSummary[]>;
  'session:load': (id: string) => Promise<TurnRecord[]>;
  'session:new': () => Promise<void>;
  'google:connect': () => Promise<{ email: string }>;        // runs OAuth flow
  'google:disconnect': () => Promise<void>;
  'audio:listInputs': () => Promise<{ id: string; label: string }[]>;
  'app:quit': () => Promise<void>;
}
```

`buildPreloadApi(ipcRenderer)` returns a typed object implementing both directions; it is the
only thing exposed via `contextBridge.exposeInMainWorld('jarvis', ...)`.

## ConfigStore (packages/app/src/main/config.ts)

```ts
export class ConfigStore {
  constructor(userDataDir: string);
  get(): AppConfig;                                  // secrets decrypted, main-process only
  getRedacted(): AppConfig;                          // secrets replaced with '•set' / ''
  set(patch: Partial<AppConfig>): void;              // deep-merges, persists, emits 'changed'
  setSecret(key: string, value: string): void;       // encrypts via Electron safeStorage
  on(event: 'changed', fn: (c: AppConfig) => void): void;
}
```

Behavior: JSON file `config.json` in `app.getPath('userData')`; secrets stored in a sibling
`secrets.bin` encrypted with `safeStorage` (Windows DPAPI). Defaults come from
`DEFAULT_CONFIG` exported by the same module.

## Windows & tray (packages/app/src/main/windows.ts)

```ts
export class WindowManager {
  constructor(config: ConfigStore);
  createTray(): void;              // icon, menu: Open, New session, Start/stop listening, Quit
  showOverlay(): void;             // frameless, always-on-top, bottom-center, click-through when idle
  hideOverlay(): void;
  showMain(): void;                // history + settings window
  broadcast<K extends keyof PushChannels>(ch: K, ...args: Parameters<PushChannels[K]>): void;
  registerHotkey(accelerator: string, onTrigger: () => void): void;  // global text-bar hotkey
}
```

Overlay behavior contract: hidden in `idle`; fades in on wake; shows state + live transcript +
streaming reply; fades out 4s after returning to `idle`.

## Startup sequence (packages/app/src/main/index.ts)

1. Single-instance lock; second launch focuses the main window.
2. Load ConfigStore → create WindowManager (tray immediately).
3. Construct tools-mcp launch spec (command + args) from config.
4. Construct AgentRouter with Claude + Codex backends and SessionStore.
5. Construct VoicePipeline (capture, wake, vad, stt, tts) but start it only if the wake-word
   prerequisites are configured (access key + keyword + models present); otherwise stay in
   text-only mode and surface a setup notice in the main window.
6. Wire: pipeline finalTranscript → router.dispatch → agent events → TTS sentence queue +
   IPC broadcast.

## Error policy

- Any module failure maps to state `error` with a human-readable message pushed on
  `agent:event {kind:'error'}`; pipeline returns to `idle` after 3s. The app never crashes on a
  missing model/binary — it degrades to text-only mode and tells the user what to fix.
