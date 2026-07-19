import { describe, expect, it, vi } from 'vitest';
import * as ort from 'onnxruntime-node';
import {
  OpenWakeWord,
  sensitivityToThreshold,
  type WakeWordModelPaths
} from '../src/voice/wakeword';

const paths: WakeWordModelPaths = {
  melSpectrogram: 'C:/models/wakeword/melspectrogram.onnx',
  embedding: 'C:/models/wakeword/embedding_model.onnx',
  wakeWord: 'C:/models/wakeword/hey_jarvis_v0.1.onnx'
};

function frame(length = 512, amplitude = 0): { samples: Int16Array } {
  return { samples: new Int16Array(length).fill(amplitude) };
}

function harness(score = 0.9) {
  const melRun = vi.fn(async (_feeds: Record<string, ort.Tensor>) => ({
    output: new ort.Tensor('float32', new Float32Array(8 * 32), [1, 1, 8, 32])
  }));
  const embeddingRun = vi.fn(async (_feeds: Record<string, ort.Tensor>) => ({
    conv2d_19: new ort.Tensor('float32', new Float32Array(96), [1, 1, 1, 96])
  }));
  const wakeRun = vi.fn(async (_feeds: Record<string, ort.Tensor>) => ({
    '53': new ort.Tensor('float32', Float32Array.of(score), [1, 1])
  }));
  const releases = [vi.fn(), vi.fn(), vi.fn()];
  const sessions = [melRun, embeddingRun, wakeRun].map((run, i) => ({
    run,
    release: releases[i]
  }));
  const createSession = vi.fn(async (_path: string) => {
    const session = sessions.shift();
    if (!session) throw new Error('unexpected session');
    return session;
  });
  return { melRun, embeddingRun, wakeRun, releases, createSession };
}

describe('OpenWakeWord', () => {
  it('maps the existing sensitivity control to a bounded score threshold', () => {
    expect(sensitivityToThreshold(0.6)).toBeCloseTo(0.5);
    expect(sensitivityToThreshold(1)).toBeCloseTo(0.1);
    expect(sensitivityToThreshold(0)).toBeCloseTo(0.95);
  });

  it('loads the pinned preprocessing, embedding, and classifier models', async () => {
    const h = harness();
    const wake = new OpenWakeWord({ modelPaths: paths, createSession: h.createSession });
    await wake.init({ sensitivity: 0.6 });
    expect(h.createSession.mock.calls.map(([p]) => p)).toEqual([
      paths.melSpectrogram,
      paths.embedding,
      paths.wakeWord
    ]);
  });

  it('buffers 512-sample capture frames into 1280-sample native inference chunks', async () => {
    const h = harness(0);
    const wake = new OpenWakeWord({ modelPaths: paths, createSession: h.createSession });
    await wake.init({ sensitivity: 0.6 });

    await wake.process(frame(512, 1));
    await wake.process(frame(512, 2));
    expect(h.melRun).not.toHaveBeenCalled();
    await wake.process(frame(512, 3));
    expect(h.melRun).toHaveBeenCalledTimes(1);

    const melInput = h.melRun.mock.calls[0]?.[0]?.input as ort.Tensor;
    expect(melInput.dims).toEqual([1, 1280]);
    const embeddingInput = h.embeddingRun.mock.calls[0]?.[0]?.input_1 as ort.Tensor;
    expect(embeddingInput.dims).toEqual([1, 76, 32, 1]);
    const wakeInput = h.wakeRun.mock.calls[0]?.[0]?.['x.1'] as ort.Tensor;
    expect(wakeInput.dims).toEqual([1, 16, 96]);
  });

  it('suppresses startup predictions, then detects a score above threshold', async () => {
    const h = harness(0.9);
    const wake = new OpenWakeWord({ modelPaths: paths, createSession: h.createSession });
    await wake.init({ sensitivity: 0.6 });
    const results: boolean[] = [];
    for (let i = 0; i < 15; i++) results.push(await wake.process(frame()));
    expect(h.wakeRun).toHaveBeenCalledTimes(6);
    expect(results.slice(0, -1)).not.toContain(true);
    expect(results.at(-1)).toBe(true);
  });

  it('requires init and enforces the 512-sample capture contract', async () => {
    const h = harness();
    const wake = new OpenWakeWord({ modelPaths: paths, createSession: h.createSession });
    await expect(wake.process(frame())).rejects.toThrow(/init\(\)/);
    await wake.init({ sensitivity: 0.6 });
    await expect(wake.process(frame(256))).rejects.toThrow(/512/);
  });

  it('rephrases model-load failures and releases initialized sessions idempotently', async () => {
    const createSession = vi.fn(async (_path: string) => {
      throw new Error('bad model');
    });
    const broken = new OpenWakeWord({ modelPaths: paths, createSession });
    await expect(broken.init({ sensitivity: 0.6 })).rejects.toThrow(
      /openWakeWord initialization failed/
    );

    const h = harness();
    const wake = new OpenWakeWord({ modelPaths: paths, createSession: h.createSession });
    await wake.init({ sensitivity: 0.6 });
    wake.release();
    wake.release();
    expect(h.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });
});
