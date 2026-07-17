import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { google, type calendar_v3, type drive_v3, type gmail_v1 } from 'googleapis';
import {
  deleteStoredAuth,
  dpapiTokenCipher,
  readStoredAuth,
  withTokenLock,
  writeStoredAuth,
  type TokenCipher
} from './tokenCodec.js';

/**
 * Installed-app Google OAuth 2.0 with a loopback redirect on `http://127.0.0.1:<random port>`
 * (cdd/plan/tools-and-google.md → "Google OAuth"). The OAuth *flow* is initiated from the app
 * (which injects `shell.openExternal` as `openBrowser`); the disposable MCP worker only ever reads
 * the persisted token file via `getClients`/`status`. Token refresh re-persists single-writer-safely
 * per amendments.md §A3.
 */

/** google-auth-library `Credentials`, derived without a direct dependency on that package. */
type Credentials = InstanceType<typeof google.auth.OAuth2>['credentials'];

export interface GoogleClients {
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
  drive: drive_v3.Drive;
}

export interface GoogleAuthManager {
  /** Connection state from the persisted token file — never hits the network. */
  status(): { connected: boolean; email: string | null };
  /** Opens the browser, runs the loopback flow, persists tokens, returns the account email. */
  beginAuthFlow(clientId: string, clientSecret: string): Promise<{ email: string }>;
  /** Authenticated + auto-refreshing API clients, or `null` when not connected. */
  getClients(): GoogleClients | null;
  /** Revokes the tokens with Google, then deletes the local token file. */
  disconnect(): Promise<void>;
}

/**
 * Narrowest scopes per operation (amendments.md — "Google OAuth scopes: narrowest per operation").
 * Each is explained to the user at consent time in docs/google-setup.md:
 *  - gmail.readonly   — search & read mail (never modify/delete)
 *  - gmail.send       — send mail as the user (no read grant implied)
 *  - calendar.events  — read + create/delete events (NOT full-calendar/ACL access)
 *  - drive.readonly   — search & read Drive files (no write/delete)
 *  - userinfo.email   — learn which account connected (shown in Settings)
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
] as const;

/** The subset of googleapis' OAuth2Client this module uses — the seam mocked in tests. */
export interface OAuth2ClientLike {
  generateAuthUrl(opts: { access_type?: string; scope: string[]; prompt?: string }): string;
  getToken(code: string): Promise<{ tokens: Credentials }>;
  setCredentials(tokens: Credentials): void;
  credentials: Credentials;
  on(event: 'tokens', listener: (tokens: Credentials) => void): void;
  revokeCredentials(): Promise<unknown>;
}

/** A running loopback server awaiting the OAuth redirect. */
export interface LoopbackServer {
  readonly port: number;
  /** Resolves with the `code` query param, or rejects if Google returns `?error=`. */
  waitForCode(): Promise<string>;
  close(): void;
}

export type StartLoopback = () => Promise<LoopbackServer>;

/** Injectable seams; every optional member has a production default. */
export interface GoogleAuthDeps {
  /** JARVIS data dir (the token file lands under `<dataDir>/google/`). */
  dataDir: string;
  /** Opens the consent URL in the user's browser (app passes `shell.openExternal`). */
  openBrowser: (url: string) => void | Promise<void>;
  cipher?: TokenCipher;
  createOAuth2Client?: (
    clientId: string,
    clientSecret: string,
    redirectUri: string
  ) => OAuth2ClientLike;
  startLoopback?: StartLoopback;
  fetchEmail?: (client: OAuth2ClientLike) => Promise<string>;
  makeClients?: (client: OAuth2ClientLike) => GoogleClients;
}

function defaultCreateOAuth2Client(
  clientId: string,
  clientSecret: string,
  redirectUri: string
): OAuth2ClientLike {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri) as unknown as OAuth2ClientLike;
}

async function defaultFetchEmail(client: OAuth2ClientLike): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oauth2 = google.oauth2({ version: 'v2', auth: client as any });
  const res = await oauth2.userinfo.get();
  const email = res.data.email;
  if (!email) throw new Error('Google did not return an account email.');
  return email;
}

