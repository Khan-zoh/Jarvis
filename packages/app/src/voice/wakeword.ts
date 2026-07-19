// Native openWakeWord inference for Jarvis. The upstream Python implementation chains three
// ONNX models: PCM -> mel spectrogram -> shared speech embedding -> wake-word classifier. This
// module ports that small streaming inference path to TypeScript so the Electron app needs no
// Python sidecar, cloud account, or access key.

import * as ort from 'onnxruntime-node';
import type { AudioFrame } from './capture';

export interface WakeWordConfig {
  /** Higher values make detection easier. Converted to openWakeWord's score threshold. */
  sensitivity: number;
}

export interface WakeWordModelPaths {
  melSpectrogram: string;
  embedding: string;
  wakeWord: string;
}

export interface WakeWordDetector {
  init(cfg: WakeWordConfig): Promise<void>;
  process(frame: AudioFrame): Promise<boolean>;
  release(): void;
}

interface SessionLike {
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
  release?(): Promise<void> | void;
}

type CreateSession = (path: string) => Promise<SessionLike>;

export interface OpenWakeWordOptions {
  modelPaths: WakeWordModelPaths;
  /** Test seam; production uses onnxruntime-node directly. */
  createSession?: CreateSession;
}

const CAPTURE_FRAME_SAMPLES = 512;
const INFERENCE_CHUNK_SAMPLES = 1280; // 80 ms at 16 kHz, openWakeWord's streaming cadence
const MEL_CONTEXT_SAMPLES = 480; // three 10 ms windows retained across chunks
const MEL_BINS = 32;
const MEL_WINDOW_FRAMES = 76;
const EMBEDDING_SIZE = 96;
const WAKE_FEATURE_FRAMES = 16;
const STARTUP_PREDICTIONS_TO_IGNORE = 5;
const MAX_RAW_SAMPLES = 16000 * 10;
const MAX_MEL_FRAMES = 970;
const MAX_FEATURE_FRAMES = 120;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Porcupine exposed "sensitivity" (high = easier); openWakeWord exposes a score threshold
 * (low = easier). Preserve the UI meaning and make the existing 0.6 default map to the upstream
 * recommended 0.5 threshold. */
export function sensitivityToThreshold(sensitivity: number): number {
  return clamp(1.1 - clamp(sensitivity, 0, 1), 0.05, 0.95);
}

function rows(data: Float32Array<ArrayBufferLike>, width: number): Float32Array[] {
  if (data.length % width !== 0) {
    throw new Error(`openWakeWord model returned ${data.length} values, not a multiple of ${width}`);
  }
  const result: Float32Array[] = [];
  for (let offset = 0; offset < data.length; offset += width) {
    result.push(Float32Array.from(data.subarray(offset, offset + width)));
  }
  return result;
}

function flatten(input: Float32Array[], width: number): Float32Array {
  const result = new Float32Array(input.length * width);
  input.forEach((row, index) => result.set(row, index * width));
  return result;
}

export class OpenWakeWord implements WakeWordDetector {
  private readonly paths: WakeWordModelPaths;
  private readonly createSession: CreateSession;
  private melSession: SessionLike | null = null;
  private embeddingSession: SessionLike | null = null;
  private wakeSession: SessionLike | null = null;
  private pendingSamples: number[] = [];
  private rawSamples: number[] = [];
  private melFrames: Float32Array[] = [];
  private featureFrames: Float32Array[] = [];
  private threshold = 0.5;
  private predictionCount = 0;

  constructor(opts: OpenWakeWordOptions) {
    this.paths = opts.modelPaths;
    this.createSession =
      opts.createSession ??
      ((path) => ort.InferenceSession.create(path, { executionProviders: ['cpu'] }));
    this.resetBuffers();
  }

