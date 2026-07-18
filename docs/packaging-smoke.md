# Packaging smoke (amendments.md §A7) — findings, 2026-07-18

Early `--dir` (unpacked, unsigned) electron-builder build proving the packaged-Electron risks
before the full packaging-hardening task. Config: `packages/app/electron-builder.yml`; build with
`npm run package` from the repo root (output: `dist-package/win-unpacked/`). electron-builder
26.15.3, Electron 43.1.1 (Node 24.18 / ABI 148), Windows 11 x64.

## The five proofs

### 1. Native modules load inside packaged Electron — VERIFIED
`better-sqlite3`, `onnxruntime-node`, `@picovoice/porcupine-node` all load and RUN from the
packaged layout, both in the main process context and in `ELECTRON_RUN_AS_NODE` children:

```
OK better-sqlite3: sqlite 3.53.2                                  (opened :memory:, ran a query)
OK onnxruntime-node: InferenceSession=function Tensor=function
OK @picovoice/porcupine-node: Porcupine=function BuiltinKeyword=object
electron=43.1.1 node=24.18.0 abi=148
```

Config needed: `asarUnpack` for the three native packages (see electron-builder.yml). Their
pure-JS deps stay in the asar; the module loader transparently redirects `.node` loads to
`app.asar.unpacked/`. electron-builder auto-ran `@electron/rebuild` for better-sqlite3
(source-compiled to ABI 148); onnxruntime-node and porcupine are N-API prebuilds and needed no
rebuild.

