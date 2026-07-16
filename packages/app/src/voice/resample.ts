// Pure, dependency-free audio-format helpers shared by AudioCapture implementations. See
// cdd/plan/voice-pipeline.md ("AudioCapture") — everything downstream of capture expects
// 16 kHz mono s16 PCM delivered as exact 512-sample frames.

/**
 * Resamples a mono s16 PCM buffer from `fromRate` Hz to 16 kHz using linear interpolation.
 * Linear interpolation is not brick-wall anti-aliased, but per cdd/tasks/audio-capture.md
 * ("linear interpolation is sufficient") that's an accepted tradeoff for speech-band audio at
 * the downsampling ratios this app actually sees (48kHz/44.1kHz -> 16kHz).
 */
export function resampleTo16k(input: Int16Array, fromRate: number): Int16Array {
  if (fromRate <= 0) {
    throw new Error(`resampleTo16k: invalid fromRate ${fromRate}`);
  }
  if (fromRate === 16000) {
    return input;
  }

  const ratio = fromRate / 16000;
  const outLength = input.length === 0 ? 0 : Math.max(0, Math.floor((input.length - 1) / ratio) + 1);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcPos - idx0;
    const s0 = input[idx0] ?? 0;
    const s1 = input[idx1] ?? 0;
    const interpolated = s0 + (s1 - s0) * frac;
    // Clamp defensively: interpolation of in-range s16 values can't overflow, but keep this
    // honest against future callers that might feed already-out-of-range data.
    out[i] = Math.max(-32768, Math.min(32767, Math.round(interpolated)));
  }

  return out;
}

/**
 * Rechunks an arbitrary stream of samples (delivered via successive `push` calls) into exact
 * `frameSize`-length frames (default 512 — Porcupine's required frame length, see
 * cdd/plan/voice-pipeline.md). Leftover samples that don't fill a whole frame are held and
 * prepended to the next `push`.
 */
export class Framer {
  private buffer: Int16Array = new Int16Array(0);

  constructor(private readonly frameSize: number = 512) {
    if (frameSize <= 0) {
      throw new Error(`Framer: invalid frameSize ${frameSize}`);
    }
  }

  /** Feeds new samples in; returns zero or more complete `frameSize`-length frames. */
  push(samples: Int16Array): Int16Array[] {
    const merged = new Int16Array(this.buffer.length + samples.length);
    merged.set(this.buffer, 0);
    merged.set(samples, this.buffer.length);

    const frames: Int16Array[] = [];
    let offset = 0;
    while (merged.length - offset >= this.frameSize) {
      frames.push(merged.slice(offset, offset + this.frameSize));
      offset += this.frameSize;
    }
    this.buffer = merged.slice(offset);
    return frames;
  }

  /** Samples currently buffered that haven't yet filled a whole frame. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Drops any buffered partial frame (e.g. when starting a fresh utterance/stream). */
  reset(): void {
    this.buffer = new Int16Array(0);
  }
}
