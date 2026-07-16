import type { z } from 'zod';

/**
 * The plugin contract (binding — cdd/plan/tools-and-google.md as amended by
 * cdd/plan/amendments.md A3/A4/A5).
 *
 * Every capability (system, web, google, smart-home, ...) is a self-contained plugin exposing
 * `ToolDef`s. Handler results are compact plain text — the model relays them by voice — so no
 * JSON dumps; lists are capped at 10 items with "and N more".
 *
 * DISPOSABILITY RULE (amendments A3 — binding on every plugin author): each backend client
 * spawns its OWN tools-mcp instance, and instances may be short-lived. Server processes are
 * stateless disposable workers. No plugin may keep must-survive state solely in process memory:
 * anything that must outlive a call (timers, tokens, caches that matter) belongs in files under
 * `JARVIS_DATA_DIR`, written atomically (write temp file, then rename). Assume another instance
 * may be running concurrently.
 */

/** Side-effect class of a tool (amendments A4). Mapped to MCP annotations at registration:
 *  readOnlyHint = effect==='read', destructiveHint = effect==='destructive',
 *  openWorldHint = openWorld ?? effect==='outward'. Default: 'read'. */
export type ToolEffect = 'read' | 'local-write' | 'outward' | 'destructive';

/** Per-call context passed by the loader to every handler. */
export interface ToolCall {
  /** Aborted when the loader's per-call timeout fires (default 30s; see ToolDef.timeoutMs).
   *  Long-running handlers (network IO especially) should thread this into their work. */
  signal: AbortSignal;
}

export interface ToolResult {
  /** Plain-text result for voice. */
  text: string;
  /** True marks a failed call; the server relays it as an MCP `isError` result. Handlers may
   *  set it directly; thrown errors are converted to `{ text: "error: <m>", isError: true }`
   *  by the loader. */
  isError?: boolean;
}

export interface ToolDef<In> {
  /** snake_case, globally unique across all plugins. */
  name: string;
  /** Written for the model. */
  description: string;
  inputSchema: z.ZodType<In>;
  /** Side-effect class (default 'read'). See ToolEffect. */
  effect?: ToolEffect;
  /** Overrides the openWorldHint annotation (e.g. read-only web tools reach the open web). */
  openWorld?: boolean;
  /** Per-call timeout override in ms (loader default: 30_000). */
  timeoutMs?: number;
  handler: (input: In, call?: ToolCall) => Promise<ToolResult>;
}

export interface PluginSetting {
  /** e.g. "baseUrl" */
  key: string;
  /** Shown in the settings UI. */
  label: string;
  /** 'action' renders a button → pluginAction(id, key). */
  kind: 'text' | 'secret' | 'toggle' | 'number' | 'action';
  placeholder?: string;
  /** One line, links allowed. */
  help?: string;
}

export interface PluginContext {
  dataDir: string;
  /** This plugin's own config slice (JARVIS_DATA_DIR/plugins/<id>.json). */
  config: Record<string, unknown>;
  /** This plugin's own secrets (DPAPI-decrypted from <id>.secrets). */
  secret(key: string): string | null;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface ToolPlugin {
  /** "google", "system", "web", "smarthome" — namespace + config key. */
  id: string;
  /** "Google Workspace", "Smart Home". */
  displayName: string;
  /** Declares its config/secrets → the settings UI renders them automatically. */
  settings?: PluginSetting[];
  /**
   * Called once at boot. Return tools, OR a reason the plugin is inactive (missing config etc.).
   * An inactive plugin still contributes STUB tools so the tool surface is stable; each stub
   * returns `unavailable`'s text so the model can tell the user how to enable it.
   */
  init(
    ctx: PluginContext
  ): Promise<{ tools: ToolDef<any>[] } | { unavailable: string; stubTools: ToolDef<any>[] }>;
  /** Optional cleanup, called once on server shutdown (amendments A4). Must be best-effort;
   *  the process may also die without it (see the disposability rule above). */
  dispose?(): Promise<void> | void;
}
