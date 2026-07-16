// SpeechToText implementation on local whisper.cpp — see cdd/plan/voice-pipeline.md
// ("SpeechToText") for the binding interface/behavior and cdd/tasks/stt-whisper.md for the task
// contract. Mirrors the shape of ./capture.ts (FfmpegCapture): a constructor-injected exe path +
// injectable spawnFn so tests never spawn a real process, and a production factory that sources
// paths from resolveModelPaths().

import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { encodeWav } from './wav';

export interface SpeechToText {
  init(cfg: { modelPath: string }): Promise<void>;
  transcribe(audio: Int16Array): Promise<{ text: string; ms: number }>;
}

/** Minimal shape WhisperCppStt needs from a spawned process — same contract as capture.ts's
 * SpawnFn. Real `spawn` (stdio: ['ignore','pipe','pipe']) satisfies this directly; tests inject a
 * lightweight fake so no real whisper-cli process is ever spawned in unit tests. */
export type SttSpawnFn = (
  command: string,
  args: string[]
) => ChildProcessByStdio<null, Readable, Readable>;

const TIMEOUT_MS = 30_000;

function defaultSpawn(command: string, args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<
    null,
    Readable,
    Readable
  >;
}

/** Strips whisper.cpp transcription artifacts and normalizes whitespace, per
 * cdd/tasks/stt-whisper.md: `[BLANK_AUDIO]` markers, parenthesized noise annotations (e.g.
 * `(wind blowing)`), and leading/trailing quote characters. Exported so the artifact-stripping
 * table can be unit-tested directly against this pure function. Transcripts shorter than 2
 * characters after cleanup collapse to `''` (the pipeline treats that as a cancel). */
export function cleanTranscript(raw: string): string {
  let text = raw;
  text = text.replace(/\[BLANK_AUDIO\]/gi, '');
  text = text.replace(/\([^)]*\)/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^["']+/, '').replace(/["']+$/, '');
  text = text.trim();
  return text.length < 2 ? '' : text;
}

export interface WhisperCppSttOptions {
  /** Path to whisper-cli.exe. Sourced from resolveModelPaths().whisperCli — never resolved from
   * PATH, matching FfmpegCapture's ffmpegPath contract. */
  whisperCliPath: string;
  /** Injectable in tests; defaults to node:child_process's real `spawn`. */
  spawnFn?: SttSpawnFn;
  /** Base directory for per-call temp WAV/output files. Defaults to os.tmpdir(). */
  tmpDir?: string;
}

export class WhisperCppStt implements SpeechToText {
  private readonly whisperCliPath: string;
  private readonly spawnFn: SttSpawnFn;
  private readonly tmpDirBase: string;
  private modelPath = '';

  constructor(opts: WhisperCppSttOptions) {
    this.whisperCliPath = opts.whisperCliPath;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.tmpDirBase = opts.tmpDir ?? tmpdir();
  }

  async init(cfg: { modelPath: string }): Promise<void> {
    this.modelPath = cfg.modelPath;
  }

  async transcribe(audio: Int16Array): Promise<{ text: string; ms: number }> {
    if (!this.modelPath) {
      throw new Error('WhisperCppStt.transcribe: init() must be called before transcribe()');
    }

    const start = Date.now();
    const dir = mkdtempSync(join(this.tmpDirBase, 'jarvis-stt-'));
    const wavPath = join(dir, 'audio.wav');
    const outBase = join(dir, 'audio');
    const txtPath = `${outBase}.txt`;

    try {
      writeFileSync(wavPath, encodeWav(audio));

      const args = [
        '-m',
        this.modelPath,
        '-f',
        wavPath,
        '-nt',
        '-np',
        '--language',
        'en',
        '--output-txt',
        '-of',
        outBase
      ];

      await this.runWhisperCli(args);

      const raw = existsSync(txtPath) ? readFileSync(txtPath, 'utf8') : '';
      const text = cleanTranscript(raw);
      return { text, ms: Date.now() - start };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private runWhisperCli(args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      let proc: ChildProcessByStdio<null, Readable, Readable>;
      try {
        proc = this.spawnFn(this.whisperCliPath, args);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let settled = false;
      let stderr = '';

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        reject(new Error(`whisper-cli timed out after ${TIMEOUT_MS}ms and was killed`));
      }, TIMEOUT_MS);

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      proc.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`whisper-cli exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        resolvePromise();
      });
    });
  }
}

/** Production factory. `whisperCliPath`/`modelPath` must come from resolveModelPaths() — never
 * resolved from PATH (cdd/plan/amendments.md A6, matching FfmpegCapture's contract). */
export function createSpeechToText(whisperCliPath: string): SpeechToText {
  return new WhisperCppStt({ whisperCliPath });
}
