import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * MCP wire test (per task spec): boots the compiled server over stdio with the client SDK,
 * checks tools/list carries every system + web tool, reads the plugin manifest resource, and
 * round-trips the clipboard through real PowerShell (fine on Windows dev/CI).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, '../dist/index.js');

const SYSTEM_TOOLS = [
  'open_app_or_url',
  'system_media',
  'clipboard_read',
  'clipboard_write',
  'window_focus',
  'timer_set'
];
const WEB_TOOLS = ['web_search', 'web_fetch'];

describe('tools-mcp wire', () => {
  let client: Client;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'jarvis-wire-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...(process.env as Record<string, string>), JARVIS_DATA_DIR: dataDir }
    });
    client = new Client({ name: 'jarvis-wire-test-client', version: '0.1.0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('tools/list contains every system and web tool (and ping is gone)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [...SYSTEM_TOOLS, ...WEB_TOOLS]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('ping');
  });

  it('tools advertise real input schemas on the wire', async () => {
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'web_search')!;
    const props = (search.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('query');
    expect(props).toHaveProperty('max');
  });

  it('tools carry effect-derived MCP annotations (amendments A4)', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const search = byName.get('web_search')!.annotations!;
    expect(search.readOnlyHint).toBe(true); // effect 'read'
    expect(search.openWorldHint).toBe(true); // reaches the open web
    const clipWrite = byName.get('clipboard_write')!.annotations!;
    expect(clipWrite.readOnlyHint).toBe(false); // effect 'local-write'
    expect(clipWrite.destructiveHint).toBe(false);
    expect(clipWrite.openWorldHint).toBe(false);
    const clipRead = byName.get('clipboard_read')!.annotations!;
    expect(clipRead.readOnlyHint).toBe(true);
  });

  it('exposes the plugin manifest as an MCP resource', async () => {
    const res = await client.readResource({ uri: 'jarvis://plugins/manifest' });
    const first = res.contents[0]!;
    const manifest = JSON.parse(first.text as string) as Array<{
      id: string;
      displayName: string;
      settings: Array<{ key: string; kind: string }>;
    }>;
    expect(manifest.map((m) => m.id)).toEqual(['system', 'web', 'google']);
    for (const entry of manifest) {
      expect(typeof entry.displayName).toBe('string');
      expect(Array.isArray(entry.settings)).toBe(true);
    }
    const system = manifest.find((m) => m.id === 'system')!;
    expect(system.settings.map((s) => s.key)).toContain('allowUnsafePaths');
  });

  it('clipboard write → read round-trips through real PowerShell', async () => {
    const payload = `jarvis wire test ${Date.now()}`;
    const write = await client.callTool({ name: 'clipboard_write', arguments: { text: payload } });
    expect((write.content as Array<{ text: string }>)[0]!.text).toBe('copied to clipboard');

    const read = await client.callTool({ name: 'clipboard_read', arguments: {} });
    const text = (read.content as Array<{ text: string }>)[0]!.text;
    expect(text).toBe(`clipboard contents: ${payload}`);
  }, 30_000);

  it('handler failures surface as protocol-level isError results, never a crash (A4)', async () => {
    // 127.0.0.1 is refused by the SSRF guard (A5) — a failure path with no network involved.
    const res = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://127.0.0.1:1/unreachable' }
    });
    expect(res.isError).toBe(true); // backends must see failure, not a plain ok
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/^error: /);
    expect(text).toContain('private or local');
    // The server is still alive and serving requests after the failure.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  }, 30_000);

  it('gated open_app_or_url refusals also come back as isError (A5)', async () => {
    const res = await client.callTool({
      name: 'open_app_or_url',
      arguments: { target: 'C:\\Windows\\System32\\cmd.exe' }
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('disabled');
  }, 30_000);

  it('successful calls do NOT set isError', async () => {
    const res = await client.callTool({ name: 'clipboard_read', arguments: {} });
    expect(res.isError).toBeFalsy();
  }, 30_000);
});
