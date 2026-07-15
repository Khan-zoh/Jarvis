import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, '../dist/index.js');

describe('tools-mcp ping', () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry]
    });
    client = new Client({ name: 'jarvis-scaffold-test-client', version: '0.1.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it('boots the stdio server and returns pong from the ping tool', async () => {
    const result = await client.callTool({ name: 'ping', arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe('pong');
  });
});
