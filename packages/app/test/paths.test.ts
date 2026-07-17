import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
// paths.ts imports electron for the thin toolsMcpEntry() wrapper; stub it headless.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '' } }));
import { resolveToolsMcpEntry } from '../src/main/paths';

describe('resolveToolsMcpEntry', () => {
  it('dev: resolves the workspace tools-mcp dist next to the app package', () => {
    const entry = resolveToolsMcpEntry({
      isPackaged: false,
      appPath: join('C:', 'repo', 'packages', 'app'),
      resourcesPath: ''
    });
    expect(entry).toBe(join('C:', 'repo', 'packages', 'tools-mcp', 'dist', 'index.js'));
  });

  it('packaged: resolves under process.resourcesPath (outside the ASAR)', () => {
    const entry = resolveToolsMcpEntry({
      isPackaged: true,
      appPath: join('C:', 'apps', 'jarvis', 'resources', 'app.asar'),
      resourcesPath: join('C:', 'apps', 'jarvis', 'resources')
    });
    expect(entry).toBe(
      join('C:', 'apps', 'jarvis', 'resources', 'tools-mcp', 'dist', 'index.js')
    );
  });
});
