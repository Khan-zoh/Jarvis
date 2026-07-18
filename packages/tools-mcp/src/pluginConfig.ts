import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext } from './plugin.js';

/**
 * Per-plugin config + secret storage (binding — see cdd/plan/tools-and-google.md).
 *
 * - `JARVIS_DATA_DIR/plugins/<id>.json`    — non-secret config, plain JSON, written by the app.
 * - `JARVIS_DATA_DIR/plugins/<id>.secrets` — a base64 Windows-DPAPI (CurrentUser) blob whose
 *   plaintext is a JSON `Record<string, string>`. Written by the app; decrypted here on demand.
 *
 * This file also hosts the PowerShell-DPAPI token codec (`dpapiEncrypt`/`dpapiDecrypt`) that the
 * google-auth task reuses for `google-token.json` — implemented here because google-auth has not
 * landed yet (per tools-mcp-core task notes).
 */

/** Synchronous PowerShell runner seam (injectable for tests). Returns stdout; throws on failure. */
export type SyncPsRunner = (script: string, extraEnv?: Record<string, string>) => string;

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

export const defaultSyncPs: SyncPsRunner = (script, extraEnv) => {
  const res = spawnSync('powershell.exe', [...PS_ARGS, script], {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true
  });
  if (res.error) throw new Error(`powershell failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = (res.stderr ?? '').trim() || `exit code ${res.status}`;
    throw new Error(`powershell failed: ${detail.slice(0, 500)}`);
  }
  return res.stdout ?? '';
};

// The payload travels via an environment variable (never interpolated into the script) and is
// base64 on BOTH sides of the process boundary: Windows PowerShell 5.1 writes stdout in the
// console codepage, which mangles non-ASCII text, so only ASCII-safe base64 ever crosses it.
const ENCRYPT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$plain = [Convert]::FromBase64String($env:JARVIS_DPAPI_IN);',
  '$blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($blob))'
].join(' ');

const DECRYPT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$blob = [Convert]::FromBase64String($env:JARVIS_DPAPI_IN);',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))'
].join(' ');

/** Encrypts UTF-8 text with Windows DPAPI (CurrentUser scope). Returns a base64 blob. */
export function dpapiEncrypt(plain: string, runPs: SyncPsRunner = defaultSyncPs): string {
  const inB64 = Buffer.from(plain, 'utf8').toString('base64');
  return runPs(ENCRYPT_SCRIPT, { JARVIS_DPAPI_IN: inB64 }).trim();
}

/** Decrypts a base64 DPAPI blob produced by `dpapiEncrypt` back to UTF-8 text. */
export function dpapiDecrypt(blobBase64: string, runPs: SyncPsRunner = defaultSyncPs): string {
  const outB64 = runPs(DECRYPT_SCRIPT, { JARVIS_DPAPI_IN: blobBase64.trim() }).trim();
  return Buffer.from(outB64, 'base64').toString('utf8');
}

/** Reads `JARVIS_DATA_DIR/plugins/<id>.json`. Missing or malformed file → `{}`. */
export function readPluginConfig(dataDir: string, id: string): Record<string, unknown> {
  const file = join(dataDir, 'plugins', `${id}.json`);
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Reads + DPAPI-decrypts `JARVIS_DATA_DIR/plugins/<id>.secrets`. Missing file → `{}`. */
export function readPluginSecrets(
  dataDir: string,
  id: string,
  runPs: SyncPsRunner = defaultSyncPs
): Record<string, string> {
  const file = join(dataDir, 'plugins', `${id}.secrets`);
  if (!existsSync(file)) return {};
  const blob = readFileSync(file, 'utf8');
  const parsed: unknown = JSON.parse(dpapiDecrypt(blob, runPs));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Atomically writes `data` to `file` (temp file in the same directory, then rename — amendments.md
 * "Session/config writes: atomic temp+rename"). Creates the parent directory if needed.
 */
function atomicWrite(file: string, data: string | Buffer): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * Merges `patch` into `JARVIS_DATA_DIR/plugins/<id>.json` and writes it atomically. Non-secret
 * config only — never call with a secret-kind value (use `writePluginSecret` instead).
 */
export function writePluginConfig(dataDir: string, id: string, patch: Record<string, unknown>): void {
  const current = readPluginConfig(dataDir, id);
  const merged = { ...current, ...patch };
  atomicWrite(join(dataDir, 'plugins', `${id}.json`), JSON.stringify(merged, null, 2));
}

/**
 * Merges a single `key`/`value` into `JARVIS_DATA_DIR/plugins/<id>.secrets`, re-encrypting the
 * whole per-plugin secret map with DPAPI and writing it atomically. Reuses the same codec
 * `readPluginSecrets` decrypts with.
 */
export function writePluginSecret(
  dataDir: string,
  id: string,
  key: string,
  value: string,
  runPs: SyncPsRunner = defaultSyncPs
): void {
  const current = readPluginSecrets(dataDir, id, runPs);
  const merged = { ...current, [key]: value };
  const blob = dpapiEncrypt(JSON.stringify(merged), runPs);
  atomicWrite(join(dataDir, 'plugins', `${id}.secrets`), blob);
}

export interface PluginLogger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

/**
 * Builds the scoped `PluginContext` handed to a plugin's `init`. Secrets are decrypted lazily on
 * the first `secret()` call (one PowerShell round-trip), then cached for the process lifetime.
 */
export function createPluginContext(
  dataDir: string,
  id: string,
  logger: PluginLogger,
  runPs: SyncPsRunner = defaultSyncPs
): PluginContext {
  let secrets: Record<string, string> | null = null;
  return {
    dataDir,
    config: readPluginConfig(dataDir, id),
    secret(key: string): string | null {
      if (secrets === null) {
        try {
          secrets = readPluginSecrets(dataDir, id, runPs);
        } catch (err) {
          logger.error(
            `plugin ${id}: failed to read secrets: ${err instanceof Error ? err.message : String(err)}`
          );
          secrets = {};
        }
      }
      return secrets[key] ?? null;
    },
    logger: {
      info: (m) => logger.info(`[${id}] ${m}`),
      warn: (m) => logger.warn(`[${id}] ${m}`),
      error: (m) => logger.error(`[${id}] ${m}`)
    }
  };
}
