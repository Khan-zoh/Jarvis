import { describe, expect, it, vi } from 'vitest';
import { join, sep } from 'node:path';
// paths.ts imports electron for the thin toolsMcpEntry() wrapper; stub it headless.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '' } }));
import { resolveModelsRoot, resolveToolsMcpEntry } from '../src/main/paths';
import { toUnpackedPath } from '../src/agents/unpacked';

describe('resolveToolsMcpEntry', () => {
  it('dev: resolves the workspace tools-mcp dist next to the app package', () => {
    const entry = resolveToolsMcpEntry({
      isPackaged: false,
      appPath: join('C:', 'repo', 'packages', 'app'),
      resourcesPath: ''
    });
    expect(entry).toBe(join('C:', 'repo', 'packages', 'tools-mcp', 'dist', 'index.js'));
  });

  it('packaged: resolves the workspace package INSIDE app.asar (A7 smoke-verified layout)', () => {
    const entry = resolveToolsMcpEntry({
      isPackaged: true,
      appPath: join('C:', 'apps', 'jarvis', 'resources', 'app.asar'),
      resourcesPath: join('C:', 'apps', 'jarvis', 'resources')
    });
    expect(entry).toBe(
      join(
        'C:', 'apps', 'jarvis', 'resources', 'app.asar',
        'node_modules', '@jarvis', 'tools-mcp', 'dist', 'index.js'
      )
    );
  });
});

describe('resolveModelsRoot (A7 packaged models-root contract)', () => {
  it('dev: <cwd>/models, matching scripts/fetch-models.ts', () => {
    const root = resolveModelsRoot({
      isPackaged: false,
      userDataPath: join('C:', 'ud'),
      cwd: join('C:', 'repo')
    });
    expect(root).toBe(join('C:', 'repo', 'models'));
  });

  it('packaged: <userData>/models (per-user writable, survives updates)', () => {
    const root = resolveModelsRoot({
      isPackaged: true,
      userDataPath: join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Jarvis'),
      cwd: join('C:', 'somewhere')
    });
    expect(root).toBe(join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Jarvis', 'models'));
  });

  it('JARVIS_MODELS_DIR override always wins', () => {
    const root = resolveModelsRoot({
      isPackaged: true,
      userDataPath: join('C:', 'ud'),
      cwd: join('C:', 'repo'),
      envOverride: join('D:', 'big-models')
    });
    expect(root).toBe(join('D:', 'big-models'));
  });
});

describe('toUnpackedPath (asar-internal exe paths are unspawnable)', () => {
  it('substitutes app.asar with app.asar.unpacked', () => {
    const asar = ['C:', 'app', 'resources', 'app.asar', 'node_modules', 'x', 'x.exe'].join(sep);
    const unpacked = ['C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', 'x', 'x.exe'].join(sep);
    expect(toUnpackedPath(asar)).toBe(unpacked);
  });

  it('leaves dev (non-asar) paths untouched', () => {
    const dev = ['C:', 'repo', 'node_modules', 'x', 'x.exe'].join(sep);
    expect(toUnpackedPath(dev)).toBe(dev);
  });

  it('leaves already-unpacked paths untouched', () => {
    const p = ['C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', 'x.exe'].join(sep);
    expect(toUnpackedPath(p)).toBe(p);
  });
});
