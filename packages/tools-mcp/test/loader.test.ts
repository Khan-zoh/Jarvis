import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { disposePlugins, loadPlugins, pluginManifests, PLUGINS } from '../src/loader.js';
import type { PluginContext, ToolDef, ToolPlugin } from '../src/plugin.js';

function fakeCtx(): PluginContext & { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    dataDir: 'X:\\nowhere',
    config: {},
    secret: () => null,
    logger: {
      info: () => {},
      warn: (m) => warnings.push(m),
      error: (m) => errors.push(m)
    },
    warnings,
    errors
  };
}

const echoTool: ToolDef<{ msg: string }> = {
  name: 'echo',
  description: 'echoes',
  inputSchema: z.object({ msg: z.string() }),
  handler: async ({ msg }) => ({ text: `echo: ${msg}` })
};

const throwingTool: ToolDef<{ msg: string }> = {
  name: 'boom',
  description: 'always throws',
  inputSchema: z.object({ msg: z.string() }),
  handler: async () => {
    throw new Error('kaboom');
  }
};

describe('loadPlugins', () => {
  it('flattens tools from active plugins', async () => {
    const plugin: ToolPlugin = {
      id: 'fake',
      displayName: 'Fake',
      init: async () => ({ tools: [echoTool] })
    };
    const tools = await loadPlugins(() => fakeCtx(), [plugin]);
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(await tools[0]!.handler({ msg: 'hi' })).toEqual({ text: 'echo: hi' });
  });

  it('wraps thrown handler errors as isError results instead of crashing (A4)', async () => {
    const plugin: ToolPlugin = {
      id: 'fake',
      displayName: 'Fake',
      init: async () => ({ tools: [throwingTool] })
    };
    const [tool] = await loadPlugins(() => fakeCtx(), [plugin]);
    await expect(tool!.handler({ msg: 'x' })).resolves.toEqual({
      text: 'error: kaboom',
      isError: true
    });
  });

  it('turns zod rejections into readable isError text', async () => {
    const plugin: ToolPlugin = {
      id: 'fake',
      displayName: 'Fake',
      init: async () => ({ tools: [echoTool] })
    };
    const [tool] = await loadPlugins(() => fakeCtx(), [plugin]);
    const result = await tool!.handler({ msg: 42 });
    expect(result.text).toMatch(/^error: invalid input for echo/);
    expect(result.text).toContain('msg');
    expect(result.isError).toBe(true);
  });

  it('hands every handler an AbortSignal (A4)', async () => {
    let seenSignal: AbortSignal | undefined;
    const probe: ToolDef<Record<string, never>> = {
      name: 'probe',
      description: 'records its call context',
      inputSchema: z.object({}),
      handler: async (_input, call) => {
        seenSignal = call?.signal;
        return { text: 'ok' };
      }
    };
    const plugin: ToolPlugin = {
      id: 'fake',
      displayName: 'Fake',
      init: async () => ({ tools: [probe] })
    };
    const [tool] = await loadPlugins(() => fakeCtx(), [plugin]);
    await tool!.handler({});
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(false);
  });

  it('enforces the per-call timeout, aborting the signal and returning isError (A4)', async () => {
    let sawAbort = false;
    const slow: ToolDef<Record<string, never>> = {
      name: 'slow',
      description: 'never finishes on its own',
      inputSchema: z.object({}),
      timeoutMs: 50,
      handler: (_input, call) =>
        new Promise((resolve) => {
          call?.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ text: 'aborted late' });
          });
        })
    };
    const plugin: ToolPlugin = {
      id: 'fake',
      displayName: 'Fake',
      init: async () => ({ tools: [slow] })
    };
    const [tool] = await loadPlugins(() => fakeCtx(), [plugin]);
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('slow timed out after 0.05s');
    expect(sawAbort).toBe(true);
  });

  it('inactive plugins contribute stub tools that reply with the unavailable text', async () => {
    const stub: ToolDef<Record<string, never>> = {
      name: 'smarthome_stub',
      description: 'stub',
      inputSchema: z.object({}),
      handler: async () => ({ text: 'smart home is not set up — add your hub in settings' })
    };
    const plugin: ToolPlugin = {
      id: 'smarthome',
      displayName: 'Smart Home',
      init: async () => ({ unavailable: 'not configured', stubTools: [stub] })
    };
    const ctx = fakeCtx();
    const tools = await loadPlugins(() => ctx, [plugin]);
    expect(tools.map((t) => t.name)).toEqual(['smarthome_stub']);
    expect((await tools[0]!.handler({})).text).toContain('not set up');
    expect(ctx.warnings.join(' ')).toContain('inactive');
  });

  it('a plugin whose init throws is logged and skipped, others still load', async () => {
    const bad: ToolPlugin = {
      id: 'bad',
      displayName: 'Bad',
      init: async () => {
        throw new Error('init exploded');
      }
    };
    const good: ToolPlugin = {
      id: 'good',
      displayName: 'Good',
      init: async () => ({ tools: [echoTool] })
    };
    const ctx = fakeCtx();
    const tools = await loadPlugins(() => ctx, [bad, good]);
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(ctx.errors.join(' ')).toContain('init exploded');
  });
});

