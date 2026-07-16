// Pure unit tests for Endpointer (packages/app/src/voice/vad.ts). No onnxruntime, no fixtures —
// feeds synthetic 'speech'/'silence' sequences directly, per cdd/tasks/vad-endpointing.md
// ("Tests: Endpointer: pure table-driven tests").

import { describe, expect, it } from 'vitest';
import { Endpointer, FRAME_MS, type EndpointResult, type FrameClass } from '../src/voice/vad';

describe('FRAME_MS', () => {
  it('is 32ms, derived from 512 samples / 16000 Hz', () => {
    expect(FRAME_MS).toBe(32);
  });
});

describe('Endpointer', () => {
  it('never ends on a silence-only stream, however long', () => {
    const ep = new Endpointer();
    const results: EndpointResult[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(ep.push('silence'));
    }
    expect(results.every((r) => r === 'continue')).toBe(true);
  });

  it("ends exactly on the 25th consecutive silence frame following speech (25*32ms=800ms)", () => {
    const ep = new Endpointer();
    expect(ep.push('speech')).toBe('continue');

    for (let i = 1; i <= 24; i++) {
      expect(ep.push('silence')).toBe('continue');
    }
    // The 25th silence frame in a row is the one that crosses the 800ms threshold.
    expect(ep.push('silence')).toBe('end');
  });

  it('resets the silence counter on any interleaved speech frame, delaying end', () => {
    const ep = new Endpointer();
    expect(ep.push('speech')).toBe('continue');

    for (let i = 1; i <= 20; i++) {
      expect(ep.push('silence')).toBe('continue');
    }
    // A speech frame here resets the consecutive-silence run.
    expect(ep.push('speech')).toBe('continue');

    for (let i = 1; i <= 24; i++) {
      expect(ep.push('silence')).toBe('continue');
    }
    expect(ep.push('silence')).toBe('end');
  });

  it('reports too-long at frame 469 on continuous speech (ceil(15000/32)=469)', () => {
    const ep = new Endpointer();
    let last: EndpointResult = 'continue';
    let tooLongAt = -1;
    for (let i = 1; i <= 469; i++) {
      last = ep.push('speech');
      if (last === 'too-long' && tooLongAt === -1) tooLongAt = i;
    }
    expect(tooLongAt).toBe(469);
    expect(last).toBe('too-long');
  });

  it('reports too-long at frame 469 on continuous silence too (hard cap applies regardless of content)', () => {
    const ep = new Endpointer();
    let last: EndpointResult = 'continue';
    for (let i = 1; i <= 469; i++) {
      last = ep.push('silence');
    }
    expect(last).toBe('too-long');
  });

  it('does not end or too-long before their respective thresholds', () => {
    const ep = new Endpointer();
    ep.push('speech');
    for (let i = 1; i <= 23; i++) {
      expect(ep.push('silence')).toBe('continue');
    }
  });

  it('honors a custom silenceMs threshold', () => {
    // 320ms / 32ms = 10 frames exactly.
    const ep = new Endpointer({ silenceMs: 320 });
    ep.push('speech');
    for (let i = 1; i <= 9; i++) {
      expect(ep.push('silence')).toBe('continue');
    }
    expect(ep.push('silence')).toBe('end');
  });

  it('honors a custom maxMs threshold', () => {
    // 320ms / 32ms = 10 frames exactly.
    const ep = new Endpointer({ maxMs: 320 });
    const sequence: FrameClass[] = new Array(9).fill('speech');
    for (const v of sequence) {
      expect(ep.push(v)).toBe('continue');
    }
    expect(ep.push('speech')).toBe('too-long');
  });

  it('too-long takes precedence over end when both thresholds are crossed on the same frame', () => {
    // silenceMs=32 -> 1-frame silence threshold; maxMs=64 -> 2-frame hard cap.
    const ep = new Endpointer({ silenceMs: 32, maxMs: 64 });
    expect(ep.push('speech')).toBe('continue'); // frame 1
    // frame 2: 1 consecutive silence frame alone would satisfy 'end', but totalFrames (2) also
    // crosses maxFrameThreshold (2) on this same push — too-long must win.
    expect(ep.push('silence')).toBe('too-long');
  });
});
