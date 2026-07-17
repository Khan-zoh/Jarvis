// VoicePipeline — the state machine that ties capture, wake word, VAD, STT and TTS together, per
// cdd/plan/voice-pipeline.md ("VoicePipeline") and cdd/plan/architecture.md ("Core state
// machine" / "Error policy"). Lives in the Electron main process (amendments.md A6).
//
//   idle --wake--> listening --VAD end--> transcribing --text--> thinking --reply--> speaking --> idle
//
// All five components are constructor-injected behind their plan interfaces, plus a config getter
// and a handful of small seams (wake-sound player, timer functions, endpointer factory) so the
// whole machine is drivable with fakes and fake timers — no mic, speaker, model, or real clock is
// ever required in a unit test.
//
// Two behaviours worth calling out, both from binding findings:
//   - Burst-drain (amendments.md A6 / scripts/smoke/smoke-vad.ts): ffmpeg delivers frames in
//     bursts, and SileroVad.process() is async, so a naive "drop if busy" loses ~92% of frames.
//     Frames are queued and drained serially into the async VAD, with a bounded queue that only
//     drops once inference genuinely falls behind real time.
//   - Barge-in (architecture.md): the wake word is live in `idle` AND `speaking`; detecting it
//     while speaking cancels TTS and starts a fresh listen (echo-retrigger risk is a live Gate A
//     check, not a code concern here).

import type { AppConfig, AssistantState, TranscriptEvent } from '../shared/types';
import type { AudioCapture, AudioFrame } from './capture';
import type { WakeWordDetector } from './wakeword';
import type { VoiceActivityDetector } from './vad';
import type { SpeechToText } from './stt';
import type { TextToSpeech } from './tts';
import { Endpointer } from './vad';
import { SentenceChunker } from './chunker';

export interface VoicePipelineEvents {
  /** Assistant state transitions (drives overlay + tray). Fires only on an actual change. */
  state: (s: AssistantState) => void;
  /** Final transcript for display (whisper.cpp is not streaming, so `final` is always true). */
  transcript: (e: TranscriptEvent) => void;
  /** Final user text ready for the agent router. */
  utterance: (text: string) => void;
  /** Instantaneous mic input level 0..1 (RMS), emitted per frame while listening. */
  micLevel: (level: number) => void;
}

/** Timer seam so the 3s error auto-recover and the listen timeout are drivable with fake timers.
 * Defaults to the globals. */
export interface PipelineTimers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(h: ReturnType<typeof setTimeout>): void;
}

export interface VoicePipelineDeps {
  capture: AudioCapture;
  wake: WakeWordDetector;
  vad: VoiceActivityDetector;
  stt: SpeechToText;
  tts: TextToSpeech;
  config: () => AppConfig;
  /** Plays the short wake acknowledgement (assets/wake.wav). Injected so tests never touch audio;
   * the main process wires a real ffplay-backed player. Defaults to a no-op. */
  playWakeSound?: () => void;
  /** Timer seam (default: global setTimeout/clearTimeout). */
  timers?: PipelineTimers;
  /** Endpointer factory (default: `new Endpointer()` with plan defaults). Injectable for tests. */
  makeEndpointer?: () => Endpointer;
}

/** How long the error state lingers before auto-returning to idle (architecture.md "Error
 * policy": pipeline returns to idle after 3s). */
const ERROR_RECOVER_MS = 3000;

/** Bounded frame queue: ~1s of audio at 32ms/frame. Matches smoke-vad.ts's proven MAX_QUEUE. Once
 * exceeded, the oldest queued frame is dropped (inference has fallen behind real time). */
const MAX_QUEUE = 32;

const DEFAULT_TIMERS: PipelineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h)
};

export class VoicePipeline {
  private readonly deps: VoicePipelineDeps;
  private readonly timers: PipelineTimers;
  private readonly playWakeSound: () => void;
  private readonly makeEndpointer: () => Endpointer;

  private readonly listeners: {
    [K in keyof VoicePipelineEvents]: Set<VoicePipelineEvents[K]>;
  } = { state: new Set(), transcript: new Set(), utterance: new Set(), micLevel: new Set() };

