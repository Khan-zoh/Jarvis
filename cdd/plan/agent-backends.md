# Agent Backends & Routing

All modules live in `packages/app/src/agents/`.

## AgentBackend interface (types.ts)

```ts
export interface TurnHandle { interrupt(): Promise<void> }

export interface AgentBackend {
  readonly id: BackendId;
  init(): Promise<{ ok: boolean; problem?: string }>;   // verifies login/CLI availability
  startTurn(args: {
    input: string;
    sessionId: string | null;          // backend-native session/thread id to resume, or null
    onEvent: (e: AgentEvent) => void;
  }): Promise<{ handle: TurnHandle; result: Promise<{ finalText: string; sessionId: string }> }>;
}
```

Contract: `onEvent` receives zero+ `text_delta`/`tool_start`/`tool_end` then exactly one
`done` or `error`. `result` resolves with the backend-native session id for resumption.
`interrupt()` must cause a prompt `error {message:'cancelled'}` or truncated `done`.

## System prompt (prompt.ts)

```ts
export function buildSystemPrompt(cfg: AppConfig): string;
```

Content requirements (same text for both backends, appended with `cfg.agents.claude.systemPromptExtra`):
- Identity: "You are <agentName>, a voice assistant on the user's Windows PC."
- Output style: answers will be SPOKEN — short conversational sentences, no markdown, no code
  blocks, no lists unless asked; lead with the answer.
- Tool doctrine: prefer tools over guessing; for destructive/outward actions (sending email,
  deleting events/files) state what you're about to do in the reply BEFORE calling the tool only
  when the user's request was ambiguous; never invent recipients.
- Include current date/time and timezone.

## ClaudeBackend (claude.ts)

Wraps `@anthropic-ai/claude-agent-sdk` `query()`. Auth: inherits the user's Claude Code login
(subscription). `init()` fails with a setup message if no login is detected.

Key `query()` options (behavioral spec, not code):
- `options.systemPrompt` = buildSystemPrompt output.
- `options.mcpServers` = `{ jarvisTools: { type:'stdio', command: process.execPath-independent node, args:[toolsMcpEntry] , env: {...google token dir...} } }`.
- `options.allowedTools` = the tools-mcp tool names (see tools-and-google.md) — nothing else;
  `permissionMode: 'bypassPermissions'` (headless voice app; safety comes from the limited tool
  surface, which has no shell/file-write tools).
- `options.resume` = sessionId when resuming; capture new session id from the SDK `system:init`
  message.
- Map SDK stream: assistant text deltas → `text_delta`; `tool_use` start/stop → `tool_start`
  (with a one-line human summary from tool name + key args) / `tool_end`; final result →
  `done`.
- `maxTurns`: 12.

## CodexBackend (codex.ts)

Wraps `@openai/codex-sdk`. Auth: user runs `codex login` once (ChatGPT account); `init()` runs
`codex login status` (child process) to verify and returns a setup message otherwise.

Behavioral spec:
- One `Codex` client; `startThread({ skipGitRepoCheck: true, workingDirectory: userData dir })`
  for new sessions, `resumeThread(sessionId)` to resume.
- MCP tools: written to `~/.codex/config.toml` under `[mcp_servers.jarvisTools]`
  (command/args/env identical to Claude's spec). A `ensureCodexConfig()` function owns
  idempotent TOML patching (create-or-update only our table, never touch other keys).
- Sandbox/approvals: configure the thread for non-interactive use (`sandboxMode:
  'read-only'` + our MCP tools carry the side effects; approvals: 'never').
- Map thread events: `item.updated agent_message` deltas → `text_delta`; `mcp_tool_call`
  begin/end → `tool_start`/`tool_end`; `turn.completed` → `done`; `turn.failed` → `error`.
- System prompt: prepended to the first `run()` input of each thread (Codex threads lack a
  persistent system-prompt option).

## Turn seams — ContextProvider & TurnObserver (seams.ts)

Two generic hooks the router runs around every turn. They keep the second brain (and any future
context source) out of the router's core: the router doesn't know what a "brain" is, only that
providers may add context before a turn and observers may react after one.

```ts
export interface ContextProvider {
  id: string;
  // Return text to prepend to this turn's input (as a "context" preamble), or null to add nothing.
  contribute(utterance: string, cfg: AppConfig): Promise<string | null>;
}

export interface TurnObserver {
  id: string;
  // Fired after a turn fully completes; may not block the reply (run detached, errors swallowed+logged).
  onTurn(turn: TurnRecord, flags: { offTheRecord: boolean }): Promise<void>;
}
```

The second brain registers a ContextProvider (profile.md + above-threshold semantic hits) and a
TurnObserver (auto-capture extraction). See second-brain.md.

## AgentRouter (router.ts)

```ts
export interface RouteDecision { backend: BackendId; cleanedInput: string }

export function routeUtterance(text: string, cfg: AppConfig): RouteDecision;

export class AgentRouter {
  constructor(backends: Record<BackendId, AgentBackend>, sessions: SessionStore, cfg: () => AppConfig,
    seams?: { providers?: ContextProvider[]; observers?: TurnObserver[] });
  dispatch(text: string, onEvent: (e: AgentEvent) => void, backendOverride?: BackendId): Promise<TurnRecord>;
  setOffTheRecord(next: boolean): void;          // "off the record" flag applied to the next turn
  interrupt(): Promise<void>;                    // interrupts the in-flight turn, if any
  readonly busy: boolean;
}
```

`routeUtterance` rules (first match wins):
1. Leading directive "ask codex …" / "use codex …" / "codex, …" → codex, directive stripped.
   Same for "claude".
2. Otherwise `cfg.agents.defaultBackend`.

`dispatch` behavior: refuses (spoken "one moment, still working") if `busy`; runs all
`ContextProvider.contribute` (in parallel, with a short timeout each so a slow provider can't
stall the reply) and prepends their non-null results as a context preamble to the backend input;
resolves the backend session id from the SessionStore's active session; persists a `TurnRecord`
on completion, then fires all `TurnObserver.onTurn` **detached** (never delays the spoken reply);
converts backend `init` failures into `error` events with the setup message. "off the record"
utterances ("don't remember this") set the flag so observers skip capture for that turn.

## SessionStore (sessions.ts)

```ts
export class SessionStore {
  constructor(dir: string);                       // userData/sessions/*.json
  activeSession(): SessionSummary;                // creates one if none
  newSession(): SessionSummary;
  list(): SessionSummary[];                       // most recent first, max 100
  turns(id: string): TurnRecord[];
  appendTurn(id: string, t: TurnRecord): void;
  backendSessionId(id: string, backend: BackendId): string | null;   // native id mapping
  setBackendSessionId(id: string, backend: BackendId, native: string): void;
}
```

A session groups turns; each backend keeps its own native thread id per session (switching
backends mid-session starts a fresh native thread but keeps UI history together). Title = first
user utterance truncated to 48 chars.

## Testing

- Unit: `routeUtterance` table-driven tests; SessionStore round-trip on temp dir; prompt builder
  snapshot.
- Integration: `AgentRouter` with two `FakeBackend`s (scripted event sequences) — asserts event
  ordering, busy-guard, TurnRecord persistence, override + directive routing.
- Live smoke scripts (manual, need logins): `scripts/smoke/smoke-claude.ts`,
  `smoke-codex.ts` — send "say hello in five words", print streamed events.
