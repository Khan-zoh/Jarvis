import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import { FfmpegCapture, parseAudioDevices, type AudioFrame, type SpawnFn } from '../src/voice/capture';

type FakeProc = ChildProcessByStdio<null, Readable, Readable> & {
  stdout: EventEmitter & Readable;
  stderr: EventEmitter & Readable;
  kill: ReturnType<typeof vi.fn>;
};

/** Builds a fake ffmpeg child process: real EventEmitters for stdout/stderr/exit so production
 * code (which uses real `.on('data'|'exit'|'error', ...)`) works unmodified, but nothing ever
 * spawns a real process. `kill()` schedules an async 'exit' by default, matching how a real
 * process behaves (never synchronous). */
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

describe('parseAudioDevices', () => {
  it('parses the modern inline-tagged format (real output shape of the pinned ffmpeg 8.0.1 build)', () => {
    const stderr = [
      '[dshow @ 000001498cd44280] "USB2.0 HD UVC WebCam" (video)',
      '[dshow @ 000001498cd44280]   Alternative name "@device_pnp_\\\\?\\usb#vid_13d3&pid_56a2&mi_00#6&c91c3a9&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"',
      '[dshow @ 000001498cd44280] "Microphone (C-Media(R) Audio)" (audio)',
      '[dshow @ 000001498cd44280]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{74CF3C1D-BAA8-4237-9C8F-5523CC34F805}"',
      '[dshow @ 000001498cd44280] "SteelSeries Sonar - Microphone (SteelSeries Sonar Virtual Audio Device)" (audio)',
      '[dshow @ 000001498cd44280]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{61582756-3F4C-486D-B1B9-B21C83C6AB2B}"',
      'Error opening input file dummy.'
    ].join('\n');

    expect(parseAudioDevices(stderr)).toEqual([
      { id: 'Microphone (C-Media(R) Audio)', label: 'Microphone (C-Media(R) Audio)' },
      {
        id: 'SteelSeries Sonar - Microphone (SteelSeries Sonar Virtual Audio Device)',
        label: 'SteelSeries Sonar - Microphone (SteelSeries Sonar Virtual Audio Device)'
      }
    ]);
  });

  it('extracts only audio device names from the legacy sectioned format, skipping video devices and alternative-name lines', () => {
    const stderr = [
      '[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)',
      '[dshow @ 0x1]  "Integrated Webcam"',
      '[dshow @ 0x1]     Alternative name "@device_pnp_\\\\?\\usb#vid_0000&pid_0000\\global"',
      '[dshow @ 0x1] DirectShow audio devices',
      '[dshow @ 0x1]  "Microphone (Realtek(R) Audio)"',
      '[dshow @ 0x1]     Alternative name "@device_cm_{...}\\wave_{...}"',
      '[dshow @ 0x1]  "Headset Microphone (Bluetooth)"',
      '[dshow @ 0x1]     Alternative name "@device_cm_{...}\\wave_{...}"'
    ].join('\n');

    expect(parseAudioDevices(stderr)).toEqual([
      { id: 'Microphone (Realtek(R) Audio)', label: 'Microphone (Realtek(R) Audio)' },
      { id: 'Headset Microphone (Bluetooth)', label: 'Headset Microphone (Bluetooth)' }
    ]);
  });

  it('returns an empty list when there is no audio devices section', () => {
    expect(parseAudioDevices('nothing relevant here')).toEqual([]);
  });
});

