// WhisperServerStt unit tests — fake spawn + HTTP seams, per the voice-pipeline task brief:
// flag/URL assembly, readiness polling, crash surfacing, dispose (no orphans), and the
// FallbackStt degradation to the per-spawn WhisperCppStt path. No real process or socket is
// ever touched here; the real whisper-server round trip lives in stt-server.integration.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import type { SpeechToText } from '../src/voice/stt';
import {
  buildInferenceMultipart,
  cleanServerTranscript,
  FallbackStt,
  parseInferenceBody,
  WhisperServerStt,
  type HttpFn,
  type ServerSpawnFn
} from '../src/voice/stt-server';

type FakeProc = ChildProcessByStdio<null, Readable, Readable> & {
  stdout: EventEmitter & Readable;
  stderr: EventEmitter & Readable;
  kill: ReturnType<typeof vi.fn>;
};

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

/** httpFn that reports the server as up and answers /inference with a canned transcript. */
function makeHttpFn(
  transcript = 'What time is it?'
): { httpFn: HttpFn; calls: Parameters<HttpFn>[0][] } {
  const calls: Parameters<HttpFn>[0][] = [];
  const httpFn: HttpFn = async (opts) => {
    calls.push(opts);
    if (opts.path === '/inference') {
      return { status: 200, body: JSON.stringify({ text: transcript }) };
    }
    return { status: 200, body: 'ok' };
  };
  return { httpFn, calls };
}

const findPort = async (): Promise<number> => 45123;

