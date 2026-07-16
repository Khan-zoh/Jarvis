import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTranscript, WhisperCppStt, type SttSpawnFn } from '../src/voice/stt';

type FakeProc = ChildProcessByStdio<null, Readable, Readable> & {
  stdout: EventEmitter & Readable;
  stderr: EventEmitter & Readable;
  kill: ReturnType<typeof vi.fn>;
};

/** Same shape as capture.test.ts's fake process: real EventEmitters so production `.on(...)`
 * code works unmodified, but nothing ever spawns a real process. */
function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as unknown as FakeProc;
  proc.stdout = new EventEmitter() as EventEmitter & Readable;
  proc.stderr = new EventEmitter() as EventEmitter & Readable;
  proc.kill = vi.fn(() => {
    queueMicrotask(() => proc.emit('exit', null, 'SIGTERM'));
    return true;
  });
  return proc;
}

/** Finds the `-of <base>` output-file argument whisper-cli was given and writes `raw` to
 * `<base>.txt`, simulating whisper-cli's --output-txt side effect without spawning it. */
function writeOutputTxt(args: string[], raw: string): void {
  const idx = args.indexOf('-of');
  const base = args[idx + 1];
  if (!base) throw new Error('test fake: -of argument not found');
  writeFileSync(`${base}.txt`, raw);
}

describe('cleanTranscript', () => {
  const cases: Array<[string, string]> = [
    ['What time is it?', 'What time is it?'],
    [' What time is it? ', 'What time is it?'],
    ['[BLANK_AUDIO]', ''],
    ['[blank_audio]', ''],
    ['[BLANK_AUDIO] What time is it?', 'What time is it?'],
    ['(wind blowing)', ''],
    ['(wind blowing) hello there', 'hello there'],
    ['"What time is it?"', 'What time is it?'],
    ["'What time is it?'", 'What time is it?'],
    ['What   time    is   it?', 'What time is it?'],
    ['a', ''],
    ['', ''],
    ['ok', 'ok'],
    ['[BLANK_AUDIO]  (background noise)  ', '']
  ];

  it.each(cases)('cleanTranscript(%j) -> %j', (input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });
});

describe('WhisperCppStt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-stt-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('assembles the plan-specified flags and calls init() model path', async () => {
    let capturedArgs: string[] = [];
    const spawnFn: SttSpawnFn = vi.fn((_cmd, args) => {
      capturedArgs = args;
      writeOutputTxt(args, 'hello world');
      const proc = makeFakeProc();
      queueMicrotask(() => proc.emit('exit', 0, null));
      return proc;
    });

    const stt = new WhisperCppStt({ whisperCliPath: 'C:/fake/whisper-cli.exe', spawnFn, tmpDir });
    await stt.init({ modelPath: 'C:/fake/ggml-small.en.bin' });

    const result = await stt.transcribe(new Int16Array(16000));

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect((spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('C:/fake/whisper-cli.exe');
    expect(capturedArgs).toEqual(
      expect.arrayContaining([
        '-m',
        'C:/fake/ggml-small.en.bin',
        '-nt',
        '-np',
        '--language',
        'en',
        '--output-txt'
      ])
    );
    // -f <wav path> and -of <out base> are dynamic (temp dir) — check flags are present with a value.
    expect(capturedArgs[capturedArgs.indexOf('-f') + 1]).toMatch(/audio\.wav$/);
    expect(capturedArgs[capturedArgs.indexOf('-of') + 1]).toMatch(/audio$/);
    expect(result.text).toBe('hello world');
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('throws if transcribe() is called before init()', async () => {
    const spawnFn: SttSpawnFn = vi.fn(() => makeFakeProc());
    const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
    await expect(stt.transcribe(new Int16Array(10))).rejects.toThrow(/init\(\)/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('parses --output-txt content and applies artifact stripping/whitespace normalization', async () => {
    const spawnFn: SttSpawnFn = vi.fn((_cmd, args) => {
      writeOutputTxt(args, '[BLANK_AUDIO]  What   time  is it?  ');
      const proc = makeFakeProc();
      queueMicrotask(() => proc.emit('exit', 0, null));
      return proc;
    });

    const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
    await stt.init({ modelPath: 'model.bin' });
    const result = await stt.transcribe(new Int16Array(1600));

    expect(result.text).toBe('What time is it?');
  });

  it('returns empty text when the cleaned transcript is under 2 characters', async () => {
    const spawnFn: SttSpawnFn = vi.fn((_cmd, args) => {
      writeOutputTxt(args, '[BLANK_AUDIO]');
      const proc = makeFakeProc();
      queueMicrotask(() => proc.emit('exit', 0, null));
      return proc;
    });

    const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
    await stt.init({ modelPath: 'model.bin' });
    const result = await stt.transcribe(new Int16Array(1600));

    expect(result.text).toBe('');
  });

  it('returns empty text when whisper-cli produces no output-txt file at all', async () => {
    const spawnFn: SttSpawnFn = vi.fn(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => proc.emit('exit', 0, null));
      return proc;
    });

    const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
    await stt.init({ modelPath: 'model.bin' });
    const result = await stt.transcribe(new Int16Array(1600));

    expect(result.text).toBe('');
  });

  it('cleans up the temp working directory in the success path', async () => {
    const spawnFn: SttSpawnFn = vi.fn((_cmd, args) => {
      writeOutputTxt(args, 'hello world');
      const proc = makeFakeProc();
      queueMicrotask(() => proc.emit('exit', 0, null));
      return proc;
    });

    const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
    await stt.init({ modelPath: 'model.bin' });
    await stt.transcribe(new Int16Array(1600));

    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('cleans up the temp working directory even when whisper-cli exits non-zero', async () => {
    const spawnFn: SttSpawnFn = vi.fn(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('boom'));
        proc.emit('exit', 1, null);
      });
      return proc;
    });

    const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
    await stt.init({ modelPath: 'model.bin' });

    await expect(stt.transcribe(new Int16Array(1600))).rejects.toThrow(/exited with code 1/);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('cleans up the temp working directory when the spawned process errors', async () => {
    const spawnFn: SttSpawnFn = vi.fn(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => proc.emit('error', new Error('ENOENT: no such file')));
      return proc;
    });

    const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
    await stt.init({ modelPath: 'model.bin' });

    await expect(stt.transcribe(new Int16Array(1600))).rejects.toThrow(/ENOENT/);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('kills whisper-cli and rejects after the 30s timeout, then still cleans up', async () => {
    vi.useFakeTimers();
    try {
      let proc!: FakeProc;
      const spawnFn: SttSpawnFn = vi.fn(() => {
        proc = makeFakeProc();
        // Never emits 'exit' on its own — simulates a hung whisper-cli process.
        return proc;
      });

      const stt = new WhisperCppStt({ whisperCliPath: 'whisper-cli.exe', spawnFn, tmpDir });
      await stt.init({ modelPath: 'model.bin' });

      const pending = stt.transcribe(new Int16Array(1600));
      const assertion = expect(pending).rejects.toThrow(/timed out after 30000ms/);

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;

      expect(proc.kill).toHaveBeenCalledTimes(1);
      // kill()'s own fake 'exit' emission runs on a real microtask queued by fake-timer advance;
      // flush microtasks once more so the finally{} cleanup has definitely run.
      await Promise.resolve();
      expect(existsSync(tmpDir)).toBe(true);
      expect(readdirSync(tmpDir)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
