# Outward/destructive tool confirmation — 0.1 behavior and the deferred design

Status: **visibility shipped in 0.1 (wire-and-converse); blocking confirmation deferred.**
Contract hook: cdd/plan/amendments.md §A4/§A5 — tools-mcp annotates every tool with
`effect: 'read' | 'local-write' | 'outward' | 'destructive'` (mapped to MCP
readOnlyHint/destructiveHint/openWorldHint). `gmail_send` is `outward`;
`calendar_create_event` / `calendar_delete_event` are annotated accordingly.

## What 0.1 does (implemented)

Outward and destructive tool calls are **allowed but always visible**:

- Every `tool_start` / `tool_end` is broadcast on `agent:event` and shown
  - in the overlay tool ticker (`→ sending an email to sam…` / `✓ gmail_send`), and
  - in the main window as live footnote lines under the streaming turn.
- On voice-initiated turns the pipeline also **speaks** each `tool_start` summary as it happens
  ("sending an email to sam.") and speaks tool failures ("gmail send didn't work."), so an
  outward action is announced audibly before its result is narrated. Text-bar turns stay silent
  by rule (TTS is voice-only); their visibility is the main-window footnotes + ticker.
- The persisted `TurnRecord.tools` list keeps the per-tool ✓/✕ history.

This satisfies A5's hook — the `effect` annotation exists server-side, the app surfaces every
call — without inventing a blocking UX the plan never specified.

## Deferred design (for a later task; do not build piecemeal)

- Config: `agents.confirmOutward: boolean` (default `true`).
- Enforcement lives in the **router layer** (not prompts — prompt wording is not an
  authorization boundary, A5): when a backend streams a `tool_start` whose tool is annotated
  `outward`/`destructive` AND `confirmOutward` is on AND the turn is voice-initiated, the app
  pauses/holds the turn, speaks and displays "about to \<summary> — say confirm or cancel", and
  resumes or interrupts on the user's answer.
- Open problems that pushed this out of 0.1:
  - Neither SDK exposes a "pause this tool call" primitive today; a real gate needs an MCP-side
    hold (tools-mcp waiting on an app-mediated approval channel) or SDK permission callbacks.
  - Barge-in/confirmation grammar ("confirm"/"cancel" recognition) inside the `speaking` state.
  - Timeout semantics (what happens when the user says nothing).
