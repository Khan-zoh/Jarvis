import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGoogleAuthManager,
  GOOGLE_SCOPES,
  OAUTH_REDIRECT_PATH,
  startHttpLoopback,
  type AuthUrlOpts,
  type GetTokenArg,
  type GoogleAuthDeps,
  type GoogleClients,
  type LoopbackOptions,
  type LoopbackServer,
  type OAuth2ClientLike
} from '../../src/google/auth.js';
import { readStoredAuth, tokenPaths, type TokenCipher } from '../../src/google/tokenCodec.js';

const fakeCipher: TokenCipher = {
  encrypt: (plain) => `B64.${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (blob) => Buffer.from(blob.replace(/^B64\./, ''), 'base64').toString('utf8')
};

type Tokens = Record<string, unknown>;

/** A scriptable OAuth2Client stand-in that records what it was asked to do. */
class FakeClient implements OAuth2ClientLike {
  credentials: Tokens = {};
  redirectUri: string;
  lastAuthOpts: AuthUrlOpts | null = null;
  exchangedCode: string | null = null;
  exchangedVerifier: string | null = null;
  revoked = false;
  private listeners: ((t: Tokens) => void)[] = [];

  constructor(
    public clientId: string,
    public clientSecret: string,
    redirectUri: string,
    private readonly tokenFor: (code: string) => Tokens
  ) {
    this.redirectUri = redirectUri;
  }

  generateAuthUrl(opts: AuthUrlOpts): string {
    this.lastAuthOpts = opts;
    const q = new URLSearchParams({
      redirect_uri: this.redirectUri,
      scope: opts.scope.join(' ')
    });
    if (opts.state) q.set('state', opts.state);
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  }
  async getToken(arg: GetTokenArg): Promise<{ tokens: Tokens }> {
    const code = typeof arg === 'string' ? arg : arg.code;
    this.exchangedCode = code;
    this.exchangedVerifier = typeof arg === 'string' ? null : (arg.codeVerifier ?? null);
    return { tokens: this.tokenFor(code) };
  }
  setCredentials(t: Tokens): void {
    this.credentials = t;
  }
  on(_event: 'tokens', listener: (t: Tokens) => void): void {
    this.listeners.push(listener);
  }
  emitTokens(t: Tokens): void {
    for (const l of this.listeners) l(t);
  }
  async revokeCredentials(): Promise<unknown> {
    this.revoked = true;
    return {};
  }
}

/** Builds deps with recording seams; `created` collects every FakeClient the manager makes. */
function makeDeps(dir: string, overrides: Partial<GoogleAuthDeps> = {}) {
  const created: FakeClient[] = [];
  const openedUrls: string[] = [];
  const loopbackOpts: LoopbackOptions[] = [];
  const deps: GoogleAuthDeps = {
    dataDir: dir,
    cipher: fakeCipher,
    openBrowser: (url) => {
      openedUrls.push(url);
    },
    createOAuth2Client: (clientId, clientSecret, redirectUri) => {
      const c = new FakeClient(clientId, clientSecret, redirectUri, (code) => ({
        access_token: `at-${code}`,
        refresh_token: `rt-${code}`,
        expiry_date: 1_700_000_000_000
      }));
      created.push(c);
      return c;
    },
    startLoopback: async (opts): Promise<LoopbackServer> => {
      loopbackOpts.push(opts);
      return {
        port: 54321,
        waitForCode: async () => 'auth-code-1',
        close: () => {}
      };
    },
    fetchEmail: async () => 'me@example.com',
    makeClients: (client) => ({ __client: client }) as unknown as GoogleClients,
    ...overrides
  };
  return { deps, created, openedUrls, loopbackOpts };
}

const waitFor = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-google-auth-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('beginAuthFlow', () => {
  it('builds the consent URL with the narrow scopes + loopback port, exchanges the code, and persists', async () => {
    const { deps, created, openedUrls } = makeDeps(dir);
    const mgr = createGoogleAuthManager(deps);

    const { email } = await mgr.beginAuthFlow('cid', 'secret');
    expect(email).toBe('me@example.com');

    const client = created[0]!;
    // Auth URL: right scopes, offline access + forced consent, loopback redirect on the random port.
    expect(client.lastAuthOpts?.scope).toEqual([...GOOGLE_SCOPES]);
    expect(client.lastAuthOpts?.access_type).toBe('offline');
    expect(client.lastAuthOpts?.prompt).toBe('consent');
    expect(client.redirectUri).toBe('http://127.0.0.1:54321');
    expect(openedUrls[0]).toContain('http%3A%2F%2F127.0.0.1%3A54321');
    expect(client.exchangedCode).toBe('auth-code-1');

    // Persisted + decryptable, and status() reads it back with no network.
    const stored = readStoredAuth(dir, fakeCipher);
    expect(stored?.email).toBe('me@example.com');
    expect(stored?.tokens.refresh_token).toBe('rt-auth-code-1');
    expect(mgr.status()).toEqual({ connected: true, email: 'me@example.com' });
  });

  it('persists no plaintext refresh_token to disk', async () => {
    const { deps } = makeDeps(dir);
    await createGoogleAuthManager(deps).beginAuthFlow('cid', 'secret');
    const raw = readFileSync(tokenPaths(dir).file, 'utf8');
    expect(raw).not.toContain('rt-auth-code-1');
    expect(raw).not.toContain('secret');
  });
});

describe('status / getClients when disconnected', () => {
  it('reports disconnected and returns null clients', () => {
    const { deps } = makeDeps(dir);
    const mgr = createGoogleAuthManager(deps);
    expect(mgr.status()).toEqual({ connected: false, email: null });
    expect(mgr.getClients()).toBeNull();
  });
});

describe('getClients', () => {
  it('rebuilds a client from the persisted file with the stored id/secret + tokens', async () => {
    const { deps, created } = makeDeps(dir);
    const mgr = createGoogleAuthManager(deps);
    await mgr.beginAuthFlow('cid', 'secret');

    const clients = mgr.getClients();
    expect(clients).not.toBeNull();
    const rebuilt = created[created.length - 1]!;
    expect(rebuilt.clientId).toBe('cid');
    expect(rebuilt.clientSecret).toBe('secret');
    expect(rebuilt.credentials.refresh_token).toBe('rt-auth-code-1');
  });
});

describe('refresh event re-persists (§A3)', () => {
  it('overlays new access token while preserving the refresh_token', async () => {
    const { deps, created } = makeDeps(dir);
    const mgr = createGoogleAuthManager(deps);
    await mgr.beginAuthFlow('cid', 'secret');
    const client = created[0]!;

    // Google refresh responses usually omit refresh_token.
    client.emitTokens({ access_token: 'at-REFRESHED', expiry_date: 1_800_000_000_000 });
    await waitFor(() => readStoredAuth(dir, fakeCipher)?.tokens.access_token === 'at-REFRESHED');

    const stored = readStoredAuth(dir, fakeCipher);
    expect(stored?.tokens.access_token).toBe('at-REFRESHED');
    expect(stored?.tokens.refresh_token).toBe('rt-auth-code-1'); // not dropped
  });
});

describe('two managers on one token file (§A3 concurrency)', () => {
  it('a stale writer re-reads under lock and does not clobber the concurrent refresh winner', async () => {
    // Manager A connects and owns the file.
    const a = makeDeps(dir);
    const mgrA = createGoogleAuthManager(a.deps);
    await mgrA.beginAuthFlow('cid', 'secret');
    const clientA = a.created[0]!;

    // A rotates to a brand-new refresh_token (the "winner").
    clientA.emitTokens({ access_token: 'at-A2', refresh_token: 'rt-NEW-WINNER' });
    await waitFor(() => readStoredAuth(dir, fakeCipher)?.tokens.refresh_token === 'rt-NEW-WINNER');

    // Manager B is a separate process with a client built from the ORIGINAL (now-stale) tokens.
    const b = makeDeps(dir);
    const mgrB = createGoogleAuthManager(b.deps);
    mgrB.getClients(); // builds + wires a client from disk
    const clientB = b.created[b.created.length - 1]!;

    // B refreshes; its event carries no refresh_token. It must re-read A's winner first.
    clientB.emitTokens({ access_token: 'at-B3' });
    await waitFor(() => readStoredAuth(dir, fakeCipher)?.tokens.access_token === 'at-B3');

    const stored = readStoredAuth(dir, fakeCipher);
    expect(stored?.tokens.access_token).toBe('at-B3');
    expect(stored?.tokens.refresh_token).toBe('rt-NEW-WINNER'); // winner preserved, not clobbered
  });
});

describe('disconnect', () => {
  it('revokes the tokens then deletes the file', async () => {
    const { deps, created } = makeDeps(dir);
    const mgr = createGoogleAuthManager(deps);
    await mgr.beginAuthFlow('cid', 'secret');

    await mgr.disconnect();
    const revoker = created[created.length - 1]!;
    expect(revoker.revoked).toBe(true);
    expect(mgr.status()).toEqual({ connected: false, email: null });
    expect(mgr.getClients()).toBeNull();
  });

  it('a refresh racing disconnect cannot resurrect the deleted file (B6)', async () => {
    const { deps, created } = makeDeps(dir);
    // Gate every revoke so disconnect can be held open mid-critical-section, under the lock.
    let releaseRevoke!: () => void;
    const revokeGate = new Promise<void>((r) => (releaseRevoke = r));
    const origCreate = deps.createOAuth2Client!;
    deps.createOAuth2Client = (id, sec, uri) => {
      const c = origCreate(id, sec, uri) as FakeClient;
      c.revokeCredentials = async () => {
        c.revoked = true;
        await revokeGate;
        return {};
      };
      return c;
    };
    const mgr = createGoogleAuthManager(deps);
    await mgr.beginAuthFlow('cid', 'secret');
    const clientA = created[0]!;
    const lockPath = tokenPaths(dir).lock;

    // Disconnect acquires the lock, reads, and parks inside revoke.
    const disconnecting = mgr.disconnect();
    await waitFor(() => existsSync(lockPath));

    // Refresh fires mid-disconnect. Its locked section must queue behind disconnect's lock, then
    // see the file already gone and bail — NOT re-persist the credentials.
    clientA.emitTokens({ access_token: 'at-ZOMBIE', refresh_token: 'rt-ZOMBIE' });
    await new Promise((r) => setTimeout(r, 60)); // let the refresh reach lock contention

    releaseRevoke();
    await disconnecting;

    // Wait for the refresh's queued lock attempt to fully drain (lock created then released).
    await waitFor(() => !existsSync(lockPath));
    await new Promise((r) => setTimeout(r, 100)); // settle any straggler write
    expect(readStoredAuth(dir, fakeCipher)).toBeNull(); // file stays gone
    expect(existsSync(tokenPaths(dir).file)).toBe(false);
    expect(mgr.status()).toEqual({ connected: false, email: null });
  });
});

describe('B5 — state + PKCE on the auth flow', () => {
  it('mints a random state, puts it in the auth URL, and hands it to the loopback server', async () => {
    const { deps, created, openedUrls, loopbackOpts } = makeDeps(dir);
    await createGoogleAuthManager(deps).beginAuthFlow('cid', 'secret');

    const opts = created[0]!.lastAuthOpts!;
    expect(typeof opts.state).toBe('string');
    expect(opts.state!.length).toBeGreaterThanOrEqual(32); // 32 random bytes, base64url
    expect(openedUrls[0]).toContain(`state=${opts.state}`);
    // The loopback server validates against the SAME state, on the exact redirect path.
    expect(loopbackOpts[0]).toEqual({ redirectPath: OAUTH_REDIRECT_PATH, expectedState: opts.state });
  });

  it('uses a fresh state per flow', async () => {
    const { deps, created } = makeDeps(dir);
    const mgr = createGoogleAuthManager(deps);
    await mgr.beginAuthFlow('cid', 'secret');
    await mgr.beginAuthFlow('cid', 'secret');
    expect(created[0]!.lastAuthOpts!.state).not.toBe(created[1]!.lastAuthOpts!.state);
  });

  it('sends an S256 PKCE challenge matching the verifier used at token exchange', async () => {
    const { deps, created } = makeDeps(dir);
    await createGoogleAuthManager(deps).beginAuthFlow('cid', 'secret');

    const client = created[0]!;
    const opts = client.lastAuthOpts!;
    expect(opts.code_challenge_method).toBe('S256');
    expect(client.exchangedVerifier).toBeTruthy();
    const expected = createHash('sha256').update(client.exchangedVerifier!).digest('base64url');
    expect(opts.code_challenge).toBe(expected);
  });

  it('does not exchange a code and persists nothing when the loopback rejects (state mismatch)', async () => {
    const { deps, created } = makeDeps(dir, {
      startLoopback: async () => ({
        port: 54321,
        waitForCode: async () => {
          throw new Error('Google authorization failed: state mismatch');
        },
        close: () => {}
      })
    });
    const mgr = createGoogleAuthManager(deps);
    await expect(mgr.beginAuthFlow('cid', 'secret')).rejects.toThrow(/state mismatch/);
    expect(created[0]!.exchangedCode).toBeNull(); // no token exchange happened
    expect(mgr.status()).toEqual({ connected: false, email: null }); // nothing persisted
  });
});

describe('startHttpLoopback — real HTTP callback validation (B5)', () => {
  const get = (port: number, pathAndQuery: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${pathAndQuery}`);

  it('accepts the callback only with the matching state (happy path)', async () => {
    const server = await startHttpLoopback({ redirectPath: '/', expectedState: 'S-GOOD' });
    try {
      const res = await get(server.port, '/?code=code-1&state=S-GOOD');
      expect(res.status).toBe(200);
      await expect(server.waitForCode()).resolves.toBe('code-1');
    } finally {
      server.close();
    }
  });

  it('rejects a code with a mismatched state: 400, flow rejected', async () => {
    const server = await startHttpLoopback({ redirectPath: '/', expectedState: 'S-GOOD' });
    try {
      const pending = server.waitForCode();
      const res = await get(server.port, '/?code=injected&state=S-EVIL');
      expect(res.status).toBe(400);
      await expect(pending).rejects.toThrow(/state mismatch/);
    } finally {
      server.close();
    }
  });

  it('rejects a code with NO state: 400, flow rejected', async () => {
    const server = await startHttpLoopback({ redirectPath: '/', expectedState: 'S-GOOD' });
    try {
      const pending = server.waitForCode();
      const res = await get(server.port, '/?code=injected');
      expect(res.status).toBe(400);
      await expect(pending).rejects.toThrow(/state mismatch/);
    } finally {
      server.close();
    }
  });

  it('404s any path other than the exact redirect path, leaving the flow pending', async () => {
    const server = await startHttpLoopback({ redirectPath: '/', expectedState: 'S-GOOD' });
    try {
      const res = await get(server.port, '/callback?code=injected&state=S-GOOD');
      expect(res.status).toBe(404);
      // The flow is neither resolved nor rejected by the off-path hit.
      const outcome = await Promise.race([
        server.waitForCode().then(
          () => 'settled',
          () => 'settled'
        ),
        new Promise((r) => setTimeout(() => r('pending'), 150))
      ]);
      expect(outcome).toBe('pending');
    } finally {
      server.close();
    }
  });
});
