// Manual smoke test for AudioCapture (packages/app/src/voice/capture.ts). Not part of `npm test`
// — run by hand: `node scripts/smoke/smoke-capture.ts`. See cdd/tasks/audio-capture.md
// ("Acceptance") and cdd/plan/amendments.md A6.
//
// What it does:
//   1. Lists dshow audio input devices via ffmpeg (models/bin/ffmpeg/ffmpeg.exe, resolved
//      through resolveModelPaths() — never PATH).
//   2. If a device exists, records ~3s from the default device, writes a 16kHz mono s16 WAV to
//      scratch/capture-test.wav, and prints the peak sample level.
//   3. If no device exists, reports that and exits 0 (missing hardware is not a script failure).
//
// This file imports the real .ts sources (packages/app/src/voice/capture.ts,
// packages/app/src/main/modelPaths.ts) via Vite's programmatic SSR module loader rather than
// plain `node`/ESM import, because those files use the project's normal extensionless relative
// imports (TypeScript "Bundler" moduleResolution, matched by electron-vite/vitest elsewhere in
// the repo) which plain Node ESM cannot resolve on its own. `vite` is already a devDependency of
// packages/app; no new dependency was added for this.

import { createServer, type ViteDevServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const APP_SRC = join(REPO_ROOT, 'packages', 'app', 'src');

const RECORD_MS = 3000;
const HARD_TIMEOUT_MS = 60_000; // overall watchdog: never leave the process hanging

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

function writeWavFile(path: string, samples: Int16Array, sampleRate = 16000): void {
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  const data = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(samples[i] ?? 0, i * 2);
  }

  writeFileSync(path, Buffer.concat([header, data]));
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
    console.error(`smoke-capture: hard watchdog fired after ${HARD_TIMEOUT_MS}ms — forcing exit`);
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

    const resolveModelPaths = modelPathsMod.resolveModelPaths as (opts?: {
      modelsRoot?: string;
    }) => { ffmpegExe: string } | { missing: string[] };
    const createAudioCapture = captureMod.createAudioCapture as (ffmpegPath: string) => AudioCaptureLike;

    const modelsRoot = join(REPO_ROOT, 'models');
    const paths = resolveModelPaths({ modelsRoot });
    if ('missing' in paths) {
      console.error('smoke-capture: models are missing, run `npm run fetch-models` first.');
      console.error(`  missing: ${paths.missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Using ffmpeg: ${paths.ffmpegExe}`);
    const capture = createAudioCapture(paths.ffmpegExe);

    console.log('Listing audio input devices...');
    const inputs = await withHardTimeout(capture.listInputs(), 15_000, 'listInputs()');
    if (inputs.length === 0) {
      console.log('No audio input devices found. Nothing more to do (this is not a failure).');
      return;
    }

    console.log(`Found ${inputs.length} audio input device(s):`);
    for (const input of inputs) {
      console.log(`  - ${input.label}`);
    }

    let crashed: Error | null = null;
    capture.on?.('crash', (err: Error) => {
      crashed = err;
    });

    const collected: Int16Array[] = [];
    let peak = 0;

    console.log(`Recording ~${RECORD_MS}ms from the default device: "${inputs[0]?.label}"...`);
    await withHardTimeout(
      capture.start(null, (frame) => {
        collected.push(frame.samples);
        for (const s of frame.samples) {
          const abs = Math.abs(s);
          if (abs > peak) peak = abs;
        }
      }),
      15_000,
      'start()'
    );

    await new Promise((r) => setTimeout(r, RECORD_MS));
    await withHardTimeout(capture.stop(), 10_000, 'stop()');

    if (crashed) {
      console.error('smoke-capture: ffmpeg reported a crash during capture:');
      console.error((crashed as Error).message);
      process.exitCode = 1;
      return;
    }

    const totalSamples = collected.reduce((sum, s) => sum + s.length, 0);
    if (totalSamples === 0) {
      console.error('smoke-capture: no frames were captured (device produced no audio).');
      process.exitCode = 1;
      return;
    }

    const merged = new Int16Array(totalSamples);
    let offset = 0;
    for (const s of collected) {
      merged.set(s, offset);
      offset += s.length;
    }

    const scratchDir = join(REPO_ROOT, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const outPath = join(scratchDir, 'capture-test.wav');
    writeWavFile(outPath, merged, 16000);

    const peakFraction = peak / 32768;
    const peakDb = peak > 0 ? 20 * Math.log10(peakFraction) : -Infinity;

    console.log(`Wrote ${merged.length} samples (${(merged.length / 16000).toFixed(2)}s) to ${outPath}`);
    console.log(
      `Peak level: ${peak}/32768 (${(peakFraction * 100).toFixed(1)}% full scale, ${peakDb.toFixed(1)} dBFS)`
    );
  } finally {
    clearTimeout(watchdog);
    await server?.close();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('smoke-capture failed:', err);
    process.exit(1);
  });
