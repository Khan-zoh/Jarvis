import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
// `safeStorage` is only dereferenced by the default (production) codec; tests inject a fake codec
// so this import is never touched in a headless run.
import { safeStorage } from 'electron';
import { DEFAULT_APP_CONFIG, type AppConfig } from '../shared/types';

/**
 * The subset of Electron's `safeStorage` that ConfigStore relies on. Injecting it via the
 * constructor lets tests run headless with a fake base64 codec instead of real Windows DPAPI.
 */
export interface SafeStorageCodec {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * The two secret values that never touch `config.json` in plaintext. Each maps a secret key (as
 * used by the `secret:set` IPC channel) to its location inside AppConfig.
 */
type SecretKey = 'googleClientSecret';

interface SecretSlot {
  read(c: AppConfig): string;
  write(c: AppConfig, value: string): void;
}

const SECRET_SLOTS: Record<SecretKey, SecretSlot> = {
  googleClientSecret: {
    read: (c) => c.google.clientSecret,
    write: (c, v) => {
      c.google.clientSecret = v;
    }
  }
};

const SECRET_KEYS = Object.keys(SECRET_SLOTS) as SecretKey[];

/** The factory default. Moved to shared/types.ts (settings-ui: the renderer needs it for
 * first-run detection); re-exported here so existing main-process imports keep working. */
export const DEFAULT_CONFIG: AppConfig = DEFAULT_APP_CONFIG;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively deep-merges `patch` onto `base`, returning a fresh object. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = deepMerge(current, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Owns `AppConfig` persistence: a JSON file for non-secret fields plus a sibling `secrets.bin`
 * whose contents are encrypted with `safeStorage`. `config.json` never contains secret plaintext.
 */
export class ConfigStore {
  private readonly configPath: string;
  private readonly secretsPath: string;
  private readonly codec: SafeStorageCodec;
  private readonly emitter = new EventEmitter();
  private config: AppConfig;

  /**
   * @param userDataDir directory (usually `app.getPath('userData')`) holding config + secrets.
   * @param codec       safeStorage codec; defaults to Electron's real `safeStorage`. Tests inject
   *                    a fake base64 codec so no DPAPI is required.
   */
  constructor(userDataDir: string, codec?: SafeStorageCodec) {
    this.configPath = join(userDataDir, 'config.json');
    this.secretsPath = join(userDataDir, 'secrets.bin');
    this.codec = codec ?? createElectronCodec();
    if (!existsSync(userDataDir)) {
      mkdirSync(userDataDir, { recursive: true });
    }
    this.config = this.load();
  }

  /** Full config with secrets decrypted. Main-process only. */
  get(): AppConfig {
    return clone(this.config);
  }

  /** Config with secret fields masked: `'•set'` when a secret is present, `''` when empty. */
  getRedacted(): AppConfig {
    const redacted = clone(this.config);
    for (const key of SECRET_KEYS) {
      const slot = SECRET_SLOTS[key];
      slot.write(redacted, slot.read(this.config) ? '•set' : '');
    }
    return redacted;
  }

  /** Deep-merges `patch`, persists, and emits `'changed'` with the redacted config. */
  set(patch: Partial<AppConfig>): void {
    this.config = deepMerge(this.config, patch);
    this.persist();
    this.emitChanged();
  }

  /** Encrypts and persists a single secret, then emits `'changed'`. */
  setSecret(key: string, value: string): void {
    if (!(key in SECRET_SLOTS)) {
      throw new Error(`Unknown secret key: ${key}`);
    }
    SECRET_SLOTS[key as SecretKey].write(this.config, value);
    this.persist();
    this.emitChanged();
  }

  on(event: 'changed', fn: (c: AppConfig) => void): void {
    this.emitter.on(event, fn);
  }

  private emitChanged(): void {
    this.emitter.emit('changed', this.getRedacted());
  }

  private load(): AppConfig {
    let merged = clone(DEFAULT_CONFIG);
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, 'utf-8')) as unknown;
        merged = deepMerge(merged, parsed);
      } catch {
        // Corrupt config file: fall back to defaults rather than crash.
      }
    }
    // v0.1 private-beta migration: Porcupine was replaced by native openWakeWord. Remove its
    // obsolete key/keyword fields so old profiles become structurally identical to new ones and
    // a later persist also drops them from config.json.
    const legacyVoice = merged.voice as AppConfig['voice'] & Record<string, unknown>;
    delete legacyVoice.picovoiceAccessKey;
    delete legacyVoice.builtinKeyword;
    delete legacyVoice.customKeywordPath;
    // config.json must never hold secret plaintext; force secrets empty before overlaying.
    for (const key of SECRET_KEYS) {
      SECRET_SLOTS[key].write(merged, '');
    }
    const secrets = this.readSecrets();
    for (const key of SECRET_KEYS) {
      const value = secrets[key];
      if (typeof value === 'string' && value) {
        SECRET_SLOTS[key].write(merged, value);
      }
    }
    return merged;
  }

  private readSecrets(): Partial<Record<SecretKey, string>> {
    if (!existsSync(this.secretsPath)) return {};
    try {
      const encrypted = readFileSync(this.secretsPath);
      if (encrypted.length === 0) return {};
      const json = this.codec.decryptString(encrypted);
      return JSON.parse(json) as Partial<Record<SecretKey, string>>;
    } catch {
      return {};
    }
  }

  private persist(): void {
    // Strip secrets out of the on-disk config so plaintext never lands in config.json.
    const onDisk = clone(this.config);
    for (const key of SECRET_KEYS) {
      SECRET_SLOTS[key].write(onDisk, '');
    }
    writeFileSync(this.configPath, JSON.stringify(onDisk, null, 2), 'utf-8');

    const secrets: Record<string, string> = {};
    for (const key of SECRET_KEYS) {
      const value = SECRET_SLOTS[key].read(this.config);
      if (value) secrets[key] = value;
    }
    const plaintext = JSON.stringify(secrets);
    const encrypted = this.codec.encryptString(plaintext);
    writeFileSync(this.secretsPath, encrypted);
  }
}

/** Wraps Electron's real `safeStorage`. Only used when no codec is injected (production). */
function createElectronCodec(): SafeStorageCodec {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText: string) => safeStorage.encryptString(plainText),
    decryptString: (encrypted: Buffer) => safeStorage.decryptString(encrypted)
  };
}
