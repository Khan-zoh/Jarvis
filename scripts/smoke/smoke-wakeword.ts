// Manual smoke test for native openWakeWord (packages/app/src/voice/wakeword.ts). Not part of
// `npm test` — run by hand: `npx tsx scripts/smoke/smoke-wakeword.ts` (or
// `node --import tsx scripts/smoke/smoke-wakeword.ts`). See cdd/tasks/wakeword.md ("Acceptance")
// and the README for the voice setup contract.
//
// What it does:
//   1. Resolves ffmpeg.exe and the three openWakeWord ONNX files via resolveModelPaths().
//   2. Starts AudioCapture on the default input.
//      contract as smoke-capture.ts/smoke-stt.ts) and starts AudioCapture on the default input.
//   3. Feeds every captured frame into a real OpenWakeWord instance; on each detection prints
//      `WAKE <ISO timestamp>`.
//   4. Runs until Ctrl+C (SIGINT) or a hard watchdog timeout, then releases the detector and
//      stops capture cleanly.
//
// This file imports the real .ts sources via Vite's programmatic SSR module loader rather than
// plain `node`/ESM import — same reasoning as smoke-capture.ts/smoke-stt.ts: those files use the
// project's extensionless relative imports (TS "Bundler" moduleResolution) that plain Node ESM
// can't resolve on its own. `vite` is already a devDependency of packages/app; no new dependency
// added.

import { createServer, type ViteDevServer } from 'vite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const APP_SRC = join(REPO_ROOT, 'packages', 'app', 'src');

// Overall session watchdog: long enough to comfortably try the wake word 5+ times by hand
// (cdd/tasks/wakeword.md acceptance: >=4 of 5 tries), short enough to never leave an unattended
// process hanging forever.
const HARD_TIMEOUT_MS = 5 * 60_000;

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

interface WakeWordConfig {
  sensitivity: number;
}

interface WakeWordDetectorLike {
  init(cfg: WakeWordConfig): Promise<void>;
  process(frame: AudioFrame): Promise<boolean>;
  release(): void;
}

function parseSensitivity(raw: string | undefined): number {
  if (!raw) return 0.6;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.6;
}

async function main(): Promise<void> {
  const sensitivity = parseSensitivity(process.env.WAKE_SENSITIVITY);

  let server: ViteDevServer | undefined;
  let capture: AudioCaptureLike | undefined;
  let wake: WakeWordDetectorLike | undefined;
  let shuttingDown = false;

  const watchdog = setTimeout(() => {
    console.error(`smoke-wakeword: hard watchdog fired after ${HARD_TIMEOUT_MS}ms — forcing exit`);
    process.exit(1);
  }, HARD_TIMEOUT_MS);
  watchdog.unref?.();

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(watchdog);
    try {
      await capture?.stop();
    } catch {
      // best-effort on shutdown
    }
    wake?.release();
    await server?.close();
  };

  process.on('SIGINT', () => {
    console.log('\nsmoke-wakeword: stopping (Ctrl+C)...');
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });

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
    const wakewordMod = await server.ssrLoadModule(join(APP_SRC, 'voice', 'wakeword.ts'));

    const resolveModelPaths = modelPathsMod.resolveModelPaths as (opts?: {
      modelsRoot?: string;
    }) => {
      ffmpegExe: string;
      wakeMelSpectrogram: string;
      wakeEmbedding: string;
      wakeWordModel: string;
    } | { missing: string[] };
    const createAudioCapture = captureMod.createAudioCapture as (ffmpegPath: string) => AudioCaptureLike;
    const createWakeWordDetector = wakewordMod.createWakeWordDetector as (paths: {
      melSpectrogram: string;
      embedding: string;
      wakeWord: string;
    }) => WakeWordDetectorLike;

    const modelsRoot = join(REPO_ROOT, 'models');
    const paths = resolveModelPaths({ modelsRoot });
    if ('missing' in paths) {
      console.error('smoke-wakeword: models are missing, run `npm run fetch-models` first.');
      console.error(`  missing: ${paths.missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Using ffmpeg: ${paths.ffmpegExe}`);
    console.log('Wake phrase: "hey jarvis" (native openWakeWord ONNX)');
    console.log(`Sensitivity: ${sensitivity}`);

    wake = createWakeWordDetector({
      melSpectrogram: paths.wakeMelSpectrogram,
      embedding: paths.wakeEmbedding,
      wakeWord: paths.wakeWordModel
    });
    await wake.init({ sensitivity });

    capture = createAudioCapture(paths.ffmpegExe);

    const inputs = await capture.listInputs();
    if (inputs.length === 0) {
      console.log('No audio input devices found. Nothing more to do (this is not a failure).');
      await shutdown();
      return;
    }

    let crashed: Error | null = null;
    capture.on?.('crash', (err: Error) => {
      crashed = err;
      console.error('smoke-wakeword: ffmpeg reported a crash during capture:');
      console.error(err.message);
    });

    console.log(`Listening on "${inputs[0]?.label}". Say the wake word (Ctrl+C to stop)...`);

    let inference = Promise.resolve();
    await capture.start(null, (frame) => {
      inference = inference.then(async () => {
        if (wake && (await wake.process(frame))) {
          console.log(`WAKE ${new Date().toISOString()}`);
        }
      }).catch((err: unknown) => {
        crashed = err instanceof Error ? err : new Error(String(err));
      });
    });

    // Idle until SIGINT or the watchdog fires; the frame callback above does all the work.
    await new Promise<void>((resolvePromise) => {
      const check = setInterval(() => {
        if (shuttingDown || crashed) {
          clearInterval(check);
          resolvePromise();
        }
      }, 250);
    });

    if (crashed) {
      process.exitCode = 1;
    }
  } finally {
    await shutdown();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('smoke-wakeword failed:', err);
    process.exit(1);
  });
