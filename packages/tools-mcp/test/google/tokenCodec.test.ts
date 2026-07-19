import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

describe('lock lifecycle stays with withTokenLock (B6)', () => {
  it('deleteStoredAuth removes the token file but never the lock file', () => {
    writeStoredAuth(dir, sampleAuth, fakeCipher);
    const { lock } = tokenPaths(dir);
    writeFileSync(lock, ''); // simulate a writer currently holding the lock
    deleteStoredAuth(dir);
    expect(readStoredAuth(dir, fakeCipher)).toBeNull(); // token file gone
    expect(existsSync(lock)).toBe(true); // live lock untouched — holder still exclusive
  });

  it('holding the lock across a delete keeps contenders out until release', async () => {
    writeStoredAuth(dir, sampleAuth, fakeCipher);
    let release!: () => void;
    const held = withTokenLock(dir, async () => {
      deleteStoredAuth(dir); // in-lock delete (what disconnect does) must not free the lock
      await new Promise<void>((r) => (release = r));
    });
    // While the deleting writer still holds the lock, a contender must NOT get in.
    await expect(
      withTokenLock(dir, () => {}, { retries: 3, delayMs: 5, staleMs: 60_000 })
    ).rejects.toThrow(/timed out/);
    release();
    await held;
    // After release, the lock is acquirable again.
    await expect(withTokenLock(dir, () => 'ok')).resolves.toBe('ok');
  });
});

describe('stale-lock threshold (B6)', () => {
  const ageLock = (ageMs: number): string => {
    writeStoredAuth(dir, sampleAuth, fakeCipher); // ensures google/ dir exists
    const { lock } = tokenPaths(dir);
    writeFileSync(lock, '');
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(lock, t, t);
    return lock;
  };

  it('does NOT break a lock younger than 30s — covers the 20s DPAPI ceiling', async () => {
    // A writer legitimately inside a 20s DPAPI PowerShell call must not be broken as stale.
    ageLock(21_000);
    await expect(withTokenLock(dir, () => {}, { retries: 3, delayMs: 5 })).rejects.toThrow(
      /timed out/
    );
  });

  it('breaks a lock older than the 30s default threshold', async () => {
    const lock = ageLock(31_000);
    await expect(withTokenLock(dir, () => 'ran', { retries: 3, delayMs: 5 })).resolves.toBe('ran');
    expect(existsSync(lock)).toBe(false); // broken, used, and released
  });
});
