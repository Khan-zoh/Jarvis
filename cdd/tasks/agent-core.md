# Task: agent-core

## Objective
Implement the backend-agnostic agent layer: `AgentBackend` types, system prompt builder,
`SessionStore`, `routeUtterance`, and `AgentRouter` — fully tested against fake backends.

## Read first
- cdd/plan/agent-backends.md — every interface here is binding.

## Deliverables
- `src/agents/types.ts` — AgentBackend, TurnHandle (verbatim from plan).
- `src/agents/prompt.ts` — buildSystemPrompt with all content requirements (identity, spoken
  style, tool doctrine, date/time/timezone).
- `src/agents/sessions.ts` — SessionStore per plan (JSON files in a dir, list cap 100,
  backend-native id mapping, title rule).
- `src/agents/seams.ts` — `ContextProvider` + `TurnObserver` interfaces per plan.
- `src/agents/router.ts` — routeUtterance (directive rules, case-insensitive, strips the
  directive and following comma/space) + AgentRouter per plan (busy guard with the spoken
  refusal emitted as a synthetic `text_delta`+`done`, init-failure → error event containing
  the backend's `problem` string, TurnRecord persistence including tool list). Router runs
  `ContextProvider.contribute` in parallel with a per-provider timeout and prepends non-null
  results as a context preamble; fires `TurnObserver.onTurn` detached after persistence;
  `setOffTheRecord` flag gates observers for the next turn.
- `test/fakes/fakeBackend.ts` — scripted-events FakeBackend for reuse by later tasks.

## Tests
- routeUtterance table: "ask codex to refactor this" → codex/"to refactor this" wait — spec
  says strip directive; expected cleanedInput "refactor this" (also strip leading "to").
  Add that rule to the implementation. Cases: "codex, what's up", "use claude for this",
  no directive, directive mid-sentence (NOT routed — only leading).
- SessionStore: round-trip, ordering, cap, native-id per backend, title truncation.
- Prompt: snapshot + contains agentName, ISO date.
- AgentRouter with FakeBackends: event passthrough order, busy refusal, override beats
  directive, persistence, interrupt delegates to in-flight handle. Plus seams: a fake
  ContextProvider's text is prepended; a slow provider is dropped at timeout without stalling;
  a fake TurnObserver fires after persistence and is skipped when off-the-record is set.

## Acceptance
- `npm test` passes; no Electron/network/audio imports anywhere in `src/agents/` core files
  (keep it plain Node for testability) — verified by tests running in node environment.
