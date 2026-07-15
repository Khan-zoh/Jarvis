# Task: vad-endpointing

## Objective
Implement `VoiceActivityDetector` (src/voice/vad.ts) on Silero VAD via onnxruntime-node, plus
the reusable `Endpointer` helper that turns per-frame speech/silence into utterance boundaries.

## Read first
- cdd/plan/voice-pipeline.md — VoiceActivityDetector interface + endpointing rule (binding).

## Deliverables
- `SileroVad implements VoiceActivityDetector`: loads `models/vad/silero_vad.onnx`
  (path injected), maintains the model's recurrent state across `process` calls, resets on
  `reset()`. Speech threshold 0.5 (constant, documented).
  Note: Silero v4 expects specific input tensor names (`input`, `sr`, `h`, `c`) and
  float32 input — convert Int16Array frames to normalized Float32Array.
- `Endpointer` (same file): `push(v: 'speech'|'silence'): 'continue'|'end'|'too-long'` —
  end after 800ms silence following ≥1 speech frame; too-long at 15s; frame duration derived
  from 512/16000. Constructor takes `{ silenceMs, maxMs }` for testability.
- `scripts/smoke/smoke-vad.ts`: mic → prints live `█`/`·` per frame and "ENDPOINT" on end.

## Tests
- Endpointer: pure table-driven tests (silence-only → never ends; speech then 24 silence
  frames → 'end' on the 25th (25×32ms=800ms); continuous speech → 'too-long' at frame 469).
- SileroVad integration: run real model over `fixtures/utterance.pcm` → speech detected in the
  middle, silence at edges; `fixtures/silence.pcm` → no speech frames. (Real onnx in CI is
  fine — CPU, tiny model.)

## Acceptance
- `npm test` passes including the real-model fixture tests.
