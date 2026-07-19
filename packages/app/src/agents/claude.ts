import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type { AgentEvent, AppConfig, BackendId } from '../shared/types';
import type { AgentBackend, TurnHandle } from './types';
import { buildSystemPrompt } from './prompt';
import { toolsMcpSpec } from './toolsLauncher';
import { toUnpackedPath } from './unpacked';

/**
 * ClaudeBackend — wraps `@anthropic-ai/claude-agent-sdk` `query()`.
 *
 * Security model is the SPIKE-VERIFIED A1/A9 template (cdd/plan/amendments.md §A1/§A9,
 * evidence in spikes/b0/). A9 OVERRIDES cdd/tasks/claude-backend.md and agent-backends.md
 * wherever they conflict — notably:
 *   - `tools: []`            → removes all 32 Claude Code built-ins (Bash/Write/Edit/…); only the
 *                              jarvisTools MCP tools remain. Verified: without it the built-ins
 *                              are present. This is THE tool-surface boundary, not a prompt.
 *   - `permissionMode: 'dontAsk'` (NOT bypassPermissions — that would re-enable everything).
 *   - `settingSources: []`, `strictMcpConfig: true` → no user/project config leaks in.
 *   - `alwaysLoad: true` on the MCP server → tools present at turn-1 and startup surfaces a
 *                              `mcp_servers[].status === 'failed'` we can detect.
 *   - `includePartialMessages: true` → REQUIRED for streamed text deltas ('stream_event').
 *   - `abortController` → interrupt path.
 *
 * There is NO login-status API. Auth failure surfaces as an assistant message carrying
 * `error: 'authentication_failed'` while the terminal `result` still lies `subtype: 'success'`
 * — so `init()` runs its own probe and NEVER trusts the result subtype alone.
 */

const MCP_SERVER_NAME = 'jarvisTools';

/**
 * Grant the whole jarvisTools MCP server (server-wide), deliberately NOT a per-tool allowlist:
 * cdd/plan/tools-and-google.md "Backend attachment contract" + toolsLauncher.ts require that
 * adding a plugin never touches the backends. `mcp__<server>` allows every tool from that server.
 * (A9 writes this as `mcp__jarvisTools__*`; the server-wide grant is the same intent and matches
 * the launcher contract, which exposes no tool-name list at this layer.)
 */
const ALLOWED_TOOLS = [`mcp__${MCP_SERVER_NAME}`];

/** Bounded per turn (agent-backends.md). */
const MAX_TURNS = 12;

/**
 * Resolves the SDK-bundled native Claude Code CLI for this platform, asar-corrected.
 *
 * Packaged build (amendments.md A7 smoke finding): the SDK's DEFAULT resolution runs
 * `createRequire(import.meta.url).resolve(...)` from inside app.asar, yielding an asar-internal
 * `claude.exe` path that `spawn()` rejects with ENOENT (asar-aware fs makes it LOOK present).
 * We resolve the same platform package ourselves, substitute the app.asar.unpacked twin
 * (see unpacked.ts), and pass it as `pathToClaudeCodeExecutable`. In dev this resolves to the
 * identical exe the SDK default would pick, so passing it is a no-op there.
 *
 * Returns null when the platform package is absent (SDK default resolution then applies).
 */
