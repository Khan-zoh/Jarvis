# Tools MCP Server & Google Integration

`packages/tools-mcp/` is a standalone Node package exposing every assistant capability as MCP
tools over stdio, built with `@modelcontextprotocol/sdk`. Both backends attach the same server,
so tools are written exactly once.

Entry: `packages/tools-mcp/src/index.ts` → `node dist/index.js`. Env contract:
`JARVIS_DATA_DIR` (token + cache location) is passed by the launcher.

> **Extensibility is a first-class requirement.** Every capability — Google, system, web, and
> future ones like smart-home — is a self-contained **plugin**. Adding a feature means dropping
> one folder under `src/plugins/`; it becomes callable, speakable, and configurable with no edits
> to the backends, the allowlist, or the settings UI. The full authoring guide and a smart-home
> worked example are in `cdd/plan/extending.md`. The catalog below is just the plugins that ship
> in 0.1.

## Plugin contract (src/plugin.ts)

```ts
export interface ToolDef<In> {
  name: string;                     // snake_case, globally unique
  description: string;              // written for the model
  inputSchema: ZodSchema<In>;
  handler: (input: In) => Promise<{ text: string }>;   // plain-text result for voice
}

export interface PluginSetting {
  key: string;                      // e.g. "baseUrl"
  label: string;                    // shown in settings UI
  kind: 'text' | 'secret' | 'toggle' | 'number' | 'action';   // 'action' renders a button → pluginAction(id,key)
  placeholder?: string;
  help?: string;                    // one line, links allowed
}

export interface PluginContext {
  dataDir: string;
  config: Record<string, unknown>;          // this plugin's own config slice
  secret(key: string): string | null;       // this plugin's own secrets (DPAPI-decrypted)
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface ToolPlugin {
  id: string;                       // "google", "system", "web", "smarthome" — namespace + config key
  displayName: string;              // "Google Workspace", "Smart Home"
  settings?: PluginSetting[];       // declares its config/secrets → settings UI renders them
  // Called once at boot. Return tools, OR a reason the plugin is inactive (missing config etc.).
  // An inactive plugin still contributes STUB tools so the tool surface is stable; each stub
  // returns `unavailable`'s text so the model can tell the user how to enable it.
  init(ctx: PluginContext): Promise<{ tools: ToolDef<any>[] } | { unavailable: string; stubTools: ToolDef<any>[] }>;
}
```

Handler results are compact plain text (the model relays them by voice) — no JSON dumps; lists
capped at 10 items with "and N more".

## Plugin loader (src/loader.ts)

```ts
export const PLUGINS: ToolPlugin[];          // static import list — the one place a new plugin is registered
export async function loadPlugins(ctx: (id: string) => PluginContext): Promise<ToolDef<any>[]>;
export function pluginManifests(): { id: string; displayName: string; settings: PluginSetting[] }[];
```

