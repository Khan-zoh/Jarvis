import { join } from 'node:path';
import { app } from 'electron';

/**
 * Resolves the built jarvis-tools-mcp stdio entry (`dist/index.js`) for the toolsMcpSpec
 * launcher (cdd/tasks/wire-and-converse.md deliverable).
 *
 * - dev: the workspace path `packages/tools-mcp/dist/index.js`, reached relative to the app
 *   package (`app.getAppPath()` is `packages/app` under electron-vite dev AND when running the
 *   built `out/` from the package root).
 * - packaged: `<resources>/tools-mcp/dist/index.js` — tools-mcp ships outside the ASAR (native
 *   deps; see cdd/plan/amendments.md A7); the packaging task copies it there.
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
  return env.isPackaged
    ? join(env.resourcesPath, 'tools-mcp', 'dist', 'index.js')
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
