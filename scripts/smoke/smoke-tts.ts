// Manual smoke test for TextToSpeech (packages/app/src/voice/tts.ts + player.ts). Not part of
// `npm test` — run by hand: `node scripts/smoke/smoke-tts.ts`. See cdd/tasks/tts-piper.md
// ("Acceptance") and cdd/plan/amendments.md A6.
//
// What it does:
//   1. Resolves piper.exe / the piper voice / ffplay.exe via resolveModelPaths() (never PATH).
//   2. Speaks two short sentences back to back through the real piper + ffplay pipeline (plays
//      audio out the default output device).
//   3. Queues a third, longer sentence and cancels it ~150ms after starting — proving cancel()
//      cuts speech mid-sentence: item 3's actual playback duration should be far shorter than
//      items 1/2's.
//   4. Reports per-item wall-clock duration and exits 0. Never leaves a hanging piper/ffplay
//      process — every step is wrapped in a hard timeout, and cancel()/an overall watchdog kill
//      anything still running before exit.
//
// This file imports the real .ts sources via Vite's programmatic SSR module loader rather than
// plain `node`/ESM import, matching scripts/smoke/smoke-capture.ts — see that file's header
// comment for why (extensionless relative imports under TS "Bundler" moduleResolution).

import { createServer, type ViteDevServer } from 'vite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const APP_SRC = join(REPO_ROOT, 'packages', 'app', 'src');

const HARD_TIMEOUT_MS = 60_000; // overall watchdog: never leave the process hanging
const CANCEL_AFTER_MS = 150; // cancel item 3 shortly after it starts playing

interface TextToSpeechLike {
  init(cfg: { voicePath: string }): Promise<void>;
  speak(text: string): Promise<void>;
  cancel(): void;
  readonly speaking: boolean;
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
    console.error(`smoke-tts: hard watchdog fired after ${HARD_TIMEOUT_MS}ms — forcing exit`);
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
    const ttsMod = await server.ssrLoadModule(join(APP_SRC, 'voice', 'tts.ts'));
    const playerMod = await server.ssrLoadModule(join(APP_SRC, 'voice', 'player.ts'));

    const resolveModelPaths = modelPathsMod.resolveModelPaths as (opts?: {
      modelsRoot?: string;
    }) => { piperExe: string; piperVoice: string; ffplayExe: string } | { missing: string[] };
    const createPiperTts = ttsMod.createPiperTts as (piperExe: string, player: unknown) => TextToSpeechLike;
    const createPcmPlayer = playerMod.createPcmPlayer as (ffplayExe: string) => unknown;

    const modelsRoot = join(REPO_ROOT, 'models');
    const paths = resolveModelPaths({ modelsRoot });
    if ('missing' in paths) {
      console.error('smoke-tts: models are missing, run `npm run fetch-models` first.');
      console.error(`  missing: ${paths.missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Using piper: ${paths.piperExe}`);
    console.log(`Using voice: ${paths.piperVoice}`);
    console.log(`Using ffplay: ${paths.ffplayExe}`);

    const player = createPcmPlayer(paths.ffplayExe);
    const tts = createPiperTts(paths.piperExe, player);

    console.log('Initializing PiperTts...');
    await withHardTimeout(tts.init({ voicePath: paths.piperVoice }), 15_000, 'init()');

    const sentences = [
      'Hello, this is the first test sentence.',
      'And here comes the second sentence right after it.'
    ];

    for (const [i, text] of sentences.entries()) {
      const start = Date.now();
      console.log(`Speaking item ${i + 1}: "${text}"`);
      await withHardTimeout(tts.speak(text), 20_000, `speak() item ${i + 1}`);
      console.log(`  item ${i + 1} finished in ${Date.now() - start}ms`);
    }

    const longSentence =
      'This third sentence is deliberately long so that cancellation lands well before ' +
      'the speech would finish naturally, giving a clear before and after to compare durations against.';

    console.log(`Speaking item 3 (will cancel after ~${CANCEL_AFTER_MS}ms): "${longSentence}"`);
    const item3Start = Date.now();
    const item3Promise = withHardTimeout(tts.speak(longSentence), 20_000, 'speak() item 3');

    await new Promise((r) => setTimeout(r, CANCEL_AFTER_MS));
    console.log('Cancelling...');
    tts.cancel();

    await item3Promise; // cancel() resolves in-flight speak(), never rejects
    const item3Duration = Date.now() - item3Start;
    console.log(`  item 3 (cancelled) resolved after ${item3Duration}ms`);
    console.log(`  speaking flag after cancel: ${tts.speaking}`);

    if (tts.speaking) {
      console.error('smoke-tts: FAILED — speaking is still true after cancel().');
      process.exitCode = 1;
      return;
    }

    if (item3Duration > 5000) {
      console.error(
        `smoke-tts: FAILED — cancelled item took ${item3Duration}ms, expected it to be cut short (<5000ms).`
      );
      process.exitCode = 1;
      return;
    }

    console.log('smoke-tts: PASSED — two sentences spoken, third cancelled mid-way as expected.');
  } finally {
    clearTimeout(watchdog);
    await server?.close();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('smoke-tts failed:', err);
    process.exit(1);
  });
