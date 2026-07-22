// TextToSpeech implementation — see cdd/plan/voice-pipeline.md ("TextToSpeech") for the binding
// interface and cdd/plan/amendments.md A6 for the playback correction this file implements:
// naudiodon2 is dropped; playback goes through the injected PcmPlayer (./player.ts, ffplay-based
// in production) so this module never touches an audio device directly.
//
// PiperTts maintains a FIFO sentence queue: each `speak(text)` call enqueues one item and
// resolves once that sentence has finished playing. Exactly one item is "in flight" at a time —
// per item this spawns a fresh `piper.exe --output_raw` process (piper has no persistent-session
// mode; one process per utterance is the supported usage), collects the raw PCM it writes to
// stdout until it exits, then hands that buffer to the PcmPlayer. `cancel()` tears down whatever
// is in flight (killing the piper child and stopping the player) and drains the queue, resolving
// every promise it touches — cancellation is not an error for the caller.

import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { PcmPlayer } from './player';

export interface TextToSpeech {
  init(cfg: { voicePath: string }): Promise<void>;
  speak(text: string): Promise<void>; // resolves when playback finishes
  cancel(): void; // immediately stops current + queued speech
  readonly speaking: boolean;
}

/** Minimal shape PiperTts needs from a spawned process. node:child_process's real `spawn` (with
 * stdio: ['pipe', 'pipe', 'pipe']) satisfies this directly; tests inject a lightweight fake so
 * no real piper process is ever spawned headlessly. */
export type PiperSpawnFn = (
  command: string,
  args: string[]
) => ChildProcessByStdio<Writable, Readable, Readable>;

export interface PiperTtsOptions {
  /** Path to piper.exe. Never resolved from PATH — see cdd/plan/amendments.md A6. */
  piperExe: string;
  player: PcmPlayer;
  /** Injectable in tests; defaults to node:child_process's real `spawn`. */
  spawnFn?: PiperSpawnFn;
  /** Reads a UTF-8 text file synchronously; defaults to node:fs readFileSync. Injectable so
   * tests can fake the voice config .json without touching disk. */
  readFileFn?: (path: string) => string;
}

interface QueueItem {
  text: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

function defaultSpawn(command: string, args: string[]): ChildProcessByStdio<Writable, Readable, Readable> {
  return nodeSpawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<
    Writable,
    Readable,
    Readable
  >;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

// Keep these adjustments subtle: a slightly slower pace, a touch more prosodic variation, and
// enough sentence spacing to sound conversational without making replies feel sluggish.
const PIPER_LENGTH_SCALE = 1.05;
const PIPER_NOISE_SCALE = 0.7;
const PIPER_NOISE_WIDTH = 0.85;
const PIPER_SENTENCE_SILENCE = 0.25;

/** Parses a piper voice `.onnx.json` config's `audio.sample_rate` field. Pure/exported so it can
 * be unit-tested against a small fixture string without touching disk. */
export function parseSampleRate(configJson: string): number {
  const parsed: unknown = JSON.parse(configJson);
  const rate =
    parsed && typeof parsed === 'object' && 'audio' in parsed
      ? (parsed as { audio?: { sample_rate?: unknown } }).audio?.sample_rate
      : undefined;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('piper voice config: missing or invalid audio.sample_rate');
  }
  return rate;
}

function buffersToInt16Array(chunks: Buffer[]): Int16Array {
  const merged = Buffer.concat(chunks);
  // Raw PCM from piper is always a whole number of 2-byte samples; if it somehow weren't, drop
  // a dangling odd byte rather than reading out of bounds.
  const usableLength = merged.length - (merged.length % 2);
  const sampleCount = usableLength / 2;
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = merged.readInt16LE(i * 2);
  }
  return out;
}

export class PiperTts implements TextToSpeech {
  private readonly piperExe: string;
  private readonly player: PcmPlayer;
  private readonly spawnFn: PiperSpawnFn;
  private readonly readFileFn: (path: string) => string;

  private voicePath = '';
  private sampleRate = 22050;

  private readonly queue: QueueItem[] = [];
  private processing = false;
  private currentItem: QueueItem | null = null;
  private currentProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  /** Bumped by cancel() to invalidate the in-flight pump() completion callback so a killed
   * item's eventual settle can't corrupt state a new speak() has already moved past. */
  private token = 0;
  private _speaking = false;

