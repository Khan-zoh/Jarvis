# Plan Amendments — 2026-07-15 (post independent architecture review)

An independent senior review (GPT-5.6 Sol, high reasoning, read-only repo access) was run after
Phase 1 and before locking Phase 2 contracts. Findings were verified against the repo before
adoption. **Precedence: where this file conflicts with other plan docs, this file wins.** Task
authors must read this alongside their task file.

## Adopted — blocking (verified wrong assumptions in the original plan)

### A1. Claude backend permission model (replaces agent-backends.md lines ~45-50)
`allowedTools` + `permissionMode:'bypassPermissions'` is NOT a safety boundary: allowedTools only
pre-approves matching tools, it does not remove the others, and bypassPermissions approves
everything (Bash, Write, Edit included). The claude-backend task MUST instead:
- Remove/disable Claude Code built-in tools (SDK `tools: []` or equivalent for the pinned version),
  keeping only the jarvisTools MCP server.
- Use a non-bypass permission mode (e.g. `dontAsk`-style deny-by-default for anything unexpected).
- Defense-in-depth: explicitly disallow Bash/Edit/Write if the pinned SDK supports it; run with a
  non-sensitive empty cwd; no user/project settings sources.
- **Gate B acceptance now includes**: inspect the SDK init message and assert the effective tool
  list contains ONLY jarvisTools MCP tools; a prompt instructing Claude to run a shell command must
  fail (tool unavailable/denied).

