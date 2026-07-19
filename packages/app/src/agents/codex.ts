import { Codex, type CodexOptions, type ThreadOptions } from '@openai/codex-sdk';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AppConfig } from '../shared/types';
import type { AgentBackend, TurnHandle } from './types';
import { buildSystemPrompt } from './prompt';
import { toolsMcpSpec } from './toolsLauncher';
import { toUnpackedPath } from './unpacked';

/** The launch spec for the jarvis-tools-mcp stdio server (from toolsMcpSpec). */
export type ToolsMcpSpec = { command: string; args: string[]; env: Record<string, string> };

type ProbeResult = { ok: boolean; problem?: string };

/**
 * Injectable seams. All default to the real implementations; tests supply fakes so no real SDK
 * call, child process, or MCP spawn ever happens headless.
 */
export interface CodexBackendDeps {
  /** SDK client factory. Default: `new Codex(options)`. */
  createCodex?: (options?: CodexOptions) => Codex;
  /** Verifies the Codex CLI login. Default: bundled `codex login status`. */
  checkLogin?: () => Promise<ProbeResult>;
  /** Out-of-band health-check of the jarvisTools MCP server (A9: Codex MCP failure is SILENT). */
  healthCheck?: (spec: ToolsMcpSpec) => Promise<ProbeResult>;
  /** Injectable clock for the (per-thread) system prompt timestamp. */
  now?: () => Date;
}

/**
 * `CodexBackend` wraps `@openai/codex-sdk` (ChatGPT-account auth via the SDK-bundled Codex CLI).
 *
 * Design notes (cdd/plan/amendments.md §A9, spike-verified against @openai/codex-sdk 0.144.5):
 *  - MCP tools are attached PER-INSTANCE via `new Codex({ config: { mcp_servers: { jarvisTools } } })`
 *    — there is NO ~/.codex/config.toml patching (A9 deleted ensureCodexConfig; it is unimplementable
 *    and unnecessary — instance config overrides win).
 *  - Codex threads have no system-prompt option, so buildSystemPrompt output is PREPENDED to the
 *    first turn's input of each NEW thread. Resumed threads already carry it in their history.
 *  - Codex emits NO incremental text deltas: each `item.completed:agent_message` carries the full
 *    text. Commentary maps to `status_update`; the final answer maps to ONE `text_delta`.
 *    `turn.completed` → `done`.
 *  - The Codex shell tool cannot be removed; containment is `sandboxMode:'read-only'` +
 *    `approvalPolicy:'never'` (verified: model file-write attempts fail "filesystem is read-only").
 *  - A silent MCP child startup failure is invisible to the turn stream, so `init()` health-checks
 *    the jarvisTools server out-of-band (spawns it and issues a real MCP `tools/list` probe).
 */
export class CodexBackend implements AgentBackend {
  readonly id = 'codex' as const;

  private readonly toolsSpec: ToolsMcpSpec;
  private readonly codex: Codex;
  private readonly checkLogin: () => Promise<ProbeResult>;
  private readonly healthCheck: (spec: ToolsMcpSpec) => Promise<ProbeResult>;
  private readonly now: () => Date;

  /**
   * Cached readiness (B2): init() spawns a login-status child AND a full MCP tools/list probe,
   * so it must run once — not on every dispatch/distill. Only an ok result is cached; a failure
   * clears the slot so the next init() re-probes. `invalidate()` forces a fresh probe.
   */
  private initPromise: Promise<ProbeResult> | null = null;

  constructor(
    private readonly cfg: AppConfig,
    paths: { entryJs: string; dataDir: string },
    deps: CodexBackendDeps = {}
  ) {
    this.toolsSpec = toolsMcpSpec(cfg, paths);
    this.now = deps.now ?? ((): Date => new Date());
    this.checkLogin = deps.checkLogin ?? defaultCheckLogin;
    this.healthCheck = deps.healthCheck ?? defaultHealthCheck;

    const createCodex = deps.createCodex ?? ((options?: CodexOptions): Codex => new Codex(options));
    // Packaged build (amendments.md A7 smoke finding): the SDK's own CLI resolution returns an
    // app.asar-internal path that spawn() cannot execute (ENOENT), so we always hand it the
    // asar-corrected bundled-CLI path explicitly. In dev this resolves to the identical exe the
    // SDK would pick itself, so the override is a no-op there.
    const bundledCodex = resolveBundledCodex();
    // Per-instance MCP config. `env` deliberately stays at the SDK default (inherits process.env
    // for the codex CLI); the tools server's own env is scoped inside mcp_servers.jarvisTools.env.
    this.codex = createCodex({
      ...(bundledCodex ? { codexPathOverride: bundledCodex } : {}),
      config: {
        mcp_servers: {
          jarvisTools: {
            command: this.toolsSpec.command,
            args: this.toolsSpec.args,
            env: this.toolsSpec.env
          }
        }
      }
    });
  }

