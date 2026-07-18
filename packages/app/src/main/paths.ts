import { join } from 'node:path';
import { app } from 'electron';

/**
 * Resolves the built jarvis-tools-mcp stdio entry (`dist/index.js`) for the toolsMcpSpec
 * launcher (cdd/tasks/wire-and-converse.md deliverable).
 *
 * - dev: the workspace path `packages/tools-mcp/dist/index.js`, reached relative to the app
 *   package (`app.getAppPath()` is `packages/app` under electron-vite dev AND when running the
 *   built `out/` from the package root).
 * - packaged: `<resources>/app.asar/node_modules/@jarvis/tools-mcp/dist/index.js` — DECIDED by
 *   the A7 packaging smoke (cdd/plan/amendments.md §A7, evidence in docs/packaging-smoke.md).
 *   electron-builder collects the @jarvis/tools-mcp workspace package into the asar like any
 *   other production dep, and an ELECTRON_RUN_AS_NODE child loads asar-internal JS fine (asar
 *   support is active in run-as-node children); its native deps (better-sqlite3,
 *   onnxruntime-node) are asarUnpack'ed and the module loader transparently redirects them to
 *   app.asar.unpacked. VERIFIED: a packaged worker spawned from this path served tools/list with
 *   all 24 tools. The original plan (copy tools-mcp to `<resources>/tools-mcp` outside the asar)
 *   is unnecessary — no extra packaging copy step exists or is needed.
 *
 * The pure `resolveToolsMcpEntry` carries the branch logic so it is unit-testable without
 * Electron; `toolsMcpEntry` is the thin Electron-facing wrapper used by src/main/index.ts.
 */
export interface ToolsMcpEntryEnv {
  isPackaged: boolean;
  /** `app.getAppPath()` — the app package root in dev. */
  appPath: string;
  /** `process.resourcesPath` — only meaningful when packaged. */
  resourcesPath: string;
}

export function resolveToolsMcpEntry(env: ToolsMcpEntryEnv): string {
  // Packaged: app.getAppPath() IS `<resources>/app.asar`, so address the workspace package
  // inside it. (resourcesPath stays in the env shape for callers/tests that reason about the
  // packaged layout explicitly.)
  return env.isPackaged
    ? join(env.appPath, 'node_modules', '@jarvis', 'tools-mcp', 'dist', 'index.js')
    : join(env.appPath, '..', 'tools-mcp', 'dist', 'index.js');
}

/** The tools-mcp entry for THIS process (Electron main only). */
export function toolsMcpEntry(): string {
  return resolveToolsMcpEntry({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath ?? ''
  });
}

/**
 * Models-root contract (decided by the A7 packaging smoke — cdd/plan/amendments.md §A7 item 3):
 *
 * - `JARVIS_MODELS_DIR` env, when set, always wins (used by the packaged smoke, and lets a user
 *   relocate the ~900 MB model set to another drive).
 * - packaged: `<userData>/models` — i.e. `%APPDATA%/Jarvis/models`. Models are NOT shipped in the
 *   installer (whisper+piper+ffmpeg+embedder ≈ 900 MB, fetched by `fetchModels` via the settings
 *   UI, which already targets this same root). userData is per-user writable, survives app
 *   updates (resources/ does not), and needs no elevation.
 * - dev: `<cwd>/models` (repo root), matching scripts/fetch-models.ts' default.
 */
export interface ModelsRootEnv {
  isPackaged: boolean;
  /** `app.getPath('userData')`. */
  userDataPath: string;
  /** `process.cwd()` — only meaningful in dev. */
  cwd: string;
  /** `process.env.JARVIS_MODELS_DIR`, empty/undefined when unset. */
  envOverride?: string;
}

export function resolveModelsRoot(env: ModelsRootEnv): string {
  if (env.envOverride) return env.envOverride;
  return env.isPackaged ? join(env.userDataPath, 'models') : join(env.cwd, 'models');
}

/** The models root for THIS process (Electron main only). */
export function modelsRoot(): string {
  return resolveModelsRoot({
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    cwd: process.cwd(),
    envOverride: process.env['JARVIS_MODELS_DIR'] || undefined
  });
}