  async init(cfg: WakeWordConfig): Promise<void> {
    this.release();
    this.resetBuffers();
    this.threshold = sensitivityToThreshold(cfg.sensitivity);
    try {
      [this.melSession, this.embeddingSession, this.wakeSession] = await Promise.all([
        this.createSession(this.paths.melSpectrogram),
        this.createSession(this.paths.embedding),
        this.createSession(this.paths.wakeWord)
      ]);
    } catch (err) {
      this.release();
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`openWakeWord initialization failed — download the voice models again (${detail})`);
    }
  }

  async process(frame: AudioFrame): Promise<boolean> {
    if (!this.melSession || !this.embeddingSession || !this.wakeSession) {
      throw new Error('OpenWakeWord.process: init() must be called before process()');
    }
    if (frame.samples.length !== CAPTURE_FRAME_SAMPLES) {
      throw new Error(
        `OpenWakeWord.process: expected a ${CAPTURE_FRAME_SAMPLES}-sample frame, got ${frame.samples.length}`
      );
    }

    for (const sample of frame.samples) this.pendingSamples.push(sample);
    let detected = false;
    while (this.pendingSamples.length >= INFERENCE_CHUNK_SAMPLES) {
      const chunk = this.pendingSamples.splice(0, INFERENCE_CHUNK_SAMPLES);
      detected = (await this.processChunk(chunk)) || detected;
    }
    return detected;
  }

  release(): void {
    for (const session of [this.melSession, this.embeddingSession, this.wakeSession]) {
      if (session?.release) void session.release();
    }
    this.melSession = null;
    this.embeddingSession = null;
    this.wakeSession = null;
  }

  private resetBuffers(): void {
    this.pendingSamples = [];
    this.rawSamples = [];
    // Matches upstream's neutral initial mel history. Zero feature history avoids randomized
    // startup behavior; the first five classifier results are ignored as upstream also does.
    this.melFrames = Array.from(
      { length: MEL_WINDOW_FRAMES },
      () => new Float32Array(MEL_BINS).fill(1)
    );
    this.featureFrames = Array.from(
      { length: WAKE_FEATURE_FRAMES },
      () => new Float32Array(EMBEDDING_SIZE)
    );
    this.predictionCount = 0;
  }

  private async processChunk(chunk: number[]): Promise<boolean> {
    const melSession = this.melSession;
    const embeddingSession = this.embeddingSession;
    const wakeSession = this.wakeSession;
    if (!melSession || !embeddingSession || !wakeSession) return false;

    this.rawSamples.push(...chunk);
    if (this.rawSamples.length > MAX_RAW_SAMPLES) {
      this.rawSamples.splice(0, this.rawSamples.length - MAX_RAW_SAMPLES);
    }

    const contextSize = Math.min(
      this.rawSamples.length,
      INFERENCE_CHUNK_SAMPLES + MEL_CONTEXT_SAMPLES
    );
    const pcm = Float32Array.from(this.rawSamples.slice(-contextSize));
    const melResult = await melSession.run({
      input: new ort.Tensor('float32', pcm, [1, pcm.length])
    });
    const melOutput = melResult.output;
    if (!melOutput) throw new Error('openWakeWord mel model output is missing');
    const newMelFrames = rows(melOutput.data as Float32Array<ArrayBufferLike>, MEL_BINS);
    // Upstream transform aligns this ONNX spectrogram with Google's embedding model.
    for (const row of newMelFrames) {
      for (let i = 0; i < row.length; i++) row[i] = (row[i] ?? 0) / 10 + 2;
      this.melFrames.push(row);
    }
    if (this.melFrames.length > MAX_MEL_FRAMES) {
      this.melFrames.splice(0, this.melFrames.length - MAX_MEL_FRAMES);
    }

    const melWindow = this.melFrames.slice(-MEL_WINDOW_FRAMES);
    if (melWindow.length !== MEL_WINDOW_FRAMES) return false;
    const embeddingResult = await embeddingSession.run({
      input_1: new ort.Tensor(
        'float32',
        flatten(melWindow, MEL_BINS),
        [1, MEL_WINDOW_FRAMES, MEL_BINS, 1]
      )
    });
    const embeddingOutput = embeddingResult.conv2d_19;
    if (!embeddingOutput) throw new Error('openWakeWord embedding model output is missing');
    const embedding = Float32Array.from(
      (embeddingOutput.data as Float32Array<ArrayBufferLike>).subarray(0, EMBEDDING_SIZE)
    );
    if (embedding.length !== EMBEDDING_SIZE) {
      throw new Error(`openWakeWord embedding model returned ${embedding.length} values`);
    }
    this.featureFrames.push(embedding);
    if (this.featureFrames.length > MAX_FEATURE_FRAMES) {
      this.featureFrames.splice(0, this.featureFrames.length - MAX_FEATURE_FRAMES);
    }

    const wakeFeatures = this.featureFrames.slice(-WAKE_FEATURE_FRAMES);
    const wakeResult = await wakeSession.run({
      'x.1': new ort.Tensor(
        'float32',
        flatten(wakeFeatures, EMBEDDING_SIZE),
        [1, WAKE_FEATURE_FRAMES, EMBEDDING_SIZE]
      )
    });
    const wakeOutput = wakeResult['53'];
    if (!wakeOutput) throw new Error('openWakeWord classifier output is missing');
    const score = (wakeOutput.data as Float32Array<ArrayBufferLike>)[0] ?? 0;
    this.predictionCount += 1;
    return this.predictionCount > STARTUP_PREDICTIONS_TO_IGNORE && score >= this.threshold;
  }
}

export function createWakeWordDetector(modelPaths: WakeWordModelPaths): WakeWordDetector {
  return new OpenWakeWord({ modelPaths });
}
