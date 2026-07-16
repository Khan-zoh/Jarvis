// Integration test: runs the REAL Silero VAD onnx model (models/vad/silero_vad.onnx, no fakes)
// over fixtures/utterance.pcm and fixtures/silence.pcm, per cdd/tasks/vad-endpointing.md
// ("SileroVad integration"). Skipped entirely when the provisioned model isn't on disk (mirrors
// stt.integration.test.ts's describe.skipIf pattern) so checkouts without `npm run fetch-models`
// still pass.
//
// fixtures/utterance.pcm: 16kHz mono s16 raw PCM, "What time is it?" (see stt.integration.test.ts
// for provenance). fixtures/silence.pcm: 2s of 16kHz mono s16 near-zero dither noise (deterministic
// PRNG, +/-2 LSB — see scripts used to generate it) — "near-zero" rather than bit-perfect zero.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SileroVad } from '../src/voice/vad';
import { resolveModelPaths } from '../src/main/modelPaths';

const here = dirname(fileURLToPath(import.meta.url));
// test/ -> app/ -> packages/ -> repo root
const repoRoot = join(here, '..', '..', '..');
const modelsRoot = join(repoRoot, 'models');

const paths = resolveModelPaths({ modelsRoot });
const modelsPresent = !('missing' in paths);

const FRAME_SIZE = 512;

function loadFixtureFrames(fileName: string): Int16Array[] {
  const buf = readFileSync(join(here, 'fixtures', fileName));
  const totalSamples = Math.floor(buf.length / 2);
  const numFrames = Math.floor(totalSamples / FRAME_SIZE);
  const frames: Int16Array[] = [];
  for (let f = 0; f < numFrames; f++) {
    const frame = new Int16Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      frame[i] = buf.readInt16LE((f * FRAME_SIZE + i) * 2);
    }
    frames.push(frame);
  }
  return frames;
}

describe.skipIf(!modelsPresent)('SileroVad (real silero_vad.onnx)', () => {
  it('classifies fixtures/utterance.pcm as speech in the middle and silence at the edges', async () => {
    if ('missing' in paths) throw new Error('unreachable — guarded by describe.skipIf');

    const vad = new SileroVad({ modelPath: paths.sileroVad });
    await vad.init();

    const frames = loadFixtureFrames('utterance.pcm');
    expect(frames.length).toBeGreaterThan(10);

    const classes: Array<'speech' | 'silence'> = [];
    for (const frame of frames) {
      classes.push(await vad.process({ samples: frame }));
    }

    // eslint-disable-next-line no-console
    console.log(
      `[vad.integration] utterance.pcm: ${frames.length} frames, classes=${JSON.stringify(classes)}`
    );

    const speechCount = classes.filter((c) => c === 'speech').length;
    expect(speechCount).toBeGreaterThan(0);

    // At least one speech frame somewhere in the middle third of the clip.
    const midStart = Math.floor(classes.length / 3);
    const midEnd = Math.ceil((classes.length * 2) / 3);
    const midSpeech = classes.slice(midStart, midEnd).some((c) => c === 'speech');
    expect(midSpeech).toBe(true);

    // The very first and very last frames (edges) should be silence.
    expect(classes[0]).toBe('silence');
    expect(classes[classes.length - 1]).toBe('silence');
  }, 30_000);

  it('classifies every frame of fixtures/silence.pcm as silence (zero speech frames)', async () => {
    if ('missing' in paths) throw new Error('unreachable — guarded by describe.skipIf');

    const vad = new SileroVad({ modelPath: paths.sileroVad });
    await vad.init();

    const frames = loadFixtureFrames('silence.pcm');
    expect(frames.length).toBeGreaterThan(10);

    const classes: Array<'speech' | 'silence'> = [];
    for (const frame of frames) {
      classes.push(await vad.process({ samples: frame }));
    }

    // eslint-disable-next-line no-console
    console.log(
      `[vad.integration] silence.pcm: ${frames.length} frames, classes=${JSON.stringify(classes)}`
    );

    expect(classes.every((c) => c === 'silence')).toBe(true);
  }, 30_000);

  it('reset() zeroes recurrent state so a fresh utterance is unaffected by prior audio', async () => {
    if ('missing' in paths) throw new Error('unreachable — guarded by describe.skipIf');

    const vad = new SileroVad({ modelPath: paths.sileroVad });
    await vad.init();

    // Run the speech-containing fixture through once to build up non-zero recurrent state.
    for (const frame of loadFixtureFrames('utterance.pcm')) {
      await vad.process({ samples: frame });
    }

    vad.reset();

    // Immediately after reset, silence should still classify as silence (state carried over from
    // the prior utterance's speech tail doesn't leak into the new one).
    const silenceFrames = loadFixtureFrames('silence.pcm');
    const first = await vad.process({ samples: silenceFrames[0]! });
    expect(first).toBe('silence');
  }, 30_000);
});
