import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModelPaths } from '../src/main/modelPaths';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-modelpaths-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(...segments: string[]): void {
  const p = join(dir, ...segments);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, 'x');
}

describe('resolveModelPaths', () => {
  it('returns the full missing list on an empty models dir', () => {
    const result = resolveModelPaths({ modelsRoot: dir });
    expect('missing' in result).toBe(true);
    if ('missing' in result) {
      expect(result.missing.sort()).toEqual(
        ['ffmpegExe', 'ffplayExe', 'piperExe', 'piperVoice', 'sileroVad', 'whisperCli', 'whisperModel'].sort()
      );
    }
  });

  it('does not require embedder files when the brain is disabled', () => {
    touch('bin', 'whisper-cli.exe');
    touch('whisper', 'ggml-small.en.bin');
    touch('bin', 'piper', 'piper.exe');
    touch('piper', 'en_US-lessac-medium.onnx');
    touch('piper', 'en_US-lessac-medium.onnx.json');
    touch('vad', 'silero_vad.onnx');
    touch('bin', 'ffmpeg', 'ffmpeg.exe');
    touch('bin', 'ffmpeg', 'ffplay.exe');

    const result = resolveModelPaths({ modelsRoot: dir, brainEnabled: false });
    expect('missing' in result).toBe(false);
    if (!('missing' in result)) {
      expect(result.whisperCli).toBe(join(dir, 'bin', 'whisper-cli.exe'));
      expect(result.whisperModel).toBe(join(dir, 'whisper', 'ggml-small.en.bin'));
      expect(result.piperExe).toBe(join(dir, 'bin', 'piper', 'piper.exe'));
      expect(result.piperVoice).toBe(join(dir, 'piper', 'en_US-lessac-medium.onnx'));
      expect(result.sileroVad).toBe(join(dir, 'vad', 'silero_vad.onnx'));
      expect(result.ffmpegExe).toBe(join(dir, 'bin', 'ffmpeg', 'ffmpeg.exe'));
      expect(result.ffplayExe).toBe(join(dir, 'bin', 'ffmpeg', 'ffplay.exe'));
      expect(result.embedModel).toBeUndefined();
      expect(result.embedTokenizer).toBeUndefined();
    }
  });

  it('requires embedder files when the brain is enabled', () => {
    touch('bin', 'whisper-cli.exe');
    touch('whisper', 'ggml-small.en.bin');
    touch('bin', 'piper', 'piper.exe');
    touch('piper', 'en_US-lessac-medium.onnx');
    touch('piper', 'en_US-lessac-medium.onnx.json');
    touch('vad', 'silero_vad.onnx');
    touch('bin', 'ffmpeg', 'ffmpeg.exe');
    touch('bin', 'ffmpeg', 'ffplay.exe');

    const withoutEmbed = resolveModelPaths({ modelsRoot: dir, brainEnabled: true });
    expect('missing' in withoutEmbed).toBe(true);
    if ('missing' in withoutEmbed) {
      expect(withoutEmbed.missing.sort()).toEqual(['embedModel', 'embedTokenizer'].sort());
    }

    touch('embed', 'model.onnx');
    touch('embed', 'tokenizer.json');

    const withEmbed = resolveModelPaths({ modelsRoot: dir, brainEnabled: true });
    expect('missing' in withEmbed).toBe(false);
    if (!('missing' in withEmbed)) {
      expect(withEmbed.embedModel).toBe(join(dir, 'embed', 'model.onnx'));
      expect(withEmbed.embedTokenizer).toBe(join(dir, 'embed', 'tokenizer.json'));
    }
  });

  it('treats a missing piper voice config json as an incomplete piper voice', () => {
    touch('bin', 'whisper-cli.exe');
    touch('whisper', 'ggml-small.en.bin');
    touch('bin', 'piper', 'piper.exe');
    touch('piper', 'en_US-lessac-medium.onnx');
    // .onnx.json intentionally omitted
    touch('vad', 'silero_vad.onnx');
    touch('bin', 'ffmpeg', 'ffmpeg.exe');
    touch('bin', 'ffmpeg', 'ffplay.exe');

    const result = resolveModelPaths({ modelsRoot: dir });
    expect('missing' in result).toBe(true);
    if ('missing' in result) {
      expect(result.missing).toEqual(['piperVoice']);
    }
  });

  it('populates whisperServer when whisper-server.exe is present (and it never gates voice)', () => {
    touch('bin', 'whisper-cli.exe');
    touch('bin', 'whisper-server.exe');
    touch('whisper', 'ggml-small.en.bin');
    touch('bin', 'piper', 'piper.exe');
    touch('piper', 'en_US-lessac-medium.onnx');
    touch('piper', 'en_US-lessac-medium.onnx.json');
    touch('vad', 'silero_vad.onnx');
    touch('bin', 'ffmpeg', 'ffmpeg.exe');
    touch('bin', 'ffmpeg', 'ffplay.exe');

    const result = resolveModelPaths({ modelsRoot: dir });
    expect('missing' in result).toBe(false);
    if (!('missing' in result)) {
      expect(result.whisperServer).toBe(join(dir, 'bin', 'whisper-server.exe'));
    }
  });

  it('omits whisperServer (without adding it to missing) when whisper-server.exe is absent', () => {
    touch('bin', 'whisper-cli.exe');
    // whisper-server.exe intentionally omitted — the pipeline falls back to whisper-cli.
    touch('whisper', 'ggml-small.en.bin');
    touch('bin', 'piper', 'piper.exe');
    touch('piper', 'en_US-lessac-medium.onnx');
    touch('piper', 'en_US-lessac-medium.onnx.json');
    touch('vad', 'silero_vad.onnx');
    touch('bin', 'ffmpeg', 'ffmpeg.exe');
    touch('bin', 'ffmpeg', 'ffplay.exe');

    const result = resolveModelPaths({ modelsRoot: dir });
    expect('missing' in result).toBe(false);
    if (!('missing' in result)) {
      expect(result.whisperServer).toBeUndefined();
    }
  });

  it('reports ffmpegExe and ffplayExe individually when only one of the pair is missing', () => {
    touch('bin', 'whisper-cli.exe');
    touch('whisper', 'ggml-small.en.bin');
    touch('bin', 'piper', 'piper.exe');
    touch('piper', 'en_US-lessac-medium.onnx');
    touch('piper', 'en_US-lessac-medium.onnx.json');
    touch('vad', 'silero_vad.onnx');
    touch('bin', 'ffmpeg', 'ffmpeg.exe');
    // ffplay.exe intentionally omitted

    const result = resolveModelPaths({ modelsRoot: dir });
    expect('missing' in result).toBe(true);
    if ('missing' in result) {
      expect(result.missing).toEqual(['ffplayExe']);
    }
  });
});
