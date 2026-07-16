import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { disposePlugins, loadPlugins, pluginManifests } from './loader.js';
import { createPluginContext, type PluginLogger } from './pluginConfig.js';

/**
 * jarvis-tools-mcp — the real stdio entry (binding — cdd/plan/tools-and-google.md +
 * cdd/plan/amendments.md A3/A4).
 *
 * Boots every plugin from the loader, registers each returned tool on an MCP server, and exposes
 * the plugin manifest (settings UI metadata) as the `jarvis://plugins/manifest` resource. Both
 * backends attach this server whole — no per-tool allowlist — so a new plugin's tools are
 * immediately callable.
 *
 * Process model (A3): each backend client spawns its own instance of this server; instances are
 * stateless disposable workers. Durable state lives in JARVIS_DATA_DIR files, never here.
 *
 * Env contract: `JARVIS_DATA_DIR` (plugin config/secrets + caches) is passed by the launcher
 * (packages/app/src/agents/toolsLauncher.ts).
 */

// stdout carries the MCP transport — all logging goes to stderr.
const logger: PluginLogger = {
  info: (m) => console.error(`[tools-mcp] ${m}`),
  warn: (m) => console.error(`[tools-mcp] warn: ${m}`),
  error: (m) => console.error(`[tools-mcp] error: ${m}`)
};

const dataDir = process.env.JARVIS_DATA_DIR ?? join(homedir(), '.jarvis');
if (!process.env.JARVIS_DATA_DIR) {
  logger.warn(`JARVIS_DATA_DIR not set — defaulting to ${dataDir}`);
}

const server = new McpServer({ name: 'jarvis-tools-mcp', version: '0.1.0' });

const tools = await loadPlugins((id) => createPluginContext(dataDir, id, logger));

for (const tool of tools) {
  // The loader-wrapped handler re-validates with zod, enforces the per-call timeout, and never
  // throws; the SDK additionally gets the zod object's shape so tools/list advertises a real
  // JSON schema, plus effect-derived annotations (amendments A4).
  const shape = tool.inputSchema instanceof z.ZodObject ? tool.inputSchema.shape : {};
  const effect = tool.effect ?? 'read';
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: shape,
      annotations: {
        readOnlyHint: effect === 'read',
        destructiveHint: effect === 'destructive',
        openWorldHint: tool.openWorld ?? effect === 'outward'
      }
    },
    async (args: Record<string, unknown>) => {
      const result = await tool.handler(args ?? {});
      return {
        content: [{ type: 'text' as const, text: result.text }],
        // Failures surface as protocol-level isError results (amendments A4) — backends must
        // see failure, never a plain ok.
        ...(result.isError === true ? { isError: true } : {})
      };
    }
  );
}
logger.info(`registered ${tools.length} tools from ${pluginManifests().length} plugins`);

// The app reads this to render one settings section per plugin (fields from `settings`).
server.registerResource(
  'plugins-manifest',
  'jarvis://plugins/manifest',
  {
    description: 'Per-plugin settings manifest: id, displayName, and declared settings fields.',
    mimeType: 'application/json'
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(pluginManifests())
      }
    ]
  })
);

// Best-effort plugin cleanup on shutdown (amendments A4). The process may also be killed
// outright — plugins must already tolerate that (disposability rule in plugin.ts).
let disposed = false;
async function shutdown(): Promise<void> {
  if (disposed) return;
  disposed = true;
  await disposePlugins();
}
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
// Stdio transport closing (client went away) is the normal end of life for this worker.
process.stdin.once('close', () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
