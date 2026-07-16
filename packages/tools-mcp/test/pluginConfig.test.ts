import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPluginContext,
  dpapiDecrypt,
  dpapiEncrypt,
  readPluginConfig,
  readPluginSecrets,
  type SyncPsRunner
} from '../src/pluginConfig.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Fake DPAPI honoring the codec's contract: input arrives base64 in JARVIS_DPAPI_IN and output
 * is base64 on stdout. "Encryption" reverses the string so blobs never equal the plaintext.
 */
const fakePs: SyncPsRunner = (script, extraEnv) => {
  const input = extraEnv?.JARVIS_DPAPI_IN ?? '';
  if (script.includes('::Protect(')) return `ENC.${input}`;
  if (script.includes('::Unprotect(')) return input.replace(/^ENC\./, '');
  throw new Error(`unexpected script: ${script}`);
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-pluginconfig-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readPluginConfig', () => {
  it('reads the plugin json slice', () => {
    writeFileSync(join(dir, 'plugins', 'web.json'), JSON.stringify({ maxResults: 7 }));
    expect(readPluginConfig(dir, 'web')).toEqual({ maxResults: 7 });
  });

  it('missing or malformed files yield {}', () => {
    expect(readPluginConfig(dir, 'nope')).toEqual({});
    writeFileSync(join(dir, 'plugins', 'bad.json'), '{not json');
    expect(readPluginConfig(dir, 'bad')).toEqual({});
    writeFileSync(join(dir, 'plugins', 'arr.json'), '[1,2]');
    expect(readPluginConfig(dir, 'arr')).toEqual({});
  });
});

describe('secrets via injected codec seam', () => {
  it('round-trips and scopes secrets per plugin', () => {
    const blob = dpapiEncrypt(JSON.stringify({ token: 'shh' }), fakePs);
    expect(blob).not.toContain('shh'); // written blob never holds plaintext
    writeFileSync(join(dir, 'plugins', 'smarthome.secrets'), blob);
    expect(readPluginSecrets(dir, 'smarthome', fakePs)).toEqual({ token: 'shh' });

    const ctx = createPluginContext(dir, 'smarthome', silentLogger, fakePs);
    expect(ctx.secret('token')).toBe('shh');
    expect(ctx.secret('other')).toBeNull();

    const otherCtx = createPluginContext(dir, 'web', silentLogger, fakePs);
    expect(otherCtx.secret('token')).toBeNull(); // no cross-plugin leakage
  });

  it('context carries dataDir, config slice, and a prefixed logger', () => {
    writeFileSync(join(dir, 'plugins', 'demo.json'), JSON.stringify({ a: 1 }));
    const warnings: string[] = [];
    const ctx = createPluginContext(
      dir,
      'demo',
      { ...silentLogger, warn: (m) => warnings.push(m) },
      fakePs
    );
    expect(ctx.dataDir).toBe(dir);
    expect(ctx.config).toEqual({ a: 1 });
    ctx.logger.warn('hi');
    expect(warnings).toEqual(['[demo] hi']);
  });
});

// Real Windows DPAPI through PowerShell — this is the codec google-auth reuses.
describe('dpapi codec (real PowerShell)', () => {
  it('encrypts and decrypts UTF-8 text with quotes, newlines, and unicode', () => {
    const plain = 'line1\nline2 "quoted" \'single\' — émoji ✓ $env:PATH';
    const blob = dpapiEncrypt(plain);
    expect(blob).not.toContain('line1'); // actually encrypted, not passthrough
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(dpapiDecrypt(blob)).toBe(plain);
  }, 30_000);
});