export function resolveClaudeCli(): string | null {
  // Mirrors @anthropic-ai/claude-agent-sdk's platform-package naming. win32-x64 is the shipping
  // target for Jarvis 0.1; the other entries keep dev-on-other-OS working.
  const pkgByPlatform: Record<string, string> = {
    'win32-x64': '@anthropic-ai/claude-agent-sdk-win32-x64',
    'win32-arm64': '@anthropic-ai/claude-agent-sdk-win32-arm64',
    'darwin-x64': '@anthropic-ai/claude-agent-sdk-darwin-x64',
    'darwin-arm64': '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    'linux-x64': '@anthropic-ai/claude-agent-sdk-linux-x64',
    'linux-arm64': '@anthropic-ai/claude-agent-sdk-linux-arm64'
  };
  const pkg = pkgByPlatform[`${process.platform}-${process.arch}`];
  if (!pkg) return null;
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const exe = toUnpackedPath(createRequire(import.meta.url).resolve(`${pkg}/${bin}`));
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** Setup message surfaced when the spawned CLI is not logged in. */
export const AUTH_PROBLEM =
  'claude code not logged in — run `claude` in a terminal and sign in.';

/** Setup message surfaced when the jarvisTools MCP child fails to start. */
export const MCP_FAILED_PROBLEM =
  'the jarvis tools server failed to start — check the app installation.';

export interface ClaudeBackendDeps {
  /** Current app config (system prompt + `agents.claude.systemPromptExtra`). */
  getConfig: () => AppConfig;
  /** Launch paths for the jarvisTools stdio MCP server (see toolsLauncher.ts). */
  toolsPaths: { entryJs: string; dataDir: string };
  /**
   * Non-sensitive, empty working directory for the SDK subprocess (A1 defense-in-depth: never
   * run in a directory with the user's real files).
   */
  cwd: string;
  /** Injectable clock for the system-prompt timestamp; defaults to real now. */
  now?: () => Date;
  /** Injectable `query` for tests; defaults to the SDK export. */
  queryFn?: typeof query;
}

/** A single content block from an assistant/user SDK message, read structurally. */
type Block = Record<string, unknown>;

export class ClaudeBackend implements AgentBackend {
  readonly id: BackendId = 'claude';

  private readonly getConfig: () => AppConfig;
  private readonly toolsPaths: { entryJs: string; dataDir: string };
  private readonly cwd: string;
  private readonly now: () => Date;
  private readonly query: typeof query;

  /**
   * Cached readiness (B2): the live probe is a REAL model turn, so it must run once — not on
   * every dispatch/distill. Only an ok result is cached; a failure clears the slot so the next
   * init() re-probes (the user may have just logged in). `invalidate()` forces a fresh probe
   * (settings-UI status checks, auth changes).
   */
  private initPromise: Promise<{ ok: boolean; problem?: string }> | null = null;

  constructor(deps: ClaudeBackendDeps) {
    this.getConfig = deps.getConfig;
    this.toolsPaths = deps.toolsPaths;
    this.cwd = deps.cwd;
    this.now = deps.now ?? (() => new Date());
    this.query = deps.queryFn ?? query;
  }

  /**
   * Verifies the Claude Code login by running a minimal one-turn probe and inspecting the stream
   * directly — there is no login-status API, and the terminal result subtype is unreliable
   * (A9). Also asserts the jarvisTools MCP child started (`mcp_servers[].status`).
   *
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

  /** Drops the cached readiness so the next init() runs a fresh live probe. */
  invalidate(): void {
    this.initPromise = null;
  }

  /** The actual A9 live probe (one minimal model turn). Never rejects. */
  private async probe(): Promise<{ ok: boolean; problem?: string }> {
    const ac = new AbortController();
    try {
      const q = this.query({
        prompt: 'Reply with exactly: ok',
        options: this.buildOptions(null, ac, { stream: false, probe: true })
      });
      let mcpFailed = false;
      let authError: string | null = null;
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          if (this.mcpFailed(m.mcp_servers)) mcpFailed = true;
        } else if (m.type === 'assistant' && m.error) {
          authError = m.error;
          break; // no need to spend the rest of the turn
        }
      }
      if (authError) {
        return {
          ok: false,
          problem: authError === 'authentication_failed' ? AUTH_PROBLEM : `claude backend error: ${authError}`
        };
      }
      if (mcpFailed) return { ok: false, problem: MCP_FAILED_PROBLEM };
      return { ok: true };
    } catch (err) {
      return { ok: false, problem: `claude backend failed to start: ${errText(err)}` };
    } finally {
      ac.abort();
    }
  }

  async startTurn(args: {
    input: string;
    sessionId: string | null;
    onEvent: (e: AgentEvent) => void;
  }): Promise<{ handle: TurnHandle; result: Promise<{ finalText: string; sessionId: string }> }> {
    const ac = new AbortController();
    const q = this.query({
      prompt: args.input,
      options: this.buildOptions(args.sessionId, ac, { stream: true })
    });

    const handle: TurnHandle = {
      // Verified interrupt path (spike proof 5): aborting the controller stops the stream and
      // tears down the child. `consume` turns the resulting throw into an `error:'cancelled'`.
      interrupt: async () => {
        ac.abort();
      }
    };

    const result = this.consume(q, args.onEvent, ac);
    // The router attaches its own catch; mark handled so a rejection here isn't "unhandled".
    result.catch(() => {});
    return { handle, result };
  }

  /**
   * Assembles the exact A1/A9 option set. `stream` toggles delta emission; `probe` shrinks the
   * turn budget for `init()`.
   */
  private buildOptions(
    sessionId: string | null,
    ac: AbortController,
    opts: { stream: boolean; probe?: boolean }
  ): Options {
    const cfg = this.getConfig();
    const spec = toolsMcpSpec(cfg, this.toolsPaths);
    const options: Options = {
      abortController: ac,
      tools: [], // A1/A9: remove ALL Claude Code built-ins — jarvisTools MCP only.
      permissionMode: 'dontAsk', // A1/A9: deny-by-default, NOT bypassPermissions.
      allowedTools: ALLOWED_TOOLS, // server-wide jarvisTools grant, nothing else.
      settingSources: [], // A9: no user/project settings sources.
      strictMcpConfig: true, // A9: only the MCP servers we pass here.
      includePartialMessages: opts.stream, // A9: required for 'stream_event' text deltas.
      maxTurns: opts.probe ? 1 : MAX_TURNS,
      cwd: this.cwd, // A1: non-sensitive empty cwd.
      systemPrompt: buildSystemPrompt(cfg, this.now()),
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'stdio',
          command: spec.command,
          args: spec.args,
          env: spec.env,
          alwaysLoad: true // A9: tools present at turn-1; startup failure becomes status 'failed'.
        }
      }
    };
    if (sessionId) options.resume = sessionId; // A9: session continuity.
    // Packaged build: hand the SDK the asar-corrected bundled CLI (see resolveClaudeCli). When
    // null (platform package missing) the SDK's own default resolution applies unchanged.
    const cli = resolveClaudeCli();
    if (cli) options.pathToClaudeCodeExecutable = cli;
    return options;
  }

  /**
   * Drains the SDK stream into AgentEvents. Emits zero+ `text_delta`/`tool_start`/`tool_end`
   * then EXACTLY ONE terminal `done` (resolve) or `error` (reject), per the AgentBackend
   * contract. Session id is captured from `system:init` (falling back to the result message).
   */
  private async consume(
    q: AsyncIterable<SDKMessage>,
    onEvent: (e: AgentEvent) => void,
    ac: AbortController
  ): Promise<{ finalText: string; sessionId: string }> {
    let sessionId = '';
    let finalText = '';
    let terminated = false;
    // tool_use.id → humanized tool name, so a later tool_result (which only carries the id) can
    // report `tool_end` under the same name.
    const toolNames = new Map<string, string>();

    const emitTerminal = (e: AgentEvent): void => {
      if (!terminated) {
        terminated = true;
        onEvent(e);
      }
    };

    try {
      for await (const m of q) {
        switch (m.type) {
          case 'system': {
            if (m.subtype === 'init') {
              if (m.session_id) sessionId = m.session_id;
              if (this.mcpFailed(m.mcp_servers)) {
                emitTerminal({ kind: 'error', message: MCP_FAILED_PROBLEM });
                ac.abort();
                throw new Error('mcp_failed');
              }
            }
            break;
          }
          case 'stream_event': {
            const ev = m.event as { type?: string; delta?: { type?: string; text?: string } };
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              const text = ev.delta.text ?? '';
              if (text) onEvent({ kind: 'text_delta', text });
            }
            break;
          }
          case 'assistant': {
            // Auth failure lives here even though the terminal result lies 'success' (A9).
            if (m.error) {
              emitTerminal({
                kind: 'error',
                message: m.error === 'authentication_failed' ? AUTH_PROBLEM : `claude error: ${m.error}`
              });
              ac.abort();
              throw new Error(m.error);
            }
            for (const b of blocks(m.message)) {
              if (b['type'] === 'tool_use') {
                const rawName = typeof b['name'] === 'string' ? (b['name'] as string) : 'tool';
                const id = typeof b['id'] === 'string' ? (b['id'] as string) : '';
                const bare = stripMcpPrefix(rawName);
                if (id) toolNames.set(id, bare);
                onEvent({
                  kind: 'tool_start',
                  toolName: bare,
                  summary: summarizeToolCall(rawName, b['input'])
                });
              }
            }
            break;
          }
          case 'user': {
            for (const b of blocks(m.message)) {
              if (b['type'] === 'tool_result') {
                const id = typeof b['tool_use_id'] === 'string' ? (b['tool_use_id'] as string) : '';
                const name = toolNames.get(id) ?? 'tool';
                const ok = b['is_error'] !== true;
                onEvent({ kind: 'tool_end', toolName: name, ok });
              }
            }
            break;
          }
          case 'result': {
            if (!sessionId && m.session_id) sessionId = m.session_id;
            if (m.subtype === 'success') {
              finalText = typeof m.result === 'string' ? m.result : '';
              emitTerminal({ kind: 'done', finalText });
            } else {
              const message = m.errors?.length ? m.errors.join('; ') : `claude error: ${m.subtype}`;
              emitTerminal({ kind: 'error', message });
              throw new Error(m.subtype);
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      // Cancellation (abort) or any mid-stream throw: surface a terminal error if we haven't yet.
      if (!terminated) {
        const message = ac.signal.aborted ? 'cancelled' : errText(err);
        emitTerminal({ kind: 'error', message });
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      // Never leave the SDK child running once the turn is over.
      if (!ac.signal.aborted) ac.abort();
    }

    // Defensive: the stream ended without a terminal `result`. Honor the contract's "exactly one
    // terminal" with a `done` carrying whatever text streamed.
    if (!terminated) onEvent({ kind: 'done', finalText });
    return { finalText, sessionId };
  }

  private mcpFailed(servers: { name: string; status: string }[] | undefined): boolean {
    return (servers ?? []).some((s) => s.name === MCP_SERVER_NAME && s.status === 'failed');
  }
}

/** Reads a message's `content` array as structural blocks, tolerant of the SDK's deep types. */
function blocks(message: unknown): Block[] {
  if (message && typeof message === 'object' && 'content' in message) {
    const content = (message as { content: unknown }).content;
    if (Array.isArray(content)) {
      return content.filter((b): b is Block => typeof b === 'object' && b !== null);
    }
  }
  return [];
}

/** `mcp__jarvisTools__gmail_search` → `gmail_search`; leaves un-prefixed names untouched. */
export function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- summarizeToolCall -----------------------------------------------------------------------

/**
 * One-line, human/spoken-friendly summary of a tool call for the `tool_start` event. Shared shape
 * with the codex backend (both drive the same UI). Accepts the raw tool name (with or without the
 * `mcp__jarvisTools__` prefix) and the tool input, and never throws on malformed input.
 *
 * NOTE ON PLACEMENT: cdd/tasks/claude-backend.md asks for this in `src/agents/summarize.ts`.
 * It lives here (and is exported) to stay inside this task's file boundary and avoid a
 * write-write race with the concurrent codex-backend task; the integrator can re-home it later
 * without changing behavior.
 */
export function summarizeToolCall(name: string, input: unknown): string {
  const tool = stripMcpPrefix(name);
  switch (tool) {
    case 'gmail_search': {
      const q = strField(input, 'query');
      return q ? `searching gmail for "${q}"` : 'searching your gmail';
    }
    case 'gmail_read':
      return 'reading an email';
    case 'gmail_send': {
      const to = strArrField(input, 'to');
      return to && to.length ? `sending an email to ${to.join(', ')}` : 'sending an email';
    }
    case 'gmail_unread_summary':
      return 'checking your unread email';
    case 'calendar_list_events':
      return 'checking your calendar';
    case 'calendar_create_event': {
      const title = strField(input, 'title');
      return title ? `adding "${title}" to your calendar` : 'adding an event to your calendar';
    }
    case 'calendar_delete_event':
      return 'deleting a calendar event';
    case 'calendar_find_free_slots':
      return 'finding free time on your calendar';
    case 'drive_search': {
      const q = strField(input, 'query');
      return q ? `searching your drive for "${q}"` : 'searching your drive';
    }
    case 'drive_read_doc':
      return 'reading a document';
    case 'open_app_or_url': {
      const target = strField(input, 'target');
      return target ? `opening ${target}` : 'opening an app or link';
    }
    case 'system_media': {
      const action = strField(input, 'action');
      return action ? `media control: ${action.replace(/_/g, ' ')}` : 'controlling media playback';
    }
    case 'clipboard_read':
      return 'reading your clipboard';
    case 'clipboard_write':
      return 'copying text to your clipboard';
    case 'window_focus': {
      const title = strField(input, 'titleContains');
      return title ? `focusing the ${title} window` : 'focusing a window';
    }
    case 'timer_set': {
      const minutes = numField(input, 'minutes');
      const label = strField(input, 'label');
      const base = minutes != null ? `setting a ${minutes}-minute timer` : 'setting a timer';
      return label ? `${base} for ${label}` : base;
    }
    case 'web_search': {
      const q = strField(input, 'query');
      return q ? `searching the web for "${q}"` : 'searching the web';
    }
    case 'web_fetch': {
      const url = strField(input, 'url');
      return url ? `fetching ${url}` : 'fetching a web page';
    }
    case 'brain_add_note':
      return 'saving a note';
    case 'brain_append':
      return 'updating your notes';
    case 'brain_consolidate':
      return 'organizing your notes';
    case 'brain_search': {
      const q = strField(input, 'query');
      return q ? `searching your notes for "${q}"` : 'searching your notes';
    }
    default:
      return `using ${tool}`;
  }
}

function strField(input: unknown, key: string): string | undefined {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function strArrField(input: unknown, key: string): string[] | undefined {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      const strings = v.filter((x): x is string => typeof x === 'string');
      if (strings.length) return strings;
    }
  }
  return undefined;
}

function numField(input: unknown, key: string): number | undefined {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}
