import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/shared/types';
import { makeConfig } from './fakes/testConfig';

// The SDK module is fully mocked — NO real SDK/CLI calls in unit tests. `queryMock` stands in for
// `query()` and returns a scripted async stream built from the spike JSON shapes (spikes/b0).
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

// Imported AFTER vi.mock so the mock is in place.
import { AUTH_PROBLEM, ClaudeBackend, MCP_FAILED_PROBLEM } from '../src/agents/claude';
import { backendComplete } from '../src/agents/brain/distill';

const TOOLS_PATHS = { entryJs: 'C:/app/tools-mcp/index.js', dataDir: 'C:/data' };
const CWD = 'C:/data/agent-cwd';
const FIXED_NOW = new Date('2026-07-17T12:00:00.000Z');

function makeBackend(config = makeConfig()) {
  return new ClaudeBackend({
    getConfig: () => config,
    toolsPaths: TOOLS_PATHS,
    cwd: CWD,
    now: () => FIXED_NOW
  });
}

/** An async generator over a fixed list of SDK messages. */
function stream(messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

/** Reusable fixture messages, shaped like spikes/b0/out/claude-results.json + sdk.d.ts. */
const initOk = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  tools: [],
  permissionMode: 'dontAsk',
  mcp_servers: [{ name: 'jarvisTools', status: 'pending' }]
};
const initMcpFailed = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  mcp_servers: [{ name: 'jarvisTools', status: 'failed' }]
};
const delta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
});
const assistantToolUse = {
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 'tu_1', name: 'mcp__jarvisTools__gmail_search', input: { query: 'from:amy' } }
    ]
  }
};
const userToolResult = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: 'ok' }] }
};
const resultSuccess = { type: 'result', subtype: 'success', result: 'You have one email.', session_id: 'sess-1' };
const assistantAuthError = {
  type: 'assistant',
  error: 'authentication_failed',
  message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }
};
// A9: result subtype LIES 'success' even on an auth failure — never trust it alone.
const resultLiesSuccess = { type: 'result', subtype: 'success', result: 'Not logged in · Please run /login', session_id: 'sess-1' };

/**
 * Reset + script the mock. IMPORTANT: reset is done inside the test body, NOT in a beforeEach
 * hook — vitest v4 fails to forward call args to a mock implementation when the reset happens in a
 * separate hook, which the interrupt test depends on.
 */
function useStream(messages: unknown[]): void {
  queryMock.mockReset();
  queryMock.mockImplementation(() => stream(messages));
}

describe('ClaudeBackend option assembly (A1/A9)', () => {
  it('passes EVERY spike-verified A1/A9 field to query()', async () => {
    useStream([initOk, resultSuccess]);
    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { result } = await backend.startTurn({
      input: 'hi',
      sessionId: null,
      onEvent: (e) => events.push(e)
    });
    await result;

    const opts = queryMock.mock.calls[0]![0].options;
    expect(opts.tools).toEqual([]); // built-ins removed
    expect(opts.permissionMode).toBe('dontAsk'); // NOT bypassPermissions
    expect(opts.allowedTools).toEqual(['mcp__jarvisTools']); // server-wide grant only
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.includePartialMessages).toBe(true); // required for deltas
    expect(opts.maxTurns).toBe(12);
    expect(opts.cwd).toBe(CWD);
    expect(opts.abortController).toBeInstanceOf(AbortController);
    expect(typeof opts.systemPrompt).toBe('string');
    expect(opts.systemPrompt).toContain("You are Jarvis, a voice assistant on the user's Windows PC.");

    const server = opts.mcpServers.jarvisTools;
    expect(server.type).toBe('stdio');
    expect(server.alwaysLoad).toBe(true);
    expect(server.args).toEqual([TOOLS_PATHS.entryJs]);
    expect(server.env.JARVIS_DATA_DIR).toBe(TOOLS_PATHS.dataDir);
    expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(typeof server.command).toBe('string');

    // No resume key when starting fresh.
    expect('resume' in opts).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'done', finalText: 'You have one email.' });
  });

  it('sets resume to the given native session id', async () => {
    useStream([initOk, resultSuccess]);
    const backend = makeBackend();
    const { result } = await backend.startTurn({ input: 'hi', sessionId: 'prev-abc', onEvent: () => {} });
    await result;
    expect(queryMock.mock.calls[0]![0].options.resume).toBe('prev-abc');
  });

  it('enables the Claude Code tool preset only in explicit full-computer mode', async () => {
    useStream([initOk, resultSuccess]);
    const config = makeConfig();
    config.agents.access = { mode: 'full', workspaceRoot: 'C:\\dev' };
    const backend = makeBackend(config);
    const { result } = await backend.startTurn({ input: 'work', sessionId: null, onEvent: () => {} });
    await result;
    const opts = queryMock.mock.calls[0]![0].options;
    expect(opts.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.settingSources).toEqual(['user']);
    expect(opts.strictMcpConfig).toBe(false);
    expect(opts.cwd).toBe('C:\\dev');
  });

  it('passes the input as the prompt', async () => {
    useStream([initOk, resultSuccess]);
    const backend = makeBackend();
    const { result } = await backend.startTurn({ input: 'what is the weather', sessionId: null, onEvent: () => {} });
    await result;
    expect(queryMock.mock.calls[0]![0].prompt).toBe('what is the weather');
  });
});

