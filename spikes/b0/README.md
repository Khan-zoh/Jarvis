# Gate B0 — SDK spike (evidence, not production code)

Standalone workspace (NOT an npm workspace member — root `workspaces` is `packages/*` only).
Run everything from this directory. `npm install` here only.

## Pinned versions (recorded 2026-07-16)
| package | version |
|---|---|
| @anthropic-ai/claude-agent-sdk | 0.3.211 (runs its own downloaded native CLI v2.1.211) |
| @openai/codex-sdk | 0.144.5 (spawns bundled `@openai/codex-win32-x64` vendor `codex.exe` v0.144.5, NOT the global PATH codex 0.144.4) |
| @modelcontextprotocol/sdk | 1.29.0 |
| zod | 4.4.3 (claude-agent-sdk 0.3.211 peer-requires zod ^4; zod 3 fails ERESOLVE) |

## Files
- `echo-mcp.mjs` — one-tool stdio MCP server (`echo` → `ECHO:<text>`), pattern from packages/tools-mcp.
- `mcp-direct-test.mjs` — auth-independent proof the echo server works (real MCP client, tools/list + call).
- `claude-spike.mjs` — Claude proofs 1–6 (stream, MCP echo, A1 tool suppression, resume, cancel, MCP start-fail). Results → `out/claude-results.json`.
- `claude-a1-toolsurface.mjs` — focused A1 proof: inspects `system:init.tools` with `tools: []` + `alwaysLoad` MCP server (auth-independent — init is emitted before inference).
- `codex-spike.mjs` — Codex proofs 1–7. Results → `out/codex-results.json`.
- `codex-cancel.mjs` — focused AbortSignal-mid-turn proof.

## Re-run
```
npm install
node mcp-direct-test.mjs        # no auth needed
node claude-a1-toolsurface.mjs  # no auth needed (aborts before inference)
node claude-spike.mjs           # needs a standalone Claude Code login (see caveat)
node codex-spike.mjs            # needs `codex login` (ChatGPT) — auth.json on disk
node codex-cancel.mjs
```
Every SDK call carries a hard 60s abort; scripts exit(0) and kill children.

## Big caveat found during the spike (Claude auth)
In this dev environment the user's Claude subscription login lives in Claude **Desktop's
host-managed auth channel** (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`); there is no
`~/.claude/.credentials.json` and no Credential Manager entry. ANY spawned CLI — including
Desktop's own `claude.exe` run standalone — reports `Not logged in · Please run /login`
(`apiKeySource: none`, assistant error `authentication_failed`). Claude inference proofs
therefore require a machine where `claude /login` (or `claude setup-token`) was run
standalone. Everything auth-independent (tool surface, MCP wiring, MCP failure surfacing,
event shapes) was still proven for the pinned version.
