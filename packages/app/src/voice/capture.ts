// AudioCapture implementation — see cdd/plan/voice-pipeline.md ("AudioCapture") for the binding
// interface and cdd/plan/amendments.md A6 for the corrections this file implements:
//
//   - naudiodon2 (PortAudio) is dropped entirely: it does not build in this environment (no
//     MSVC). The only implementation is FfmpegCapture, spawning ffmpeg with `-f dshow`.
//   - Windows device identity = the dshow device NAME string (e.g.
//     "Microphone (Realtek(R) Audio)"), for both listInputs() ids and start(deviceId).
//   - ffmpeg.exe is a provisioned artifact resolved via modelPaths.ts and passed in by the
//     caller — this module never resolves it from PATH (see createAudioCapture below).
//
// Capture strategy: dshow is asked to deliver mono s16 PCM at a fixed native rate (48 kHz —
// Windows' WASAPI shared-mode default mix format) rather than querying each device's native
// format, which keeps the ffmpeg invocation static and testable. If a device genuinely can't
// honor that rate, ffmpeg exits non-zero and that surfaces via the 'crash' event below instead
// of being silently papered over. The 48kHz PCM is then downsampled to 16kHz with
// resampleTo16k() and rechunked into exact 512-sample frames with Framer (both from
// ./resample.ts), so AudioCapture itself — not ffmpeg's own resampler — is what performs the
// "device native rate -> 16kHz mono" step the plan describes.

import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { Framer, resampleTo16k } from './resample';

export interface AudioFrame {
  samples: Int16Array; // fixed 512-sample frames
}

export interface AudioCapture {
  listInputs(): Promise<{ id: string; label: string }[]>;
  start(deviceId: string | null, onFrame: (f: AudioFrame) => void): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}

/** Minimal shape FfmpegCapture needs from a spawned process. node:child_process's real `spawn`
 * (with stdio: ['ignore', 'pipe', 'pipe']) satisfies this directly; tests inject a lightweight
 * fake so no real ffmpeg process is ever spawned headlessly. */
export type SpawnFn = (command: string, args: string[]) => ChildProcessByStdio<null, Readable, Readable>;

const FRAME_SIZE = 512;

/** Requested directly from dshow. See the module comment above for why this is fixed rather
 * than queried per-device. */
const DEFAULT_NATIVE_SAMPLE_RATE = 48000;

const LIST_DEVICES_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

export interface FfmpegCaptureOptions {
  /** Path to ffmpeg.exe. Never resolved from PATH — see cdd/plan/amendments.md A6. */
  ffmpegPath: string;
  /** Injectable in tests; defaults to node:child_process's real `spawn`. */
  spawnFn?: SpawnFn;
  /** Overrides the fixed native capture rate. Production always uses the 48kHz default; tests
   * use this to exercise the frame pipeline without exercising the resampler too. */
  nativeSampleRate?: number;
}

function defaultSpawn(command: string, args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<
    null,
    Readable,
    Readable
  >;
}

/** Parses `ffmpeg -f dshow -list_devices true -i dummy` stderr output into the audio device
 * list. Handles both dshow listing formats:
 *
 *   - Modern (ffmpeg >= ~5.0, incl. the pinned 8.0.1 build — verified against its real output
 *     on this machine): every device on one flat list, each line tagged inline, e.g.
 *       [dshow @ ...] "Microphone (C-Media(R) Audio)" (audio)
 *       [dshow @ ...] "USB2.0 HD UVC WebCam" (video)
 *   - Legacy: two section headers ("DirectShow video devices" / "DirectShow audio devices")
 *     with untagged quoted names under each.
 *
 * "Alternative name" lines (the @device_... moniker) are skipped in both formats — per
 * cdd/plan/amendments.md A6 the Windows device contract is the human-readable NAME string. */
export function parseAudioDevices(stderr: string): { id: string; label: string }[] {
  const lines = stderr.split(/\r?\n/);
  const devices: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  let inAudioSection = false;

  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    devices.push({ id: name, label: name });
  };

  for (const line of lines) {
    if (/Alternative name/i.test(line)) continue;

    // Modern format: inline `"Name" (audio)` / `"Name" (video)` markers.
    const inlineMatch = line.match(/"([^"]+)"\s*\((audio|video)\)\s*$/i);
    if (inlineMatch?.[1]) {
      if (inlineMatch[2]?.toLowerCase() === 'audio') add(inlineMatch[1]);
      continue;
    }

    // Legacy format: section headers followed by untagged quoted names.
    if (/DirectShow audio devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;

    const match = line.match(/"([^"]+)"/);
    if (match?.[1]) add(match[1]);
  }

  return devices;
}

