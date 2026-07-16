// Manual smoke test for WhisperCppStt (packages/app/src/voice/stt.ts). Not part of `npm test` —
// run by hand: `node scripts/smoke/smoke-stt.ts`. See cdd/tasks/stt-whisper.md ("Acceptance").
//
// What it does:
//   1. Resolves whisper-cli.exe + ggml-small.en.bin + ffmpeg.exe via resolveModelPaths().
//   2. Records ~4s from the default mic device (reusing AudioCapture from ./voice/capture.ts,
//      same as scripts/smoke/smoke-capture.ts).
//   3. Transcribes the recorded audio with WhisperCppStt and prints the text + latency.
//
// This file imports the real .ts sources via Vite's programmatic SSR module loader rather than
// plain `node`/ESM import — same reasoning as smoke-capture.ts: those files use the project's
// extensionless relative imports (TS "Bundler" moduleResolution) that plain Node ESM can't
// resolve on its own. `vite` is already a devDependency of packages/app; no new dependency added.

import { createServer, type ViteDevServer } from 'vite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const APP_SRC = join(REPO_ROOT, 'packages', 'app', 'src');

const RECORD_MS = 4000;
const HARD_TIMEOUT_MS = 90_000; // overall watchdog: never leave the process hanging

interface AudioFrame {
  samples: Int16Array;
}

interface AudioCaptureLike {
  listInputs(): Promise<{ id: string; label: string }[]>;
  start(deviceId: string | null, onFrame: (f: AudioFrame) => void): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
  on?(event: 'crash', listener: (err: Error) => void): unknown;
}

interface SpeechToTextLike {
  init(cfg: { modelPath: string }): Promise<void>;
  transcribe(audio: Int16Array): Promise<{ text: string; ms: number }>;
}

async function withHardTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function main(): Promise<void> {
  let server: ViteDevServer | undefined;

  const watchdog = setTimeout(() => {
    console.error(`smoke-stt: hard watchdog fired after ${HARD_TIMEOUT_MS}ms — forcing exit`);
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  watchdog.unref?.();

  try {
    server = await createServer({
      configFile: false,
      root: REPO_ROOT,
      logLevel: 'error',
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true, include: [] }
    });

    const modelPathsMod = await server.ssrLoadModule(join(APP_SRC, 'main', 'modelPaths.ts'));
    const captureMod = await server.ssrLoadModule(join(APP_SRC, 'voice', 'capture.ts'));
    const sttMod = await server.ssrLoadModule(join(APP_SRC, 'voice', 'stt.ts'));

    const resolveModelPaths = modelPathsMod.resolveModelPaths as (opts?: { modelsRoot?: string }) =>
      | { ffmpegExe: string; whisperCli: string; whisperModel: string }
      | { missing: string[] };
    const createAudioCapture = captureMod.createAudioCapture as (ffmpegPath: string) => AudioCaptureLike;
    const WhisperCppStt = sttMod.WhisperCppStt as new (opts: {
      whisperCliPath: string;
    }) => SpeechToTextLike;

    const modelsRoot = join(REPO_ROOT, 'models');
    const paths = resolveModelPaths({ modelsRoot });
    if ('missing' in paths) {
      console.error('smoke-stt: models are missing, run `npm run fetch-models` first.');
      console.error(`  missing: ${paths.missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Using whisper-cli: ${paths.whisperCli}`);
    console.log(`Using model: ${paths.whisperModel}`);

    const capture = createAudioCapture(paths.ffmpegExe);

    console.log('Listing audio input devices...');
    const inputs = await withHardTimeout(capture.listInputs(), 15_000, 'listInputs()');
    if (inputs.length === 0) {
      console.log('No audio input devices found. Nothing more to do (this is not a failure).');
      return;
    }

    let crashed: Error | null = null;
    capture.on?.('crash', (err: Error) => {
      crashed = err;
    });

    const collected: Int16Array[] = [];

    console.log(`Recording ~${RECORD_MS}ms from the default device: "${inputs[0]?.label}"...`);
    await withHardTimeout(
      capture.start(null, (frame) => {
        collected.push(frame.samples);
      }),
      15_000,
      'start()'
    );

    await new Promise((r) => setTimeout(r, RECORD_MS));
    await withHardTimeout(capture.stop(), 10_000, 'stop()');

    if (crashed) {
      console.error('smoke-stt: ffmpeg reported a crash during capture:');
      console.error((crashed as Error).message);
      process.exitCode = 1;
      return;
    }

    const totalSamples = collected.reduce((sum, s) => sum + s.length, 0);
    if (totalSamples === 0) {
      console.error('smoke-stt: no frames were captured (device produced no audio).');
      process.exitCode = 1;
      return;
    }

    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const s of collected) {
      merged.set(s, offset);
      offset += s.length;
    }
    console.log(`Captured ${(merged.length / 16000).toFixed(2)}s of audio. Transcribing...`);

    const stt = new WhisperCppStt({ whisperCliPath: paths.whisperCli });
    await stt.init({ modelPath: paths.whisperModel });

    const result = await withHardTimeout(stt.transcribe(merged), 35_000, 'transcribe()');

    console.log(`Transcript: ${JSON.stringify(result.text)}`);
    console.log(`Latency: ${result.ms}ms`);
    if (result.text === '') {
      console.log('(Empty transcript — expected if the room was silent during recording.)');
    }
  } finally {
    clearTimeout(watchdog);
    await server?.close();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('smoke-stt failed:', err);
    process.exit(1);
  });
