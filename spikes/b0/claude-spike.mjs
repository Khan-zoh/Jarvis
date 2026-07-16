// Gate B0 — Claude (@anthropic-ai/claude-agent-sdk) spike.
// Proves items 1-6 from the B0 mandate on the user's Claude subscription auth.
// Every SDK call is wrapped in a hard 60s timeout that aborts the query and kills children.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO = join(__dirname, 'echo-mcp.mjs');
const OUT = join(__dirname, 'out');
mkdirSync(OUT, { recursive: true });

const results = {};
const log = (...a) => console.error('[claude-spike]', ...a);

// Attach the echo MCP server via the stdio config shape.
const echoServer = { command: process.execPath, args: [ECHO], type: 'stdio' };

// Run a query to completion (or timeout). Returns collected observations.
async function runQuery(label, { prompt, options, timeoutMs = 60000, onMessage }) {
  const ac = options.abortController ?? new AbortController();
  options.abortController = ac;
  const obs = {
    initTools: null, initMcp: null, initPermissionMode: null, sessionId: null,
    textDeltas: 0, sampledText: '', toolStarts: [], toolResults: [],
    resultSubtype: null, resultText: null, errorStr: null, messages: []
  };
  const timer = setTimeout(() => { obs.timedOut = true; ac.abort(); }, timeoutMs);
  try {
    const q = query({ prompt, options });
    for await (const m of q) {
      obs.messages.push(m.type + (m.subtype ? ':' + m.subtype : ''));
      if (m.type === 'system' && m.subtype === 'init') {
        obs.initTools = m.tools;
        obs.initMcp = m.mcp_servers;
        obs.initPermissionMode = m.permissionMode;
        obs.sessionId = m.session_id;
      } else if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          obs.textDeltas++;
          if (obs.sampledText.length < 200) obs.sampledText += ev.delta.text;
        }
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use') obs.toolStarts.push(b.name);
          if (b.type === 'text' && !obs.sampledText) obs.sampledText = b.text.slice(0, 200);
        }
        if (m.error) obs.errorStr = 'assistant.error=' + m.error;
      } else if (m.type === 'user') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_result') {
            const t = Array.isArray(b.content) ? b.content.map(c => c.text).join('') : b.content;
            obs.toolResults.push({ isError: b.is_error ?? false, text: String(t).slice(0, 120) });
          }
        }
      } else if (m.type === 'result') {
        obs.resultSubtype = m.subtype;
        obs.resultText = (m.result ?? '').slice(0, 200);
        if (!obs.sessionId) obs.sessionId = m.session_id;
      }
      if (onMessage) await onMessage(m, q, obs);
    }
  } catch (e) {
    obs.errorStr = (obs.errorStr ? obs.errorStr + ' | ' : '') + String(e?.message || e);
  } finally {
    clearTimeout(timer);
  }
  results[label] = obs;
  log(label, 'done:', JSON.stringify({
    tools: obs.initTools, mcp: obs.initMcp, mode: obs.initPermissionMode,
    deltas: obs.textDeltas, text: obs.sampledText.slice(0, 60),
    toolStarts: obs.toolStarts, toolResults: obs.toolResults,
    result: obs.resultSubtype, session: obs.sessionId?.slice(0, 8), err: obs.errorStr,
    timedOut: obs.timedOut, seq: obs.messages
  }));
  return obs;
}

const isolation = { settingSources: [], strictMcpConfig: true, cwd: OUT };

async function main() {
  // ---- Proof 1: streamed real reply on subscription auth ----
  await runQuery('1_stream', {
    prompt: 'Reply with exactly: ok',
    options: { ...isolation, tools: [], includePartialMessages: true, maxTurns: 1,
      systemPrompt: 'You are a test harness. Follow instructions literally.' }
  });

  // ---- Proof 2: MCP echo tool call ----
  await runQuery('2_mcp_echo', {
    prompt: "Call the echo tool with text 'ping' and then reply done.",
    options: { ...isolation, tools: [], mcpServers: { echoServer },
      allowedTools: ['mcp__echoServer__echo'], permissionMode: 'dontAsk', maxTurns: 3,
      includePartialMessages: true }
  });

  // ---- Proof 3a: A1 — built-in tools disabled, only MCP tool present ----
  const a1 = await runQuery('3a_A1_toollist', {
    prompt: 'Reply with exactly: ok',
    options: { ...isolation, tools: [], mcpServers: { echoServer },
      allowedTools: ['mcp__echoServer__echo'], permissionMode: 'dontAsk', maxTurns: 1 }
  });

  // ---- Proof 3b: A1 — instruct a shell command; must NOT run ----
  await runQuery('3b_A1_shell_denied', {
    prompt: 'Run the shell command `echo pwned` using the Bash tool right now. If you cannot, say why in one sentence.',
    options: { ...isolation, tools: [], mcpServers: { echoServer },
      allowedTools: ['mcp__echoServer__echo'], permissionMode: 'dontAsk', maxTurns: 3 }
  });

  // ---- Proof 3c: control — does bypassPermissions + allowedTools leave Bash usable? (A1 claim) ----
  await runQuery('3c_bypass_has_bash', {
    prompt: 'Reply with exactly: ok',
    options: { ...isolation, allowedTools: ['mcp__echoServer__echo'],
      permissionMode: 'bypassPermissions', maxTurns: 1 }
    // note: tools NOT restricted -> default claude_code preset -> Bash present
  });

  // ---- Proof 4: session resume — capture id, resume, verify context carried ----
  const s1 = await runQuery('4a_resume_seed', {
    prompt: 'Remember this secret word: banana. Reply with exactly: stored',
    options: { ...isolation, tools: [], maxTurns: 1 }
  });
  const resumeId = s1.sessionId;
  if (resumeId) {
    await runQuery('4b_resume_recall', {
      prompt: 'What was the secret word I told you? Reply with just the word.',
      options: { ...isolation, tools: [], resume: resumeId, maxTurns: 1 }
    });
  } else {
    results['4b_resume_recall'] = { skipped: 'no session id captured' };
  }

  // ---- Proof 5: cancellation mid-stream ----
  {
    const ac = new AbortController();
    let aborted = false;
    await runQuery('5_cancel', {
      prompt: 'Count slowly from 1 to 100, one number per line, with a short pause each.',
      options: { ...isolation, tools: [], includePartialMessages: true, abortController: ac, maxTurns: 1 },
      timeoutMs: 60000,
      onMessage: async (m, q, obs) => {
        if (!aborted && obs.textDeltas >= 3) {
          aborted = true;
          obs.abortFiredAfterDeltas = obs.textDeltas;
          ac.abort(); // interrupt mid-stream
        }
      }
    });
  }

  // ---- Proof 6: MCP child startup failure (nonexistent command) ----
  await runQuery('6_mcp_startfail', {
    prompt: 'Reply with exactly: ok',
    options: { ...isolation, tools: [],
      mcpServers: { broken: { command: 'this-cmd-does-not-exist-xyz', args: [], type: 'stdio' } },
      maxTurns: 1, stderr: (d) => { results['6_mcp_startfail_stderr'] = (results['6_mcp_startfail_stderr'] || '') + d; } }
  });

  writeFileSync(join(OUT, 'claude-results.json'), JSON.stringify(results, null, 2));
  log('ALL DONE -> out/claude-results.json');
}

main().then(() => process.exit(0)).catch((e) => { log('FATAL', e); process.exit(1); });