**Side effect (real finding):** the `@electron/rebuild` step recompiles better-sqlite3 IN PLACE
in the shared root `node_modules`, which breaks plain-Node `npm test` afterwards
(`NODE_MODULE_VERSION 148` vs Node 24's `137`). The `package` script therefore ends with
`npm rebuild better-sqlite3` to restore the Node ABI; the packaged copy is snapshotted at package
time and unaffected. See "What hardening must still do" for the dev-mode implication.

### 2. tools-mcp + native deps from the packaged layout — VERIFIED (layout CORRECTED)
The plan's assumption (copy tools-mcp to `resources/tools-mcp` outside the asar) is
**unnecessary and was corrected**. electron-builder collects the `@jarvis/tools-mcp` workspace
package into `app.asar/node_modules/@jarvis/tools-mcp` like any production dep, and asar support
is active in `ELECTRON_RUN_AS_NODE` children — the worker loads its JS from inside the asar while
its natives redirect to `app.asar.unpacked`. `resolveToolsMcpEntry` (src/main/paths.ts) packaged
branch now points inside the asar; no packaging copy step exists.

Evidence — a real MCP client against the packaged worker (spawned exactly as `toolsMcpSpec` does:
`Jarvis.exe` + `ELECTRON_RUN_AS_NODE=1`):

```
[tools-mcp] registered 24 tools from 4 plugins
[probe] tools/list OK: 24 tools
```

### 3. whisper/piper/ffmpeg + models from an installed layout — VERIFIED (contract DECIDED)
**Decided contract** (implemented in `modelsRoot()`, src/main/paths.ts):
- `JARVIS_MODELS_DIR` env override always wins (relocation / tests).
- packaged: `<userData>/models` = `%APPDATA%/Jarvis/models`. Per-user writable, survives app
  updates, no elevation; `fetchModels` (settings UI) already targets the same root, so first-run
  provisioning needs no new plumbing. Models (~900 MB) are NOT shipped in the installer.
- dev: `<cwd>/models` (unchanged).

Evidence — real work, not `--version` checks, all spawned from inside packaged Electron against a
models tree at `<userData>/models`:

```
OK ffmpeg -version:  exit=0   ffmpeg version 8.0.1-essentials_build
OK ffplay -version:  exit=0
OK ffmpeg synth wav: exit=0   (generated 1s/16k mono wav)
OK whisper-cli transcribe: exit=0   (ggml-small.en.bin, real inference)
OK piper synth: exit=0   piper output written: true (77984 bytes)
```

And in the real packaged app run (clean profile with models copied in): startup reached
"voice disabled: Picovoice access key is not set" — i.e. `resolveModelPaths` found every
model/binary at `<userData>/models`; the ONLY missing prerequisite was the user secret.

### 4. Claude/Codex SDK executable discovery — FAILED as-is, FIXED in app code, now VERIFIED
The failure mode is subtle: both SDKs (and our `resolveBundledCodex`) resolve their bundled CLI
via `require.resolve(...)`, which in a packaged build returns an **app.asar-internal** path.
Node's asar-aware `fs.existsSync` says it exists — but the OS cannot execute a file inside an
archive, so `spawn()` fails with ENOENT:

```
codex resolved:  ...\resources\app.asar\node_modules\@openai\codex-win32-x64\...\codex.exe
  existsSync: true    spawn(asar path) -> ENOENT
  spawn(unpacked path) -> ok: codex-cli 0.144.5
claude resolved: ...\resources\app.asar\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe
  existsSync: true    spawn(asar path) -> ENOENT
  spawn(unpacked path) -> ok: 2.1.212 (Claude Code)
```

Fixes (all app code; electron-builder already auto-unpacks packages containing executables, so
`@anthropic-ai/*` and `@openai/*` were in `app.asar.unpacked` without extra config):
- `src/agents/unpacked.ts` — `toUnpackedPath()`: substitutes `app.asar` → `app.asar.unpacked`
  (no-op in dev; unit-tested).
- `resolveBundledCodex` applies it, and `CodexBackend` now passes the corrected path as
  `codexPathOverride` (otherwise the SDK's own internal resolution hits the same ENOENT).
- `ClaudeBackend.buildOptions` passes `pathToClaudeCodeExecutable` from the new
  `resolveClaudeCli()` (same substitution; SDK default resolution would fail packaged).

### 5. Packaged app startup + text-mode MCP health check — VERIFIED
Launched `dist-package/win-unpacked/Jarvis.exe --hidden` with `JARVIS_USER_DATA_DIR` pointed at a
clean throwaway profile (env override added in src/main/index.ts, applied BEFORE the
single-instance lock so a smoke instance can't collide with an installed Jarvis). No GUI
interaction; killed via taskkill tree kill afterwards.

```
[main] ipc handlers registered
[main] voice disabled (text-only mode): Picovoice access key is not set — ...
[tools-mcp] registered 24 tools from 4 plugins
[main] tools-mcp health check ok (tools/list non-empty)
orphan check: clean (no Jarvis.exe processes)
```

The health-check line is a new permanent startup diagnostic (fire-and-forget out-of-band
`tools/list` via `defaultHealthCheck`, the same probe CodexBackend.init uses): a broken packaged
layout is now loudly visible at every startup instead of surfacing mid-turn. It caught a real bug
during this smoke (the stale `resources/tools-mcp` path in proof 2).

A full agent turn (Claude/Codex login) was NOT exercised — this machine's CLI login is
host-managed (amendments.md A9 machine blocker) — but the entire packaged plumbing under a turn
(exe → main → spawn worker via `ELECTRON_RUN_AS_NODE` → MCP initialize → tools/list with all 24
tools) is proven above, and proof 4 shows both agent CLIs launch from the packaged build.

## Files + config added/changed by this smoke
- `packages/app/electron-builder.yml` — new; every decision commented inline.
- `package.json` (root) — `package` script: build → electron-builder `--dir` → restore ABI.
- `packages/app/package.json` — devDep `electron-builder@^26.0.12`.
- `packages/app/src/agents/unpacked.ts` — new `toUnpackedPath()`.
- `packages/app/src/agents/codex.ts` — asar-corrected `resolveBundledCodex` + `codexPathOverride`.
- `packages/app/src/agents/claude.ts` — new `resolveClaudeCli()` + `pathToClaudeCodeExecutable`.
- `packages/app/src/main/paths.ts` — packaged tools-mcp entry corrected to the asar location;
  new `resolveModelsRoot`/`modelsRoot` (models contract).
- `packages/app/src/main/index.ts` — `JARVIS_USER_DATA_DIR` override; models root via
  `modelsRoot()`; startup tools-mcp health-check + "ipc handlers registered" milestone log.
- `packages/app/test/paths.test.ts` — updated packaged-entry expectation; new resolveModelsRoot
  and toUnpackedPath tests.
- `.gitignore` — `dist-package/`.
- Suites after all changes: app 427 passed, tools-mcp 158 passed.

## What packaging-hardening must still do
1. **Installer**: NSIS target, icon/metadata (`signAndEditExecutable` currently false), code
   signing decision, `--hidden` autostart registration from an installed path.
2. **First-run model provisioning UX**: `<userData>/models` starts empty on a fresh install; the
   settings-UI `fetchModels` flow must be the guided first-run path (works already, needs polish +
   the packaged `docs/wakeword-setup.md` link surfaced in-app).
3. **better-sqlite3 dual-ABI strategy**: today the repo's single `node_modules` copy serves three
   runtimes — plain-Node vitest (ABI 137), dev Electron (`npm run dev`, ABI 148), and the packaged
   app. The `package` script leaves it at Node ABI, which means **dev-mode Electron with the brain
   enabled loads the wrong ABI** (pre-existing: nothing before this smoke ever rebuilt it for
   Electron, so a live dev brain run would have failed the same way; tests mask it because they run
   under plain Node, and the packaged app is self-contained). Hardening should pick a real
   strategy, e.g. `@electron/rebuild` on postinstall + running vitest through
   `ELECTRON_RUN_AS_NODE` node, or a two-copy scheme.
4. **Deferred items carried from earlier tasks** (unchanged by this smoke):
   - cold-start ONNX embedder warm-up flag (brain-integration).
   - renderer `sandbox: true` needs a real GUI verification (preload is ESM; sandboxed preloads
     must be CJS — do not blind-flip). GUI was deliberately not exercised here.
   - adversarial Gate B/C cases from amendments "non-blocking" list.
5. **Live packaged agent turn**: after the user completes the standalone CLI login (A9 machine
   blocker), run one real text turn from the packaged build end-to-end.
6. **App size**: unpacked build is large (onnxruntime-node ~259 MB incl. DirectML, googleapis
   ~203 MB in-asar). Consider pruning onnxruntime's unused CUDA/DirectML variants and googleapis'
   unused endpoints at package time.

## Repro
```
npm run package                       # root; ends by restoring better-sqlite3 to Node ABI
dist-package\win-unpacked\Jarvis.exe  # launch; use JARVIS_USER_DATA_DIR / JARVIS_MODELS_DIR to isolate
```