### A2. Gate B0 — SDK spike moved ahead of backend work (new task, before Phase 5)
Both SDK integrations get a pinned-version spike proving: subscription login, one streamed reply,
one benign MCP echo-tool call, session resume, cancellation before/during streaming, MCP child
startup-failure behavior, and (Claude) built-in tool suppression per A1. Codex: pass MCP config
per-`Codex`-instance (SDK config overrides) — do NOT patch the user's global `~/.codex/config.toml`
(this also removes codex-backend.md's TOML byte-preservation requirement, which is unimplementable).
Use the SDK-bundled CLI for both status checks and turns (the global `codex` binary is not the one
the SDK runs).

### A3. MCP stdio servers are per-client, not shared runtime (architecture.md process model note)
Each backend client spawns its OWN tools-mcp instance; instances may be short-lived. Decision:
**stateless disposable workers** (Sol's option 1; the named-pipe capability host is rejected as
disproportionate for a single-user app — revisit only if evidence shows state races in practice).
Consequences, binding on all plugin/task authors:
- No plugin may keep must-survive state solely in process memory.
- Durable state → files under JARVIS_DATA_DIR, written atomically (temp+rename).
- `timer_set` → durable one-shot Windows Scheduled Task (schtasks), not in-process setTimeout.
- Google OAuth token refresh must be single-writer-safe across processes: atomic replace +
  re-read-after-lock (file lock) before refreshing; tolerate a concurrent refresh having won.
- Brain store: writer ownership must be single-instance-safe (see A8).

### A4. ToolPlugin contract hardening (lean subset; tools-mcp-core)
- Optional per-tool `effect: 'read'|'local-write'|'outward'|'destructive'` (default 'read'),
  mapped to MCP annotations (readOnlyHint/destructiveHint/openWorldHint).
- Thrown handler errors → MCP result with `isError: true` + "error: <message>" (never a plain ok).
- Handler context carries an AbortSignal; loader enforces a default 30s per-call timeout.
- Optional `ToolPlugin.dispose()`.
- Full versioned mega-contract (structured output schemas, principals, confirmation enums,
  migrations) REJECTED as overkill for 0.1.

### A5. Server-side tool guards (tools-mcp-core; prompt wording is not an authorization boundary)
- `web_fetch`: http/https only; SSRF guard (resolve + refuse private/loopback/link-local); max 3
  redirects re-validated per hop; body byte cap.
- `open_app_or_url`: http/https URLs only; apps only via Start-Menu .lnk resolution; arbitrary
  paths/executables refused unless plugin setting `allowUnsafePaths` (default false).
- Outward/destructive confirmation UX: deferred to wire-and-converse — the `effect` annotation
  (A4) is the hook it will build on; google-tools must annotate gmail_send / event-delete etc. as
  `outward`/`destructive`.

### A6. Voice pipeline corrections (before Phase 3 tasks)
- VAD interface MUST be async (onnxruntime `run()` returns a Promise; the plan's sync signature is
  unimplementable). Serialize inference per frame; drop frames if inference falls behind.
- FFmpeg (ffmpeg.exe + ffplay.exe, pinned build, sha256) becomes a provisioned artifact in
  fetch-models + resolveModelPaths — never resolved from PATH. Audio capture uses FfmpegCapture
  (dshow) with device names (not generic IDs) as the Windows contract; naudiodon2 is dropped
  (does not build here).
- Pipeline stays in the Electron main process for 0.1 (frames are small; whisper/piper/ONNX-heavy
  work already lives in child processes). Utility-process migration REJECTED for now; re-evaluate
  at Gate A if latency budget or UI responsiveness fails. Latency components must be measured
  separately at Gate A (capture→endpoint, STT, backend first token, first TTS audio, total).
- Barge-in (wake-word during speaking) is at echo-retrigger risk without AEC: Gate A must test it
  live; fallback is disabling wake-during-speaking + hotkey interrupt.

### A7. Early packaging smoke (new task after Phase 3, not Phase 10)
Minimal electron-builder build proving: better-sqlite3, onnxruntime-node, porcupine load inside
packaged Electron; tools-mcp + native deps work outside ASAR; whisper/piper/ffmpeg spawn from an
installed layout; one text-mode MCP turn works from the installed build on a clean profile.

### A8. Second-brain contract resolutions (before brain-store lands)
- Writer ownership: second-brain.md's "app owns writes / plugin only reads" contradicts the
  brain_* tool catalog (add/append/consolidate ARE plugin-process writes). Resolution: BOTH
  processes may write; safety comes from BrainStore itself — SQLite WAL + busy-timeout, every
  write inside an immediate transaction, vault file writes atomic (temp+rename). Drop the
  exclusivity sentence; the engine must be safe wherever it's instantiated.
- Capture identity: "one captured/YYYY-MM-DD.md append-only file per day" contradicts the Note
  API (per-item id/remove/undo). Resolution: one file PER CAPTURED ITEM —
  `captured/YYYY-MM-DD-<slug>-<shortid>.md` — preserving per-item identity, dedup, deletion, and
  reindexing; equally Obsidian-friendly.
- Off-the-record semantics (also for brain-integration): "off the record" = observers/brain capture
  skipped; the turn IS still persisted to local session history. UI copy must say exactly that.

### A9. Gate B0 spike results (2026-07-16; evidence + templates in spikes/b0/)
Pinned: `@anthropic-ai/claude-agent-sdk` 0.3.211 (bundles CLI 2.1.211; peer-requires zod ^4 — we
are on zod 4 ✓), `@openai/codex-sdk` 0.144.5 (spawns its own bundled codex.exe, never PATH).
Binding corrections to agent-backends.md:
- Claude config template = spikes/b0 A1-compliant snippet: `tools: []` (VERIFIED: only
  `mcp__…` tools remain; without it 32 built-ins incl. Bash/Write are present), `permissionMode:
  'dontAsk'`, `allowedTools: ['mcp__jarvisTools__*'…]`, `settingSources: []`, `strictMcpConfig:
  true`, `alwaysLoad: true` on the MCP server, `includePartialMessages: true` (REQUIRED for text
  deltas), `abortController` for interrupt.
- There is NO login-status API: auth failure surfaces as `assistant.error:'authentication_failed'`
  while result subtype reads `success` — init() needs its own probe; never trust subtype alone.
- Claude MCP child failure → `init.mcp_servers[].status === 'failed'` (assert at Gate B). Codex
  MCP child failure is SILENT — backend must health-check the tools server out-of-band.
- Codex: per-instance `new Codex({ config: { mcp_servers: … } })` works (no config.toml patching —
  delete ensureCodexConfig from the plan). `thread.runStreamed(input,{signal})`, resume via
  `codex.resumeThread(id)`, abort throws AbortError with atomic-text semantics.
- Codex emits NO incremental text deltas (one `item.completed:agent_message`): Codex replies reach
  TTS only when complete — record as voice-latency consideration; sentence-queue TTS still applies.
- Codex shell CANNOT be removed; containment = `sandboxMode:'read-only'` + `approvalPolicy:
  'never'` (verified: model's file-write attempt failed "filesystem is read-only"). Accepted for
  0.1: Codex tool surface is sandbox-contained, not suppressed.
- **Machine blocker (user action)**: this machine's Claude login is Desktop host-managed; spawned
  CLIs see "Not logged in". Before Gate B the user must run a standalone `claude /login` (or
  `claude setup-token`), then re-run `spikes/b0/claude-spike.mjs` to close Claude items 1-2/4/5.

## Adopted — non-blocking (fold into later task briefs)
- Google OAuth scopes: narrowest per operation; explain each scope at consent (google-auth).
- Pin exact versions of both agent SDKs (no carets) (Gate B0/backends).
- Session/config writes: atomic temp+rename (small refactor task, low priority).
- Renderer `sandbox: true`: desired, but preload is ESM (.mjs) and sandboxed preloads must be CJS —
  needs a real GUI verification; owned by wire-and-converse. Do not blind-flip.
- Stub tools for inactive plugins: keep compact (a status/setup hint, not a large fake surface).
- Gates B/C get adversarial cases: prompt injection via email/web content, SSRF attempt, malformed
  tool output, MCP worker crash mid-turn, cancellation during an outward action.
- Backend switching mid-session: inject a bounded cross-backend summary on first switch, or surface
  "new backend lacks context" (wire-and-converse).
- Brain dedup threshold 0.92 + profile budget become config values, not constants (brain-store).
- Error policy: auth/missing-model failures surface as durable setup/degraded states, not the
  3s-reset transient error (wire-and-converse/settings-ui).

## Rejected / deferred (with rationale)
- Named-pipe shared capability host (A3): disproportionate for single-user; stateless workers cover it.
- Full TurnRequest/TurnOutcome seam redesign: current seams are plan-conformant, tested, and
  mockable; backends adapt at integration. Revisit only if Gate B0 shows the seams cannot express
  real SDK behavior (cancellation race note: backends must return their TurnHandle immediately).
- Voice utility process (A6): deferred pending Gate A evidence.
- Generic plugin settings IPC (`plugin:*` channels): implementation deferred to settings-ui, but no
  new code may hard-code the two-secret assumption; the manifest from pluginManifests() is the
  source of truth for what settings exist.
