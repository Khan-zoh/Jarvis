// Manual smoke test for GoogleAuthManager (packages/tools-mcp/src/google/auth.ts). NOT part of
// `npm test` — the live consent flow needs a real GCP OAuth client and a human clicking "Allow",
// so it cannot run unattended. This is the user's Gate C prerequisite (see docs/google-setup.md).
//
// Prerequisites:
//   1. Build tools-mcp so dist/ exists:  npm run build --workspace=packages/tools-mcp
//   2. Create a GCP "Desktop app" OAuth client and enable Gmail/Calendar/Drive APIs — the full
//      click-path is in docs/google-setup.md.
//   3. Export the client id/secret, then run this script:
//        GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...  node scripts/smoke/smoke-google-auth.ts
//      Add `--disconnect` to also revoke + delete the tokens at the end.
//
// What it does:
//   1. Runs the loopback OAuth flow (opens your default browser to Google's consent screen).
//   2. Prints the connected account email.
//   3. Re-reads the persisted token file from a FRESH manager instance — proving status() survives
//      a process restart (real DPAPI decrypt, no network).
//   4. Asserts the on-disk token file contains no plaintext refresh_token (real DPAPI encryption).
//
// Tokens are written under a throwaway data dir (scratch/google-smoke), never your real userData.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoogleAuthManager } from '../../packages/tools-mcp/dist/google/auth.js';
import {
  dpapiTokenCipher,
  readStoredAuth,
  tokenPaths
} from '../../packages/tools-mcp/dist/google/tokenCodec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'scratch', 'google-smoke');

function openBrowser(url: string): void {
  // Windows: `cmd /c start "" <url>` launches the default browser. The empty "" is the window
  // title arg that `start` requires before a quoted URL.
  spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true });
}

async function main(): Promise<void> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a GCP Desktop OAuth client).');
    console.error('See docs/google-setup.md for how to create one.');
    process.exit(1);
  }

  console.log('[smoke] starting loopback OAuth flow — a browser window will open for consent...');
  const manager = createGoogleAuthManager({ dataDir: DATA_DIR, openBrowser });
  const { email } = await manager.beginAuthFlow(clientId, clientSecret);
  console.log(`[smoke] connected as: ${email}`);

  // Persistence survives a "restart": a brand-new manager reads status() from disk, no network.
  const restarted = createGoogleAuthManager({ dataDir: DATA_DIR, openBrowser });
  const status = restarted.status();
  console.log(`[smoke] status() after fresh instance: ${JSON.stringify(status)}`);
  if (!status.connected || status.email !== email) {
    throw new Error('status() did not survive re-instantiation');
  }

  // The real DPAPI blob on disk must not leak the refresh_token in plaintext.
  const { file } = tokenPaths(DATA_DIR);
  const raw = readFileSync(file, 'utf8');
  const stored = readStoredAuth(DATA_DIR, dpapiTokenCipher());
  const refreshToken = stored?.tokens.refresh_token as string | undefined;
  if (refreshToken && raw.includes(refreshToken)) {
    throw new Error('SECURITY: refresh_token found in plaintext on disk');
  }
  console.log(`[smoke] token file OK (no plaintext refresh_token): ${file}`);

  if (process.argv.includes('--disconnect')) {
    await restarted.disconnect();
    console.log(`[smoke] disconnected: status() now ${JSON.stringify(restarted.status())}`);
  } else {
    console.log('[smoke] leaving tokens in place. Re-run with --disconnect to revoke + delete.');
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
