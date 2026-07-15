# Task: app-core

## Objective
Implement the app's main-process backbone: ConfigStore (with encrypted secrets), the full typed
IPC contract + preload bridge, WindowManager (tray, overlay, main window), global hotkey, and
single-instance behavior.

## Read first
- cdd/plan/architecture.md — implement `ConfigStore`, `PushChannels`, `InvokeChannels`,
  `buildPreloadApi`, `WindowManager`, startup sequence, error policy exactly as specified.

## Deliverables
- `src/main/config.ts` — ConfigStore per spec. `DEFAULT_CONFIG` exported: agentName "Jarvis",
  builtinKeyword "jarvis", sensitivity 0.6, listenTimeoutMs 8000, defaultBackend 'claude',
  hotkey "Ctrl+Shift+Space", everything else empty/null/false.
- `src/main/ipc.ts` — channel constants + `registerInvokeHandlers(deps)` wiring every
  InvokeChannel to a handler object (voice/agent handlers accept stubs for now — later tasks
  inject real ones through the `deps` interface; define that `IpcDeps` interface here).
- `src/preload/index.ts` — `buildPreloadApi` + contextBridge exposure as `window.jarvis`.
- `src/main/windows.ts` — WindowManager per spec. Tray menu: open, new session,
  pause/resume listening, quit. Overlay: frameless, transparent, alwaysOnTop 'screen-saver'
  level, skipTaskbar, positioned bottom-center of primary display, `setIgnoreMouseEvents(true)`
  when idle. Hotkey via `globalShortcut`.
- `src/main/index.ts` — startup sequence steps 1–2 + IPC registration; later steps stay TODO
  markers referenced by later tasks.
- `src/main/autostart.ts` — `setLaunchOnStartup(enabled)` using `app.setLoginItemSettings`.

## Tests
- ConfigStore: temp-dir round trip; patch deep-merge; secret set → `config.json` and
  `secrets.bin` on disk contain NO plaintext of the secret; `getRedacted` masks it. Use a fake
  `safeStorage` (base64 codec) injected via constructor param so tests run headless.
- IPC: unit-test `buildPreloadApi` against a mock ipcRenderer (channel names match constants).
- WindowManager: constructor logic that computes overlay bounds from a fake display size.

## Acceptance
- `npm test` passes. `npm run dev`: tray icon appears; hotkey toggles main window; second
  instance focuses the first; overlay window can be shown via a temporary tray menu item.