describe('ClaudeBackend event mapping', () => {
  it('maps init/deltas/tool_use/tool_result/result → text_delta/tool_start/tool_end/done', async () => {
    useStream([initOk, delta('You have '), delta('one email.'), assistantToolUse, userToolResult, resultSuccess]);
    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { handle, result } = await backend.startTurn({
      input: 'unread?',
      sessionId: null,
      onEvent: (e) => events.push(e)
    });
    expect(handle).toBeDefined();
    const r = await result;

    expect(events).toEqual([
      { kind: 'text_delta', text: 'You have ' },
      { kind: 'text_delta', text: 'one email.' },
      { kind: 'tool_start', toolName: 'gmail_search', summary: 'searching gmail for "from:amy"' },
      { kind: 'tool_end', toolName: 'gmail_search', ok: true },
      { kind: 'done', finalText: 'You have one email.' }
    ]);
    expect(r).toEqual({ finalText: 'You have one email.', sessionId: 'sess-1' });
  });

  it('captures the session id from system:init', async () => {
    useStream([initOk, resultSuccess]);
    const backend = makeBackend();
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: () => {} });
    expect((await result).sessionId).toBe('sess-1');
  });

  it('emits exactly one terminal event on success', async () => {
    useStream([initOk, delta('hi'), resultSuccess]);
    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: (e) => events.push(e) });
    await result;
    const terminals = events.filter((e) => e.kind === 'done' || e.kind === 'error');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.kind).toBe('done');
  });

  it('emits a done even when the stream ends without a result message', async () => {
    useStream([initOk, delta('partial')]);
    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: (e) => events.push(e) });
    const r = await result;
    expect(events).toEqual([
      { kind: 'text_delta', text: 'partial' },
      { kind: 'done', finalText: '' }
    ]);
    expect(r.sessionId).toBe('sess-1');
  });

  it('maps a result error subtype → error and rejects', async () => {
    const resultError = { type: 'result', subtype: 'error_max_turns', errors: ['too many turns'], session_id: 'sess-1' };
    useStream([initOk, resultError]);
    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: (e) => events.push(e) });
    await expect(result).rejects.toThrow();
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'too many turns' });
  });
});

describe('ClaudeBackend auth-failure detection (A9)', () => {
  it('init() returns ok:false with the setup problem when the assistant errors authentication_failed', async () => {
    // Note: result STILL says success — init must not trust the subtype.
    useStream([initOk, assistantAuthError, resultLiesSuccess]);
    const backend = makeBackend();
    const res = await backend.init();
    expect(res).toEqual({ ok: false, problem: AUTH_PROBLEM });
  });

  it('init() returns ok:true when the probe streams clean', async () => {
    useStream([initOk, delta('ok'), resultSuccess]);
    const backend = makeBackend();
    expect(await backend.init()).toEqual({ ok: true });
  });

  it('startTurn surfaces the auth failure as an error event and rejects', async () => {
    useStream([initOk, assistantAuthError, resultLiesSuccess]);
    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: (e) => events.push(e) });
    await expect(result).rejects.toThrow('authentication_failed');
    expect(events).toEqual([{ kind: 'error', message: AUTH_PROBLEM }]);
  });
});

