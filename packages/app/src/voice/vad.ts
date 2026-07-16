// VoiceActivityDetector on Silero VAD v4 (packages/app/src/voice/vad.ts) — see
// cdd/plan/voice-pipeline.md ("VoiceActivityDetector") for the binding interface shape and
// cdd/plan/amendments.md A6 for the correction this file implements:
//
//   - onnxruntime-node's `session.run()` returns a Promise, so the plan's sync
//     `process(frame): 'speech'|'silence'` signature is unimplementable. `process()` here is
//     async (`Promise<'speech'|'silence'>`). Everything else about the interface (init(), reset(),
//     one production impl) is unchanged from the plan.
//   - Inference is serialized per-instance: calls queue behind one another so the shared
//     recurrent state (h/c) is always read/updated by exactly one in-flight `session.run()` at a
//     time. The pipeline layer is responsible for *dropping* frames that arrive while inference is
//     still pending (per A6) — this file's contract only needs to stay correct under that
//     sequential-await usage, which the queue guarantees even if a caller doesn't await between
//     frames.
//
// This file also exports `Endpointer`, a small pure state machine that turns a stream of
// 'speech'/'silence' frame classifications into utterance boundary decisions
// ('continue'/'end'/'too-long'). It has no dependency on the VAD or onnxruntime and is unit-tested
// independently of the real model.

import * as ort from 'onnxruntime-node';
import type { AudioFrame } from './capture';

export interface VoiceActivityDetector {
  init(): Promise<void>; // loads silero_vad.onnx via onnxruntime-node
  process(frame: AudioFrame): Promise<'speech' | 'silence'>; // async per amendments.md A6
  reset(): void; // clear internal RNN state between utterances
}

/** Silero VAD's required frame size (samples @ 16kHz) — the model is trained/validated against
 * exactly this window. */
const FRAME_SIZE = 512;
const SAMPLE_RATE = 16000;

/** Frame duration in ms, derived from FRAME_SIZE/SAMPLE_RATE (512/16000 = 32ms) — the single
 * source of truth Endpointer uses to convert its ms-based thresholds into frame counts. */
export const FRAME_MS = (FRAME_SIZE / SAMPLE_RATE) * 1000;

/** Speech-probability threshold. Silero v4's `output` is a P(speech) score in [0,1]; frames
 * scoring >= this are classified 'speech'. 0.5 is the documented default operating point from the
 * Silero VAD project's own streaming examples (https://github.com/snakers4/silero-vad) — the task
 * spec pins it as a documented constant rather than a tunable. */
const SPEECH_THRESHOLD = 0.5;

/** Silero v4's recurrent state tensors (`h`/`c`, LSTM-style hidden/cell state) are both
 * float32[2,1,64], confirmed against the provisioned models/vad/silero_vad.onnx via its
 * session.inputNames/outputNames (['input','sr','h','c'] / ['output','hn','cn']). */
const STATE_SHAPE = [2, 1, 64];
const STATE_SIZE = 2 * 1 * 64;

export interface SileroVadOptions {
  /** Path to silero_vad.onnx. Sourced from resolveModelPaths().sileroVad — never resolved from
   * PATH, matching FfmpegCapture/WhisperCppStt's path-injection contract. */
  modelPath: string;
}

