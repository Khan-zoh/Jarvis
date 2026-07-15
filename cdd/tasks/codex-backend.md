# Task: codex-backend

## Objective
Implement `CodexBackend` on `@openai/codex-sdk` (ChatGPT-account auth via Codex CLI login),
including idempotent MCP-server registration in `~/.codex/config.toml`.

## Read first
- cdd/plan/agent-backends.md — CodexBackend spec (binding).
- Verify current @openai/codex-sdk API (thread events, options) from its README/types at
  implementation time — the plan names intents, the SDK's real names win; document any
  mapping deviations in code comments.

## Deliverables
- `src/agents/codex.ts` — `CodexBackend implements AgentBackend`:
  - `init()`: spawn `codex login status`; non-zero/“not logged in” → problem "codex not
    logged in — run `codex login` in a terminal." Also handle codex CLI missing entirely
    ("codex cli not installed — npm i -g @openai/codex").
  - `ensureCodexConfig(spec)`: parse-or-create config.toml, upsert ONLY
    `[mcp_servers.jarvisTools]` (command/args/env), preserve all other content byte-exact.
    Use `@iarna/toml` or equivalent.
  - `startTurn()`: startThread/resumeThread per plan (skipGitRepoCheck, workingDirectory =
    userData, sandbox read-only, approvals never); system prompt prepended to first run input
    of a new thread; event mapping → AgentEvent; capture thread id for resumption.
  - `interrupt()`: abort the run (SDK abort signal or kill).
- Model override from `cfg.agents.codex.model` when set.

## Tests
- ensureCodexConfig: creates fresh file; upserts into existing toml with unrelated tables
  preserved exactly; idempotent second run byte-identical.
- Mocked SDK: thread lifecycle (new vs resume), prompt-prepend only on first run of new
  thread, event mapping table, login-status parsing (logged in / not / CLI missing).
- Live smoke `scripts/smoke/smoke-codex.ts` (real login, manual).

## Acceptance
- `npm test` passes; live smoke streams a real codex reply; a pre-existing config.toml with
  other MCP servers survives ensureCodexConfig untouched except our table.
