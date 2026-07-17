import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * MCP wire test for the google plugin (task spec: "tools/list includes the google tools alongside
 * system + web, with stubs when unavailable, and annotations map correctly").
 *
 * The temp JARVIS_DATA_DIR has no google token file, so the plugin loads UNAVAILABLE — its tools
 * appear as stubs. That is exactly the surface we assert here: names present, effect-derived
 * annotations correct, and a stub call returning the setup hint (not a crash).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, '../../dist/index.js');

const GOOGLE_TOOLS = [
  'gmail_search',
  'gmail_read',
  'gmail_unread_summary',
  'gmail_send',
  'calendar_list_events',
  'calendar_create_event',
  'calendar_delete_event',
  'calendar_find_free_slots',
  'drive_search',
  'drive_read_doc'
];

describe('tools-mcp google wire', () => {
  let client: Client;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'jarvis-google-wire-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...(process.env as Record<string, string>), JARVIS_DATA_DIR: dataDir }
    });
    client = new Client({ name: 'jarvis-google-wire-test-client', version: '0.1.0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('tools/list includes every google tool (as stubs when unavailable)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of GOOGLE_TOOLS) expect(names).toContain(expected);
    // System + web still present — google registration touched nothing else.
    expect(names).toContain('web_search');
    expect(names).toContain('clipboard_read');
  });

  it('effect-derived annotations map correctly (A4/A5)', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const search = byName.get('gmail_search')!.annotations!;
    expect(search.readOnlyHint).toBe(true); // effect 'read'
    expect(search.destructiveHint).toBe(false);

    const send = byName.get('gmail_send')!.annotations!;
    expect(send.readOnlyHint).toBe(false); // effect 'outward'
    expect(send.openWorldHint).toBe(true);
    expect(send.destructiveHint).toBe(false);

    const del = byName.get('calendar_delete_event')!.annotations!;
    expect(del.destructiveHint).toBe(true); // effect 'destructive'
    expect(del.readOnlyHint).toBe(false);
  });

  it('the manifest exposes the google settings (clientId + clientSecret)', async () => {
    const res = await client.readResource({ uri: 'jarvis://plugins/manifest' });
    const manifest = JSON.parse(res.contents[0]!.text as string) as Array<{
      id: string;
      settings: Array<{ key: string; kind: string }>;
    }>;
    const google = manifest.find((m) => m.id === 'google')!;
    expect(google.settings.map((s) => s.key)).toEqual(['clientId', 'clientSecret']);
    expect(google.settings.find((s) => s.key === 'clientSecret')!.kind).toBe('secret');
  });

  it('a stub tool call returns the setup hint (not connected), not a crash', async () => {
    const res = await client.callTool({ name: 'gmail_unread_summary', arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('not connected');
  }, 30_000);
});