`PLUGINS` is a plain array literal at the top of `loader.ts`; adding a plugin = add its folder +
one line to this array. `loadPlugins` calls each plugin's `init` with a scoped context, flattens
the returned tools, and registers them on the MCP server. `pluginManifests()` is exposed to the
app (over the MCP server's `resources` or a tiny side channel) so the **settings UI renders one
section per plugin automatically** from its declared `settings`.

## Tool catalog (contracts)

### Google — Gmail (src/google/gmail.ts)
| name | input | behavior |
|---|---|---|
| `gmail_search` | `{ query: string; max?: number }` | Gmail search syntax; returns from/subject/date/snippet per hit |
| `gmail_read` | `{ messageId: string }` | full body as text, attachments listed by name |
| `gmail_send` | `{ to: string[]; subject: string; body: string; cc?: string[] }` | sends from the connected account; returns confirmation with recipients |
| `gmail_unread_summary` | `{ max?: number }` | newest unread: sender + subject one-liner each |

### Google — Calendar (src/google/calendar.ts)
| name | input | behavior |
|---|---|---|
| `calendar_list_events` | `{ fromIso: string; toIso: string }` | events with time, title, location, attendees count |
| `calendar_create_event` | `{ title: string; startIso: string; endIso: string; description?: string; attendees?: string[]; location?: string }` | creates on primary calendar; returns confirmation + link |
| `calendar_delete_event` | `{ eventId: string }` | deletes; returns confirmation |
| `calendar_find_free_slots` | `{ dateIso: string; durationMinutes: number }` | free gaps 08:00–22:00 local |

### Google — Drive (src/google/drive.ts)
| name | input | behavior |
|---|---|---|
| `drive_search` | `{ query: string; max?: number }` | name/fullText search; returns name, type, modified, webViewLink |
| `drive_read_doc` | `{ fileId: string }` | Docs exported as text; Sheets first tab as CSV text; others: metadata only. 20k char cap |

### System (src/system.ts) — all implemented with PowerShell child processes / Node APIs
| name | input | behavior |
|---|---|---|
| `open_app_or_url` | `{ target: string }` | `start`-launches a URL, file path, or app name (resolves via Start-Menu shortcut search) |
| `system_media` | `{ action: 'play_pause'|'next'|'previous'|'volume_up'|'volume_down'|'mute' }` | virtual media-key presses |
| `clipboard_read` / `clipboard_write` | `{}` / `{ text: string }` | clipboard text io |
| `window_focus` | `{ titleContains: string }` | focuses first matching top-level window |
| `timer_set` | `{ minutes: number; label?: string }` | in-process timer; fires a Windows toast on expiry |

Deliberately **absent**: shell-exec, file-write, file-delete tools. The safety model is "the
model can only do what the tool surface allows".

### Web (src/web.ts)
| name | input | behavior |
|---|---|---|
| `web_search` | `{ query: string; max?: number }` | DuckDuckGo HTML endpoint scrape → title/url/snippet |
| `web_fetch` | `{ url: string }` | fetch + readability-style text extraction, 15k char cap |

## Google OAuth (src/google/auth.ts)

Installed-app OAuth 2.0 with loopback redirect (`http://127.0.0.1:<random port>`), using
`googleapis` `OAuth2Client`.

```ts
export interface GoogleAuthManager {
  status(): { connected: boolean; email: string | null };
  beginAuthFlow(clientId: string, clientSecret: string): Promise<{ email: string }>; // opens browser, waits for callback
  getClients(): GoogleClients | null;      // null if not connected
  disconnect(): Promise<void>;             // revokes + deletes tokens
}
export interface GoogleClients { gmail: gmail_v1.Gmail; calendar: calendar_v3.Calendar; drive: drive_v3.Drive }
```

- Scopes: `gmail.modify`, `calendar`, `drive.readonly`, `userinfo.email`.
- Tokens persisted to `JARVIS_DATA_DIR/google-token.json`, DPAPI-encrypted by the **app** before
  handoff (the app writes the file; tools-mcp reads it via a shared `tokenCodec` util in this
  package, imported by the app).
- Refresh handled by OAuth2Client `tokens` event → re-persist.
- The OAuth **flow** is initiated from the app's settings UI (`google:connect` IPC) — the app
  imports `GoogleAuthManager` directly from `tools-mcp` (workspace dependency) so browser
  opening happens in the app; the MCP server process only ever reads tokens.
- Setup UX: settings has a "Google" section with a link to a `docs/google-setup.md` walkthrough
  (create GCP project → enable Gmail/Calendar/Drive APIs → OAuth consent (testing) → desktop
  client → paste client id/secret).

## Backend attachment contract

```ts
// packages/app/src/agents/toolsLauncher.ts
export function toolsMcpSpec(cfg: AppConfig, paths: { entryJs: string; dataDir: string }):
  { command: string; args: string[]; env: Record<string,string> };
```

The allowlist is **not hardcoded**. Both backends allow the entire `jarvisTools` MCP server, so
any tool a plugin registers is automatically permitted:
- ClaudeBackend: SDK `mcpServers: { jarvisTools: spec }` and `allowedTools: ['mcp__jarvisTools']`
  (server-wide grant — the SDK permits every `mcp__jarvisTools__*` tool without enumerating).
- CodexBackend: `ensureCodexConfig` writes `[mcp_servers.jarvisTools]`; Codex exposes all of its
  tools to the thread.

This is deliberate: **adding a plugin must never require touching the backends.** The safety
boundary is the plugin set itself (no shell-exec / file-delete plugin ships), not an allowlist.
The app can still enumerate what's live at runtime via the MCP `tools/list` call for display.

## Testing

- Unit: each handler with mocked `googleapis` clients / mocked child_process — asserts request
  shapes and text formatting (list caps, "and N more").
- Integration: boot the MCP server over stdio in-test with the MCP client SDK; `tools/list`
  contains every loaded plugin's tools; a throwaway test plugin added to `PLUGINS` shows up with
  no other change; `tools/call clipboard_write→clipboard_read` round-trips.
- Live smoke (manual): `scripts/smoke/smoke-google.ts` — auth status, list today's events,
  search 1 email.
