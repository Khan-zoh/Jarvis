import { describe, expect, it } from 'vitest';
import type { Codex, CodexOptions, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import { CodexBackend } from '../src/agents/codex';
import type { AgentEvent, AppConfig } from '../src/shared/types';
import { makeConfig } from './fakes/testConfig';

// ---- Test doubles for the @openai/codex-sdk surface (NO real SDK calls) ----

interface ThreadSpec {
  events?: ThreadEvent[];
  gen?: (signal?: AbortSignal) => AsyncGenerator<ThreadEvent>;
  id?: string | null;
}

async function* fromArray(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const e of events) {
    yield e;
    await Promise.resolve();
  }
}

class FakeThread {
  runStreamedInput: string | null = null;
  signal?: AbortSignal;
  constructor(
    readonly kind: 'new' | 'resume',
    readonly opts: ThreadOptions | undefined,
    readonly resumeId: string | null,
    private readonly spec: ThreadSpec
  ) {}
  get id(): string | null {
    return this.spec.id ?? null;
  }
  async runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal }
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    this.runStreamedInput = input;
    this.signal = turnOptions?.signal;
    const events = this.spec.gen ? this.spec.gen(this.signal) : fromArray(this.spec.events ?? []);
    return { events };
  }
}

class FakeCodex {
  threads: FakeThread[] = [];
  constructor(
    readonly createOptions: CodexOptions | undefined,
    private readonly specs: ThreadSpec[]
  ) {}
  startThread(opts?: ThreadOptions): Thread {
    const t = new FakeThread('new', opts, null, this.specs.shift() ?? {});
    this.threads.push(t);
    return t as unknown as Thread;
  }
  resumeThread(id: string, opts?: ThreadOptions): Thread {
    const t = new FakeThread('resume', opts, id, this.specs.shift() ?? {});
    this.threads.push(t);
    return t as unknown as Thread;
  }
}

const PATHS = { entryJs: 'C:/dev/jarvis/tools.js', dataDir: 'C:/data/jarvis' };

function configWithModel(model: string | null): AppConfig {
  const cfg = makeConfig();
  cfg.agents.codex.model = model;
  return cfg;
}

/** Builds a backend wired to a FakeCodex holding `specs`; returns both plus the captured events. */
function makeBackend(
  specs: ThreadSpec[],
  opts?: { cfg?: AppConfig; checkLogin?: () => Promise<{ ok: boolean; problem?: string }>; healthCheck?: () => Promise<{ ok: boolean; problem?: string }> }
): { backend: CodexBackend; fakeRef: () => FakeCodex; events: AgentEvent[] } {
  let fake!: FakeCodex;
  const events: AgentEvent[] = [];
  const backend = new CodexBackend(opts?.cfg ?? makeConfig(), PATHS, {
    createCodex: (options?: CodexOptions): Codex => {
      fake = new FakeCodex(options, specs);
      return fake as unknown as Codex;
    },
    checkLogin: opts?.checkLogin ?? (async () => ({ ok: true })),
    healthCheck: opts?.healthCheck ?? (async () => ({ ok: true })),
    now: () => new Date('2026-07-17T00:00:00.000Z')
  });
  return { backend, fakeRef: () => fake, events };
}

const started = (id: string): ThreadEvent => ({ type: 'thread.started', thread_id: id });
const turnStarted: ThreadEvent = { type: 'turn.started' };
const agentMsg = (text: string): ThreadEvent => ({
  type: 'item.completed',
  item: { id: 'm1', type: 'agent_message', text }
});
const turnCompleted: ThreadEvent = {
  type: 'turn.completed',
  usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }
};

