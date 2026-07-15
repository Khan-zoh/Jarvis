# Task: smarthome-plugin (example / optional)

## Objective
Ship a **Smart Home** plugin controlling lights and appliances by voice, via Home Assistant.
This task exists as much to prove the plugin architecture as to deliver the feature: it must be
implementable with NO edits outside `packages/tools-mcp/src/plugins/smarthome/` and one line in
`src/loader.ts`. If it needs any other change, that's an extensibility bug in tools-mcp-core —
fix it there.

## Read first
- cdd/plan/extending.md — the plugin recipe + this exact worked example (binding).
- cdd/plan/tools-and-google.md — plugin contract.

## Deliverables
- `src/plugins/smarthome/index.ts` — `ToolPlugin` id `smarthome`, settings: `baseUrl` (text),
  `token` (secret). `init` returns stub tools with "smart home not configured…" when either is
  missing.
- `src/plugins/smarthome/homeAssistant.ts` — thin client: `getStates()`, `callService(domain,
  service, data)` against `${baseUrl}/api/...` with bearer token; 8s timeout; readable errors
  ("can't reach home assistant at <url>").
- `src/plugins/smarthome/resolve.ts` — fuzzy `target` → entity_id resolver over friendly names +
  areas; ambiguous → return candidate list text (no side effect).
- Tools per extending.md catalog: `smarthome_list_devices`, `smarthome_set_light`,
  `smarthome_set_switch`, `smarthome_activate_scene`, `smarthome_set_climate`. Voice-friendly
  confirmations ("living room lamp set to 20%").
- Add `smarthome` to `PLUGINS` in `loader.ts` (the one allowed outside-the-folder line).
- `docs/smarthome-setup.md`: install Home Assistant (or point at existing), create a
  long-lived token, paste URL + token into the Smart Home settings section.

## Tests
- resolve.ts: table — exact name, area-qualified, fuzzy, ambiguous→candidates, no-match.
- Each tool with a fake HomeAssistant client: correct service call (`light.turn_on` with
  `brightness_pct`, `light.turn_off`, `switch.turn_on`, `scene.turn_on`, `climate.set_temperature`),
  confirmation text, unconfigured stub message.
- MCP wire test: with baseUrl+token set (fake client injected), `tools/list` includes the 5
  smarthome tools; adding the plugin required no change outside its folder + the one PLUGINS line
  (assert by construction — reviewer confirms the diff).

## Acceptance
- `npm test` passes. Manual (with a real Home Assistant): "Jarvis, turn the living room lights to
  twenty percent" and "turn off the kitchen" work end-to-end and are spoken back. Diff touches
  only `src/plugins/smarthome/**`, one line of `loader.ts`, and docs.
