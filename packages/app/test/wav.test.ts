import { describe, expect, it } from 'vitest';
import { encodeWav } from '../src/voice/wav';

describe('encodeWav', () => {
  it('writes every RIFF/fmt/data header field correctly for a known 1s 16kHz mono buffer', () => {
    const sampleRate = 16000;
    const samples = new Int16Array(sampleRate); // 1 second of silence
    samples[0] = 1234;
    samples[1] = -5678;

    const buf = encodeWav(samples, { sampleRate });

    const dataBytes = samples.length * 2;
    expect(buf.length).toBe(44 + dataBytes);

    // RIFF chunk descriptor
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.readUInt32LE(4)).toBe(36 + dataBytes);
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');

    // fmt subchunk
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
    expect(buf.readUInt32LE(16)).toBe(16); // PCM fmt chunk size
    expect(buf.readUInt16LE(20)).toBe(1); // AudioFormat = PCM
    expect(buf.readUInt16LE(22)).toBe(1); // NumChannels = mono
    expect(buf.readUInt32LE(24)).toBe(sampleRate);
    expect(buf.readUInt32LE(28)).toBe(sampleRate * 2); // ByteRate = SampleRate * BlockAlign
    expect(buf.readUInt16LE(32)).toBe(2); // BlockAlign = NumChannels * BitsPerSample/8
    expect(buf.readUInt16LE(34)).toBe(16); // BitsPerSample

    // data subchunk
    expect(buf.toString('ascii', 36, 40)).toBe('data');
    expect(buf.readUInt32LE(40)).toBe(dataBytes);

    // sample payload round-trips
    expect(buf.readInt16LE(44)).toBe(1234);
    expect(buf.readInt16LE(46)).toBe(-5678);
  });

  it('defaults to 16000 Hz when no sampleRate is given', () => {
    const buf = encodeWav(new Int16Array([1, 2, 3]));
    expect(buf.readUInt32LE(24)).toBe(16000);
  });

  it('encodes an empty sample buffer as a valid zero-length-data WAV', () => {
    const buf = encodeWav(new Int16Array(0));
    expect(buf.length).toBe(44);
    expect(buf.readUInt32LE(40)).toBe(0);
    expect(buf.readUInt32LE(4)).toBe(36);
  });
});
