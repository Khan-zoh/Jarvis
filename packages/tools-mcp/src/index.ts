import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Scaffold placeholder: a single "ping" tool proving the stdio MCP server boots and can be
// driven end to end. Replaced by the real plugin-loaded tool set in the tools-mcp-core task.
const server = new McpServer({
  name: 'jarvis-tools-mcp',
  version: '0.1.0'
});

server.registerTool(
  'ping',
  {
    title: 'Ping',
    description: 'Health-check tool. Always replies "pong".',
    inputSchema: {}
  },
  async () => ({
    content: [{ type: 'text' as const, text: 'pong' }]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