describe('buildInferenceMultipart', () => {
  it('encodes the WAV as a "file" part plus form fields, with a consistent boundary', () => {
    const wav = Buffer.from('RIFFfakewav');
    const { body, contentType } = buildInferenceMultipart(wav);
    const text = body.toString('latin1');

    const boundary = contentType.split('boundary=')[1]!;
    expect(boundary.length).toBeGreaterThan(10);
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('name="file"; filename="audio.wav"');
    expect(text).toContain('Content-Type: audio/wav');
    expect(text).toContain('RIFFfakewav');
    expect(text).toContain('name="response_format"');
    expect(text).toContain('name="language"');
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});

describe('parseInferenceBody', () => {
  it.each([
    ['{"text":" hello world "}', 'hello world'],
    ['"bare json string"', 'bare json string'],
    ['not json at all', 'not json at all'],
    ['{"other":"field"}', ''],
    ['', '']
  ])('parseInferenceBody(%j) -> %j', (input, expected) => {
    expect(parseInferenceBody(input)).toBe(expected);
  });
});

describe('cleanServerTranscript', () => {
  it.each([
    ['What time is it?', 'What time is it?'],
    ['[BLANK_AUDIO]', ''],
    ['(wind blowing) hello there', 'hello there'],
    ['"quoted"', 'quoted'],
    ['a', ''],
    ['  spaced   out  ', 'spaced out']
  ])('cleanServerTranscript(%j) -> %j', (input, expected) => {
    expect(cleanServerTranscript(input)).toBe(expected);
  });
});

describe('WhisperServerStt', () => {
  it('spawns whisper-server once with the expected flags and the resolved port', async () => {
    let capturedCmd = '';
    let capturedArgs: string[] = [];
    const spawnFn: ServerSpawnFn = vi.fn((cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return makeFakeProc();
    });
    const { httpFn } = makeHttpFn();

    const stt = new WhisperServerStt({
      whisperServerPath: 'C:/fake/whisper-server.exe',
      spawnFn,
      httpFn,
      findPort
    });
    await stt.init({ modelPath: 'C:/fake/ggml-small.en.bin' });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(capturedCmd).toBe('C:/fake/whisper-server.exe');
    expect(capturedArgs).toEqual([
      '-m',
      'C:/fake/ggml-small.en.bin',
      '--host',
      '127.0.0.1',
      '--port',
      '45123',
      '--language',
      'en',
      '-t',
      '8',
      '-ac',
      '768'
    ]);
    expect(stt.ready).toBe(true);

    // A second init while ready is a no-op (still one spawn).
    await stt.init({ modelPath: 'C:/fake/ggml-small.en.bin' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    stt.dispose();
  });

  it('POSTs multipart WAV to /inference on the resolved host:port and cleans the transcript', async () => {
    const spawnFn: ServerSpawnFn = vi.fn(() => makeFakeProc());
    const { httpFn, calls } = makeHttpFn('  (clears throat) What time is it?  ');

    const stt = new WhisperServerStt({
      whisperServerPath: 'srv.exe',
      spawnFn,
      httpFn,
      findPort
    });
    await stt.init({ modelPath: 'model.bin' });

    const result = await stt.transcribe(new Int16Array(16000));
    expect(result.text).toBe('What time is it?');
    expect(result.ms).toBeGreaterThanOrEqual(0);

    const post = calls.find((c) => c.path === '/inference');
    expect(post).toBeDefined();
    expect(post!.method).toBe('POST');
    expect(post!.port).toBe(45123);
    expect(post!.host).toBe('127.0.0.1');
    expect(post!.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(post!.body!.length).toBeGreaterThan(16000 * 2); // WAV payload actually included
    stt.dispose();
  });

  it('rejects transcribe() before a successful init()', async () => {
    const stt = new WhisperServerStt({
      whisperServerPath: 'srv.exe',
      spawnFn: vi.fn(() => makeFakeProc()),
      httpFn: makeHttpFn().httpFn,
      findPort
    });
    await expect(stt.transcribe(new Int16Array(10))).rejects.toThrow(/not ready/);
  });

  it('rejects init() when the child exits before becoming ready', async () => {
    const spawnFn: ServerSpawnFn = vi.fn(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('failed to load model'));
        proc.emit('exit', 1, null);
      });
      return proc;
    });
    // Server never answers HTTP.
    const httpFn: HttpFn = async () => {
      throw new Error('ECONNREFUSED');
    };

    const stt = new WhisperServerStt({ whisperServerPath: 'srv.exe', spawnFn, httpFn, findPort });
    await expect(stt.init({ modelPath: 'model.bin' })).rejects.toThrow(
      /whisper-server exited .*failed to load model/
    );
    expect(stt.ready).toBe(false);
  });

  it('rejects init() and kills the child when readiness times out', async () => {
    const proc = makeFakeProc();
    const spawnFn: ServerSpawnFn = vi.fn(() => proc);
    const httpFn: HttpFn = async () => {
      throw new Error('ECONNREFUSED');
    };

    const stt = new WhisperServerStt({
      whisperServerPath: 'srv.exe',
      spawnFn,
      httpFn,
      findPort,
      readyTimeoutMs: 350
    });
    await expect(stt.init({ modelPath: 'model.bin' })).rejects.toThrow(/did not become ready/);
    expect(proc.kill).toHaveBeenCalled();
  });

  it("emits 'crash' when the server dies after becoming ready (HTTP error transcribe rejects)", async () => {
    const proc = makeFakeProc();
    const spawnFn: ServerSpawnFn = vi.fn(() => proc);
    const { httpFn } = makeHttpFn();

    const stt = new WhisperServerStt({ whisperServerPath: 'srv.exe', spawnFn, httpFn, findPort });
    await stt.init({ modelPath: 'model.bin' });

    const crashes: Error[] = [];
    stt.on('crash', (err: Error) => crashes.push(err));

    proc.stderr.emit('data', Buffer.from('segfault'));
    proc.emit('exit', 139, null);
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.message).toMatch(/segfault/);
    expect(stt.ready).toBe(false);
    await expect(stt.transcribe(new Int16Array(10))).rejects.toThrow(/not ready/);
  });

  it("dispose() kills the child and does NOT emit 'crash' for the intentional teardown", async () => {
    const proc = makeFakeProc();
    const spawnFn: ServerSpawnFn = vi.fn(() => proc);
    const { httpFn } = makeHttpFn();

    const stt = new WhisperServerStt({ whisperServerPath: 'srv.exe', spawnFn, httpFn, findPort });
    await stt.init({ modelPath: 'model.bin' });

    const crashes: Error[] = [];
    stt.on('crash', (err: Error) => crashes.push(err));
    stt.dispose();
    expect(proc.kill).toHaveBeenCalledTimes(1);
    // kill()'s fake exit lands on a microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(crashes).toHaveLength(0);
    expect(stt.ready).toBe(false);
  });
});

