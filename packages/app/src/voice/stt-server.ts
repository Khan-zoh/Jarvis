// WhisperServerStt — persistent whisper.cpp HTTP-server SpeechToText, per cdd/plan/amendments.md
// A6 (MEASURED 2026-07-16): per-spawn whisper-cli with small.en costs 3.1-3.4s because the model
// is reloaded on every call, blowing the 2.5s end-of-speech->text budget. The fix is to spawn
// `whisper-server.exe` ONCE (it loads the model at startup and stays resident on localhost HTTP),
// then transcribe each utterance with a cheap multipart-WAV POST — warm calls run well under 1s.
//
// whisper-server.exe ships in the SAME pinned whisper.cpp release zip as whisper-cli.exe (both
// under Release/ in whisper-bin-x64.zip), extracted to models/bin/whisper-server.exe by
// scripts/fetch-models.ts and resolved via modelPaths.ts (never PATH), matching every other voice
// binary's path-injection contract.
//
// Seams (so nothing real is spawned/networked in unit tests): an injectable spawnFn (same shape as
// stt.ts's), an injectable httpFn (localhost request transport), and an injectable findPort. The
// production factory wires the real node:child_process + node:http implementations.
//
// Fallback: if the server can't start (or dies mid-session), the pipeline must degrade to the
// per-spawn WhisperCppStt. WhisperServerStt emits 'crash' when its child exits unexpectedly;
// FallbackStt (below) is the composite the app wires in — it prefers the server and transparently
// routes to a WhisperCppStt once the server is known-dead, so the pipeline only ever sees one
// SpeechToText.

import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { encodeWav } from './wav';
import type { SpeechToText } from './stt';

/** Minimal spawned-process shape WhisperServerStt needs — stdout/stderr piped so readiness and
 * crashes can be observed. Real `spawn` (stdio ['ignore','pipe','pipe']) satisfies it directly. */
export type ServerSpawnFn = (
  command: string,
  args: string[]
) => ChildProcessByStdio<null, Readable, Readable>;

/** Localhost HTTP transport seam. Default uses node:http; tests inject a fake returning canned
 * JSON so no socket is opened. */
export type HttpFn = (opts: {
  method: 'GET' | 'POST';
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
}) => Promise<{ status: number; body: string }>;

export interface WhisperServerSttOptions {
  /** Path to whisper-server.exe (resolveModelPaths().whisperServer — never PATH). */
  whisperServerPath: string;
  /** Host to bind/serve on. Defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /** Preferred fixed high port; falls back to an OS-assigned free port if it is taken. */
  preferredPort?: number;
  spawnFn?: ServerSpawnFn;
  httpFn?: HttpFn;
  /** Resolves the port to bind. Defaults to "try preferredPort, else an OS-assigned free port". */
  findPort?: (preferred: number) => Promise<number>;
  /** How long to wait for the server to answer its first health poll after spawn. */
  readyTimeoutMs?: number;
  /** whisper-server `-t` compute threads. Default 8 (measured on the dev machine, 16 cores:
   * 4 threads ≈ 3.5s warm, 8 ≈ 2.4s; leaves headroom for Electron/piper/onnx). */
  threads?: number;
  /** whisper-server `-ac` audio context size. Default 768 = 15.36s of audio (1500 = 30s), which
   * covers the Endpointer's 15s utterance hard cap exactly — whisper otherwise pads every
   * utterance to a 30s encoder window, doubling inference cost. Measured on the dev machine:
   * warm per-utterance latency drops from ~2.4s to ~1.1s with small.en. */
  audioCtx?: number;
}

const DEFAULT_HOST = '127.0.0.1';
// A fixed, unlikely-to-collide high port (with a free-port fallback), per A6.
const DEFAULT_PREFERRED_PORT = 38769;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 150;
const INFERENCE_TIMEOUT_MS = 30_000;
const DEFAULT_THREADS = 8;
const DEFAULT_AUDIO_CTX = 768; // 15.36s — matches the Endpointer's 15s hard cap (see options doc)

function defaultSpawn(command: string, args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<
    null,
    Readable,
    Readable
  >;
}

/** Default port picker: bind the preferred port to see if it is free; if not, bind port 0 and let
 * the OS assign a free one. Either way returns a port nothing else is currently listening on. */
