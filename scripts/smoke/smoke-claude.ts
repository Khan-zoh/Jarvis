// Manual LIVE smoke for the Claude backend (packages/app/src/agents/claude.ts). NOT part of
// `npm test`: it makes real Claude turns against the user's Claude Code subscription login, so it
// needs a standalone `claude /login` and cannot run unattended. Keep prompts tiny — every run
// costs the user.
//
// Why it does not import ClaudeBackend directly: the app source uses extensionless TS relative
// imports (`./prompt`, `../shared/types`), which the bundler (vitest / electron-vite) supports but
// raw `node file.ts` type-stripping does NOT resolve. So this script MIRRORS claude.ts exactly —
// the same A1/A9 option assembly and the same stream → event mapping — driving
// @anthropic-ai/claude-agent-sdk `query()` itself. If claude.ts's assembly/mapping changes,
// mirror it here.
//
// Run (from repo root):
//     node scripts/smoke/smoke-claude.ts
//
// Proves, live: (A1 Gate B) the effective tool list contains ONLY mcp__ tools — asserted even
// when not logged in, because system:init is emitted before inference; then, once logged in:
// (1) a streamed real reply, (2) an echo MCP tool call, (3) a Bash-request denial probe.
//
// EXIT CODES:  0 = all proofs passed   1 = a proof genuinely broke   2 = blocked on auth
// (spike caveat: this machine's Claude login is Desktop host-managed; a standalone `claude
// /login` or `claude setup-token` is required first — see cdd/plan/amendments.md §A9).

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type AgentEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_start'; toolName: string; summary: string }
  | { kind: 'tool_end'; toolName: string; ok: boolean }
  | { kind: 'done'; finalText: string }
  | { kind: 'error'; message: string };

const WORK = mkdtempSync(join(tmpdir(), 'jarvis-claude-smoke-'));

// A one-tool stdio MCP echo server (copied from spikes/b0/echo-mcp.mjs) standing in for jarvisTools.
const ECHO = join(WORK, 'echo-mcp.mjs');
writeFileSync(
  ECHO,
  `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'jarvis-echo-mcp', version: '0.0.0' });
server.registerTool('echo',
  { description: 'Echo back the provided text verbatim.', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: 'text', text: 'ECHO:' + text }] }));
await server.connect(new StdioServerTransport());
console.error('[echo-mcp] connected');
`
);

// Mirrors ClaudeBackend.buildOptions — the exact A1/A9 template (spikes/b0, amendments §A1/§A9).
function options(ac: AbortController, sessionId?: string): Options {
  const opts: Options = {
    abortController: ac,
    tools: [], // remove ALL built-ins (Bash/Write/Edit/…)
    permissionMode: 'dontAsk', // deny-by-default, NOT bypassPermissions
    allowedTools: ['mcp__echoServer'], // server-wide grant only (jarvisTools in prod)
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: true, // required for text deltas
    maxTurns: 3,
    cwd: WORK,
    systemPrompt: 'You are a test harness. Follow instructions literally and keep replies short.',
    mcpServers: {
      echoServer: { type: 'stdio', command: process.execPath, args: [ECHO], alwaysLoad: true }
    }
  };
  if (sessionId) opts.resume = sessionId;
  return opts;
}

interface TurnObs {
  initTools: string[];
  sessionId: string;
  deltas: string;
  toolStarts: string[];
  toolEnds: { name: string; ok: boolean }[];
  finalText: string;
  authFailed: boolean;
  mcpFailed: boolean;
  error: string | null;
}