describe('FallbackStt (server preferred, whisper-cli degradation)', () => {
  function makeFallback(text = 'fallback transcript'): SpeechToText & {
    initCalls: number;
    transcribeCalls: number;
  } {
    return {
      initCalls: 0,
      transcribeCalls: 0,
      async init() {
        this.initCalls += 1;
      },
      async transcribe() {
        this.transcribeCalls += 1;
        return { text, ms: 1 };
      }
    };
  }

  it('uses the server while it is healthy (fallback never transcribes)', async () => {
    const { httpFn } = makeHttpFn('server transcript');
    const server = new WhisperServerStt({
      whisperServerPath: 'srv.exe',
      spawnFn: vi.fn(() => makeFakeProc()),
      httpFn,
      findPort
    });
    const fallback = makeFallback();
    const stt = new FallbackStt(server, fallback);

    await stt.init({ modelPath: 'model.bin' });
    expect(stt.usingServer).toBe(true);
    const result = await stt.transcribe(new Int16Array(100));
    expect(result.text).toBe('server transcript');
    expect(fallback.transcribeCalls).toBe(0);
    stt.dispose();
  });

  it('degrades to the fallback when the server fails to start', async () => {
    const spawnFn: ServerSpawnFn = vi.fn(() => {
      const proc = makeFakeProc();
      queueMicrotask(() => proc.emit('exit', 1, null));
      return proc;
    });
    const httpFn: HttpFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const server = new WhisperServerStt({ whisperServerPath: 'srv.exe', spawnFn, httpFn, findPort });
    const fallback = makeFallback();
    const stt = new FallbackStt(server, fallback);

    await stt.init({ modelPath: 'model.bin' }); // must NOT throw — degrade instead
    expect(stt.usingServer).toBe(false);
    const result = await stt.transcribe(new Int16Array(100));
    expect(result.text).toBe('fallback transcript');
    expect(fallback.transcribeCalls).toBe(1);
  });

  it('switches to the fallback after a mid-session server crash', async () => {
    const proc = makeFakeProc();
    const { httpFn } = makeHttpFn('server transcript');
    const server = new WhisperServerStt({
      whisperServerPath: 'srv.exe',
      spawnFn: vi.fn(() => proc),
      httpFn,
      findPort
    });
    const fallback = makeFallback();
    const stt = new FallbackStt(server, fallback);

    await stt.init({ modelPath: 'model.bin' });
    expect((await stt.transcribe(new Int16Array(10))).text).toBe('server transcript');

    proc.emit('exit', 1, null); // server dies mid-session -> 'crash'
    expect(stt.usingServer).toBe(false);
    expect((await stt.transcribe(new Int16Array(10))).text).toBe('fallback transcript');
  });

  it('falls back for the same call when a server transcribe rejects', async () => {
    let first = true;
    const httpFn: HttpFn = async (opts) => {
      if (opts.path === '/inference') {
        if (first) {
          first = false;
          throw new Error('socket hang up');
        }
        return { status: 200, body: '{"text":"never used"}' };
      }
      return { status: 200, body: 'ok' };
    };
    const server = new WhisperServerStt({
      whisperServerPath: 'srv.exe',
      spawnFn: vi.fn(() => makeFakeProc()),
      httpFn,
      findPort
    });
    const fallback = makeFallback();
    const stt = new FallbackStt(server, fallback);

    await stt.init({ modelPath: 'model.bin' });
    const result = await stt.transcribe(new Int16Array(10));
    expect(result.text).toBe('fallback transcript'); // same-call degradation
    expect(stt.usingServer).toBe(false); // and permanent
  });
});
