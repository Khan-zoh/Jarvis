// Voice-component fakes per cdd/plan/testing-strategy.md ("Fakes live in packages/app/test/fakes/
// and implement the plan interfaces exactly"): FakeCapture (test-driven frames), FakeWake (fires
// at frame N), FakeVad (scripted classifications), FakeStt / FakeTts (record calls). Used by
// test/pipeline.test.ts to drive VoicePipeline with no mic, model, speaker, or real clock.

import type { AudioCapture, AudioFrame } from '../../src/voice/capture';
import type { WakeWordDetector, WakeWordConfig } from '../../src/voice/wakeword';
import type { VoiceActivityDetector } from '../../src/voice/vad';
import type { SpeechToText } from '../../src/voice/stt';
import type { TextToSpeech } from '../../src/voice/tts';

export function makeFrame(amplitude = 0): AudioFrame {
  const samples = new Int16Array(512);
  samples.fill(amplitude);
  return { samples };
}

/** Capture fake: start() records the onFrame sink; tests push frames (or bursts) through it. */
export class FakeCapture implements AudioCapture {
  running = false;
  startCalls = 0;
  stopCalls = 0;
  lastDeviceId: string | null | undefined;
  private onFrame: ((f: AudioFrame) => void) | null = null;

  async listInputs(): Promise<{ id: string; label: string }[]> {
    return [{ id: 'Fake Mic', label: 'Fake Mic' }];
  }

  async start(deviceId: string | null, onFrame: (f: AudioFrame) => void): Promise<void> {
    if (this.running) return;
    this.startCalls += 1;
    this.lastDeviceId = deviceId;
    this.onFrame = onFrame;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.running = false;
    this.onFrame = null;
  }

  /** Delivers one frame synchronously, exactly like ffmpeg's stdout data handler does. */
  push(frame: AudioFrame = makeFrame()): void {
    this.onFrame?.(frame);
  }

  /** Delivers a burst of frames in one synchronous loop (ffmpeg's real burst behavior). */
  pushBurst(count: number, frame: AudioFrame = makeFrame()): void {
    for (let i = 0; i < count; i++) this.push(frame);
  }
}

/** Wake fake: fires on the exact process() call numbers listed in `fireOnCalls` (1-based). */
export class FakeWake implements WakeWordDetector {
  processCalls = 0;
  released = false;
  constructor(private readonly fireOnCalls: Set<number> = new Set()) {}

  fireOn(...calls: number[]): void {
    for (const c of calls) this.fireOnCalls.add(c);
  }

  async init(_cfg: WakeWordConfig): Promise<void> {}

  async process(_frame: AudioFrame): Promise<boolean> {
    this.processCalls += 1;
    return this.fireOnCalls.has(this.processCalls);
  }

  release(): void {
    this.released = true;
  }
}

/** VAD fake: returns classifications from a script (default 'silence'), optionally gated on a
 * manually-released promise so tests can hold inference "in flight". */
export class FakeVad implements VoiceActivityDetector {
  processCalls = 0;
  resetCalls = 0;
  /** Classifications consumed in order; when exhausted, `fallback` is returned. */
  script: Array<'speech' | 'silence'> = [];
  fallback: 'speech' | 'silence' = 'silence';
  /** When set, every process() call awaits this gate before resolving. */
  gate: Promise<void> | null = null;

  async init(): Promise<void> {}

  async process(_frame: AudioFrame): Promise<'speech' | 'silence'> {
    this.processCalls += 1;
    if (this.gate) await this.gate;
    return this.script.shift() ?? this.fallback;
  }

  reset(): void {
    this.resetCalls += 1;
  }
}

/** STT fake: records every transcribe() input; resolves with a scripted text. */
export class FakeStt implements SpeechToText {
  initCalls = 0;
  transcribeCalls: Int16Array[] = [];
  /** Next transcripts, consumed in order; when exhausted, `fallbackText` is returned. */
  script: string[] = [];
  fallbackText = 'what time is it';
  /** When set, transcribe() rejects with this error. */
  failWith: Error | null = null;

  async init(_cfg: { modelPath: string }): Promise<void> {
    this.initCalls += 1;
  }

  async transcribe(audio: Int16Array): Promise<{ text: string; ms: number }> {
    this.transcribeCalls.push(audio);
    if (this.failWith) throw this.failWith;
    const text = this.script.shift() ?? this.fallbackText;
    return { text, ms: 5 };
  }
}

/** TTS fake: records speak() calls in order; each resolves immediately unless `hold` is set, in
 * which case it stays pending until releaseAll() (or cancel()) is called. */
export class FakeTts implements TextToSpeech {
  spoken: string[] = [];
  cancelCalls = 0;
  hold = false;
  private pending: Array<() => void> = [];
  private _speaking = false;

  get speaking(): boolean {
    return this._speaking;
  }

  async init(_cfg: { voicePath: string }): Promise<void> {}

  speak(text: string): Promise<void> {
    this.spoken.push(text);
    this._speaking = true;
    if (!this.hold) {
      this._speaking = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  /** Resolves every held speak() promise (playback "finished"). */
  releaseAll(): void {
    const pending = this.pending.splice(0, this.pending.length);
    this._speaking = false;
    for (const r of pending) r();
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.releaseAll();
  }
}
