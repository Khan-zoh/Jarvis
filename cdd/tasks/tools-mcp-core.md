# Task: tools-mcp-core

## Objective
Build the real tools-mcp server as a **plugin host**: the plugin contract, the plugin loader,
the **system** and **web** plugins, and the stdio server entry. This establishes the
extensibility model every future capability plugs into. (Google plugin lands in google-tools;
smart-home is a later example task.)

## Read first
- cdd/plan/tools-and-google.md — plugin contract, plugin loader, tool catalog (system + web
  sections), env contract, output-format rules. Binding.
- cdd/plan/extending.md — the plugin promise this task must deliver (drop-a-folder = callable +
  configurable). Binding.

## Deliverables
- `packages/tools-mcp/src/plugin.ts` — `ToolDef`, `PluginSetting`, `PluginContext`, `ToolPlugin`
  exactly per plan.
- `src/loader.ts` — `PLUGINS` array, `loadPlugins(ctxFor)`, `pluginManifests()` per plan.
  Wraps every handler so thrown errors become `{ text: "error: <message>" }` (never crash the
  server). Inactive plugins contribute their `stubTools`.
- `src/plugins/system/index.ts` — a `ToolPlugin` (id `system`, no settings) exposing the 6
  system tools per catalog:
  - `open_app_or_url`: URLs/paths via `shell.openExternal`-equivalent (`start` in PowerShell);
    app names resolved by scanning Start Menu `.lnk` files (both ProgramData and AppData) with
    fuzzy match; ambiguous → text listing top 3 candidates.
  - `system_media`: PowerShell `SendKeys`-free approach — use `nircmd`-free native: implement
    via a small PowerShell script calling `keybd_event` P/Invoke (embed script as string).
  - clipboard via PowerShell `Get-Clipboard`/`Set-Clipboard`.
  - `window_focus` via PowerShell EnumWindows/SetForegroundWindow P/Invoke script.
  - `timer_set`: setTimeout in-process + toast via PowerShell BurntToast-free
    `Windows.UI.Notifications` script; reply text confirms scheduled time.
- `src/plugins/web/index.ts` — a `ToolPlugin` (id `web`) exposing `web_search` (DuckDuckGo html
  endpoint, parse results, no API key) and `web_fetch` (fetch, strip tags to readable text, 15k
  cap, 10s timeout).
- `src/index.ts` — real entry: McpServer over stdio, reads `JARVIS_DATA_DIR`, reads plugin
  config/secrets from the data dir, calls `loadPlugins`, registers every returned tool; remove
  `ping`. Exposes `pluginManifests()` to the app (MCP resource or a `plugins_manifest` meta tool).
- App `src/agents/toolsLauncher.ts` updated to return the real entry path via `toolsMcpSpec`
  (no `ALLOWED_TOOL_NAMES` constant — backends grant the whole server per plan).
- Config/secret storage for plugins: a `src/pluginConfig.ts` reading
  `JARVIS_DATA_DIR/plugins/<id>.json` (non-secret) and DPAPI-decrypting `<id>.secrets`
  (written by the app; shares the tokenCodec mechanism from google-auth — if that task hasn't
  landed, implement the PowerShell-DPAPI codec here and google-auth reuses it).

## Tests
- Loader: error-wrapping, zod rejection → readable text; inactive plugin returns stub tools;
  `pluginManifests()` reflects declared settings.
- Each system/web handler with injected fake `runPs(script)` / fake fetch: command/script
  shape + output formatting (list caps, "and N more").
- MCP wire test: boot server via client SDK; `tools/list` contains all system + web tool names;
  call clipboard round-trip (real PowerShell — fine on Windows CI/dev).

## Acceptance
- `npm test` passes; manual: `open_app_or_url {"target":"notepad"}` opens Notepad;
  `web_search {"query":"weather"}` returns readable results. Adding a throwaway 1-tool plugin
  folder + one `PLUGINS` line makes it appear in `tools/list` with no other change (verify, then
  remove it).