describe('CodexBackend — instance & thread option assembly', () => {
  it('attaches jarvisTools per-instance via new Codex({ config: { mcp_servers } })', async () => {
    const { backend, fakeRef } = makeBackend([{ events: [started('t1'), agentMsg('ok'), turnCompleted] }]);
    await backend.startTurn({ input: 'hi', sessionId: null, onEvent: () => {} });
    const cfg = fakeRef().createOptions?.config as Record<string, unknown>;
    const servers = cfg.mcp_servers as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    const js = servers.jarvisTools!;
    expect(js.command).toBe(process.execPath);
    expect(js.args).toEqual([PATHS.entryJs]);
    expect(js.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      JARVIS_DATA_DIR: PATHS.dataDir
    });
    // env NOT set at the CodexOptions level (codex CLI must inherit process.env).
    expect(fakeRef().createOptions?.env).toBeUndefined();
  });

  it('starts a new thread with the A9 containment options', async () => {
    const { backend, fakeRef } = makeBackend([{ events: [started('t1'), agentMsg('ok'), turnCompleted] }]);
    await backend.startTurn({ input: 'hi', sessionId: null, onEvent: () => {} });
    const t = fakeRef().threads[0]!;
    expect(t.kind).toBe('new');
    expect(t.opts).toMatchObject({
      skipGitRepoCheck: true,
      workingDirectory: PATHS.dataDir,
      sandboxMode: 'read-only',
      approvalPolicy: 'never'
    });
  });

  it('omits model when cfg.agents.codex.model is null', async () => {
    const { backend, fakeRef } = makeBackend([{ events: [started('t1'), agentMsg('ok'), turnCompleted] }], {
      cfg: configWithModel(null)
    });
    await backend.startTurn({ input: 'hi', sessionId: null, onEvent: () => {} });
    expect(fakeRef().threads[0]!.opts?.model).toBeUndefined();
  });

  it('passes cfg.agents.codex.model through to the thread when set', async () => {
    const { backend, fakeRef } = makeBackend([{ events: [started('t1'), agentMsg('ok'), turnCompleted] }], {
      cfg: configWithModel('gpt-5-codex')
    });
    await backend.startTurn({ input: 'hi', sessionId: null, onEvent: () => {} });
    expect(fakeRef().threads[0]!.opts?.model).toBe('gpt-5-codex');
  });
});

describe('CodexBackend — system prompt prepend', () => {
  it('prepends buildSystemPrompt to the FIRST input of a NEW thread', async () => {
    const { backend, fakeRef } = makeBackend([{ events: [started('t1'), agentMsg('ok'), turnCompleted] }]);
    await backend.startTurn({ input: 'what time is it', sessionId: null, onEvent: () => {} });
    const sent = fakeRef().threads[0]!.runStreamedInput ?? '';
    expect(sent).toContain("You are Jarvis, a voice assistant on the user's Windows PC.");
    expect(sent.endsWith('what time is it')).toBe(true);
  });

  it('does NOT prepend the prompt when resuming an existing thread', async () => {
    const { backend, fakeRef } = makeBackend([{ events: [started('t1'), agentMsg('ok'), turnCompleted] }]);
    await backend.startTurn({ input: 'follow up', sessionId: 't1', onEvent: () => {} });
    const t = fakeRef().threads[0]!;
    expect(t.kind).toBe('resume');
    expect(t.resumeId).toBe('t1');
    expect(t.runStreamedInput).toBe('follow up');
  });
});

describe('CodexBackend — event mapping', () => {
  it('maps one agent_message to a single text_delta then done (no incremental deltas)', async () => {
    const events: AgentEvent[] = [];
    const { backend } = makeBackend([
      { events: [started('t1'), turnStarted, agentMsg('The time is noon.'), turnCompleted] }
    ]);
    const { result } = await backend.startTurn({
      input: 'time?',
      sessionId: null,
      onEvent: (e) => events.push(e)
    });
    const out = await result;
    expect(events).toEqual([
      { kind: 'text_delta', text: 'The time is noon.' },
      { kind: 'done', finalText: 'The time is noon.' }
    ]);
    expect(out.finalText).toBe('The time is noon.');
    expect(out.sessionId).toBe('t1');
  });

  it('maps mcp_tool_call started/completed to tool_start/tool_end', async () => {
    const events: AgentEvent[] = [];
    const toolStart: ThreadEvent = {
      type: 'item.started',
      item: { id: 'x1', type: 'mcp_tool_call', server: 'jarvisTools', tool: 'web_fetch', arguments: {}, status: 'in_progress' }
    };
    const toolDone: ThreadEvent = {
      type: 'item.completed',
      item: {
        id: 'x1',
        type: 'mcp_tool_call',
        server: 'jarvisTools',
        tool: 'web_fetch',
        arguments: {},
        status: 'completed',
        result: { content: [], structured_content: null }
      }
    };
    const { backend } = makeBackend([
      { events: [started('t1'), toolStart, toolDone, agentMsg('Done.'), turnCompleted] }
    ]);
    const { result } = await backend.startTurn({
      input: 'fetch it',
      sessionId: null,
      onEvent: (e) => events.push(e)
    });
    await result;
    expect(events).toEqual([
      { kind: 'tool_start', toolName: 'web_fetch', summary: 'jarvisTools: web_fetch' },
      { kind: 'tool_end', toolName: 'web_fetch', ok: true },
      { kind: 'text_delta', text: 'Done.' },
      { kind: 'done', finalText: 'Done.' }
    ]);
  });

  it('reports a failed mcp_tool_call as tool_end ok:false', async () => {
    const events: AgentEvent[] = [];
    const toolStart: ThreadEvent = {
      type: 'item.started',
      item: { id: 'x1', type: 'mcp_tool_call', server: 'jarvisTools', tool: 'gmail_send', arguments: {}, status: 'in_progress' }
    };
    const toolFail: ThreadEvent = {
      type: 'item.completed',
      item: { id: 'x1', type: 'mcp_tool_call', server: 'jarvisTools', tool: 'gmail_send', arguments: {}, status: 'failed', error: { message: 'boom' } }
    };
    const { backend } = makeBackend([{ events: [started('t1'), toolStart, toolFail, agentMsg('failed'), turnCompleted] }]);
    const { result } = await backend.startTurn({ input: 'send', sessionId: null, onEvent: (e) => events.push(e) });
    await result;
    expect(events).toContainEqual({ kind: 'tool_end', toolName: 'gmail_send', ok: false });
  });

  it('maps turn.failed to a terminal error event and rejects', async () => {
    const events: AgentEvent[] = [];
    const failed: ThreadEvent = { type: 'turn.failed', error: { message: 'model overloaded' } };
    const { backend } = makeBackend([{ events: [started('t1'), turnStarted, failed] }]);
    const { result } = await backend.startTurn({ input: 'x', sessionId: null, onEvent: (e) => events.push(e) });
    await expect(result).rejects.toThrow('model overloaded');
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'model overloaded' });
  });

  it('maps a fatal stream error event to a terminal error', async () => {
    const events: AgentEvent[] = [];
    const err: ThreadEvent = { type: 'error', message: 'stream died' };
    const { backend } = makeBackend([{ events: [started('t1'), err] }]);
    const { result } = await backend.startTurn({ input: 'x', sessionId: null, onEvent: (e) => events.push(e) });
    await expect(result).rejects.toThrow('stream died');
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'stream died' });
  });
});

