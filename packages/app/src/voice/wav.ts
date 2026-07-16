// Minimal dependency-free WAV (RIFF/PCM) encoder. whisper-cli.exe (models/bin/whisper-cli.exe)
// only accepts file input, so WhisperCppStt (./stt.ts) needs to write the pipeline's raw
// 16kHz mono s16 PCM (cdd/plan/voice-pipeline.md) out as a real WAV file before spawning it.
// This is the entire encoder — no `wav`/`node-wav` package dependency, per cdd/tasks/stt-whisper.md.

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

export interface WavEncodeOptions {
  /** Defaults to 16000 — the pipeline's fixed sample rate. */
  sampleRate?: number;
}

/** Encodes mono 16-bit PCM samples as a complete little-endian WAV (RIFF) file buffer. */
export function encodeWav(samples: Int16Array, opts: WavEncodeOptions = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 16000;
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = samples.length * 2;

  const buf = Buffer.alloc(HEADER_BYTES + dataBytes);

  // RIFF chunk descriptor
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4); // ChunkSize = 4 + (8 + fmt size) + (8 + data size)
  buf.write('WAVE', 8, 'ascii');

  // fmt subchunk
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buf.writeUInt16LE(1, 20); // AudioFormat: 1 = PCM (uncompressed)
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data subchunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i] ?? 0, HEADER_BYTES + i * 2);
  }

  return buf;
}