  /**
   * Verifies the Codex login AND that the jarvisTools MCP server actually boots.
   * Initialized-once: concurrent and repeated calls share ONE probe; an ok result is cached
   * until `invalidate()`; a failure is never cached.
   */
  async init(): Promise<{ ok: boolean; problem?: string }> {
    if (!this.initPromise) {
      const probe = this.probe().then((r) => {
        if (!r.ok && this.initPromise === probe) this.initPromise = null;
        return r;
      });
      this.initPromise = probe;
    }
    return this.initPromise;
  }

  /** Drops the cached readiness so the next init() runs fresh live probes. */
  invalidate(): void {
    this.initPromise = null;
  }

  /** The actual live probes (login-status child + MCP tools/list). Never rejects by contract of
   * checkLogin/healthCheck (both resolve with { ok:false } on failure). */
  private async probe(): Promise<ProbeResult> {
    const login = await this.checkLogin();
    if (!login.ok) return login;
    const health = await this.healthCheck(this.toolsSpec);
    if (!health.ok) return health;
    return { ok: true };
  }

  /** Thread options shared by new and resumed threads (A9-verified containment). */
  private threadOptions(): ThreadOptions {
    const opts: ThreadOptions = {
      skipGitRepoCheck: true,
      workingDirectory: this.toolsSpec.env.JARVIS_DATA_DIR,
      sandboxMode: 'read-only',
      approvalPolicy: 'never'
    };
    const model = this.cfg.agents.codex.model;
    if (model) opts.model = model;
    return opts;
  }

  async startTurn(args: {
    input: string;
    sessionId: string | null;
    onEvent: (e: import('../shared/types').AgentEvent) => void;
  }): Promise<{ handle: TurnHandle; result: Promise<{ finalText: string; sessionId: string }> }> {
    const { input, sessionId, onEvent } = args;
    const isNew = sessionId === null;
    const thread = isNew
      ? this.codex.startThread(this.threadOptions())
      : this.codex.resumeThread(sessionId, this.threadOptions());

    // Codex threads carry no system-prompt option → prepend it to the first input of a NEW thread.
    const turnInput = isNew ? `${buildSystemPrompt(this.cfg, this.now())}\n\n${input}` : input;

    const ac = new AbortController();
    // Return the handle synchronously (backends must not block on the SDK before handing back a
    // handle — see amendments.md cancellation-race note); interrupt() just aborts the signal.
    const handle: TurnHandle = {
      interrupt: async (): Promise<void> => {
        ac.abort();
      }
    };

    const result = (async (): Promise<{ finalText: string; sessionId: string }> => {
      let finalText = '';
      let capturedId: string | null = sessionId;
      let streamError: string | null = null;
      try {
        const { events } = await thread.runStreamed(turnInput, { signal: ac.signal });
        for await (const ev of events) {
          switch (ev.type) {
            case 'thread.started':
              capturedId = ev.thread_id;
              break;
            case 'item.started':
              if (ev.item.type === 'mcp_tool_call') {
                onEvent({
                  kind: 'tool_start',
                  toolName: ev.item.tool,
                  summary: `${ev.item.server}: ${ev.item.tool}`
                });
              }
              break;
            case 'item.completed':
              if (ev.item.type === 'agent_message') {
                // A9: full text in one shot — one text_delta, no incremental deltas exist.
                // The CLI protocol includes `phase` even though this SDK version's public type
                // omits it. Keep commentary separate from the completed answer. An absent phase
                // remains a final answer for backwards compatibility.
                const phase = (ev.item as typeof ev.item & { phase?: unknown }).phase;
                if (phase === 'commentary') {
                  onEvent({ kind: 'status_update', text: ev.item.text });
                } else {
                  onEvent({ kind: 'text_delta', text: ev.item.text });
                  finalText = ev.item.text;
                }
              } else if (ev.item.type === 'mcp_tool_call') {
                onEvent({
                  kind: 'tool_end',
                  toolName: ev.item.tool,
                  ok: ev.item.status === 'completed'
                });
              }
              break;
            case 'turn.failed':
              streamError = ev.error?.message || 'codex turn failed';
              break;
            case 'error':
              streamError = ev.message || 'codex error';
              break;
            default:
              break;
          }
        }
      } catch (e) {
        // Abort → atomic-text semantics: a cancelled turn yields nothing. Surface as the router's
        // canonical cancellation error (see test/router.test.ts / fakeBackend).
        if (ac.signal.aborted) {
          onEvent({ kind: 'error', message: 'cancelled' });
          throw new Error('cancelled');
        }
        const message = e instanceof Error ? e.message : String(e);
        onEvent({ kind: 'error', message });
        throw new Error(message);
      }

      if (streamError !== null) {
        onEvent({ kind: 'error', message: streamError });
        throw new Error(streamError);
      }

      onEvent({ kind: 'done', finalText });
      const finalId = capturedId ?? thread.id;
      if (!finalId) throw new Error('codex did not return a thread id');
      return { finalText, sessionId: finalId };
    })();
    // Mark potential rejection as handled; the router attaches its own handler.
    result.catch(() => {});

    return { handle, result };
  }
}

