// Tiny stdio MCP server exposing ONE tool: `echo` -> returns its input string.
// Pattern copied from packages/tools-mcp/src/index.ts (kept standalone per spike rules).
// stdout is the MCP transport; ALL logging goes to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'jarvis-echo-mcp', version: '0.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echo back the provided text verbatim. Use this when asked to echo something.',
    inputSchema: { text: z.string().describe('the text to echo back') },
    annotations: { readOnlyHint: true }
  },
  async ({ text }) => {
    console.error(`[echo-mcp] echo called with: ${JSON.stringify(text)}`);
    return { content: [{ type: 'text', text: `ECHO:${text}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[echo-mcp] connected');