  private _state: AssistantState = 'idle';
  private started = false;
  private crashHooked = false;

  // Burst-drain frame queue.
  private readonly queue: AudioFrame[] = [];
  private draining = false;

  // Listening-turn scratch state.
  private utteranceFrames: Int16Array[] = [];
  private endpointer: Endpointer | null = null;
  private sawSpeech = false;
  private listenTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn state (thinking/speaking). `turn` is bumped whenever a turn is started, cancelled, or
  // superseded, so async continuations (STT resolve, TTS drain) that belong to a stale turn are
  // dropped instead of moving a newer turn's state.
  private turn = 0;
  private chunker: SentenceChunker | null = null;
  private spokenPromises: Promise<void>[] = [];
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  /** Dev `--echo` flag: speak the final transcript straight back (Gate A echo test). When set,
   * the pipeline handles a turn entirely on its own — no agent router needed. */
  private echoMode = false;

  constructor(deps: VoicePipelineDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.playWakeSound = deps.playWakeSound ?? ((): void => {});
    this.makeEndpointer = deps.makeEndpointer ?? ((): Endpointer => new Endpointer());
  }

  get state(): AssistantState {
    return this._state;
  }

  /** Enables the Gate A echo behaviour: on a final transcript, speak it back instead of waiting
   * for agent events. */
  setEchoMode(on: boolean): void {
    this.echoMode = on;
  }

  on<K extends keyof VoicePipelineEvents>(ev: K, fn: VoicePipelineEvents[K]): void {
    this.listeners[ev].add(fn);
  }

  off<K extends keyof VoicePipelineEvents>(ev: K, fn: VoicePipelineEvents[K]): void {
    this.listeners[ev].delete(fn);
  }

