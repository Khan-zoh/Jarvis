import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import { PiperTts, parseSampleRate, type PiperSpawnFn } from '../src/voice/tts';
import type { PcmPlayer } from '../src/voice/player';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_CONFIG_JSON = readFileSync(join(HERE, 'fixtures', 'piper-voice-config.fixture.json'), 'utf-8');

type FakeStdin = Writable & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

type FakePiperProc = ChildProcessByStdio<Writable, Readable, Readable> & {
  stdin: FakeStdin;
  stdout: EventEmitter & Readable;
  stderr: EventEmitter & Readable;
  kill: ReturnType<typeof vi.fn>;
};

/** Builds a fake piper child process: real EventEmitters for stdout/stderr/exit (production
 * code uses real `.on('data'|'exit'|'error', ...)`), and a fake stdin recording what text was
 * written. Nothing ever spawns a real piper.exe. `kill()` schedules an async 'exit' — a real
 * process never exits synchronously from kill(). */
function makeFakePiperProc(): FakePiperProc {
  const proc = new EventEmitter() as unknown as FakePiperProc;
  proc.stdout = new EventEmitter() as EventEmitter & Readable;
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

/** Fake PcmPlayer: records every play() call and lets the test control exactly when each play
 * settles, so tests can assert ordering (speak() must not resolve before the player does) and
 * simulate stop() resolving an in-flight play() per the PcmPlayer contract. */
class FakePlayer implements PcmPlayer {
  playCalls: { pcm: Int16Array; sampleRate: number }[] = [];
  stopCalls = 0;
  private pending: Array<() => void> = [];

  play(pcm: Int16Array, sampleRate: number): Promise<void> {
    this.playCalls.push({ pcm, sampleRate });
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  stop(): void {
    this.stopCalls += 1;
    const resolvers = this.pending.splice(0, this.pending.length);
    for (const resolve of resolvers) resolve();
  }

  /** Test helper: settles the oldest still-pending play() call, as if playback finished. */
  resolveOldestPlay(): void {
    const resolve = this.pending.shift();
    resolve?.();
  }
}

/** Flushes pending microtasks/timers so promise chains spanning multiple `await`s (synthesize ->
 * player.play -> item.resolve -> pump's own continuation) settle before the next assertion. */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function makeTts(overrides: { spawnFn?: PiperSpawnFn; player?: FakePlayer } = {}) {
  const player = overrides.player ?? new FakePlayer();
  const procs: FakePiperProc[] = [];
  const spawnFn =
    overrides.spawnFn ??
    ((vi.fn(() => {
      const p = makeFakePiperProc();
      procs.push(p);
      return p;
    }) as unknown) as PiperSpawnFn);

  const tts = new PiperTts({
    piperExe: 'C:/fake/piper.exe',
    player,
    spawnFn,
    readFileFn: () => FIXTURE_CONFIG_JSON
  });

  return { tts, player, procs, spawnFn };
}

describe('parseSampleRate', () => {
  it('extracts audio.sample_rate from a voice config fixture', () => {
    expect(parseSampleRate(FIXTURE_CONFIG_JSON)).toBe(22050);
  });

  it('throws on a config missing audio.sample_rate', () => {
    expect(() => parseSampleRate('{"audio": {}}')).toThrow(/sample_rate/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseSampleRate('not json')).toThrow();
  });

  it('reads sample rate from the real provisioned piper voice config', () => {
    // Integration-style: exercises the real fixture shipped alongside the model, not a fake one.
    const REPO_ROOT = join(HERE, '..', '..', '..');
    const realConfigPath = join(REPO_ROOT, 'models', 'piper', 'en_US-lessac-medium.onnx.json');
    let realConfigJson: string;
    try {
      realConfigJson = readFileSync(realConfigPath, 'utf-8');
    } catch {
      return; // models not provisioned in this environment — skip rather than fail the suite
    }
    expect(parseSampleRate(realConfigJson)).toBe(22050);
  });
});

describe('PiperTts', () => {
  it('starts Piper with restrained conversational prosody settings', async () => {
    const { tts, procs, spawnFn } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    const speaking = tts.speak('hello');
    expect(spawnFn).toHaveBeenCalledWith('C:/fake/piper.exe', [
      '--model',
      'C:/fake/voice.onnx',
      '--config',
      'C:/fake/voice.onnx.json',
      '--length_scale',
      '1.05',
      '--noise_scale',
      '0.7',
      '--noise_w',
      '0.85',
      '--sentence_silence',
      '0.25',
      '--output_raw'
    ]);

    tts.cancel();
    await speaking;
    await tick();
    expect(procs[0]?.kill).toHaveBeenCalledOnce();
  });

  it('processes queued sentences in FIFO order, one piper process at a time', async () => {
    const { tts, player, procs, spawnFn } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    const order: string[] = [];
    const s1 = tts.speak('one').then(() => order.push('one'));
    const s2 = tts.speak('two').then(() => order.push('two'));

    // Spawning is synchronous within speak()'s promise executor, so the first (and only the
    // first) piper process should already exist.
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(procs[0]?.stdin.write).toHaveBeenCalledWith('one');

    procs[0]?.stdout.emit('data', Buffer.from([1, 2, 3, 4]));
    procs[0]?.emit('exit', 0, null);
    await tick();
    expect(player.playCalls).toHaveLength(1);

    player.resolveOldestPlay();
    await s1;
    await tick();

    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(procs[1]?.stdin.write).toHaveBeenCalledWith('two');

    procs[1]?.stdout.emit('data', Buffer.from([5, 6, 7, 8]));
    procs[1]?.emit('exit', 0, null);
    await tick();
    player.resolveOldestPlay();
    await s2;

    expect(order).toEqual(['one', 'two']);
  });

  it('speak() resolves only after the player resolves, not before', async () => {
    const { tts, player, procs } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    let resolved = false;
    const s1 = tts.speak('hello').then(() => {
      resolved = true;
    });

    procs[0]?.stdout.emit('data', Buffer.from([1, 2]));
    procs[0]?.emit('exit', 0, null);
    await tick();

    expect(player.playCalls).toHaveLength(1);
    expect(resolved).toBe(false); // player hasn't resolved yet

    player.resolveOldestPlay();
    await s1;
    expect(resolved).toBe(true);
  });

  it('speaking is true from the first queued item until the queue drains', async () => {
    const { tts, player, procs } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    expect(tts.speaking).toBe(false);
    const s1 = tts.speak('hello');
    expect(tts.speaking).toBe(true);

    procs[0]?.stdout.emit('data', Buffer.from([1, 2]));
    procs[0]?.emit('exit', 0, null);
    await tick();
    expect(tts.speaking).toBe(true); // still speaking: player hasn't finished

    player.resolveOldestPlay();
    await s1;
    await tick();

    expect(tts.speaking).toBe(false);
  });

  it('cancel() kills the current piper process, stops the player, clears the queue, and resolves in-flight speak() promises', async () => {
    const { tts, player, procs } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    const results: string[] = [];
    const s1 = tts.speak('one').then(
      () => results.push('one:resolved'),
      () => results.push('one:rejected')
    );
    const s2 = tts.speak('two').then(
      () => results.push('two:resolved'),
      () => results.push('two:rejected')
    );
    const s3 = tts.speak('three').then(
      () => results.push('three:resolved'),
      () => results.push('three:rejected')
    );

    // Only the first item has spawned a piper process; two/three are still queued.
    expect(procs).toHaveLength(1);

    tts.cancel();

    await Promise.all([s1, s2, s3]);

    expect(results.sort()).toEqual(['one:resolved', 'three:resolved', 'two:resolved']);
    expect(procs[0]?.kill).toHaveBeenCalled();
    expect(player.stopCalls).toBeGreaterThanOrEqual(1);
    expect(tts.speaking).toBe(false);

    // No further piper process should spawn for the cancelled queue.
    await tick();
    expect(procs).toHaveLength(1);
  });

  it('cancel() while player is mid-playback resolves that speak() via the player stopping', async () => {
    const { tts, player, procs } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    let settled: 'resolved' | 'rejected' | null = null;
    const s1 = tts.speak('hello').then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected')
    );

    procs[0]?.stdout.emit('data', Buffer.from([1, 2]));
    procs[0]?.emit('exit', 0, null);
    await tick();
    expect(player.playCalls).toHaveLength(1); // now mid-playback

    tts.cancel();
    await s1;

    expect(settled).toBe('resolved');
    expect(player.stopCalls).toBe(1);
  });

  it('a new speak() after cancel() starts cleanly (no leftover state from the cancelled item)', async () => {
    const { tts, procs, player } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    tts.speak('one');
    expect(procs).toHaveLength(1);

    tts.cancel();
    await tick();

    const s2 = tts.speak('two');
    expect(procs).toHaveLength(2);
    expect(procs[1]?.stdin.write).toHaveBeenCalledWith('two');

    procs[1]?.stdout.emit('data', Buffer.from([1, 2]));
    procs[1]?.emit('exit', 0, null);
    await tick();
    player.resolveOldestPlay();
    await s2;
    expect(tts.speaking).toBe(false);
  });

  it('a piper crash rejects that speak() call but the queue continues with the next item', async () => {
    const { tts, player, procs } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    const results: string[] = [];
    const s1 = tts.speak('one').then(
      () => results.push('one:resolved'),
      (err: Error) => results.push(`one:rejected:${err.message}`)
    );
    const s2 = tts.speak('two').then(
      () => results.push('two:resolved'),
      () => results.push('two:rejected')
    );

    procs[0]?.stderr.emit('data', Buffer.from('espeak-ng: fatal error\n'));
    procs[0]?.emit('exit', 1, null);
    await s1;
    await tick();

    expect(results[0]).toMatch(/^one:rejected:piper exited with code 1/);
    expect(player.playCalls).toHaveLength(0); // item 1 never reached playback

    // The queue must continue: item two should now be in flight.
    expect(procs).toHaveLength(2);
    expect(procs[1]?.stdin.write).toHaveBeenCalledWith('two');

    procs[1]?.stdout.emit('data', Buffer.from([1, 2]));
    procs[1]?.emit('exit', 0, null);
    await tick();
    player.resolveOldestPlay();
    await s2;

    expect(results).toEqual(['one:rejected:piper exited with code 1 (signal=null): espeak-ng: fatal error', 'two:resolved']);
  });

  it('a spawn error (e.g. missing piper.exe) rejects that speak() and the queue continues', async () => {
    const { tts, player, procs } = makeTts();
    await tts.init({ voicePath: 'C:/fake/voice.onnx' });

    const s1 = tts.speak('one');
    const rejection = expect(s1).rejects.toThrow(/boom/);

    procs[0]?.emit('error', new Error('spawn boom'));
    await rejection;

    const s2 = tts.speak('two');
    await tick();
    expect(procs).toHaveLength(2);

    procs[1]?.stdout.emit('data', Buffer.from([1, 2]));
    procs[1]?.emit('exit', 0, null);
    await tick();
    player.resolveOldestPlay();
    await expect(s2).resolves.toBeUndefined();
  });
});
