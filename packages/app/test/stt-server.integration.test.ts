// Integration test: spawns the REAL whisper-server.exe (models/bin/whisper-server.exe) with the
// real ggml-small.en.bin, round-trips fixtures/utterance.pcm over localhost HTTP, and reports the
// measured warm per-utterance latency — the number cdd/plan/amendments.md A6 requires (<2.5s
// budget; expected well under 1s warm since the model is loaded once at spawn). Skipped when the
// provisioned binaries/models are absent (mirrors stt.integration.test.ts's skipIf pattern).

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WhisperServerStt } from '../src/voice/stt-server';
import { resolveModelPaths } from '../src/main/modelPaths';

const here = dirname(fileURLToPath(import.meta.url));
// test/ -> app/ -> packages/ -> repo root
const repoRoot = join(here, '..', '..', '..');
const modelsRoot = join(repoRoot, 'models');

const paths = resolveModelPaths({ modelsRoot });
const ready = !('missing' in paths) && Boolean(paths.whisperServer);

function loadFixturePcm(): Int16Array {
  const buf = readFileSync(join(here, 'fixtures', 'utterance.pcm'));
  const samples = new Int16Array(buf.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buf.readInt16LE(i * 2);
  }
  return samples;
}

let stt: WhisperServerStt | null = null;

afterAll(() => {
  stt?.dispose(); // never leave an orphaned whisper-server behind
});

describe.skipIf(!ready)('WhisperServerStt (real whisper-server.exe + ggml-small.en.bin)', () => {
  it('serves warm transcriptions of utterance.pcm containing "time", well under the 2.5s budget', async () => {
    if ('missing' in paths || !paths.whisperServer) throw new Error('unreachable — skipIf-guarded');

    stt = new WhisperServerStt({ whisperServerPath: paths.whisperServer });
    const initStart = Date.now();
    await stt.init({ modelPath: paths.whisperModel });
    const initMs = Date.now() - initStart;

    const audio = loadFixturePcm();

    // First request after model load.
    const first = await stt.transcribe(audio);
    // Warm request — the steady-state per-utterance number Gate A budgets against.
    const warm = await stt.transcribe(audio);

    // eslint-disable-next-line no-console
    console.log(
      `[stt-server.integration] init(model load)=${initMs}ms first=${JSON.stringify(first.text)} ` +
        `${first.ms}ms warm=${JSON.stringify(warm.text)} ${warm.ms}ms`
    );

    expect(first.text.toLowerCase()).toContain('time');
    expect(warm.text.toLowerCase()).toContain('time');
    expect(warm.ms).toBeGreaterThan(0);
    expect(warm.ms).toBeLessThan(2500); // A6 budget
  }, 120_000);
});
