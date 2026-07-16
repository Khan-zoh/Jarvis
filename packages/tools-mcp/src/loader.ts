import type { PluginContext, PluginSetting, ToolCall, ToolDef, ToolPlugin, ToolResult } from './plugin.js';
import systemPlugin from './plugins/system/index.js';
import webPlugin from './plugins/web/index.js';

/**
 * Plugin loader (binding — cdd/plan/tools-and-google.md + cdd/plan/amendments.md A4).
 *
 * `PLUGINS` is the one place a new plugin is registered: drop a folder under src/plugins/<id>/
 * and add its default export here. Nothing else changes — not the backends, not the allowlist,
 * not the settings UI (see cdd/plan/extending.md).
 */
export const PLUGINS: ToolPlugin[] = [systemPlugin, webPlugin];

/** Default per-call timeout (amendments A4); override per tool via ToolDef.timeoutMs. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps a tool so it can never crash the server (amendments A4):
 * - input is validated against the tool's zod schema → readable "error: invalid input" text;
 * - a throwing handler → `{ text: "error: <message>", isError: true }` (relayed over MCP as an
 *   `isError` result — backends must see failure, never a plain ok);
 * - every call gets an AbortSignal that fires on the per-call timeout (default 30s); a handler
 *   that ignores the signal is still cut off by the surrounding race.
 */
function wrapTool(tool: ToolDef<any>): ToolDef<any> {
  return {
    ...tool,
    handler: async (input: unknown): Promise<ToolResult> => {
      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
          .join('; ');
        return { text: `error: invalid input for ${tool.name} — ${issues}`, isError: true };
      }
      const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      const controller = new AbortController();
      const call: ToolCall = { signal: controller.signal };
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error(`${tool.name} timed out after ${timeoutMs / 1000}s`)),
          { once: true }
        );
      });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      try {
        return await Promise.race([tool.handler(parsed.data, call), timedOut]);
      } catch (err) {
        return { text: `error: ${errorMessage(err)}`, isError: true };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * Initializes every plugin with its scoped context and returns the flattened, error-wrapped tool
 * list. Inactive plugins contribute their stub tools; a plugin whose `init` itself throws is
 * logged and skipped (it declared no stubs we could surface).
 */
export async function loadPlugins(
  ctxFor: (id: string) => PluginContext,
  plugins: ToolPlugin[] = PLUGINS
): Promise<ToolDef<any>[]> {
  const tools: ToolDef<any>[] = [];
  for (const plugin of plugins) {
    const ctx = ctxFor(plugin.id);
    try {
      const result = await plugin.init(ctx);
      if ('tools' in result) {
        tools.push(...result.tools.map(wrapTool));
      } else {
        ctx.logger.warn(`plugin ${plugin.id} inactive: ${result.unavailable}`);
        tools.push(...result.stubTools.map(wrapTool));
      }
    } catch (err) {
      ctx.logger.error(`plugin ${plugin.id} failed to initialize: ${errorMessage(err)}`);
    }
  }
  return tools;
}

/**
 * Best-effort shutdown hook (amendments A4): calls every plugin's optional `dispose()`,
 * swallowing individual failures so one bad plugin cannot block the others.
 */
export async function disposePlugins(plugins: ToolPlugin[] = PLUGINS): Promise<void> {
  for (const plugin of plugins) {
    try {
      await plugin.dispose?.();
    } catch {
      // best-effort only — the process may already be exiting
    }
  }
}

/**
 * The manifest the app's settings UI renders from — one section per plugin, fields from
 * `settings`. Exposed over MCP as the `jarvis://plugins/manifest` resource (see index.ts).
 */
export function pluginManifests(
  plugins: ToolPlugin[] = PLUGINS
): { id: string; displayName: string; settings: PluginSetting[] }[] {
  return plugins.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    settings: p.settings ?? []
  }));
}