export class SileroVad implements VoiceActivityDetector {
  private readonly modelPath: string;
  private session: ort.InferenceSession | null = null;
  private h: Float32Array<ArrayBufferLike> = new Float32Array(STATE_SIZE);
  private c: Float32Array<ArrayBufferLike> = new Float32Array(STATE_SIZE);
  // `sr` is a fixed scalar (16000) for every call — built once and reused.
  private readonly srTensor = new ort.Tensor('int64', [BigInt(SAMPLE_RATE)], []);
  // Serializes process() calls (see module comment above).
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: SileroVadOptions) {
    this.modelPath = opts.modelPath;
  }

  async init(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.modelPath);
  }

  /** Zeroes the recurrent state. Call between utterances so a new utterance's first frame isn't
   * biased by the tail end of the previous one. */
  reset(): void {
    this.h = new Float32Array(STATE_SIZE);
    this.c = new Float32Array(STATE_SIZE);
  }

  process(frame: AudioFrame): Promise<'speech' | 'silence'> {
    const result = this.queue.then(() => this.runInference(frame));
    // Swallow so a rejected inference doesn't permanently wedge the queue for subsequent frames —
    // the rejection itself still propagates to whoever awaited this particular process() call.
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runInference(frame: AudioFrame): Promise<'speech' | 'silence'> {
    const session = this.session;
    if (!session) {
      throw new Error('SileroVad.process: init() must be called before process()');
    }
    if (frame.samples.length !== FRAME_SIZE) {
      throw new Error(
        `SileroVad.process: expected a ${FRAME_SIZE}-sample frame, got ${frame.samples.length}`
      );
    }

    // Int16 -> normalized float32 in [-1, 1], per the task's tensor-contract note.
    const input = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      input[i] = (frame.samples[i] ?? 0) / 32768;
    }

    const feeds = {
      input: new ort.Tensor('float32', input, [1, FRAME_SIZE]),
      sr: this.srTensor,
      h: new ort.Tensor('float32', this.h, STATE_SHAPE),
      c: new ort.Tensor('float32', this.c, STATE_SHAPE)
    };

    const results = await session.run(feeds);
    const hn = results.hn;
    const cn = results.cn;
    const output = results.output;
    if (!hn || !cn || !output) {
      throw new Error('SileroVad.process: model output missing expected tensor(s) (hn/cn/output)');
    }

    // Carry the updated recurrent state into the next call.
    this.h = hn.data as Float32Array<ArrayBufferLike>;
    this.c = cn.data as Float32Array<ArrayBufferLike>;

    const prob = (output.data as Float32Array<ArrayBufferLike>)[0] ?? 0;
    return prob >= SPEECH_THRESHOLD ? 'speech' : 'silence';
  }
}

/** Production factory. `modelPath` must come from resolveModelPaths().sileroVad — never resolved
 * from PATH (cdd/plan/amendments.md A6, matching the other voice components' path-injection
 * contract). */
export function createVoiceActivityDetector(modelPath: string): VoiceActivityDetector {
  return new SileroVad({ modelPath });
}

// ---------------------------------------------------------------------------------------------
// Endpointer — pure utterance-boundary state machine (cdd/plan/voice-pipeline.md "Endpointing
// rule" + cdd/tasks/vad-endpointing.md). Consumes per-frame speech/silence classifications (from
// SileroVad or a fake) and decides when an utterance has ended.

export type FrameClass = 'speech' | 'silence';
export type EndpointResult = 'continue' | 'end' | 'too-long';

export interface EndpointerOptions {
  /** ms of continuous silence, following at least one speech frame, that ends the utterance.
   * Default 800ms. */
  silenceMs?: number;
  /** Hard cap in ms on total utterance length, regardless of content. Default 15000ms (15s). */
  maxMs?: number;
}

const DEFAULT_SILENCE_MS = 800;
const DEFAULT_MAX_MS = 15_000;

export class Endpointer {
  private readonly silenceFrameThreshold: number;
  private readonly maxFrameThreshold: number;
  private totalFrames = 0;
  private consecutiveSilence = 0;
  private sawSpeech = false;

  constructor(opts: EndpointerOptions = {}) {
    const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
    const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    // Math.ceil: a threshold of exactly N frames' worth of ms must require N frames, not N-1
    // (e.g. 800ms / 32ms = 25.0 -> 25 frames; 15000ms / 32ms = 468.75 -> 469 frames — matches the
    // task's table-driven expectations exactly).
    this.silenceFrameThreshold = Math.ceil(silenceMs / FRAME_MS);
    this.maxFrameThreshold = Math.ceil(maxMs / FRAME_MS);
  }

  /** Feeds one frame's classification in; returns the endpointing decision for the utterance so
   * far. Once 'end' or 'too-long' is returned the caller is expected to stop pushing (a fresh
   * utterance gets a fresh Endpointer) — pushing further is not defended against here. */
  push(v: FrameClass): EndpointResult {
    this.totalFrames += 1;

    if (v === 'speech') {
      this.sawSpeech = true;
      this.consecutiveSilence = 0;
    } else {
      this.consecutiveSilence += 1;
    }

    if (this.totalFrames >= this.maxFrameThreshold) {
      return 'too-long';
    }

    if (this.sawSpeech && this.consecutiveSilence >= this.silenceFrameThreshold) {
      return 'end';
    }

    return 'continue';
  }
}
