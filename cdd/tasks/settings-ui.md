# Task: settings-ui

## Objective
Make the settings pane fully functional: every config field live, account status indicators,
model download, first-run experience.

## Read first
- cdd/plan/ui-design.md — settings pane spec, copy voice (binding).
- cdd/plan/architecture.md — config/secret/google/audio IPC channels.

## Deliverables
- Settings sections wired to `config:get/set` + `secret:set` with debounced saves and a
  saved-tick (`saved ✓` mono text, fades):
  - Agent: name (renaming warns: "built-in wake word stays 'jarvis' — train a custom keyword
    to match", link to docs/wakeword-setup.md), default backend, hotkey capture field,
    launch on startup.
  - Voice: input device dropdown (`audio:listInputs`), builtin keyword dropdown (Porcupine
    builtins) / custom .ppn file picker, sensitivity slider (0–1), tts toggle, picovoice key
    (secret field), model status per `resolveModelPaths` with a "download models" button that
    runs fetchModels with streamed progress lines (add `'models:progress'` push channel +
    `'models:fetch'` invoke).
  - Accounts: claude + codex status lines from backend `init()` results (add
    `'accounts:status'` invoke returning both), each with its fix-hint copy.
  - **Plugins (data-driven)**: add `'plugins:manifests'` invoke returning `pluginManifests()`
    from the tools-mcp server; render ONE section per plugin from its `settings[]` array —
    `text`/`number`/`toggle`/`secret` fields map to the matching controls, `secret` fields use
    `secret:set` and never show fetched values. This is the extensibility payoff: a new plugin's
    config appears here with zero edits to this file. The Google plugin's client id/secret plus
    its connect/disconnect button + connected email render through this same mechanism (the
    connect button is a plugin-declared `action` field kind — add `'action'` to `PluginSetting.kind`
    and a `pluginAction(id, key)` invoke that the google plugin handles as connect/disconnect).
- First-run: when config is default AND models missing, main window opens automatically on a
  "setup" view = settings pane with a numbered checklist header (models → mic → picovoice key
  → accounts → google optional), items check off live as statuses turn ok.
- `'voice:status'` surfaced: if voice disabled, overlay-less banner line in main window:
  "voice off — <reason>".

## Tests
- jsdom: each control round-trips through fake api (set called with right patch); secret
  fields never render fetched values (show placeholder when set); checklist derives item
  states correctly from a status fixture matrix; rename warning appears only when name ≠
  keyword.

## Acceptance
- `npm test` passes. Manual: change mic device and sensitivity → takes effect after pipeline
  restart (restart pipeline on relevant config change — implement + verify); fresh userData
  dir → setup checklist guides to a working state without touching any file by hand.