describe('CodexBackend — thread id capture & resume', () => {
  it('captures the thread id from thread.started for resumption', async () => {
    const { backend } = makeBackend([{ events: [started('abc-123'), agentMsg('ok'), turnCompleted] }]);
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: () => {} });
    expect((await result).sessionId).toBe('abc-123');
  });

  it('falls back to thread.id when no thread.started event is emitted', async () => {
    const { backend } = makeBackend([{ events: [agentMsg('ok'), turnCompleted], id: 'from-getter' }]);
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: () => {} });
    expect((await result).sessionId).toBe('from-getter');
  });

  it('resumes via resumeThread(id) without calling startThread', async () => {
    const { backend, fakeRef } = makeBackend([{ events: [started('keep-me'), agentMsg('ok'), turnCompleted] }]);
    const { result } = await backend.startTurn({ input: 'more', sessionId: 'keep-me', onEvent: () => {} });
    const t = fakeRef().threads[0]!;
    expect(t.kind).toBe('resume');
    expect(t.resumeId).toBe('keep-me');
    expect((await result).sessionId).toBe('keep-me');
  });
});

describe('CodexBackend — abort (cancellation) semantics', () => {
  it('surfaces an interrupt as error {message:"cancelled"} and rejects (atomic-text)', async () => {
    const events: AgentEvent[] = [];
    const gen = (signal?: AbortSignal): AsyncGenerator<ThreadEvent> =>
      (async function* () {
        yield started('t1');
        yield agentMsg('partial');
        // Block until aborted, then throw like the real SDK (AbortError).
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      })();
    const { backend } = makeBackend([{ gen }]);
    const { handle, result } = await backend.startTurn({
      input: 'long task',
      sessionId: null,
      onEvent: (e) => events.push(e)
    });
    // Let the first events flow, then interrupt.
    await new Promise((r) => setTimeout(r, 10));
    await handle.interrupt();
    await expect(result).rejects.toThrow('cancelled');
    expect(events).toContainEqual({ kind: 'text_delta', text: 'partial' });
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'cancelled' });
  });
});

describe('CodexBackend — init() probes', () => {
  it('returns ok when login and MCP health-check both pass', async () => {
    const { backend } = makeBackend([], { checkLogin: async () => ({ ok: true }), healthCheck: async () => ({ ok: true }) });
    expect(await backend.init()).toEqual({ ok: true });
  });

  it('surfaces a login failure as an init problem (and skips the health-check)', async () => {
    let healthCalled = false;
    const { backend } = makeBackend([], {
      checkLogin: async () => ({ ok: false, problem: 'Codex is not logged in — run `codex login` in a terminal.' }),
      healthCheck: async () => {
        healthCalled = true;
        return { ok: true };
      }
    });
    const r = await backend.init();
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('codex login');
    expect(healthCalled).toBe(false);
  });

  it('surfaces a silent MCP startup failure as an init problem', async () => {
    const { backend } = makeBackend([], {
      checkLogin: async () => ({ ok: true }),
      healthCheck: async () => ({ ok: false, problem: 'The Jarvis tools server failed to start (timed out).' })
    });
    const r = await backend.init();
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('tools server failed to start');
  });
});
