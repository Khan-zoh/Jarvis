# Task: voice-pipeline

## Objective
Implement `SentenceChunker` and `VoicePipeline` — the state machine tying capture, wake, VAD,
STT, and TTS together — and wire it into main-process startup behind config gating.

## Read first
- cdd/plan/voice-pipeline.md — SentenceChunker + VoicePipeline contracts (binding).
- cdd/plan/architecture.md — state machine, startup sequence step 5–6, error policy.

## Deliverables
- `src/voice/chunker.ts` — SentenceChunker per plan (boundary rules, markdown stripping,
  220-char cap).
- `src/voice/pipeline.ts` — VoicePipeline per plan: full state machine, barge-in, listen
  timeout, cancel, injectText, onAgentEvent → chunker → tts, wake sound playback, mic-level
  computation (RMS of each frame while listening → emit for `mic:level`), error policy
  (3s auto-recover to idle).
- `src/main/index.ts` update: startup step 5 — construct pipeline with real components when
  `resolveModelPaths()` is complete AND picovoice key + keyword configured; else skip pipeline
  (text-only mode) and record `voiceDisabledReason: string` surfaced through a new
  `'voice:status'` invoke channel (add to shared types + preload).
- Tray "pause/resume listening" now functional (pipeline stop/start).

## Tests
- Chunker: table-driven (multi-sentence delta streams, markdown stripping, cap, flush tail).
- Pipeline integration with fakes (per testing-strategy.md): full happy-path state sequence;
  barge-in during speaking; listen timeout → idle with no STT call; cancel during thinking
  stops TTS and ignores late agent events; empty transcript → idle silently; error event →
  error → idle after 3s (use fake timers).

## Acceptance
- `npm test` passes. Manual Gate A: with models + key configured, `npm run dev` → say
  "jarvis", overlay appears with listening bars, speak, transcript shows; (router not wired
  yet) pipeline emits `utterance` — log it. TTS echo test: temporary dev flag `--echo` makes
  pipeline speak the transcript back. Wake→listening <300ms.
