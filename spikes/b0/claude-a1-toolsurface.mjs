// A1 focused: with tools:[] + alwaysLoad echo server, inspect the effective tool surface
// reported in the system:init message (emitted before inference, so auth-independent).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO = join(__dirname, 'echo-mcp.mjs');

async function probe(label, options) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  options.abortController = ac;
  let init = null;
  try {
    for await (const m of query({ prompt: 'x', options })) {
      if (m.type === 'system' && m.subtype === 'init') {
        init = { tools: m.tools, mcp_servers: m.mcp_servers, permissionMode: m.permissionMode };
        ac.abort(); // we only need init; stop before inference
        break;
      }
    }
  } catch (e) { /* aborted after init */ }
  clearTimeout(t);
  console.error(label, JSON.stringify(init));
}

const iso = { settingSources: [], strictMcpConfig: true, cwd: __dirname };
await probe('A1 tools:[] + alwaysLoad echo + dontAsk:',
  { ...iso, tools: [], permissionMode: 'dontAsk',
    allowedTools: ['mcp__echoServer__echo'],
    mcpServers: { echoServer: { command: process.execPath, args: [ECHO], type: 'stdio', alwaysLoad: true } } });
await probe('Control default preset (no tools option):',
  { ...iso, permissionMode: 'dontAsk' });
process.exit(0);