/**
 * Resolves the SDK-bundled Codex executable (NOT the global PATH `codex`, which may be a different
 * version — amendments.md A2/A9). Mirrors @openai/codex/bin/codex.js platform resolution.
 */
export function resolveBundledCodex(): string | null {
  const targetByPlatform: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc'
  };
  const pkgByTarget: Record<string, string> = {
    'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
    'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
    'x86_64-apple-darwin': '@openai/codex-darwin-x64',
    'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
    'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
    'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64'
  };
  const target = targetByPlatform[`${process.platform}-${process.arch}`];
  if (!target) return null;
  const binName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve(`${pkgByTarget[target]}/package.json`);
    // Packaged: require.resolve answers with the app.asar-internal path; the exe is only
    // executable at its app.asar.unpacked twin (see unpacked.ts). Dev: no-op.
    const exe = toUnpackedPath(join(dirname(pkgJson), 'vendor', target, 'bin', binName));
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/**
 * Default login probe: spawns the bundled Codex CLI `login status`. Exit 0 without a "not logged
 * in" message means the ChatGPT subscription is active.
 */
export async function defaultCheckLogin(): Promise<ProbeResult> {
  const exe = resolveBundledCodex();
  if (!exe) {
    return {
      ok: false,
      problem: 'Codex CLI not installed — run: npm install @openai/codex'
    };
  }
  return new Promise<ProbeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(exe, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ ok: false, problem: 'Codex CLI could not be started — run: codex login' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, problem: 'Codex login check timed out — run: codex login' });
    }, 20000);
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false, problem: 'Codex CLI could not be started — run: codex login' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`.toLowerCase();
      if (code === 0 && !text.includes('not logged in')) {
        finish({ ok: true });
      } else {
        finish({ ok: false, problem: 'Codex is not logged in — run `codex login` in a terminal.' });
      }
    });
  });
}

/**
 * Default MCP health-check: spawns the jarvisTools server and issues a real `tools/list` probe.
 * A9: a Codex MCP child startup failure is SILENT in the turn stream, so this is the only way to
 * detect a broken tools server before dispatching turns.
 */
export async function defaultHealthCheck(spec: ToolsMcpSpec): Promise<ProbeResult> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    // Merge over the inherited environment so the child keeps PATH etc. and gains our scoped vars.
    env: { ...(process.env as Record<string, string>), ...spec.env }
  });
  const client = new Client({ name: 'jarvis-codex-healthcheck', version: '0.1.0' });
  const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
    ]);
  try {
    await timeout(client.connect(transport), 15000);
    const tools = await timeout(client.listTools(), 15000);
    if (!tools.tools || tools.tools.length === 0) {
      return { ok: false, problem: 'The Jarvis tools server started but exposes no tools.' };
    }
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, problem: `The Jarvis tools server failed to start (${message}).` };
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}
