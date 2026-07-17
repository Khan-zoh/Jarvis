import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteStoredAuth,
  readStoredAuth,
  tokenPaths,
  withTokenLock,
  writeStoredAuth,
  type StoredAuth,
  type TokenCipher
} from '../../src/google/tokenCodec.js';

/**
 * Fake cipher seam (headless): base64 hides literal substrings so we can assert no plaintext
 * refresh_token reaches disk, while round-tripping exactly.
 */
const fakeCipher: TokenCipher = {
  encrypt: (plain) => `B64.${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (blob) => Buffer.from(blob.replace(/^B64\./, ''), 'base64').toString('utf8')
};

const sampleAuth: StoredAuth = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'super-secret-value',
  email: 'user@example.com',
  tokens: { access_token: 'at-123', refresh_token: 'rt-TOP-SECRET', expiry_date: 1_700_000_000_000 }
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-tokencodec-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('token file round-trip', () => {
  it('writes under google/token.json and reads back identically', () => {
    writeStoredAuth(dir, sampleAuth, fakeCipher);
    expect(readStoredAuth(dir, fakeCipher)).toEqual(sampleAuth);
    expect(tokenPaths(dir).file).toBe(join(dir, 'google', 'token.json'));
  });

  it('never persists the refresh_token (or client secret) as plaintext on disk', () => {
    writeStoredAuth(dir, sampleAuth, fakeCipher);
    const raw = readFileSync(tokenPaths(dir).file, 'utf8');
    expect(raw).not.toContain('rt-TOP-SECRET');
    expect(raw).not.toContain('super-secret-value');
    expect(raw).not.toContain('refresh_token');
  });

  it('missing/corrupt file yields null and delete is idempotent', () => {
    expect(readStoredAuth(dir, fakeCipher)).toBeNull();
    writeStoredAuth(dir, sampleAuth, fakeCipher);
    deleteStoredAuth(dir);
    expect(readStoredAuth(dir, fakeCipher)).toBeNull();
    deleteStoredAuth(dir); // no throw on second delete
  });
});

describe('withTokenLock — single-writer safety (§A3)', () => {
  it('serializes concurrent writers so neither read-modify-write is lost', async () => {
    writeStoredAuth(dir, { ...sampleAuth, tokens: { counter: 0 } }, fakeCipher);

    // 20 concurrent increment-under-lock operations. Without the lock, the classic
    // read-modify-write race would drop updates and the final counter would be < 20.
    const bump = (): Promise<void> =>
      withTokenLock(dir, () => {
        const current = readStoredAuth(dir, fakeCipher);
        const n = (current?.tokens.counter as number) ?? 0;
        writeStoredAuth(dir, { ...sampleAuth, tokens: { counter: n + 1 } }, fakeCipher);
      });

    await Promise.all(Array.from({ length: 20 }, bump));
    expect(readStoredAuth(dir, fakeCipher)?.tokens.counter).toBe(20);
  });

  it('times out rather than hanging when the lock is wedged', async () => {
    // Hold the lock indefinitely, then a contender with tiny retries must reject.
    let release!: () => void;
    const held = withTokenLock(dir, () => new Promise<void>((r) => (release = r)));
    await expect(
      withTokenLock(dir, () => {}, { retries: 3, delayMs: 5, staleMs: 60_000 })
    ).rejects.toThrow(/timed out/);
    release();
    await held;
  });
});
