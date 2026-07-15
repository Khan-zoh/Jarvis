# Task: packaging-hardening

## Objective
Ship it: electron-builder NSIS installer, packaged-path correctness, autostart, and an
end-to-end hardening pass (latency, resilience, docs).

## Read first
- cdd/plan/overview.md, cdd/plan/testing-strategy.md — Gate D checklist.

## Deliverables
- electron-builder config: NSIS one-click off (per-user install), app id, icon from assets,
  `extraResources`: tools-mcp `dist/` + its production node_modules (or bundle tools-mcp with
  esbuild to a single file — preferred), fonts/assets. `models/` NOT packaged (fetched to
  userData on first run — change fetch-models dest to
  `%LOCALAPPDATA%/jarvis/models` when packaged; `resolveModelPaths` checks both).
- `paths.ts` finalized for `app.isPackaged` (tools-mcp entry, models dir, assets).
- Autostart honored from config; tray-only launch on login (`--hidden` flag skips showing
  main window).
- Hardening checklist (each item verified + fixed if broken):
  1. Mic device unplugged mid-listen → error state, auto-recover, pipeline restarts on device
     change.
  2. whisper/piper binary missing → text-only mode with correct reason, no crash.
  3. Backend turn > 90s → watchdog interrupt + spoken "that took too long, i stopped it".
  4. Offline network → tools fail with readable text, app stays alive.
  5. Two rapid wake words → second ignored while busy (spoken refusal max once per 10s).
  6. Sleep/resume (Windows) → capture stream recovers (restart pipeline on
     `powerMonitor.resume`).
  7. Log file: rolling `userData/logs/jarvis.log` (pino or hand-rolled), no secrets logged —
     grep-audit test for token/key patterns in log calls.
- `README.md` full: what it is, setup order, screenshots, licenses section (OFL fonts,
  Porcupine free-tier terms, whisper/piper/silero licenses).
- Version 0.1.0 tag; `npm run dist` produces the installer.

## Tests
- Existing suite green; watchdog unit test (fake timers); log-secret-audit test; paths.ts
  branch test.
- Manual Gate D on a clean Windows user account: install → first-run checklist → full voice
  round-trip with Google, then uninstall cleanly.

## Acceptance
- Installer artifact built; Gate D checklist executed and recorded in docs/release-0.1.0.md.