describe('ClaudeBackend init caching (B2)', () => {
  it('caches a successful init — repeated init() runs the live probe exactly once', async () => {
    useStream([initOk, delta('ok'), resultSuccess]);
    const backend = makeBackend();
    expect(await backend.init()).toEqual({ ok: true });
    expect(await backend.init()).toEqual({ ok: true });
    expect(await backend.init()).toEqual({ ok: true });
    expect(queryMock).toHaveBeenCalledTimes(1); // ONE live probe, not one per call
  });

  it('concurrent init() calls share a single probe', async () => {
    useStream([initOk, delta('ok'), resultSuccess]);
    const backend = makeBackend();
    const [a, b] = await Promise.all([backend.init(), backend.init()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure — the next init() re-probes (user may have just logged in)', async () => {
    useStream([initOk, assistantAuthError, resultLiesSuccess]);
    const backend = makeBackend();
    expect((await backend.init()).ok).toBe(false);
    // Login fixed: the next init must run a FRESH probe and see it.
    useStream([initOk, delta('ok'), resultSuccess]);
    expect(await backend.init()).toEqual({ ok: true });
    expect(queryMock).toHaveBeenCalledTimes(1); // the re-probe hit the (reset) mock
  });

  it('invalidate() drops the cached readiness and forces a fresh probe', async () => {
    useStream([initOk, delta('ok'), resultSuccess]);
    const backend = makeBackend();
    expect(await backend.init()).toEqual({ ok: true });
    expect(queryMock).toHaveBeenCalledTimes(1);
    backend.invalidate();
    expect(await backend.init()).toEqual({ ok: true });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('distill backendComplete reuses the cached readiness — no fresh probe per capture (B2)', async () => {
    useStream([initOk, delta('ok'), resultSuccess]);
    const backend = makeBackend();
    await backendComplete(backend, 'distill exchange 1');
    await backendComplete(backend, 'distill exchange 2');
    // 1 probe + 2 real turns = 3 query() calls; a per-capture probe would make it 4.
    expect(queryMock).toHaveBeenCalledTimes(3);
    // The first call was the probe (maxTurns 1); the captures ran full turns (maxTurns 12).
    expect(queryMock.mock.calls[0]![0].options.maxTurns).toBe(1);
    expect(queryMock.mock.calls[1]![0].options.maxTurns).toBe(12);
    expect(queryMock.mock.calls[2]![0].options.maxTurns).toBe(12);
  });
});

describe('ClaudeBackend MCP-failed status (A9 Gate B)', () => {
  it('init() returns ok:false when the jarvisTools MCP child failed to start', async () => {
    useStream([initMcpFailed, resultSuccess]);
    const backend = makeBackend();
    expect(await backend.init()).toEqual({ ok: false, problem: MCP_FAILED_PROBLEM });
  });

  it('startTurn emits an error event when the MCP child failed', async () => {
    useStream([initMcpFailed, resultSuccess]);
    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { result } = await backend.startTurn({ input: 'hi', sessionId: null, onEvent: (e) => events.push(e) });
    await expect(result).rejects.toThrow();
    expect(events).toEqual([{ kind: 'error', message: MCP_FAILED_PROBLEM }]);
  });
});

describe('ClaudeBackend interrupt via abortController', () => {
  it('aborting mid-stream stops the turn and emits error:cancelled', async () => {
    // The mock stream yields deltas then blocks until the passed abortController fires. Reset is
    // in-body (not a hook) so vitest v4 forwards `params` to the implementation.
    queryMock.mockReset();
    queryMock.mockImplementation((params: { options: { abortController: AbortController } }) => {
      const ac = params.options.abortController;
      return (async function* () {
        yield initOk;
        yield delta('hel');
        yield delta('lo');
        await new Promise<void>((_resolve, reject) => {
          ac.signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError'))
          );
        });
      })();
    });

    const backend = makeBackend();
    const events: AgentEvent[] = [];
    const { handle, result } = await backend.startTurn({
      input: 'count to 100',
      sessionId: null,
      onEvent: (e) => events.push(e)
    });

    // Let the two deltas land, then interrupt.
    await new Promise((r) => setTimeout(r, 10));
    await handle.interrupt();

    await expect(result).rejects.toThrow();
    expect(events).toContainEqual({ kind: 'text_delta', text: 'hel' });
    expect(events).toContainEqual({ kind: 'text_delta', text: 'lo' });
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'cancelled' });
    // Exactly one terminal.
    expect(events.filter((e) => e.kind === 'done' || e.kind === 'error')).toHaveLength(1);
  });
});