function defaultMakeClients(client: OAuth2ClientLike): GoogleClients {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auth = client as any;
  return {
    gmail: google.gmail({ version: 'v1', auth }),
    calendar: google.calendar({ version: 'v3', auth }),
    drive: google.drive({ version: 'v3', auth })
  };
}

/** Production loopback: a one-shot HTTP server on a random 127.0.0.1 port. */
export async function startHttpLoopback(): Promise<LoopbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Authorization failed</h1><p>You can close this window.</p>');
      rejectCode(new Error(`Google authorization failed: ${error}`));
      return;
    }
    if (code) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Jarvis is connected</h1><p>You can close this window and return to Jarvis.</p>');
      resolveCode(code);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  return {
    port,
    waitForCode: () => codePromise,
    close: () => server.close()
  };
}

export function createGoogleAuthManager(deps: GoogleAuthDeps): GoogleAuthManager {
  const { dataDir } = deps;
  const cipher = deps.cipher ?? dpapiTokenCipher();
  const createClient = deps.createOAuth2Client ?? defaultCreateOAuth2Client;
  const startLoopback = deps.startLoopback ?? startHttpLoopback;
  const fetchEmail = deps.fetchEmail ?? defaultFetchEmail;
  const makeClients = deps.makeClients ?? defaultMakeClients;

  /**
   * Re-persist refreshed tokens single-writer-safely (§A3): under the lock, re-read the current
   * file, overlay the incoming fields, and never drop the refresh_token (a refresh response usually
   * omits it). If another process already wrote a newer file, we started from *its* contents, so a
   * concurrent winner is preserved rather than clobbered.
   */
  function attachRefresh(client: OAuth2ClientLike): void {
    client.on('tokens', (incoming) => {
      void withTokenLock(dataDir, () => {
        const current = readStoredAuth(dataDir, cipher);
        if (!current) return; // disconnected concurrently — nothing to update
        const merged: Credentials = {
          ...current.tokens,
          ...incoming,
          refresh_token:
            (incoming.refresh_token as string | undefined) ??
            (current.tokens.refresh_token as string | undefined)
        };
        writeStoredAuth(
          dataDir,
          { ...current, tokens: merged as Record<string, unknown> },
          cipher
        );
      }).catch(() => {
        /* best-effort: the next getClients() re-reads from disk regardless */
      });
    });
  }

  return {
    status() {
      const stored = readStoredAuth(dataDir, cipher);
      return stored?.email
        ? { connected: true, email: stored.email }
        : { connected: false, email: null };
    },

    async beginAuthFlow(clientId, clientSecret) {
      const server = await startLoopback();
      try {
        const redirectUri = `http://127.0.0.1:${server.port}`;
        const client = createClient(clientId, clientSecret, redirectUri);
        const authUrl = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent', // force a refresh_token on every connect
          scope: [...GOOGLE_SCOPES]
        });
        await deps.openBrowser(authUrl);
        const code = await server.waitForCode();
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        const email = await fetchEmail(client);
        await withTokenLock(dataDir, () => {
          writeStoredAuth(
            dataDir,
            { clientId, clientSecret, email, tokens: tokens as Record<string, unknown> },
            cipher
          );
        });
        attachRefresh(client);
        return { email };
      } finally {
        server.close();
      }
    },

    getClients() {
      const stored = readStoredAuth(dataDir, cipher);
      if (!stored) return null;
      const client = createClient(stored.clientId, stored.clientSecret, 'http://127.0.0.1');
      client.setCredentials(stored.tokens as Credentials);
      attachRefresh(client); // token-endpoint refreshes re-persist for the next worker
      return makeClients(client);
    },

    async disconnect() {
      const stored = readStoredAuth(dataDir, cipher);
      if (stored) {
        const client = createClient(stored.clientId, stored.clientSecret, 'http://127.0.0.1');
        client.setCredentials(stored.tokens as Credentials);
        try {
          await client.revokeCredentials();
        } catch {
          /* best-effort: token may already be expired/revoked upstream */
        }
      }
      deleteStoredAuth(dataDir);
    }
  };
}
