// Manual smoke test for SileroVad + Endpointer (packages/app/src/voice/vad.ts). Not part of
// `npm test` — run by hand: `node scripts/smoke/smoke-vad.ts`. See cdd/tasks/vad-endpointing.md
// ("Deliverables": "scripts/smoke/smoke-vad.ts: mic -> prints live `█`/`·` per frame and
// 'ENDPOINT' on end") and cdd/plan/amendments.md A6.
//
// What it does:
//   1. Resolves silero_vad.onnx + ffmpeg.exe via resolveModelPaths() (never PATH).
//   2. Records live from the default mic device (reusing AudioCapture from ./voice/capture.ts,
//      same as scripts/smoke/smoke-capture.ts) for RUN_MS, feeding every 512-sample frame through
//      the real SileroVad + a real Endpointer.
//   3. Prints one character per frame live: '█' for 'speech', '.' for 'silence' — and
//      "\nENDPOINT (<end|too-long>)" whenever the Endpointer fires, then starts a fresh utterance
//      (new Endpointer + vad.reset()) so a single run can show multiple utterances.
//   4. Per A6 ("Serialize inference... drop frames if inference falls behind"): since
//      SileroVad.process() is async and AudioCapture's onFrame callback is synchronous, this
//      script drops a frame outright (prints nothing, doesn't queue it) if the previous frame's
//      inference hasn't resolved yet, rather than letting a backlog build up.
//   5. Stops capture and exits cleanly after RUN_MS — never leaves a hanging ffmpeg/mic process.
//
// This file imports the real .ts sources via Vite's programmatic SSR module loader rather than
// plain `node`/ESM import, matching scripts/smoke/smoke-capture.ts and smoke-stt.ts — see those
// files' header comments for why (extensionless relative imports under TS "Bundler"
// moduleResolution that plain Node ESM can't resolve on its own).

import { createServer, type ViteDevServer } from 'vite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const APP_SRC = join(REPO_ROOT, 'packages', 'app', 'src');

const RUN_MS = 15_000; // how long to listen live
const HARD_TIMEOUT_MS = 45_000; // overall watchdog: never leave the process hanging

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

interface VoiceActivityDetectorLike {
  init(): Promise<void>;
  process(frame: AudioFrame): Promise<'speech' | 'silence'>;
  reset(): void;
}

type EndpointResult = 'continue' | 'end' | 'too-long';

interface EndpointerLike {
  push(v: 'speech' | 'silence'): EndpointResult;
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
    console.error(`smoke-vad: hard watchdog fired after ${HARD_TIMEOUT_MS}ms — forcing exit`);
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
    const vadMod = await server.ssrLoadModule(join(APP_SRC, 'voice', 'vad.ts'));

    const resolveModelPaths = modelPathsMod.resolveModelPaths as (opts?: { modelsRoot?: string }) =>
      | { ffmpegExe: string; sileroVad: string }
      | { missing: string[] };
    const createAudioCapture = captureMod.createAudioCapture as (ffmpegPath: string) => AudioCaptureLike;
    const SileroVad = vadMod.SileroVad as new (opts: {
      modelPath: string;
    }) => VoiceActivityDetectorLike;
    const Endpointer = vadMod.Endpointer as new (opts?: {
      silenceMs?: number;
      maxMs?: number;
    }) => EndpointerLike;

    const modelsRoot = join(REPO_ROOT, 'models');
    const paths = resolveModelPaths({ modelsRoot });
    if ('missing' in paths) {
      console.error('smoke-vad: models are missing, run `npm run fetch-models` first.');
      console.error(`  missing: ${paths.missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Using ffmpeg: ${paths.ffmpegExe}`);
    console.log(`Using silero_vad.onnx: ${paths.sileroVad}`);

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

    const vad = new SileroVad({ modelPath: paths.sileroVad });
    await withHardTimeout(vad.init(), 15_000, 'vad.init()');

    let endpointer = new Endpointer();
    let frameCount = 0;
    let endpointCount = 0;

    // AudioCapture's onFrame fires synchronously and ffmpeg's stdout delivers audio in bursts (a
    // handful of 512-sample frames land in one 'data' event, not one every 32ms on the dot), so a
    // naive "drop if an inference is already pending" would drop nearly every frame in each burst
    // even though the model easily keeps up (each process() call is a few ms). Instead: queue
    // frames and drain them sequentially as fast as inference completes. Only once the queue
    // backs up past MAX_QUEUE (real inference genuinely falling behind real time, per A6) do we
    // start dropping the oldest queued frame.
    const MAX_QUEUE = 32; // ~1s of audio at 32ms/frame
    const pending: AudioFrame[] = [];
    let draining = false;

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        while (pending.length > 0) {
          const frame = pending.shift()!;
          try {
            const cls = await vad.process(frame);
            frameCount += 1;
            process.stdout.write(cls === 'speech' ? '█' : '.');
            const result = endpointer.push(cls);
            if (result === 'end' || result === 'too-long') {
              endpointCount += 1;
              process.stdout.write(`\nENDPOINT (${result})\n`);
              vad.reset();
              endpointer = new Endpointer();
            }
          } catch (err) {
            console.error('\nsmoke-vad: vad.process() error:', err);
          }
        }
      } finally {
        draining = false;
      }
    }

    console.log(`Listening live from "${inputs[0]?.label}" for ${RUN_MS}ms — speak into the mic.`);
    console.log('(each character is one 32ms frame: "█" = speech, "." = silence)\n');

    await withHardTimeout(
      capture.start(null, (frame) => {
        pending.push(frame);
        if (pending.length > MAX_QUEUE) {
          pending.shift(); // inference has genuinely fallen behind real time — drop the oldest
        }
        void drain();
      }),
      15_000,
      'start()'
    );

    await new Promise((r) => setTimeout(r, RUN_MS));
    await withHardTimeout(capture.stop(), 10_000, 'stop()');

    console.log(`\n\nDone. Processed ${frameCount} frame(s), ${endpointCount} endpoint(s) fired.`);

    if (crashed) {
      console.error('smoke-vad: ffmpeg reported a crash during capture:');
      console.error((crashed as Error).message);
      process.exitCode = 1;
      return;
    }

    if (frameCount === 0) {
      console.error('smoke-vad: no frames were captured (device produced no audio).');
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(watchdog);
    await server?.close();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('smoke-vad failed:', err);
    process.exit(1);
  });
