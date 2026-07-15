# Testing Strategy

## Tooling

- **vitest** for all unit/integration tests (`npm test` at root runs both packages).
- **jsdom** environment for renderer view classes.
- Audio fixtures: `packages/app/test/fixtures/*.pcm` (16kHz mono s16le) — one utterance
  ("what time is it"), one silence clip, generated once by `scripts/make-fixtures.ts` from a
  recorded WAV committed as source.
- Fakes live in `packages/app/test/fakes/` and implement the plan interfaces exactly:
  `FakeCapture` (replays fixture frames), `FakeWake` (fires at frame N), `FakeStt`,
  `FakeTts` (records calls), `FakeBackend` (scripted AgentEvent sequences).

## Layer map

| Layer | What is tested | How |
|---|---|---|
| Pure logic | SentenceChunker, routeUtterance, endpointing rule, prompt builder, token redaction | plain unit tests, table-driven |
| Stores | ConfigStore, SessionStore | temp-dir round-trips; secrets never in plaintext file (assert ciphertext) |
| Voice integration | VoicePipeline state sequence, barge-in, timeout, cancel | fakes + real Silero VAD on fixtures |
| Agent integration | AgentRouter event ordering, busy-guard, persistence, backend fallback errors | FakeBackends |
| Tools | every MCP handler | mocked googleapis / child_process; assert request shape + output text format |
| MCP wire | server boots, tools/list contains all loaded-plugin tools, a throwaway plugin appears with no other edit, one round-trip call | MCP client SDK over stdio in-test |
| Renderer | OverlayView + MainView state→DOM | jsdom + fake JarvisApi |
| Live smoke (manual, not CI) | real wake word, real STT/TTS, real Claude/Codex login, real Google | `scripts/smoke/*.ts`, checklist in docs/smoke.md |

## Rules for task authors/executors

1. Every task ships its tests in the same task; a task is not done until `npm test` passes.
2. Anything touching hardware, login, or the network must sit behind a plan interface with a
   fake, so CI never needs a mic, speaker, or account.
3. Live smoke scripts are still required deliverables (they're the only proof the real
   integrations work) but are run manually at the phase gates in order.json.
4. No snapshot tests except the system prompt (one intentional snapshot).

## Phase gates (manual verification checkpoints)

- **Gate A** (after voice tasks): run `smoke-wakeword`, speak → see transcript printed, hear
  TTS echo it back. Latency budget: wake→listening indicator <300ms; end-of-speech→text <2.5s.
- **Gate B** (after backend tasks): `smoke-claude` + `smoke-codex` stream real replies.
- **Gate C** (after tools tasks): `smoke-google` lists real calendar events; voice request
  "what's on my calendar today" round-trips end-to-end.
- **Gate D** (after packaging): installer installs on a clean Windows user account; app
  launches, degrades gracefully with nothing configured, setup flow completes.
