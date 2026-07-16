// Gate B0 — Codex (@openai/codex-sdk) spike. Proves items 1-7 on ChatGPT-subscription auth.
// MCP config is passed PER-INSTANCE via SDK `config` overrides (NOT ~/.codex/config.toml).
import { Codex } from '@openai/codex-sdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO = join(__dirname, 'echo-mcp.mjs');
const OUT = join(__dirname, 'out');
mkdirSync(OUT, { recursive: true });
const results = {};
const log = (...a) => console.error('[codex-spike]', ...a);

// Item 1: which binary does the SDK execute?
const require = createRequire(import.meta.url);
try {
  const codexPkg = require.resolve('@openai/codex/package.json');
  results['0_binary'] = { codexPkg, note: 'SDK resolves vendor binary from platform pkg @openai/codex-win32-x64' };
} catch (e) { results['0_binary'] = { error: String(e) }; }

// Per-instance MCP config -> flattened to `--config mcp_servers.echoServer.command=...` etc.
const mcpConfig = {
  mcp_servers: {
    echoServer: { command: process.execPath, args: [ECHO] }
  }
};

async function runThread(label, { thread, input, timeoutMs = 60000, abortEarly = null }) {
  const ac = new AbortController();
  const obs = { events: [], agentText: '', toolCalls: [], commandExecs: [], errorStr: null,
    threadId: null, completed: false, timedOut: false };
  const timer = setTimeout(() => { obs.timedOut = true; ac.abort(); }, timeoutMs);
  try {
    const { events } = await thread.runStreamed(input, { signal: ac.signal });
    let deltaCount = 0;
    for await (const ev of events) {
      obs.events.push(ev.type + (ev.item ? ':' + ev.item.type : ''));
      if (ev.type === 'thread.started') obs.threadId = ev.thread_id;
      else if (ev.type === 'item.updated' && ev.item?.type === 'agent_message') {
        deltaCount++;
        obs.agentText = ev.item.text || obs.agentText;
        if (abortEarly && deltaCount >= abortEarly.afterDeltas && !obs.aborted) {
          obs.aborted = true; obs.abortAfterDeltas = deltaCount; ac.abort();
        }
      } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
        obs.agentText = ev.item.text || obs.agentText;
      } else if (ev.item?.type === 'mcp_tool_call') {
        obs.toolCalls.push({ server: ev.item.server, tool: ev.item.tool, status: ev.item.status,
          result: JSON.stringify(ev.item.result?.content ?? ev.item.error ?? null).slice(0, 120) });
      } else if (ev.item?.type === 'command_execution') {
        obs.commandExecs.push({ command: String(ev.item.command).slice(0, 80), status: ev.item.status, exit: ev.item.exit_code });
      } else if (ev.type === 'turn.completed') obs.completed = true;
      else if (ev.type === 'turn.failed') obs.errorStr = 'turn.failed: ' + (ev.error?.message || '');
      else if (ev.type === 'error') obs.errorStr = 'error: ' + ev.message;
    }
  } catch (e) {
    obs.errorStr = (obs.errorStr ? obs.errorStr + ' | ' : '') + String(e?.message || e);
  } finally { clearTimeout(timer); }
  if (!obs.threadId && thread.id) obs.threadId = thread.id;
  results[label] = obs;
  log(label, JSON.stringify({ text: obs.agentText.slice(0, 60), tools: obs.toolCalls, cmds: obs.commandExecs,
    done: obs.completed, tid: obs.threadId?.slice(0, 8), err: obs.errorStr, timedOut: obs.timedOut, seq: obs.events }));
  return obs;
}

async function main() {
  const baseThreadOpts = { skipGitRepoCheck: true, workingDirectory: OUT,
    sandboxMode: 'read-only', approvalPolicy: 'never' };

  // ---- Item 2: streamed real reply ----
  {
    const codex = new Codex();
    const thread = codex.startThread(baseThreadOpts);
    await runThread('2_stream', { thread, input: 'Reply with exactly: ok' });
  }

  // ---- Item 3: echo MCP tool call via per-instance config ----
  {
    const codex = new Codex({ config: mcpConfig });
    const thread = codex.startThread(baseThreadOpts);
    await runThread('3_mcp_echo', { thread,
      input: "Use the echoServer MCP tool named echo with text 'ping'. Then reply done." });
  }

  // ---- Item 4: try to run a shell command under sandbox read-only + approvals never ----
  {
    const codex = new Codex();
    const thread = codex.startThread(baseThreadOpts);
    await runThread('4_shell_readonly', { thread,
      input: 'Run the shell command: echo pwned > pwned.txt  (write a file). Report whether it succeeded.' });
  }

  // ---- Item 5: session/thread resume ----
  let resumeId = null;
  {
    const codex = new Codex();
    const thread = codex.startThread(baseThreadOpts);
    const seed = await runThread('5a_resume_seed', { thread,
      input: 'Remember the secret word: banana. Reply exactly: stored' });
    resumeId = seed.threadId;
  }
  if (resumeId) {
    const codex = new Codex();
    const thread = codex.resumeThread(resumeId, baseThreadOpts);
    await runThread('5b_resume_recall', { thread,
      input: 'What was the secret word? Reply with just the word.' });
  } else results['5b_resume_recall'] = { skipped: 'no thread id' };

  // ---- Item 6: cancellation via AbortSignal mid-stream ----
  {
    const codex = new Codex();
    const thread = codex.startThread(baseThreadOpts);
    await runThread('6_cancel', { thread,
      input: 'Write a long numbered list counting from 1 to 200, one per line.',
      abortEarly: { afterDeltas: 1 } });
  }

  // ---- Item 7: MCP child startup failure ----
  {
    const codex = new Codex({ config: { mcp_servers: { broken: { command: 'this-cmd-does-not-exist-xyz', args: [] } } } });
    const thread = codex.startThread(baseThreadOpts);
    await runThread('7_mcp_startfail', { thread,
      input: "Use the broken MCP server's tools if any, else just reply ok." });
  }

  writeFileSync(join(OUT, 'codex-results.json'), JSON.stringify(results, null, 2));
  log('ALL DONE -> out/codex-results.json');
}
main().then(() => process.exit(0)).catch((e) => { log('FATAL', e); process.exit(1); });
