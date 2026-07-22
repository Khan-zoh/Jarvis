import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import { FfplayPcmPlayer, type PlayerSpawnFn } from '../src/voice/player';

type FakeStdin = Writable & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

type FakeProc = ChildProcessByStdio<Writable, null, Readable> & {
  stdin: FakeStdin;
  stderr: EventEmitter & Readable;
  kill: ReturnType<typeof vi.fn>;
};

/** Builds a fake ffplay child process: a fake stdin recording what was written, a real
 * EventEmitter for stderr/exit/error so production code's real `.on(...)` works unmodified.
 * `kill()` schedules an async 'exit', matching how a real process behaves (never synchronous). */
function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as unknown as FakeProc;
  proc.stderr = new EventEmitter() as EventEmitter & Readable;
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn()
  } as unknown as FakeStdin;
  proc.kill = vi.fn(() => {
    queueMicrotask(() => proc.emit('exit', null, 'SIGTERM'));
    return true;
  });
  return proc;
}

describe('FfplayPcmPlayer', () => {
  it('spawns ffplay with the private s16le-demuxer raw-PCM options matching the given sample rate, and writes the PCM to stdin', async () => {
    // Regression coverage for a real bug caught during manual verification: the pinned ffplay
    // build's s16le demuxer only accepts its own private `-sample_rate`/`-ch_layout` AVOptions
    // (confirmed via `ffplay -h demuxer=s16le`) — the commonly-documented generic `-ar`/`-ac`
    // flags fail outright (`-ac` => "Option not found"), and since that failure previously went
    // to a discarded stderr, play() resolved immediately as if playback had succeeded.
    const proc = makeFakeProc();
    const rawSpawn = vi.fn(() => proc);
    const spawnFn = rawSpawn as unknown as PlayerSpawnFn;
    const player = new FfplayPcmPlayer({ ffplayExe: 'C:/fake/ffplay.exe', spawnFn });

    const pcm = new Int16Array([1, 2, 3, 4]);
    const playPromise = player.play(pcm, 22050);

    expect(spawnFn).toHaveBeenCalledWith(
      'C:/fake/ffplay.exe',
      expect.arrayContaining(['-sample_rate', '22050', '-ch_layout', 'mono', '-f', 's16le', '-i', 'pipe:0'])
    );
    const calledArgs = (rawSpawn.mock.calls[0] as unknown as [string, string[]] | undefined)?.[1] ?? [];
    expect(calledArgs).not.toContain('-ar');
    expect(calledArgs).not.toContain('-ac');
    expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);

    proc.emit('exit', 0, null);
    await expect(playPromise).resolves.toBeUndefined();
  });

  it('play() resolves (not rejects) when the process is killed mid-playback via stop()', async () => {
    const proc = makeFakeProc();
    const spawnFn: PlayerSpawnFn = vi.fn(() => proc) as unknown as PlayerSpawnFn;
    const player = new FfplayPcmPlayer({ ffplayExe: 'ffplay.exe', spawnFn });

    const playPromise = player.play(new Int16Array([1, 2]), 16000);
    player.stop();

    await expect(playPromise).resolves.toBeUndefined();
    expect(proc.kill).toHaveBeenCalled();
  });

  it('stop() with nothing playing is a no-op', () => {
    const spawnFn: PlayerSpawnFn = vi.fn(() => makeFakeProc()) as unknown as PlayerSpawnFn;
    const player = new FfplayPcmPlayer({ ffplayExe: 'ffplay.exe', spawnFn });
    expect(() => player.stop()).not.toThrow();
  });

  it('rejects play() if spawning ffplay itself fails', async () => {
    const spawnFn: PlayerSpawnFn = vi.fn(() => {
      throw new Error('spawn failed');
    }) as unknown as PlayerSpawnFn;
    const player = new FfplayPcmPlayer({ ffplayExe: 'ffplay.exe', spawnFn });

    await expect(player.play(new Int16Array([1]), 16000)).rejects.toThrow('spawn failed');
  });

  it('rejects play() on an unrequested non-zero exit (e.g. a bad argument or codec failure), including ffplay stderr in the message', async () => {
    const proc = makeFakeProc();
    const spawnFn: PlayerSpawnFn = vi.fn(() => proc) as unknown as PlayerSpawnFn;
    const player = new FfplayPcmPlayer({ ffplayExe: 'ffplay.exe', spawnFn });

    const playPromise = player.play(new Int16Array([1, 2]), 22050);
    proc.stderr.emit('data', Buffer.from('Option channels not found.\n'));
    proc.emit('exit', 1, null);

    await expect(playPromise).rejects.toThrow(/ffplay exited with code 1.*Option channels not found/s);
  });

  it('a later play() call is not affected by a previous stop() (stopRequested resets per call)', async () => {
    const procs: FakeProc[] = [];
    const rawSpawn = vi.fn(() => {
      const p = makeFakeProc();
      procs.push(p);
      return p;
    });
    const spawnFn = rawSpawn as unknown as PlayerSpawnFn;
    const player = new FfplayPcmPlayer({ ffplayExe: 'ffplay.exe', spawnFn });

    const p1 = player.play(new Int16Array([1]), 16000);
    player.stop();
    await expect(p1).resolves.toBeUndefined();

    const p2 = player.play(new Int16Array([2]), 16000);
    procs[1]?.stderr.emit('data', Buffer.from('boom\n'));
    procs[1]?.emit('exit', 1, null);
    await expect(p2).rejects.toThrow(/ffplay exited with code 1/);
  });

  it('a late exit from stopped playback cannot detach the next active playback', async () => {
    const procs: FakeProc[] = [];
    const spawnFn = vi.fn(() => {
      const proc = makeFakeProc();
      procs.push(proc);
      return proc;
    }) as unknown as PlayerSpawnFn;
    const player = new FfplayPcmPlayer({ ffplayExe: 'ffplay.exe', spawnFn });

    const first = player.play(new Int16Array([1]), 16000);
    player.stop();
    // Start the next response before the killed process emits its asynchronous exit.
    const second = player.play(new Int16Array([2]), 16000);

    await expect(first).resolves.toBeUndefined();
    player.stop();
    expect(procs[1]?.kill).toHaveBeenCalledOnce();
    await expect(second).resolves.toBeUndefined();
  });
});
