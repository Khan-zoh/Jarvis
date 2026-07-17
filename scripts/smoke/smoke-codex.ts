// Manual LIVE smoke for the Codex backend (packages/app/src/agents/codex.ts). NOT part of
// `npm test`: it makes real Codex turns against the user's ChatGPT subscription, so it needs a
// real `codex login` and cannot run unattended. Keep prompts tiny — every run costs the user.
//
// Why it does not import CodexBackend directly: the app source uses extensionless TS imports and
// TypeScript parameter properties, which the bundler (vitest / electron-vite) supports but raw
// `node file.ts` type-stripping does not. So this script MIRRORS codex.ts exactly — same
// per-instance MCP config, same thread options, same event mapping — driving @openai/codex-sdk
// itself. If codex.ts's assembly/mapping changes, mirror it here.
//
// Run (from repo root, with Codex logged in):
//     node scripts/smoke/smoke-codex.ts
//
// Proves, live: (1) a streamed real reply, (2) an echo MCP tool call via a temp stdio server,
// (3) thread resume recall, (4) abort mid-turn → cancelled.

import { Codex } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type AgentEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_start'; toolName: string; summary: string }
  | { kind: 'tool_end'; toolName: string; ok: boolean }
  | { kind: 'done'; finalText: string }
  | { kind: 'error'; message: string };

// The echo server imports @modelcontextprotocol/sdk + zod, so it MUST live where Node's ESM
// resolver can walk up to the repo's node_modules — i.e. inside the repo tree, not os.tmpdir().
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
mkdirSync(join(REPO_ROOT, 'scratch'), { recursive: true });
const WORK = mkdtempSync(join(REPO_ROOT, 'scratch', 'jarvis-codex-smoke-'));

// A one-tool stdio MCP echo server (copied from spikes/b0/echo-mcp.mjs).
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

const baseThreadOpts: ThreadOptions = {
  skipGitRepoCheck: true,
  workingDirectory: WORK,
  sandboxMode: 'read-only',
  approvalPolicy: 'never'
};

/** Mirrors CodexBackend.startTurn's event mapping; returns captured events + final state. */
async function runTurn(
  thread: { runStreamed: (i: string, o?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>; id: string | null },
  input: string,
  onEvent: (e: AgentEvent) => void,
  opts: { abortAfterEvent?: ThreadEvent['type'] } = {}
): Promise<{ finalText: string; threadId: string | null; error: string | null }> {
  const ac = new AbortController();
  let finalText = '';
  let threadId: string | null = null;
  let streamError: string | null = null;
  try {
    const { events } = await thread.runStreamed(input, { signal: ac.signal });
    for await (const ev of events) {
      if (opts.abortAfterEvent && ev.type === opts.abortAfterEvent) ac.abort();
      switch (ev.type) {
        case 'thread.started':
          threadId = ev.thread_id;
          break;
        case 'item.started':
          if (ev.item.type === 'mcp_tool_call')
            onEvent({ kind: 'tool_start', toolName: ev.item.tool, summary: `${ev.item.server}: ${ev.item.tool}` });
          break;
        case 'item.completed':
          if (ev.item.type === 'agent_message') {
            onEvent({ kind: 'text_delta', text: ev.item.text });
            finalText += ev.item.text;
          } else if (ev.item.type === 'mcp_tool_call') {
            onEvent({ kind: 'tool_end', toolName: ev.item.tool, ok: ev.item.status === 'completed' });
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
    if (ac.signal.aborted) {
      onEvent({ kind: 'error', message: 'cancelled' });
      return { finalText, threadId, error: 'cancelled' };
    }
    const message = e instanceof Error ? e.message : String(e);
    onEvent({ kind: 'error', message });
    return { finalText, threadId, error: message };
  }
  if (streamError) {
    onEvent({ kind: 'error', message: streamError });
    return { finalText, threadId: threadId ?? thread.id, error: streamError };
  }
  onEvent({ kind: 'done', finalText });
  return { finalText, threadId: threadId ?? thread.id, error: null };
}

function log(e: AgentEvent): void {
  console.log('   event:', JSON.stringify(e));
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    ok ? pass++ : fail++;
  };

  // ---- 1: streamed real reply ----
  console.log('\n[1] streamed reply "reply with exactly: ok"');
  {
    const thread = new Codex().startThread(baseThreadOpts);
    const r = await runTurn(thread, 'Reply with exactly: ok', log);
    check('1 streamed reply', r.error === null && /ok/i.test(r.finalText), `text=${JSON.stringify(r.finalText)}`);
  }

  // ---- 2: echo MCP tool call (per-instance config, like codex.ts) ----
  console.log('\n[2] echo MCP tool call');
  {
    const codex = new Codex({ config: { mcp_servers: { echoServer: { command: process.execPath, args: [ECHO] } } } });
    const thread = codex.startThread(baseThreadOpts);
    const seen: AgentEvent[] = [];
    const r = await runTurn(thread, "Call the echoServer MCP tool 'echo' with text 'ping', then reply done.", (e) => {
      seen.push(e);
      log(e);
    });
    const calledOk = seen.some((e) => e.kind === 'tool_end' && e.toolName === 'echo' && e.ok);
    check('2 echo tool_start/tool_end', calledOk && r.error === null);
  }

  // ---- 3: resume recall ----
  console.log('\n[3] resume recall');
  {
    const codex = new Codex();
    const seed = codex.startThread(baseThreadOpts);
    const s = await runTurn(seed, 'Remember the secret word: banana. Reply exactly: stored', log);
    if (!s.threadId) {
      check('3 resume recall', false, 'no thread id captured');
    } else {
      const resumed = new Codex().resumeThread(s.threadId, baseThreadOpts);
      const r = await runTurn(resumed, 'What was the secret word? Reply with just the word.', log);
      check('3 resume recall', /banana/i.test(r.finalText), `recalled=${JSON.stringify(r.finalText)}`);
    }
  }

  // ---- 4: abort mid-turn ----
  console.log('\n[4] abort mid-turn → cancelled');
  {
    const thread = new Codex().startThread(baseThreadOpts);
    const r = await runTurn(
      thread,
      'Write a numbered list counting slowly from 1 to 200, one number per line.',
      log,
      { abortAfterEvent: 'turn.started' }
    );
    check('4 abort → cancelled', r.error === 'cancelled', `error=${r.error}`);
  }

  console.log(`\n=== smoke-codex: ${pass} passed, ${fail} failed ===`);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err instanceof Error ? err.stack : err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
