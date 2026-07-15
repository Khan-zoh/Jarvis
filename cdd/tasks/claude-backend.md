# Task: claude-backend

## Objective
Implement `ClaudeBackend` on `@anthropic-ai/claude-agent-sdk`, streaming AgentEvents and
resuming sessions, authenticated through the user's existing Claude Code login.

## Read first
- cdd/plan/agent-backends.md — ClaudeBackend spec (binding).
- cdd/plan/tools-and-google.md — `toolsMcpSpec` + "Backend attachment contract" (grant the whole
  `jarvisTools` server via `allowedTools: ['mcp__jarvisTools']`; no per-tool allowlist).
  `toolsMcpSpec` is implemented for real in wire-and-converse — for now create
  `src/agents/toolsLauncher.ts` with the real signature returning the tools-mcp entry path.
- Consult the claude-api skill / SDK docs if any `query()` option shape is uncertain — do not
  guess option names.

## Deliverables
- `src/agents/claude.ts` — `ClaudeBackend implements AgentBackend`:
  - `init()`: verify auth by checking for Claude Code credentials (run
    `claude --version` and a 1-token no-op is too costly — instead check
    `%USERPROFILE%\.claude\.credentials.json` or `claude auth status` if available; pick the
    most reliable detection and document it). Problem string: "claude code not logged in —
    run `claude` in a terminal and sign in."
  - `startTurn()`: SDK `query()` with systemPrompt, mcpServers from toolsMcpSpec,
    allowedTools, permissionMode bypassPermissions, maxTurns 12, resume when sessionId given.
    Map the SDK's streamed messages → AgentEvent per plan (tool_start summary: humanize
    e.g. `gmail_search {query:"from:amy"}` → `searching gmail for "from:amy"` via a
    `summarizeToolCall(name, input)` util with a default fallback `using <name>`).
  - `interrupt()`: SDK abort mechanism (AbortController / query.interrupt — whichever the SDK
    provides).
- `summarizeToolCall` in `src/agents/summarize.ts` (shared with codex backend).

## Tests
- Mock the SDK module: option assembly (prompt/resume/allowedTools/mcpServers), message→event
  mapping table (init msg captures session id; text deltas; tool use begin/end; result→done;
  SDK error→error), interrupt path.
- summarizeToolCall table for every ALLOWED_TOOL_NAME + unknown fallback.
- Live smoke `scripts/smoke/smoke-claude.ts`: "reply with exactly: hello from claude" →
  prints streamed deltas + done. Requires real login; not in CI.

## Acceptance
- `npm test` passes; live smoke works on this machine (record output in commit message).