  constructor(opts: PiperTtsOptions) {
    this.piperExe = opts.piperExe;
    this.player = opts.player;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.readFileFn = opts.readFileFn ?? defaultReadFile;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  async init(cfg: { voicePath: string }): Promise<void> {
    this.voicePath = cfg.voicePath;
    const configJson = this.readFileFn(`${cfg.voicePath}.json`);
    this.sampleRate = parseSampleRate(configJson);
  }

  speak(text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      this._speaking = true;
      this.pump();
    });
  }

  cancel(): void {
    this.token += 1; // invalidate any in-flight pump() completion still pending

    const proc = this.currentProc;
    this.currentProc = null;
    proc?.kill();

    this.player.stop();

    const current = this.currentItem;
    this.currentItem = null;
    current?.resolve();

    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) item.resolve();

    this.processing = false;
    this._speaking = false;
  }

  private pump(): void {
    if (this.processing) return;
    const item = this.queue.shift();
    if (!item) {
      this._speaking = false;
      return;
    }

    this.processing = true;
    this.currentItem = item;
    const myToken = this.token;

    this.runItem(item).then(
      (outcome) => {
        if (myToken !== this.token) return; // superseded by cancel(); state already reset
        // Update our own bookkeeping (processing/currentItem/speaking) BEFORE settling the
        // caller's speak() promise, so that by the time a caller's `await speak()` continuation
        // runs, `speaking` and internal state already reflect the queue's true post-item state
        // rather than lagging a microtask behind.
        this.processing = false;
        this.currentItem = null;
        if (this.queue.length === 0) this._speaking = false;
        if (outcome.ok) item.resolve();
        else item.reject(outcome.err);
        this.pump();
      },
      // runItem is constructed to never itself reject (see below), but guard defensively.
      (err: unknown) => {
        if (myToken !== this.token) return;
        this.processing = false;
        this.currentItem = null;
        if (this.queue.length === 0) this._speaking = false;
        item.reject(err instanceof Error ? err : new Error(String(err)));
        this.pump();
      }
    );
  }

  /** Synthesizes and plays one queue item, capturing success/failure as a value rather than a
   * rejection so pump() can finish its own state housekeeping before the item's speak() promise
   * is settled (see the ordering note in pump()). */
  private async runItem(item: QueueItem): Promise<{ ok: true } | { ok: false; err: Error }> {
    try {
      const pcm = await this.synthesize(item.text);
      await this.player.play(pcm, this.sampleRate);
      return { ok: true };
    } catch (err) {
      return { ok: false, err: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  private synthesize(text: string): Promise<Int16Array> {
    return new Promise<Int16Array>((resolve, reject) => {
      let proc: ChildProcessByStdio<Writable, Readable, Readable>;
      try {
        proc = this.spawnFn(this.piperExe, [
          '--model',
          this.voicePath,
          '--config',
          `${this.voicePath}.json`,
          '--length_scale',
          String(PIPER_LENGTH_SCALE),
          '--noise_scale',
          String(PIPER_NOISE_SCALE),
          '--noise_w',
          String(PIPER_NOISE_WIDTH),
          '--sentence_silence',
          String(PIPER_SENTENCE_SILENCE),
          '--output_raw'
        ]);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.currentProc = proc;

      const chunks: Buffer[] = [];
      let stderr = '';
      let settled = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (this.currentProc === proc) this.currentProc = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      proc.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        if (this.currentProc === proc) this.currentProc = null;
        if (code !== 0) {
          reject(
            new Error(`piper exited with code ${code ?? 'null'} (signal=${signal ?? 'null'}): ${stderr.trim()}`)
          );
          return;
        }
        resolve(buffersToInt16Array(chunks));
      });

      proc.stdin.on('error', () => {
        // Can throw EPIPE if the process has already exited (e.g. killed by cancel() racing
        // this write) — the 'exit'/'error' handlers above already settle the promise.
      });
      proc.stdin.write(text);
      proc.stdin.end();
    });
  }
}

/** Production factory. `piperExe` must come from `resolveModelPaths()` — never resolved from
 * PATH (cdd/plan/amendments.md A6). */
export function createPiperTts(piperExe: string, player: PcmPlayer): TextToSpeech {
  return new PiperTts({ piperExe, player });
}
