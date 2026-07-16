// Auth-independent proof that the echo MCP server + tool work end-to-end.
// Spawns echo-mcp.mjs as an MCP stdio server and calls its `echo` tool via a real MCP client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(__dirname, 'echo-mcp.mjs')]
});
const client = new Client({ name: 'spike-client', version: '0.0.0' });
await client.connect(transport);
const tools = await client.listTools();
console.error('[mcp-direct] tools/list:', JSON.stringify(tools.tools.map(t => ({ name: t.name, ann: t.annotations }))));
const res = await client.callTool({ name: 'echo', arguments: { text: 'ping' } });
console.error('[mcp-direct] echo result:', JSON.stringify(res.content));
await client.close();
console.error('[mcp-direct] OK');
process.exit(0);
