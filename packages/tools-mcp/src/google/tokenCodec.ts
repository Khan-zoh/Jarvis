import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultSyncPs, dpapiDecrypt, dpapiEncrypt, type SyncPsRunner } from '../pluginConfig.js';

/**
 * Encrypted Google-token persistence for the google-auth plugin.
 *
 * The token file lives at `JARVIS_DATA_DIR/google/token.json` and is a base64 Windows-DPAPI
 * (CurrentUser) blob whose plaintext is a JSON `StoredAuth`. The refresh_token — the only durable
 * secret — therefore NEVER touches disk in plaintext (asserted in tests). Both the app (which runs
 * the OAuth flow) and the disposable MCP worker (which only reads) use this one mechanism, reusing
 * the PowerShell-DPAPI codec that already ships in `pluginConfig.ts`.
 *
 * Single-writer safety (amendments.md §A3): every mutation goes through `withTokenLock` (an
 * exclusive-create lock file) and re-reads the current file under the lock before writing, and
 * writes are atomic (temp + rename). A concurrent refresh that already won is thus preserved, not
 * clobbered.
 */

/** A synchronous string cipher: base64 blob out of `encrypt`, plaintext back from `decrypt`.
 *  Real impl = Windows DPAPI via PowerShell; headless tests inject a fake. */
export interface TokenCipher {
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

/** The production cipher: Windows DPAPI (CurrentUser) through the shared pluginConfig codec. */
export function dpapiTokenCipher(runPs: SyncPsRunner = defaultSyncPs): TokenCipher {
  return {
    encrypt: (plain) => dpapiEncrypt(plain, runPs),
    decrypt: (blob) => dpapiDecrypt(blob, runPs)
  };
}

/**
 * Decrypted contents of the token file. `clientId`/`clientSecret` are stored alongside the tokens
 * so the disposable MCP worker is self-sufficient: it can rebuild a refreshable OAuth2 client from
 * this one encrypted file with no other input. `tokens` is a google-auth-library `Credentials`
 * object (kept loose here to avoid a direct dependency on that package's types).
 */
export interface StoredAuth {
  clientId: string;
  clientSecret: string;
  email: string;
  tokens: Record<string, unknown>;
}

export interface TokenPaths {
  dir: string;
  file: string;
  lock: string;
}

/** Resolves the `google/` sub-tree paths under a JARVIS data dir. */
export function tokenPaths(dataDir: string): TokenPaths {
  const dir = join(dataDir, 'google');
  return { dir, file: join(dir, 'token.json'), lock: join(dir, 'token.lock') };
}

/** Reads + decrypts the token file. Missing/malformed/undecryptable → `null`. */
export function readStoredAuth(dataDir: string, cipher: TokenCipher): StoredAuth | null {
  const { file } = tokenPaths(dataDir);
  if (!existsSync(file)) return null;
  try {
    const blob = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(cipher.decrypt(blob));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as StoredAuth;
  } catch {
    return null;
  }
}

/** Encrypts and atomically (temp + rename) writes the token file. */
export function writeStoredAuth(dataDir: string, auth: StoredAuth, cipher: TokenCipher): void {
  const { dir, file } = tokenPaths(dataDir);
  mkdirSync(dir, { recursive: true });
  const blob = cipher.encrypt(JSON.stringify(auth));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, blob, 'utf8');
  renameSync(tmp, file);
}

/**
 * Deletes the token file. Idempotent. Deliberately does NOT touch the lock file (B6): the lock's
 * lifecycle belongs to `withTokenLock`, which creates and removes it in its own `finally`. Deleting
 * a live lock from here — this runs while `disconnect` still holds it — would let another writer
 * create a fresh lock and overlap the holder.
 */
export function deleteStoredAuth(dataDir: string): void {
  const { file } = tokenPaths(dataDir);
  rmSync(file, { force: true });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` while holding a cross-process single-writer lock on the token file (§A3). The lock is
 * an exclusive-create lock file; contenders retry with backoff, and a lock older than `staleMs`
 * (e.g. a crashed writer) is broken. Always released in `finally`.
 */
export async function withTokenLock<T>(
  dataDir: string,
  fn: () => T | Promise<T>,
  opts: { retries?: number; delayMs?: number; staleMs?: number } = {}
): Promise<T> {
  const { lock } = tokenPaths(dataDir);
  mkdirSync(dirname(lock), { recursive: true });
  const retries = opts.retries ?? 100;
  const delayMs = opts.delayMs ?? 20;
  // B6: must exceed the longest single locked operation. The DPAPI PowerShell codec times out at
  // 20s (pluginConfig.defaultSyncPs), so a valid writer can legitimately hold the lock ~20s; a
  // threshold below that would let a contender break a live lock and corrupt a write. 30s clears it.
  const staleMs = opts.staleMs ?? 30_000;

  let fd: number | null = null;
  for (let attempt = 0; attempt < retries && fd === null; attempt++) {
    try {
      fd = openSync(lock, 'wx'); // exclusive create; throws EEXIST if held
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { force: true }); // break a stale lock, then retry immediately
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      await sleep(delayMs);
    }
  }
  if (fd === null) throw new Error('google token lock: timed out acquiring lock');

  try {
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
