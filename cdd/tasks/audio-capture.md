# Task: audio-capture

## Objective
Implement `AudioCapture` (packages/app/src/voice/capture.ts): microphone → 16kHz mono s16
512-sample frames, with device listing.

## Read first
- cdd/plan/voice-pipeline.md — AudioCapture interface (binding).

## Deliverables
- `NaudiodonCapture implements AudioCapture` using `naudiodon2` (PortAudio). If naudiodon2
  fails to install/build on Windows in your environment, implement `FfmpegCapture` instead:
  spawn `ffmpeg -f dshow -i audio=<device>` → stdout PCM (list devices via
  `ffmpeg -list_devices`), and record which impl was chosen in a code comment + README note.
  Either way the export is `createAudioCapture(): AudioCapture`.
- Resampler util `src/voice/resample.ts`: `resampleTo16k(int16, fromRate): Int16Array`
  (linear interpolation is sufficient) + `Framer` class that rechunks arbitrary-length buffers
  into exact 512-sample frames.
- `scripts/smoke/smoke-capture.ts`: lists devices, records 3s from default, writes
  `scratch/capture-test.wav`, prints peak level.

## Tests
- Unit: resampler (48k sine → 16k, assert length ratio + frequency preserved via zero-crossing
  count); Framer (feed 300+700+36 samples → exactly two 512 frames emitted, 12 remain).
- Fake-device test: `start` twice is a no-op; `stop` then `start` works.

## Acceptance
- `npm test` passes; smoke script produces an audible WAV of your voice (verified by running
  it — note result). Frames delivered are exactly 512 samples at a steady ~31/sec rate.