describe('FfmpegCapture', () => {
  it('listInputs spawns ffmpeg with -list_devices and parses stderr into devices', async () => {
    const proc = makeFakeProc();
    const spawnFn: SpawnFn = vi.fn(() => proc) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'C:/fake/ffmpeg.exe', spawnFn });

    const resultPromise = capture.listInputs();
    proc.stderr.emit(
      'data',
      Buffer.from('[dshow] DirectShow audio devices\n[dshow]  "Mic (Fake)"\n')
    );
    proc.emit('exit', 1, null);

    await expect(resultPromise).resolves.toEqual([{ id: 'Mic (Fake)', label: 'Mic (Fake)' }]);
    expect(spawnFn).toHaveBeenCalledWith('C:/fake/ffmpeg.exe', expect.arrayContaining(['-list_devices']));
  });

  it('start() twice is a no-op — second call does not spawn again', async () => {
    const spawnFn = vi.fn(() => makeFakeProc()) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn, nativeSampleRate: 16000 });

    await capture.start('Mic (Fake)', () => {});
    expect(capture.running).toBe(true);

    await capture.start('Mic (Fake)', () => {});
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(capture.running).toBe(true);
  });

  it('stop() then start() works and spawns a fresh process', async () => {
    const spawnFn = vi.fn(() => makeFakeProc()) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn, nativeSampleRate: 16000 });

    await capture.start('Mic (Fake)', () => {});
    expect(capture.running).toBe(true);

    await capture.stop();
    expect(capture.running).toBe(false);

    await capture.start('Mic (Fake)', () => {});
    expect(capture.running).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('stop() when never started resolves without throwing', async () => {
    const spawnFn = vi.fn(() => makeFakeProc()) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn });
    await expect(capture.stop()).resolves.toBeUndefined();
    expect(capture.running).toBe(false);
  });

  it('delivers exact 512-sample frames from raw PCM stdout data (native rate = 16kHz, no resample)', async () => {
    const proc = makeFakeProc();
    const spawnFn: SpawnFn = vi.fn(() => proc) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn, nativeSampleRate: 16000 });

    const frames: AudioFrame[] = [];
    await capture.start('Mic (Fake)', (f) => frames.push(f));

    const oneFrameBuf = Buffer.alloc(512 * 2);
    for (let i = 0; i < 512; i++) oneFrameBuf.writeInt16LE(i % 100, i * 2);
    proc.stdout.emit('data', oneFrameBuf);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.samples).toHaveLength(512);
    expect(frames[0]?.samples[0]).toBe(0);
    expect(frames[0]?.samples[1]).toBe(1);
  });

  it('carries a dangling odd byte across stdout chunk boundaries without corrupting samples', async () => {
    const proc = makeFakeProc();
    const spawnFn: SpawnFn = vi.fn(() => proc) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn, nativeSampleRate: 16000 });

    const frames: AudioFrame[] = [];
    await capture.start('Mic (Fake)', (f) => frames.push(f));

    const full = Buffer.alloc(512 * 2);
    for (let i = 0; i < 512; i++) full.writeInt16LE(1000 + i, i * 2);

    // Split at an odd byte offset so one sample straddles two 'data' events.
    const splitAt = 513;
    proc.stdout.emit('data', full.subarray(0, splitAt));
    proc.stdout.emit('data', full.subarray(splitAt));

    expect(frames).toHaveLength(1);
    const samples = frames[0]?.samples;
    expect(samples).toHaveLength(512);
    expect(samples?.[0]).toBe(1000);
    expect(samples?.[511]).toBe(1000 + 511);
  });

  it('surfaces an unexpected ffmpeg exit as a "crash" event instead of swallowing it', async () => {
    const proc = makeFakeProc();
    const spawnFn: SpawnFn = vi.fn(() => proc) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn });

    const crashes: Error[] = [];
    capture.on('crash', (err: Error) => crashes.push(err));

    await capture.start('Mic (Fake)', () => {});
    expect(capture.running).toBe(true);

    proc.emit('exit', 1, null);

    expect(crashes).toHaveLength(1);
    expect(crashes[0]?.message).toMatch(/ffmpeg exited unexpectedly/);
    expect(capture.running).toBe(false);
  });

  it('does not emit "crash" for an exit caused by our own stop()', async () => {
    const proc = makeFakeProc();
    const spawnFn: SpawnFn = vi.fn(() => proc) as unknown as SpawnFn;
    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn });

    const crashes: Error[] = [];
    capture.on('crash', (err: Error) => crashes.push(err));

    await capture.start('Mic (Fake)', () => {});
    await capture.stop();

    expect(crashes).toHaveLength(0);
  });

  it('start(null) picks the first device from listInputs()', async () => {
    const listProc = makeFakeProc();
    const captureProc = makeFakeProc();
    let call = 0;
    const spawnFn: SpawnFn = vi.fn(() => {
      call += 1;
      return call === 1 ? listProc : captureProc;
    }) as unknown as SpawnFn;

    const capture = new FfmpegCapture({ ffmpegPath: 'ffmpeg.exe', spawnFn, nativeSampleRate: 16000 });

    const startPromise = capture.start(null, () => {});
    listProc.stderr.emit(
      'data',
      Buffer.from('[dshow] DirectShow audio devices\n[dshow]  "Default Mic"\n')
    );
    listProc.emit('exit', 1, null);
    await startPromise;

    expect(capture.running).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn).toHaveBeenLastCalledWith(
      'ffmpeg.exe',
      expect.arrayContaining(['-i', 'audio=Default Mic'])
    );
  });
});