  /** Begins capture + the wake loop. Assumes every injected component has already been init()ed
   * (the main process does this once model paths + config are known). Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.setState('idle');

    // Surface a capture crash (ffmpeg died) as an error state so the pipeline degrades instead of
    // going deaf silently. `capture.on` only exists on the real FfmpegCapture (EventEmitter).
    // Hooked once — start() can run again after a tray pause/resume without stacking listeners.
    if (!this.crashHooked) {
      this.crashHooked = true;
      const maybeEmitter = this.deps.capture as unknown as {
        on?: (ev: 'crash', fn: (err: Error) => void) => void;
      };
      maybeEmitter.on?.('crash', (err: Error) => {
        if (this.started) this.toError(`audio capture crashed: ${err.message}`);
      });
    }

    const deviceId = this.deps.config().voice.inputDeviceId;
    await this.deps.capture.start(deviceId, (frame) => this.onFrame(frame));
  }

  /** Stops capture and tears down any in-flight turn. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.turn += 1;
    this.deps.tts.cancel();
    this.clearListenTimer();
    this.clearErrorTimer();
    this.queue.length = 0;
    this.utteranceFrames = [];
    await this.deps.capture.stop();
    this.setState('idle');
  }

  /** Text bar / hotkey entry: injects `text` as a final transcript, entering the machine at the
   * transcribing-equivalent point (architecture.md). Supersedes any in-flight turn. */
  injectText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.turn += 1;
    // Only tear down TTS when a turn is actually live — a cold injectText from idle has nothing
    // to cancel.
    if (this._state === 'thinking' || this._state === 'speaking' || this.deps.tts.speaking) {
      this.deps.tts.cancel();
    }
    this.clearListenTimer();
    this.clearErrorTimer();
    this.utteranceFrames = [];
    this.beginTurn(trimmed);
  }

  /** Feeds one agent event into the current turn's chunker/TTS. Ignored unless a turn is live
   * (state is thinking or speaking) — late events from a cancelled/superseded turn are dropped. */
  onAgentEvent(e: import('../shared/types').AgentEvent): void {
    if (this._state !== 'thinking' && this._state !== 'speaking') return;
    const myTurn = this.turn;
    switch (e.kind) {
      case 'text_delta': {
        if (!this.ttsEnabled() || !this.chunker) return;
        for (const sentence of this.chunker.push(e.text)) this.speakSentence(sentence);
        return;
      }
      case 'done': {
        void this.finishTurn(myTurn);
        return;
      }
      case 'error': {
        this.toError(e.message);
        return;
      }
      case 'tool_start':
      case 'tool_end':
        // Tool progress is broadcast to the overlay by the main process; the voice machine does
        // not speak it.
        return;
      default:
        return;
    }
  }

  /** User cancel: stop TTS, drop the current turn, return to idle. */
  cancel(): void {
    this.turn += 1;
    this.deps.tts.cancel();
    this.chunker = null;
    this.spokenPromises = [];
    this.utteranceFrames = [];
    this.clearListenTimer();
    this.clearErrorTimer();
    this.setState('idle');
  }

  // ---------------------------------------------------------------------------------------------
  // Frame pipeline
  // ---------------------------------------------------------------------------------------------

  private onFrame(frame: AudioFrame): void {
    this.queue.push(frame);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const frame = this.queue.shift();
        if (!frame) break;
        await this.handleFrame(frame);
      }
    } finally {
      this.draining = false;
    }
  }

  private async handleFrame(frame: AudioFrame): Promise<void> {
    switch (this._state) {
      case 'idle': {
        if (this.safeWake(frame)) this.onWake(false);
        return;
      }
      case 'speaking': {
        // Barge-in: wake word is live while speaking.
        if (this.safeWake(frame)) this.onWake(true);
        return;
      }
      case 'listening': {
        await this.handleListeningFrame(frame);
        return;
      }
      // transcribing / thinking / error: not listening for wake or voice; drop the frame.
      default:
        return;
    }
  }

  private async handleListeningFrame(frame: AudioFrame): Promise<void> {
    this.emit('micLevel', rms(frame.samples));
    this.utteranceFrames.push(frame.samples);

    let cls: 'speech' | 'silence';
    try {
      cls = await this.deps.vad.process(frame);
    } catch (err) {
      this.toError(`voice detection failed: ${errMsg(err)}`);
      return;
    }
    // A state change may have happened while awaiting inference (cancel/barge-in/timeout).
    if (this._state !== 'listening' || !this.endpointer) return;

    if (cls === 'speech' && !this.sawSpeech) {
      this.sawSpeech = true;
      this.clearListenTimer(); // speech started; the endpointer now governs the end
    }

    const decision = this.endpointer.push(cls);
    if (decision === 'end' || decision === 'too-long') {
      await this.beginTranscribe();
    }
  }

  /** Wraps wake.process so a detector throw becomes an error state instead of an unhandled
   * rejection inside the drain loop. */
  private safeWake(frame: AudioFrame): boolean {
    try {
      return this.deps.wake.process(frame);
    } catch (err) {
      this.toError(`wake word detection failed: ${errMsg(err)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------------------------

  private onWake(bargeIn: boolean): void {
    if (bargeIn) {
      // Cancel the reply that is currently speaking and abandon its remaining agent events.
      this.turn += 1;
      this.deps.tts.cancel();
    }
    this.playWakeSound();
    this.enterListening();
  }

  private enterListening(): void {
    this.clearErrorTimer();
    this.deps.vad.reset();
    this.endpointer = this.makeEndpointer();
    this.utteranceFrames = [];
    this.sawSpeech = false;
    this.setState('listening');

    const timeoutMs = this.deps.config().voice.listenTimeoutMs;
    this.clearListenTimer();
    this.listenTimer = this.timers.setTimeout(() => {
      // Fired without any speech: the user woke it but said nothing -> idle, NO STT call.
      if (this._state === 'listening' && !this.sawSpeech) {
        this.utteranceFrames = [];
        this.endpointer = null;
        this.setState('idle');
      }
    }, timeoutMs);
  }

  private async beginTranscribe(): Promise<void> {
    this.clearListenTimer();
    this.endpointer = null;
    this.setState('transcribing');
    const audio = concatFrames(this.utteranceFrames);
    this.utteranceFrames = [];
    const myTurn = ++this.turn;

    let result: { text: string; ms: number };
    try {
      result = await this.deps.stt.transcribe(audio);
    } catch (err) {
      if (this.turn === myTurn) this.toError(`transcription failed: ${errMsg(err)}`);
      return;
    }
    // Superseded (cancel/barge-in/new inject) while STT was running.
    if (this.turn !== myTurn || this._state !== 'transcribing') return;

    const text = result.text.trim();
    if (!text) {
      // Empty/garbage transcript -> treated as a cancel: back to idle silently.
      this.setState('idle');
      return;
    }
    this.beginTurn(text);
  }

  /** Starts the thinking phase for a final user `text`: emits transcript + utterance, arms the
   * chunker. In echo mode, speaks the text straight back and returns to idle. */
  private beginTurn(text: string): void {
    const myTurn = this.turn; // caller has already bumped `turn`
    this.chunker = new SentenceChunker();
    this.spokenPromises = [];
    this.setState('thinking');
    this.emit('transcript', { text, final: true });
    this.emit('utterance', text);

    if (this.echoMode) {
      // Echo speaks unconditionally — the flag is an explicit dev request for spoken output, so
      // it must not silently no-op on the default ttsEnabled:false config.
      this.speakSentence(text);
      void this.finishTurn(myTurn);
    }
    // Non-echo: the main process now drives router.dispatch and feeds onAgentEvent().
  }

  private speakSentence(sentence: string): void {
    if (this._state !== 'speaking') this.setState('speaking');
    const p = this.deps.tts.speak(sentence).catch(() => {
      // A TTS failure for a single sentence should not reject the whole turn; the pipeline keeps
      // going and finishTurn still resolves. (A hard error arrives via onAgentEvent 'error'.)
    });
    this.spokenPromises.push(p);
  }

  private async finishTurn(myTurn: number): Promise<void> {
    if (this.ttsEnabled() && this.chunker) {
      const tail = this.chunker.flush();
      if (tail) this.speakSentence(tail);
    }
    this.chunker = null;
    // Wait for every queued sentence to finish playing before returning to idle.
    const pending = this.spokenPromises;
    this.spokenPromises = [];
    await Promise.all(pending);
    if (this.turn !== myTurn) return; // cancelled/superseded while draining TTS
    this.setState('idle');
  }

  private toError(message: string): void {
    this.turn += 1;
    this.deps.tts.cancel();
    this.chunker = null;
    this.spokenPromises = [];
    this.utteranceFrames = [];
    this.clearListenTimer();
    this.clearErrorTimer();
    this.setState('error');
    // Surface the message to any state listeners via a transcript-less path — the main process
    // maps the error state to an agent:event {error} broadcast; here we just log for smoke runs.
    // eslint-disable-next-line no-console
    console.error(`[voice-pipeline] ${message}`);
    this.errorTimer = this.timers.setTimeout(() => {
      if (this._state === 'error') this.setState('idle');
    }, ERROR_RECOVER_MS);
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private ttsEnabled(): boolean {
    return this.deps.config().voice.ttsEnabled;
  }

  private clearListenTimer(): void {
    if (this.listenTimer !== null) {
      this.timers.clearTimeout(this.listenTimer);
      this.listenTimer = null;
    }
  }

  private clearErrorTimer(): void {
    if (this.errorTimer !== null) {
      this.timers.clearTimeout(this.errorTimer);
      this.errorTimer = null;
    }
  }

  private setState(s: AssistantState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  private emit<K extends keyof VoicePipelineEvents>(
    ev: K,
    ...args: Parameters<VoicePipelineEvents[K]>
  ): void {
    for (const fn of this.listeners[ev]) {
      (fn as (...a: Parameters<VoicePipelineEvents[K]>) => void)(...args);
    }
  }
}

/** Root-mean-square amplitude of a frame, normalized to 0..1 (16-bit full scale = 32768). */
function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  const value = Math.sqrt(sum / samples.length) / 32768;
  return value > 1 ? 1 : value;
}

/** Concatenates buffered 512-sample frames into one contiguous utterance buffer. */
function concatFrames(frames: Int16Array[]): Int16Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