async function defaultFindPort(preferred: number): Promise<number> {
  const tryBind = (port: number): Promise<number | null> =>
    new Promise((resolvePromise) => {
      const srv = createServer();
      srv.once('error', () => resolvePromise(null));
      srv.listen({ port, host: DEFAULT_HOST, exclusive: true }, () => {
        const addr = srv.address();
        const bound = typeof addr === 'object' && addr ? addr.port : port;
        srv.close(() => resolvePromise(bound));
      });
    });

  const onPreferred = await tryBind(preferred);
  if (onPreferred !== null) return onPreferred;
  const onAny = await tryBind(0);
  if (onAny !== null) return onAny;
  throw new Error('WhisperServerStt: could not find a free port to bind whisper-server');
}

/** Default localhost HTTP transport over node:http. */
const defaultHttp: HttpFn = (opts) =>
  new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        method: opts.method,
        host: opts.host,
        port: opts.port,
        path: opts.path,
        headers: opts.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.setTimeout(opts.timeoutMs ?? INFERENCE_TIMEOUT_MS, () => {
      req.destroy(new Error(`whisper-server request timed out after ${opts.timeoutMs ?? INFERENCE_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

/** Builds a `multipart/form-data` body carrying the WAV plus a couple of whisper-server form
 * fields. Exported so the encoding can be asserted without a socket. */
export function buildInferenceMultipart(wav: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----jarvisWhisper${randomBytes(12).toString('hex')}`;
  const field = (name: string, value: string): Buffer =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const filePart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n`);
  const body = Buffer.concat([
    filePart,
    wav,
    tail,
    field('temperature', '0.0'),
    field('response_format', 'json'),
    field('language', 'en'),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Pulls the transcript out of a whisper-server `/inference` response. Server returns
 * `{"text":"..."}` for `response_format=json`; tolerate a bare string too. Exported for testing. */
export function parseInferenceBody(body: string): string {
  const trimmed = body.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'text' in parsed) {
      const t = (parsed as { text?: unknown }).text;
      return typeof t === 'string' ? t.trim() : '';
    }
    if (typeof parsed === 'string') return parsed.trim();
  } catch {
    // Not JSON — treat the raw body as the transcript.
    return trimmed;
  }
  return '';
}

/** whisper-server transcript cleanup: strip the "[BLANK_AUDIO]"/noise-annotation artifacts and
 * collapse whitespace, matching WhisperCppStt.cleanTranscript's contract (<2 chars -> ''). */
export function cleanServerTranscript(raw: string): string {
  let text = raw;
  text = text.replace(/\[BLANK_AUDIO\]/gi, '');
  text = text.replace(/\([^)]*\)/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  return text.length < 2 ? '' : text;
}

export class WhisperServerStt extends EventEmitter implements SpeechToText {
  private readonly whisperServerPath: string;
  private readonly host: string;
  private readonly preferredPort: number;
  private readonly spawnFn: ServerSpawnFn;
  private readonly httpFn: HttpFn;
  private readonly findPort: (preferred: number) => Promise<number>;
  private readonly readyTimeoutMs: number;
  private readonly threads: number;
  private readonly audioCtx: number;

  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private port = 0;
  private _ready = false;
  private disposed = false;

  constructor(opts: WhisperServerSttOptions) {
    super();
    this.whisperServerPath = opts.whisperServerPath;
    this.host = opts.host ?? DEFAULT_HOST;
    this.preferredPort = opts.preferredPort ?? DEFAULT_PREFERRED_PORT;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.httpFn = opts.httpFn ?? defaultHttp;
    this.findPort = opts.findPort ?? defaultFindPort;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.threads = opts.threads ?? DEFAULT_THREADS;
    this.audioCtx = opts.audioCtx ?? DEFAULT_AUDIO_CTX;
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Spawns whisper-server once (loading the model), then polls until it answers HTTP. Rejects if
   * the child exits early or never becomes ready within readyTimeoutMs. */
  async init(cfg: { modelPath: string }): Promise<void> {
    if (this._ready) return;
    this.port = await this.findPort(this.preferredPort);

    const args = [
      '-m',
      cfg.modelPath,
      '--host',
      this.host,
      '--port',
      String(this.port),
      '--language',
      'en',
      '-t',
      String(this.threads),
      '-ac',
      String(this.audioCtx)
    ];

    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = this.spawnFn(this.whisperServerPath, args);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.proc = proc;

    let earlyExit: Error | null = null;
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    // Keep stdout drained (whisper-server is chatty) so its pipe never blocks.
    proc.stdout.on('data', () => {});

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const wasReady = this._ready;
      this._ready = false;
      this.proc = null;
      if (this.disposed) return;
      const detail = `whisper-server exited (code=${code}, signal=${signal}): ${stderr.trim()}`;
      if (!wasReady) {
        earlyExit = new Error(detail);
      } else {
        // Unexpected death after it was serving — surface so the pipeline can fall back.
        this.emit('crash', new Error(detail));
      }
    };
    proc.on('exit', onExit);
    proc.on('error', (err) => {
      if (this.disposed) return;
      if (!this._ready) earlyExit = err instanceof Error ? err : new Error(String(err));
      else this.emit('crash', err instanceof Error ? err : new Error(String(err)));
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    // Poll the server's health until it answers, the child dies, or we time out.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (earlyExit) throw earlyExit;
      if (Date.now() > deadline) {
        this.dispose();
        throw new Error(`whisper-server did not become ready within ${this.readyTimeoutMs}ms`);
      }
      try {
        const res = await this.httpFn({
          method: 'GET',
          host: this.host,
          port: this.port,
          path: '/',
          timeoutMs: 2000
        });
        if (res.status > 0) {
          this._ready = true;
          return;
        }
      } catch {
        // not up yet
      }
      await delay(READY_POLL_INTERVAL_MS);
    }
  }

  async transcribe(audio: Int16Array): Promise<{ text: string; ms: number }> {
    if (!this._ready) {
      throw new Error('WhisperServerStt.transcribe: server is not ready (init() must succeed first)');
    }
    const start = Date.now();
    const wav = encodeWav(audio);
    const { body, contentType } = buildInferenceMultipart(wav);

    const res = await this.httpFn({
      method: 'POST',
      host: this.host,
      port: this.port,
      path: '/inference',
      headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
      body,
      timeoutMs: INFERENCE_TIMEOUT_MS
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`whisper-server /inference returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }
    const text = cleanServerTranscript(parseInferenceBody(res.body));
    return { text, ms: Date.now() - start };
  }

  /** Kills the child (no orphans) and marks not-ready. Idempotent. Suppresses the 'crash' event
   * for this intentional teardown. */
  dispose(): void {
    this.disposed = true;
    this._ready = false;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }
}

/**
 * Composite SpeechToText that prefers a WhisperServerStt and transparently degrades to a
 * per-spawn fallback (WhisperCppStt) once the server is known-dead — so VoicePipeline only ever
 * holds a single SpeechToText. Server death is detected two ways: init() throwing, and the
 * server's 'crash' event (or a failing transcribe) mid-session.
 */
export class FallbackStt implements SpeechToText {
  private primaryDead = false;
  private fallbackInited = false;
  private lastModelPath = '';

  constructor(
    private readonly primary: WhisperServerStt,
    private readonly fallback: SpeechToText
  ) {
    this.primary.on('crash', () => {
      this.primaryDead = true;
    });
  }

  /** True while the resident server is the active path. Exposed for logging/diagnostics. */
  get usingServer(): boolean {
    return !this.primaryDead;
  }

  async init(cfg: { modelPath: string }): Promise<void> {
    this.lastModelPath = cfg.modelPath;
    // The fallback's init is cheap (it just records the model path) — always prepare it so a later
    // crash can switch over without an extra await on the hot path.
    await this.fallback.init(cfg);
    this.fallbackInited = true;
    try {
      await this.primary.init(cfg);
    } catch {
      this.primaryDead = true;
    }
  }

  async transcribe(audio: Int16Array): Promise<{ text: string; ms: number }> {
    if (!this.primaryDead) {
      try {
        return await this.primary.transcribe(audio);
      } catch {
        this.primaryDead = true;
      }
    }
    if (!this.fallbackInited) {
      await this.fallback.init({ modelPath: this.lastModelPath });
      this.fallbackInited = true;
    }
    return this.fallback.transcribe(audio);
  }

  dispose(): void {
    this.primary.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Production factory. `whisperServerPath` must come from resolveModelPaths().whisperServer. */
export function createWhisperServerStt(whisperServerPath: string): WhisperServerStt {
  return new WhisperServerStt({ whisperServerPath });
}
