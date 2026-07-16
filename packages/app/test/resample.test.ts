import { describe, expect, it } from 'vitest';
import { Framer, resampleTo16k } from '../src/voice/resample';

function makeSine(sampleRate: number, freqHz: number, seconds: number): Int16Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 16000);
  }
  return out;
}

function countZeroCrossings(samples: Int16Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1] ?? 0;
    const cur = samples[i] ?? 0;
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) count++;
  }
  return count;
}

describe('resampleTo16k', () => {
  it('preserves length ratio when downsampling a 48kHz sine to 16kHz', () => {
    const fromRate = 48000;
    const input = makeSine(fromRate, 440, 1);
    const output = resampleTo16k(input, fromRate);

    const expectedLength = input.length / (fromRate / 16000); // 16000 samples for 1s @16k
    expect(output.length).toBeGreaterThan(expectedLength - 2);
    expect(output.length).toBeLessThan(expectedLength + 2);
  });

  it('preserves the underlying frequency (zero-crossing count) across the resample', () => {
    const fromRate = 48000;
    const freq = 440;
    const seconds = 1;
    const input = makeSine(fromRate, freq, seconds);
    const output = resampleTo16k(input, fromRate);

    const inputCrossings = countZeroCrossings(input);
    const outputCrossings = countZeroCrossings(output);
    // Both signals represent the same 1-second waveform, just sampled at different rates, so a
    // 440Hz tone should cross zero ~880 times in either — allow a small tolerance for
    // interpolation error at the edges.
    expect(Math.abs(outputCrossings - inputCrossings)).toBeLessThanOrEqual(2);
    expect(inputCrossings).toBeGreaterThan(800);
  });

  it('is a no-op when the input is already 16kHz', () => {
    const input = new Int16Array([1, 2, 3, -4, -5, 0]);
    const output = resampleTo16k(input, 16000);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it('handles empty input without throwing', () => {
    const output = resampleTo16k(new Int16Array(0), 48000);
    expect(output.length).toBe(0);
  });

  it('rejects a non-positive fromRate', () => {
    expect(() => resampleTo16k(new Int16Array([1, 2, 3]), 0)).toThrow();
  });
});

describe('Framer', () => {
  it('emits exact 512-sample frames and holds the remainder across pushes (300+700+36)', () => {
    const framer = new Framer(512);

    const framesA = framer.push(new Int16Array(300));
    expect(framesA).toHaveLength(0);
    expect(framer.pending).toBe(300);

    const framesB = framer.push(new Int16Array(700));
    expect(framesB).toHaveLength(1);
    expect(framesB[0]).toHaveLength(512);
    expect(framer.pending).toBe(488);

    const framesC = framer.push(new Int16Array(36));
    expect(framesC).toHaveLength(1);
    expect(framesC[0]).toHaveLength(512);
    expect(framer.pending).toBe(12);
  });

  it('preserves sample values across frame boundaries', () => {
    const framer = new Framer(4);
    const a = Int16Array.from([1, 2, 3]);
    const b = Int16Array.from([4, 5, 6, 7, 8]);

    expect(framer.push(a)).toHaveLength(0);
    const frames = framer.push(b);

    expect(frames).toHaveLength(2);
    expect(Array.from(frames[0] ?? [])).toEqual([1, 2, 3, 4]);
    expect(Array.from(frames[1] ?? [])).toEqual([5, 6, 7, 8]);
    expect(framer.pending).toBe(0);
  });

  it('reset() drops any buffered partial frame', () => {
    const framer = new Framer(512);
    framer.push(new Int16Array(300));
    expect(framer.pending).toBe(300);
    framer.reset();
    expect(framer.pending).toBe(0);
  });

  it('rejects a non-positive frameSize', () => {
    expect(() => new Framer(0)).toThrow();
  });
});
