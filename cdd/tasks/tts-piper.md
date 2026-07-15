# Task: tts-piper

## Objective
Implement `TextToSpeech` (src/voice/tts.ts) on Piper with sentence queueing, plus playback.

## Read first
- cdd/plan/voice-pipeline.md — TextToSpeech interface + PiperTts behavior (binding).

## Deliverables
- `PiperTts implements TextToSpeech`: FIFO queue; per item spawn piper `--output-raw`
  (voice sample rate read from the voice's .json config), pipe PCM to speaker. Playback via
  the same audio lib chosen in audio-capture (naudiodon output stream) or `ffplay -nodisp`
  fallback — behind an injected `PcmPlayer` interface { play(pcm, rate): Promise; stop() }
  so tests fake it.
- `cancel()`: kill current piper process, stop player, clear queue, resolve in-flight `speak`
  promises (resolved, not rejected).
- `speaking` true from first queued item until queue drains.
- `scripts/smoke/smoke-tts.ts`: speaks two sentences, cancels a third mid-way.

## Tests
- Fake spawn + fake player: queue order preserved; `speak` resolves after player resolves;
  cancel clears queue and stops player; concurrent speak calls serialize; piper crash →
  speak rejects but queue continues with next item.
- Voice-config parse: sample rate extracted from a fixture .json.

## Acceptance
- `npm test` passes; smoke script produces clear audio out the default output device and the
  cancel demonstrably cuts speech mid-sentence.