export class FfmpegCapture extends EventEmitter implements AudioCapture {
  private readonly ffmpegPath: string;
  private readonly spawnFn: SpawnFn;
  private readonly nativeSampleRate: number;
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private _running = false;

  constructor(opts: FfmpegCaptureOptions) {
    super();
    this.ffmpegPath = opts.ffmpegPath;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.nativeSampleRate = opts.nativeSampleRate ?? DEFAULT_NATIVE_SAMPLE_RATE;
  }

  get running(): boolean {
    return this._running;
  }

  async listInputs(): Promise<{ id: string; label: string }[]> {
    return new Promise((resolvePromise, reject) => {
      let proc: ChildProcessByStdio<null, Readable, Readable>;
      try {
        proc = this.spawnFn(this.ffmpegPath, [
          '-hide_banner',
          '-list_devices',
          'true',
          '-f',
          'dshow',
          '-i',
          'dummy'
        ]);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        reject(new Error(`ffmpeg -list_devices timed out after ${LIST_DEVICES_TIMEOUT_MS}ms`));
      }, LIST_DEVICES_TIMEOUT_MS);

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
      // `-list_devices true` makes ffmpeg print the device list and exit non-zero — that's
      // expected, not a failure, so resolve on 'exit' regardless of code.
      proc.on('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolvePromise(parseAudioDevices(stderr));
      });
    });
  }

  async start(deviceId: string | null, onFrame: (f: AudioFrame) => void): Promise<void> {
    if (this._running) return; // start while running is a no-op (per voice-pipeline.md)

    let device = deviceId;
    if (device === null) {
      const inputs = await this.listInputs();
      const first = inputs[0];
      if (!first) throw new Error('FfmpegCapture: no audio input devices found');
      device = first.id;
    }

    const framer = new Framer(FRAME_SIZE);

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'dshow',
      '-sample_rate',
      String(this.nativeSampleRate),
      '-channels',
      '1',
      '-i',
      `audio=${device}`,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      String(this.nativeSampleRate),
      'pipe:1'
    ];

    const proc = this.spawnFn(this.ffmpegPath, args);
    this.proc = proc;
    this._running = true;

    let leftoverByte: Buffer = Buffer.alloc(0);

    proc.stdout.on('data', (chunk: Buffer) => {
      let data: Buffer = chunk;
      if (leftoverByte.length > 0) {
        data = Buffer.concat([leftoverByte, chunk]);
        leftoverByte = Buffer.alloc(0);
      }
      // PCM samples are 2 bytes each; a chunk boundary can split a sample in half.
      const usableLength = data.length - (data.length % 2);
      if (usableLength < data.length) {
        leftoverByte = Buffer.from(data.subarray(usableLength));
      }
      if (usableLength === 0) return;

      const sampleCount = usableLength / 2;
      const nativeSamples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        nativeSamples[i] = data.readInt16LE(i * 2);
      }

      const resampled =
        this.nativeSampleRate === 16000 ? nativeSamples : resampleTo16k(nativeSamples, this.nativeSampleRate);

      for (const samples of framer.push(resampled)) {
        onFrame({ samples });
      }
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      // Bound memory in case ffmpeg is unusually chatty over a long-running capture.
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    proc.on('exit', (code, signal) => {
      const wasRunning = this._running;
      this._running = false;
      this.proc = null;
      if (wasRunning) {
        // An exit while we still believe we're running is unexpected (stop() clears _running
        // before killing the process itself) — surface it rather than swallowing the crash.
        this.emit(
          'crash',
          new Error(`ffmpeg exited unexpectedly (code=${code}, signal=${signal}): ${stderr.trim()}`)
        );
      }
    });

    proc.on('error', (err) => {
      this._running = false;
      this.proc = null;
      this.emit('crash', err);
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this._running = false;
    this.proc = null;

    if (!proc) return;

    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGKILL');
        resolvePromise();
      }, STOP_TIMEOUT_MS);
      proc.once('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolvePromise();
      });
      proc.kill();
    });
  }
}

/** Production factory. `ffmpegPath` must come from `resolveModelPaths()` — never resolved from
 * PATH (cdd/plan/amendments.md A6). */
export function createAudioCapture(ffmpegPath: string): AudioCapture {
  return new FfmpegCapture({ ffmpegPath });
}
