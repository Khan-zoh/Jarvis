# Task: stt-whisper

## Objective
Implement `SpeechToText` (src/voice/stt.ts) on local whisper.cpp.

## Read first
- cdd/plan/voice-pipeline.md — SpeechToText interface + WhisperCppStt behavior (binding).

## Deliverables
- `WhisperCppStt implements SpeechToText` per plan: temp WAV write (implement a 30-line WAV
  header writer util `src/voice/wav.ts` — no dependency), spawn whisper-cli with the plan's
  flags, parse stdout/txt output, cleanup temp files in finally, normalize whitespace,
  `<2 chars → ''` rule. Timeout: kill process after 30s → throw.
- Paths (exe + model) injected via `init`, sourced from `resolveModelPaths()`.
- Also strip whisper artifacts: `[BLANK_AUDIO]`, `(...)` bracketed noise annotations,
  leading/trailing quotes.
- `scripts/smoke/smoke-stt.ts`: records 4s from mic (reuse capture), transcribes, prints text
  + latency ms.

## Tests
- wav.ts: header bytes verified field-by-field for a known 1s buffer.
- WhisperCppStt with a fake spawn (injectable `spawnFn` constructor param): flag assembly,
  output parsing, artifact stripping table, empty-result rule, temp cleanup on error,
  timeout kill.
- Integration (real binary, models present): transcribe `fixtures/utterance.pcm` → text
  contains "time" (fixture says "what time is it"). Mark with `describe.skipIf(!modelsPresent)`
  so CI without models still passes.

## Acceptance
- `npm test` passes; smoke script transcribes live speech with <2.5s latency for a short
  sentence on this machine (record measured latency in commit message).