describe('disposePlugins (A4)', () => {
  it('calls dispose on every plugin and swallows individual failures', async () => {
    const disposed: string[] = [];
    const a: ToolPlugin = {
      id: 'a',
      displayName: 'A',
      init: async () => ({ tools: [] }),
      dispose: () => {
        disposed.push('a');
      }
    };
    const bad: ToolPlugin = {
      id: 'bad',
      displayName: 'Bad',
      init: async () => ({ tools: [] }),
      dispose: async () => {
        disposed.push('bad');
        throw new Error('dispose exploded');
      }
    };
    const noDispose: ToolPlugin = { id: 'n', displayName: 'N', init: async () => ({ tools: [] }) };
    const b: ToolPlugin = {
      id: 'b',
      displayName: 'B',
      init: async () => ({ tools: [] }),
      dispose: async () => {
        disposed.push('b');
      }
    };
    await expect(disposePlugins([a, bad, noDispose, b])).resolves.toBeUndefined();
    expect(disposed).toEqual(['a', 'bad', 'b']);
  });
});

describe('pluginManifests', () => {
  it('reflects declared settings, defaulting to []', () => {
    const withSettings: ToolPlugin = {
      id: 'smarthome',
      displayName: 'Smart Home',
      settings: [
        { key: 'baseUrl', label: 'Home Assistant URL', kind: 'text' },
        { key: 'token', label: 'Access token', kind: 'secret' }
      ],
      init: async () => ({ tools: [] })
    };
    const without: ToolPlugin = { id: 'plain', displayName: 'Plain', init: async () => ({ tools: [] }) };
    expect(pluginManifests([withSettings, without])).toEqual([
      {
        id: 'smarthome',
        displayName: 'Smart Home',
        settings: [
          { key: 'baseUrl', label: 'Home Assistant URL', kind: 'text' },
          { key: 'token', label: 'Access token', kind: 'secret' }
        ]
      },
      { id: 'plain', displayName: 'Plain', settings: [] }
    ]);
  });

  it('the shipped registry contains system, web, and google (system declares allowUnsafePaths)', () => {
    expect(PLUGINS.map((p) => p.id)).toEqual(['system', 'web', 'google']);
    const manifest = pluginManifests();
    expect(manifest.map((m) => m.id)).toEqual(['system', 'web', 'google']);
    const system = manifest.find((m) => m.id === 'system')!;
    expect(system.settings.map((s) => s.key)).toContain('allowUnsafePaths');
    expect(system.settings.find((s) => s.key === 'allowUnsafePaths')!.kind).toBe('toggle');
  });
});
