# Extending Jarvis — Adding a Capability

The whole point of the plugin architecture (see tools-and-google.md) is that a new capability is
**one folder**, not a cross-cutting change. This doc is the contract for that promise and the
smart-home worked example the user asked about.

## What a plugin gets you for free

When you add a plugin under `packages/tools-mcp/src/plugins/<id>/` and add it to the `PLUGINS`
array in `loader.ts`, all of the following happen with no other edits:

1. **Callable** — the MCP server registers its tools at boot; both Claude and Codex allow the
   whole `jarvisTools` server, so the new tools are immediately usable by either brain.
2. **Speakable** — the system prompt already instructs the model to prefer available tools and
   the tool `description` is written for the model, so voice requests route to it. No prompt edit.
3. **Configurable** — the plugin's `settings[]` manifest makes the settings UI render a section
   for it (fields + secret fields) automatically. No UI code.
4. **Secure by construction** — secrets are DPAPI-encrypted and scoped to the plugin; the plugin
   only ever sees its own config slice via `PluginContext`.
5. **Testable in isolation** — a plugin is a pure module taking a `PluginContext`; unit-test its
   handlers with a fake context and mocked network. No Electron, no audio.

If a plugin needs config it doesn't have yet, `init` returns `{ unavailable, stubTools }`; the
stub tools still exist and answer "smart home isn't set up — add your hub address in settings,"
so the model degrades gracefully instead of the tool vanishing.

## The 5-step recipe

1. `mkdir packages/tools-mcp/src/plugins/<id>/` → `index.ts` exporting a `ToolPlugin`.
2. Declare `settings[]` for any URL/key/token the integration needs.
3. In `init(ctx)`, read `ctx.config` / `ctx.secret(...)`, build a client, return `tools[]`
   (each a `ToolDef` with a model-facing `description`, a zod `inputSchema`, and a `handler`
   returning compact voice-friendly text).
4. Add the plugin to the `PLUGINS` array in `src/loader.ts`.
5. Write `<id>.test.ts` with a fake `PluginContext` + mocked transport.

That's the entire surface. No changes to the app, the backends, the pipeline, the allowlist, or
the settings UI code.

## Worked example — Smart Home (lights & appliances)

The user's example: control WiFi/Bluetooth lights and appliances by voice.

### Recommended backend: a hub, not raw radios

Talking Bluetooth LE or per-vendor WiFi directly from Node on Windows is possible
(`@abandonware/noble` for BLE) but brittle and device-specific. The robust path is to target a
**hub that already speaks every radio** and expose *that* as one plugin:

- **Home Assistant** (recommended) — a free local server that already integrates Zigbee, Z-Wave,
  WiFi, Bluetooth, and Matter devices behind one REST API + long-lived token. One plugin →
  everything the user already paired.
- **Philips Hue Bridge** — local HTTP API, good if the user only has Hue.
- Direct BLE — still possible inside a plugin (the contract doesn't care what a handler does
  internally), just not recommended as the first move.

The plugin contract is identical regardless; below uses Home Assistant.

### Plugin manifest

```ts
// packages/tools-mcp/src/plugins/smarthome/index.ts
const plugin: ToolPlugin = {
  id: 'smarthome',
  displayName: 'Smart Home',
  settings: [
    { key: 'baseUrl', label: 'Home Assistant URL', kind: 'text',
      placeholder: 'http://homeassistant.local:8123' },
    { key: 'token', label: 'Long-lived access token', kind: 'secret',
      help: 'Home Assistant → Profile → Long-Lived Access Tokens' },
  ],
  async init(ctx) {
    const baseUrl = ctx.config.baseUrl as string | undefined;
    const token = ctx.secret('token');
    if (!baseUrl || !token) return { unavailable: 'smart home not configured', stubTools: STUBS };
    const ha = new HomeAssistantClient(baseUrl, token);
    return { tools: buildTools(ha) };
  },
};
export default plugin;
```

### Tools it would expose (contracts)

| name | input | behavior |
|---|---|---|
| `smarthome_list_devices` | `{ area?: string; kind?: 'light'|'switch'|'climate'|'all' }` | names + on/off state, capped list |
| `smarthome_set_light` | `{ target: string; on?: boolean; brightnessPct?: number; color?: string }` | resolves `target` by fuzzy name/area → HA `light.turn_on/off` |
| `smarthome_set_switch` | `{ target: string; on: boolean }` | outlets/appliances via `switch.*` |
| `smarthome_activate_scene` | `{ name: string }` | `scene.turn_on` |
| `smarthome_set_climate` | `{ target: string; tempC?: number; mode?: string }` | thermostats |

`target` resolution (fuzzy match spoken names like "the kitchen lamp" → an entity id) is a small
helper inside the plugin; ambiguous matches return a text list of candidates so the model can
ask which one — same pattern as `open_app_or_url`.

Once the folder exists and is added to `PLUGINS`, the user says *"Jarvis, turn the living room
lights to twenty percent"* and it works — because the tool is callable, the model knows it from
its description, and the token field already appeared in settings.

## Categories of future plugin (all fit the same contract)

- **Home automation**: Home Assistant, Hue, MQTT broker, Matter.
- **Comms**: Slack, Discord, Telegram, WhatsApp (send/read).
- **Productivity**: Notion, Todoist, Linear, GitHub.
- **Media**: Spotify (playback control via its Web API), local media keys (already in `system`).
- **Local/OS**: files (read-only search), screenshots, app automation.
- **Home devices via BLE directly**: a plugin using `noble` internally.

Each is the same 5-step recipe. The only architectural rule: a plugin that performs
destructive or outward actions must return a clear text confirmation of what it did, and the
system prompt's tool doctrine (state ambiguous destructive actions before doing them) applies
automatically.

## Guardrail for new plugins

The safety model is "the model can only do what the installed plugins allow." Therefore:
- No plugin shipped in-repo may expose arbitrary shell execution, arbitrary file writes/deletes,
  or arbitrary HTTP with attacker-controllable full URLs, without an explicit opt-in toggle in
  its settings that defaults off.
- A plugin handling money or irreversible actions must require a per-action confirmation surfaced
  in the reply, never silent execution.
