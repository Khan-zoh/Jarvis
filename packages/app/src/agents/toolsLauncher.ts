import type { AppConfig } from '../shared/types';

/**
 * Launch spec for the jarvis-tools-mcp stdio server (binding — cdd/plan/tools-and-google.md,
 * "Backend attachment contract").
 *
 * Both backends attach the server whole — there is deliberately NO allowed-tool-names list here.
 * ClaudeBackend grants `mcp__jarvisTools` server-wide; CodexBackend registers the server in
 * `[mcp_servers.jarvisTools]`. Adding a plugin must never require touching the backends; the
 * safety boundary is the plugin set itself.
 */
export function toolsMcpSpec(
  _cfg: AppConfig,
  paths: { entryJs: string; dataDir: string }
): { command: string; args: string[]; env: Record<string, string> } {
  return {
    // Inside Electron, process.execPath is electron.exe; ELECTRON_RUN_AS_NODE makes it behave as
    // plain Node for the child, so the same spec works in dev (node) and packaged (electron).
    command: process.execPath,
    args: [paths.entryJs],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      JARVIS_DATA_DIR: paths.dataDir,
      // Where fetch-models put the embedding model — the brain plugin resolves `<root>/embed/*`
      // from here because the worker's cwd is not guaranteed to be the repo root. Set by
      // src/main/index.ts at startup; empty falls back to the plugin's `<cwd>/models` default.
      JARVIS_MODELS_DIR: process.env['JARVIS_MODELS_DIR'] ?? ''
    }
  };
}
