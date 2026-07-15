# Voice Pipeline

All modules live in `packages/app/src/voice/`. Audio format everywhere: **16 kHz, mono, 16-bit
signed PCM** (`Int16Array` frames). Every component is an interface with one production
implementation and is constructor-injected into `VoicePipeline` so tests can substitute fakes.

## AudioCapture (capture.ts)

Wraps a native mic library (`naudiodon2` primary; fall back to spawning ffmpeg dshow capture if
naudiodon fails to build — implementation picks one behind this interface).

```ts
export interface AudioFrame { samples: Int16Array }   // fixed 512-sample frames

export interface AudioCapture {
  listInputs(): Promise<{ id: string; label: string }[]>;
  start(deviceId: string | null, onFrame: (f: AudioFrame) => void): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}
```

Behavior: resamples device native rate → 16 kHz mono; emits contiguous 512-sample frames
(Porcupine's required frame length); `start` while running is a no-op; errors emitted by
rejecting `start` or via a thrown callback are caught by the pipeline.

## WakeWordDetector (wakeword.ts)

```ts
export interface WakeWordDetector {
  init(cfg: { accessKey: string; builtinKeyword: string | null; customKeywordPath: string | null; sensitivity: number }): Promise<void>;
  process(frame: AudioFrame): boolean;   // true exactly on the frame that completes the wake word
  release(): void;
}
```

Production: `@picovoice/porcupine-node`. If `customKeywordPath` is set it wins over
`builtinKeyword`. Built-in keyword strings must match Porcupine's `BuiltinKeyword` enum names
(the plan default is `jarvis`).

## VoiceActivityDetector (vad.ts)

```ts
export interface VoiceActivityDetector {
  init(): Promise<void>;                       // loads silero_vad.onnx via onnxruntime-node
  process(frame: AudioFrame): 'speech' | 'silence';
  reset(): void;                               // clear internal RNN state between utterances
}
```

Endpointing rule (implemented in the pipeline, not the VAD): utterance ends after
`800 ms` of continuous `silence` following at least one `speech` frame; hard cap `15 s`.

## SpeechToText (stt.ts)

```ts
export interface SpeechToText {
  init(cfg: { modelPath: string }): Promise<void>;
  transcribe(audio: Int16Array): Promise<{ text: string; ms: number }>;
}
```

Production `WhisperCppStt`: writes PCM to a temp WAV in the scratchpad/tmp dir, spawns
`models/bin/whisper-cli.exe -m <model> -f <wav> -nt -np --language en --output-txt`, reads the
result, deletes temp files. Trims/normalizes whitespace. Empty/garbage transcripts (<2 chars)
return `text: ''` and the pipeline treats that as a cancel.

## TextToSpeech (tts.ts)

```ts
export interface TextToSpeech {
  init(cfg: { voicePath: string }): Promise<void>;
  speak(text: string): Promise<void>;    // resolves when playback finishes
  cancel(): void;                        // immediately stops current + queued speech
  readonly speaking: boolean;
}
```

Production `PiperTts`: spawns `models/bin/piper.exe --model <voice> --output-raw`, pipes raw
PCM to a speaker stream. Maintains an internal FIFO sentence queue: `speak` may be called per
sentence while the agent is still streaming. `cancel` kills the piper process and flushes the
queue.

## SentenceChunker (chunker.ts)

Turns streaming `text_delta` events into speakable sentences so TTS starts before the full
reply exists.

```ts
export class SentenceChunker {
  push(delta: string): string[];   // returns zero or more completed sentences
  flush(): string | null;          // remaining tail at stream end
}
```

Sentence boundary: `.`, `!`, `?`, `:` followed by whitespace, or 220 chars max. Strips markdown
symbols (backticks, asterisks, headings, bullet markers) so TTS never reads formatting aloud.

## VoicePipeline (pipeline.ts)

Owns the state machine from architecture.md and all components above.

```ts
export interface VoicePipelineDeps {
  capture: AudioCapture;
  wake: WakeWordDetector;
  vad: VoiceActivityDetector;
  stt: SpeechToText;
  tts: TextToSpeech;
  config: () => AppConfig;
}

export interface VoicePipelineEvents {
  state: (s: AssistantState) => void;
  transcript: (e: TranscriptEvent) => void;      // final only (whisper.cpp is not streaming)
  utterance: (text: string) => void;             // final transcript ready for the router
}

export class VoicePipeline {
  constructor(deps: VoicePipelineDeps);
  start(): Promise<void>;                 // begin capture + wake loop
  stop(): Promise<void>;
  injectText(text: string): void;         // text bar / hotkey entry → emits 'utterance'
  onAgentEvent(e: AgentEvent): void;      // feeds chunker + TTS during 'thinking'/'speaking'
  cancel(): void;                         // user cancel: stop TTS, drop turn, → idle
  on<K extends keyof VoicePipelineEvents>(ev: K, fn: VoicePipelineEvents[K]): void;
  readonly state: AssistantState;
}
```

Behavioral contract:
- In `idle`/`speaking`, every frame goes to `wake.process`. On detection during `speaking`,
  call `tts.cancel()` then enter `listening` (barge-in).
- In `listening`, frames buffer into the utterance and feed `vad`. On endpoint → `transcribing`,
  run `stt.transcribe`, emit `transcript` + `utterance`, enter `thinking`.
- `onAgentEvent`: `text_delta` → chunker → `tts.speak` per sentence (first sentence flips state
  to `speaking`); `done` → flush chunker, after last TTS resolves → `idle`;
  `error` → `error` state, speak nothing, auto-return to `idle` after 3 s.
- A wake sound (short click, `assets/wake.wav`) plays on wake detection.

## Model/binary provisioning (scripts/fetch-models.ts)

```ts
export interface ModelSpec { name: string; url: string; sha256: string; dest: string }
export const REQUIRED_MODELS: ModelSpec[];   // whisper small.en, silero_vad.onnx, piper voice + exe, whisper-cli exe
export async function fetchModels(force?: boolean): Promise<void>;  // download-if-missing + checksum verify
```

Run via `npm run fetch-models`; the app checks presence at startup and deep-links the user to
run it (or runs it with consent from the settings UI) if missing.

## Testing

- Unit: SentenceChunker (pure), endpointing logic (feed synthetic speech/silence sequences via a
  fake VAD), config-driven wiring.
- Integration: `VoicePipeline` with fake capture (replays `fixtures/*.pcm`), fake wake (fires on
  frame N), real Silero VAD, fake STT/TTS recording call order — asserts full state sequence
  idle→listening→transcribing→thinking→speaking→idle.
- Manual smoke per task: scripts under `scripts/smoke/` (e.g. `smoke-wakeword.ts` prints
  detections live from the real mic).
