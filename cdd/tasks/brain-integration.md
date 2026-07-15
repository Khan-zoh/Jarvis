# Task: brain-integration

## Objective
Wire the second brain into the live product: the `brain` MCP plugin (on-demand tools), the
app-side recall ContextProvider and auto-capture TurnObserver, the "off the record" voice path,
and the capture/undo UI. After this task the assistant remembers and recalls.

## Read first
- cdd/plan/second-brain.md — capture, recall, delivery split, plugin catalog. Binding.
- cdd/plan/agent-backends.md — ContextProvider/TurnObserver seams, router wiring. Binding.
- cdd/plan/extending.md — plugin recipe.

## Deliverables
- `packages/tools-mcp/src/plugins/brain/index.ts` — `ToolPlugin` id `brain`, settings
  `vaultDir`/`autoCapture`/`recallMode` per plan; `init` constructs a `BrainStore` (shared
  engine) + `OnnxEmbedder`; returns `brain_search`, `brain_add_note`, `brain_append`,
  `brain_read`, `brain_recent`, `brain_consolidate`. Stub tools with "second brain not enabled"
  when disabled/embedder missing. Add `brain` to `PLUGINS`.
- App recall provider `src/agents/brain/recallProvider.ts` implements `ContextProvider`:
  builds a preamble from `store.profile()` (always) + `store.search(utterance)` hits above
  `recallThreshold` (skip when recallMode = on-demand; always-inject-all when = proactive).
  Token-budgeted.
- App capture observer `src/agents/brain/captureObserver.ts` implements `TurnObserver`:
  when autoCapture on and not off-the-record, runs the extraction `DistillFn` via the active
  backend (a minimal non-streaming completion), `store.add(source:'auto')` each durable item,
  emits `brain:captured` (add to PushChannels). Debounce/skip trivial turns.
- App owns one shared `BrainStore` instance; the MCP plugin opens the same vault/index (WAL).
  Both constructed from `config.secondBrain`.
- Off-the-record: extend `routeUtterance` (or a pre-check in the conductor) to detect "off the
  record" / "don't remember this" / "forget that" → `router.setOffTheRecord(true)` for that turn
  (and, for "forget that", a `brain_remove`-style cleanup of the just-captured item).
- Router construction (in wire-and-converse's Conductor) now passes
  `{ providers:[recallProvider], observers:[captureObserver] }` when the brain is enabled.
- UI: overlay shows a brief "noted: <line>" on `brain:captured`; main window gets a
  **Recently captured** strip (mono list, one-click delete → `brain:remove` invoke); settings
  Brain section renders from the plugin manifest (vault path picker, auto-capture toggle, recall
  mode, "reindex" + "clean up my brain"/consolidate buttons) plus a "second brain: on/off"
  master toggle that gates model download.
- New config: `AppConfig.secondBrain { enabled: boolean; vaultDir: string; autoCapture: boolean;
  recallMode: 'hybrid'|'on-demand'|'proactive' }` (add to shared types + DEFAULT_CONFIG:
  enabled false until models fetched, vaultDir = `D:\JarvisBrain` (user's chosen off-OneDrive
  location; still configurable in settings), autoCapture true,
  recallMode 'hybrid').

## Tests
- brain plugin: each tool against a fake BrainStore; disabled → stub messages; MCP wire test
  lists brain tools when enabled.
- recallProvider: profile always included; hits gated by threshold; mode switches
  (on-demand→null, proactive→always) honored; budget respected.
- captureObserver: scripted DistillFn → correct `store.add` calls + `brain:captured` events;
  off-the-record suppresses; trivial turn skipped.
- Off-the-record detection table; "forget that" removes the last capture.
- Renderer (jsdom): captured strip renders + delete calls invoke; settings Brain section
  round-trips config.

## Acceptance
- `npm test` passes. Manual (brain enabled, models fetched): tell it "remember that my sister's
  birthday is March 3rd" → "noted" appears and a file lands in `captured/`; in a later turn ask
  "when is my sister's birthday?" → correct spoken answer with the note pulled via recall; say
  "off the record" then something personal → nothing captured; run consolidate → captured facts
  promoted into `memory/`/`profile.md`. Vault opens cleanly in Obsidian.
