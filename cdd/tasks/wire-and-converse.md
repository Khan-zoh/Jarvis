# Task: wire-and-converse

## Objective
Connect everything: pipeline utterances → AgentRouter → backends (with real tools attached) →
TTS + live UI. After this task the product works end-to-end by voice and by text bar.

## Read first
- cdd/plan/architecture.md — startup sequence steps 3–6, IPC flows (binding).
- cdd/plan/agent-backends.md, cdd/plan/tools-and-google.md — attachment contracts.

## Deliverables
- `src/main/index.ts` completed: construct SessionStore, ClaudeBackend, CodexBackend,
  AgentRouter; toolsMcpSpec now points at the built tools-mcp `dist/index.js`
  (dev: workspace path; packaged: resources path — resolve via a `paths.ts` util with an
  `app.isPackaged` branch).
- Wiring:
  - pipeline `utterance` → `router.dispatch(text, onEvent)`; every AgentEvent forwarded to
    BOTH `pipeline.onAgentEvent` and `windows.broadcast('agent:event')`.
  - transcript + state + mic-level events broadcast to renderers.
  - completed TurnRecord → `session:updated` broadcast.
  - `command:text` IPC → same dispatch path (skips pipeline audio, still speaks the reply if
    ttsEnabled — inject via `pipeline.injectText`? No: text-bar requests must NOT trigger TTS
    per UX; dispatch directly and only broadcast). Rule: TTS only for voice-initiated turns.
  - `pipeline:cancel` IPC + Esc in renderer → `router.interrupt()` + `pipeline.cancel()`.
  - Voice-initiated turn with router busy → spoken refusal already handled by router.
- Replace design-system demo driver default: renderer now consumes live events (demo stays
  behind `?demo=1`).
- Overlay show/hide driven by real state changes; main-window transcript updates live during
  streaming (render partial assistant text from text_delta accumulation).
- `ensureCodexConfig` invoked at startup (codex backend registers tools-mcp).

## Tests
- Integration test of the wiring seam: a `Conductor` class extracted from index.ts (so it's
  testable) with all-fake deps — voice utterance produces: dispatch called, events fanned to
  pipeline+broadcast, turn persisted+broadcast; text command produces dispatch WITHOUT tts
  calls; cancel fans out to router+pipeline.
- Renderer: transcript accumulates deltas correctly (jsdom).

## Acceptance
- `npm test` passes. Manual Gates B+C together: say "jarvis — what's on my calendar today?"
  → spoken correct answer, overlay shows tool ticker, main window logs the turn. "ask codex
  what 17×23 is" routes to codex. Text bar works silently. Esc cancels a long reply.
