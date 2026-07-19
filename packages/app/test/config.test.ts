import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// config.ts imports `safeStorage` from electron (only used by the production codec). Stub the
// electron module so the real binary shim never loads in headless CI.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, DEFAULT_CONFIG, type SafeStorageCodec } from '../src/main/config';

// A headless stand-in for Electron safeStorage: base64 "encryption". It never stores plaintext
// verbatim, which is exactly what the on-disk assertions check.
const fakeCodec: SafeStorageCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf-8').toString('base64'), 'utf-8'),
  decryptString: (buf) => Buffer.from(buf.toString('utf-8'), 'base64').toString('utf-8')
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('defaults match the DEFAULT_CONFIG contract', () => {
    const store = new ConfigStore(dir, fakeCodec);
    const c = store.get();
    expect(c.agentName).toBe('Jarvis');
    expect(c.voice.sensitivity).toBe(0.6);
    expect(c.voice.listenTimeoutMs).toBe(8000);
    expect(c.agents.defaultBackend).toBe('claude');
    expect(c.ui.hotkey).toBe('Ctrl+Shift+Space');
    expect(c.ui.launchOnStartup).toBe(false);
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  it('persists and round-trips through a fresh instance', () => {
    const a = new ConfigStore(dir, fakeCodec);
    a.set({ agentName: 'Friday', voice: { sensitivity: 0.9 } as never });
    const b = new ConfigStore(dir, fakeCodec);
    expect(b.get().agentName).toBe('Friday');
    expect(b.get().voice.sensitivity).toBe(0.9);
    // untouched siblings survive the deep-merge
    expect(b.get().voice.listenTimeoutMs).toBe(8000);
    expect(b.get().ui.hotkey).toBe('Ctrl+Shift+Space');
  });

  it('deep-merges nested patches without clobbering siblings', () => {
    const store = new ConfigStore(dir, fakeCodec);
    store.set({ agents: { codex: { model: 'o1' } } as never });
    expect(store.get().agents.codex.model).toBe('o1');
    expect(store.get().agents.defaultBackend).toBe('claude');
    expect(store.get().agents.claude.systemPromptExtra).toBe('');
  });

  it('drops obsolete Porcupine fields when upgrading an existing profile', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        voice: {
          picovoiceAccessKey: '',
          builtinKeyword: 'jarvis',
          customKeywordPath: 'C:/old.ppn',
          sensitivity: 0.8
        }
      })
    );
    const voice = new ConfigStore(dir, fakeCodec).get().voice as unknown as Record<string, unknown>;
    expect(voice.sensitivity).toBe(0.8);
    expect(voice.picovoiceAccessKey).toBeUndefined();
    expect(voice.builtinKeyword).toBeUndefined();
    expect(voice.customKeywordPath).toBeUndefined();
  });

  it('emits a redacted config on change', () => {
    const store = new ConfigStore(dir, fakeCodec);
    store.setSecret('googleClientSecret', 'SEED');
    let seen: string | undefined;
    store.on('changed', (c) => {
      seen = c.google.clientSecret;
    });
    store.set({ agentName: 'Edith' });
    expect(seen).toBe('•set');
  });

  it('never writes secret plaintext to config.json or secrets.bin', () => {
    const store = new ConfigStore(dir, fakeCodec);
    const googleSecret = 'google-oauth-CLIENT-SECRET-abcd';
    store.setSecret('googleClientSecret', googleSecret);

    const configText = readFileSync(join(dir, 'config.json'), 'utf-8');
    expect(configText).not.toContain(googleSecret);

    expect(existsSync(join(dir, 'secrets.bin'))).toBe(true);
    const secretsRaw = readFileSync(join(dir, 'secrets.bin'), 'utf-8');
    expect(secretsRaw).not.toContain(googleSecret);

    // But an in-process read decrypts them, and a fresh instance recovers them.
    const reopened = new ConfigStore(dir, fakeCodec);
    expect(reopened.get().google.clientSecret).toBe(googleSecret);
  });

  it('getRedacted masks set secrets as •set and empty ones as ""', () => {
    const store = new ConfigStore(dir, fakeCodec);
    expect(store.getRedacted().google.clientSecret).toBe('');
    store.setSecret('googleClientSecret', 'x');
    expect(store.getRedacted().google.clientSecret).toBe('•set');
    // getRedacted must not leak the real value
    expect(store.getRedacted().google.clientSecret).not.toBe('x');
  });

  it('rejects unknown secret keys', () => {
    const store = new ConfigStore(dir, fakeCodec);
    expect(() => store.setSecret('nope', 'v')).toThrow();
  });
});