// Mirrors ClaudeBackend.consume's stream → event mapping.
async function runTurn(prompt: string, onEvent: (e: AgentEvent) => void): Promise<TurnObs> {
  const ac = new AbortController();
  const obs: TurnObs = {
    initTools: [],
    sessionId: '',
    deltas: '',
    toolStarts: [],
    toolEnds: [],
    finalText: '',
    authFailed: false,
    mcpFailed: false,
    error: null
  };
  const timer = setTimeout(() => ac.abort(), 60000);
  const toolNames = new Map<string, string>();
  try {
    for await (const m of query({ prompt, options: options(ac) })) {
      if (m.type === 'system' && m.subtype === 'init') {
        obs.initTools = m.tools ?? [];
        obs.sessionId = m.session_id;
        if ((m.mcp_servers ?? []).some((s) => s.name === 'echoServer' && s.status === 'failed'))
          obs.mcpFailed = true;
      } else if (m.type === 'stream_event') {
        const ev = m.event as { type?: string; delta?: { type?: string; text?: string } };
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          const t = ev.delta.text ?? '';
          obs.deltas += t;
          if (t) onEvent({ kind: 'text_delta', text: t });
        }
      } else if (m.type === 'assistant') {
        if (m.error) {
          obs.authFailed = m.error === 'authentication_failed';
          obs.error = m.error;
        }
        for (const b of (m.message?.content ?? []) as unknown as Array<Record<string, unknown>>) {
          if (b['type'] === 'tool_use') {
            const name = String(b['name'] ?? 'tool');
            const id = String(b['id'] ?? '');
            const bare = name.replace(/^mcp__[^_]+__/, '');
            toolNames.set(id, bare);
            obs.toolStarts.push(bare);
            onEvent({ kind: 'tool_start', toolName: bare, summary: bare });
          }
          if (b['type'] === 'text' && !obs.finalText) obs.finalText = String(b['text'] ?? '');
        }
      } else if (m.type === 'user') {
        for (const b of (m.message?.content ?? []) as unknown as Array<Record<string, unknown>>) {
          if (b['type'] === 'tool_result') {
            const id = String(b['tool_use_id'] ?? '');
            const name = toolNames.get(id) ?? 'tool';
            const ok = b['is_error'] !== true;
            obs.toolEnds.push({ name, ok });
            onEvent({ kind: 'tool_end', toolName: name, ok });
          }
        }
      } else if (m.type === 'result') {
        if (!obs.sessionId) obs.sessionId = m.session_id;
        if (m.subtype === 'success') {
          obs.finalText = typeof m.result === 'string' ? m.result : obs.finalText;
          onEvent({ kind: 'done', finalText: obs.finalText });
        } else {
          obs.error = obs.error ?? m.subtype;
          onEvent({ kind: 'error', message: m.subtype });
        }
      }
    }
  } catch (e) {
    obs.error = obs.error ?? (e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  // "Not logged in · Please run /login" arrives as an assistant text block with the auth error.
  if (/not logged in/i.test(obs.finalText) || /not logged in/i.test(obs.deltas)) obs.authFailed = true;
  return obs;
}

function log(e: AgentEvent): void {
  console.log('   event:', JSON.stringify(e));
}

function blockedOnAuth(): never {
  console.log('\n=== BLOCKED ON AUTH ===');
  console.log('The spawned Claude CLI is not logged in.');
  console.log('On this machine the Claude subscription login is Desktop host-managed and is NOT');
  console.log('visible to spawned CLIs (cdd/plan/amendments.md §A9). To unblock the live proofs:');
  console.log('   1. Open a terminal and run:  claude /login   (or: claude setup-token)');
  console.log('   2. Complete the browser sign-in.');
  console.log('   3. Re-run:  node scripts/smoke/smoke-claude.ts');
  process.exit(2);
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (ok) pass++;
    else fail++;
  };

  // ---- A1 Gate B: tool surface (AUTH-INDEPENDENT — system:init precedes inference) ----
  console.log('\n[A1] effective tool list contains ONLY mcp__ tools');
  const probe = await runTurn('Reply with exactly: ok', () => {});
  const onlyMcp = probe.initTools.every((t) => t.startsWith('mcp__'));
  const noBash = !probe.initTools.includes('Bash');
  check('A1 only mcp__ tools present', onlyMcp && noBash, `tools=${JSON.stringify(probe.initTools)}`);

  // If the probe shows we are not logged in, report auth block (exit 2) — the A1 assertion above
  // is the one result that does not depend on auth, so it still stands.
  if (probe.authFailed) blockedOnAuth();

  // ---- 1: streamed real reply ----
  console.log('\n[1] streamed reply "reply with exactly: ok"');
  {
    const r = await runTurn('Reply with exactly: ok', log);
    if (r.authFailed) blockedOnAuth();
    check('1 streamed reply', r.error === null && /ok/i.test(r.finalText), `text=${JSON.stringify(r.finalText)}`);
  }

  // ---- 2: echo MCP tool call ----
  console.log('\n[2] echo MCP tool call');
  {
    const seen: AgentEvent[] = [];
    const r = await runTurn("Call the echo tool with text 'ping', then reply done.", (e) => {
      seen.push(e);
      log(e);
    });
    if (r.authFailed) blockedOnAuth();
    const echoed = r.toolEnds.some((t) => t.name === 'echo' && t.ok);
    check('2 echo tool_start/tool_end', echoed && r.error === null, `tools=${JSON.stringify(r.toolStarts)}`);
  }

  // ---- 3: Bash-request denial probe (A1 Gate B) ----
  console.log('\n[3] Bash request must NOT run a shell');
  {
    const r = await runTurn(
      'Run the shell command `echo pwned` using the Bash tool right now. If you cannot, say why in one sentence.',
      log
    );
    if (r.authFailed) blockedOnAuth();
    const ranBash = r.toolStarts.some((t) => /bash/i.test(t));
    check('3 Bash denied (no shell tool used)', !ranBash && r.error === null, `tools=${JSON.stringify(r.toolStarts)}`);
  }

  console.log(`\n=== smoke-claude: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
