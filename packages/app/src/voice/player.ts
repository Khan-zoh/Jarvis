// PcmPlayer implementation — playback half of cdd/plan/voice-pipeline.md ("TextToSpeech") per
// the amendment in cdd/plan/amendments.md A6: naudiodon2 is dropped entirely (does not build in
// this environment); playback is ffplay only, spawned with an absolute path resolved via
// modelPaths.ts (never PATH), fed raw PCM on stdin.
//
// Kept as a narrow injected interface so PiperTts (./tts.ts) never spawns audio playback itself
// and tests can fake it without touching a real process or an output device.
//
// Raw-PCM input options: the pinned ffplay 8.0.1 build's `s16le` demuxer only recognizes its own
// private AVOptions `-sample_rate` / `-ch_layout` (verified via `ffplay -h demuxer=s16le`) — the
// commonly-documented generic `-ar`/`-ac` flags are NOT accepted here (`-ac` hard-fails with
// "Option not found"). Getting this wrong is silent unless stderr is captured: with `-ac`, ffplay
// exits almost immediately without ever opening an output device, and since `play()` originally
// resolved on ANY exit, that looked exactly like a fast, successful, silent playback. stderr is
// therefore piped and inspected on a genuine (non-stop-requested) failure.

import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface PcmPlayer {
  /** Plays a buffer of mono 16-bit signed PCM samples at `sampleRate` Hz. Resolves once
   * playback finishes — either naturally (all audio played) or because `stop()` was called.
   * Never rejects on `stop()`; only rejects if the player itself fails to start or errors out
   * unexpectedly. */
  play(pcm: Int16Array, sampleRate: number): Promise<void>;
  /** Stops playback immediately if something is currently playing; otherwise a no-op. Causes
   * any in-flight `play()` promise to resolve (not reject). */
  stop(): void;
}

/** Minimal shape FfplayPcmPlayer needs from a spawned process. node:child_process's real
 * `spawn` (with stdio: ['pipe', 'ignore', 'pipe']) satisfies this directly; tests inject a
 * lightweight fake so no real ffplay process (and no real output device) is ever touched. */
export type PlayerSpawnFn = (
  command: string,
  args: string[]
) => ChildProcessByStdio<Writable, null, Readable>;

export interface FfplayPcmPlayerOptions {
  /** Path to ffplay.exe. Never resolved from PATH — see cdd/plan/amendments.md A6. */
  ffplayExe: string;
  /** Injectable in tests; defaults to node:child_process's real `spawn`. */
  spawnFn?: PlayerSpawnFn;
}

function defaultSpawn(command: string, args: string[]): ChildProcessByStdio<Writable, null, Readable> {
  return nodeSpawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] }) as ChildProcessByStdio<
    Writable,
    null,
    Readable
  >;
}

export class FfplayPcmPlayer implements PcmPlayer {
  private readonly ffplayExe: string;
  private readonly spawnFn: PlayerSpawnFn;
  private active: {
    proc: ChildProcessByStdio<Writable, null, Readable>;
    stopRequested: boolean;
  } | null = null;

  constructor(opts: FfplayPcmPlayerOptions) {
    this.ffplayExe = opts.ffplayExe;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }

  play(pcm: Int16Array, sampleRate: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      let proc: ChildProcessByStdio<Writable, null, Readable>;
      try {
        proc = this.spawnFn(this.ffplayExe, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-autoexit',
          '-nodisp',
          '-f',
          's16le',
          '-sample_rate',
          String(sampleRate),
          '-ch_layout',
          'mono',
          '-i',
          'pipe:0'
        ]);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const playback = { proc, stopRequested: false };
      this.active = playback;
      let settled = false;
      let stderr = '';

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (this.active === playback) this.active = null;
        reject(err);
      });

      proc.on('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        if (this.active === playback) this.active = null;
        // A non-zero/killed exit we asked for via stop() still resolves (per the PcmPlayer
        // contract, cancellation is not a playback error). An unrequested non-zero exit (a bad
        // argument, a codec/device failure, etc.) is a genuine failure and must reject —
        // otherwise callers can't tell "played fine" from "silently never played" (see the
        // module comment above for exactly this bug).
        if (!playback.stopRequested && code !== 0) {
          reject(new Error(`ffplay exited with code ${code ?? 'null'} (signal=${signal ?? 'null'}): ${stderr.trim()}`));
          return;
        }
        resolvePromise();
      });

      const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      proc.stdin.on('error', () => {
        // Writing to a stdin whose process already died (e.g. immediate stop()) throws EPIPE —
        // the 'exit'/'error' handlers above already settle the promise, so swallow this.
      });
      proc.stdin.write(buf);
      proc.stdin.end();
    });
  }

  stop(): void {
    const playback = this.active;
    if (!playback) return;
    playback.stopRequested = true;
    playback.proc.kill();
    // Do not null out `proc` here — the 'exit' handler wired in play() is what resolves the
    // in-flight promise and clears the matching active process; stop() just requests it die.
  }
}

/** Production factory. `ffplayExe` must come from `resolveModelPaths()` — never resolved from
 * PATH (cdd/plan/amendments.md A6). */
export function createPcmPlayer(ffplayExe: string): PcmPlayer {
  return new FfplayPcmPlayer({ ffplayExe });
}
