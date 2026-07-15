# Task: google-auth

## Objective
Implement Google OAuth (installed-app, loopback) in tools-mcp: `GoogleAuthManager`, encrypted
token persistence, and the app-side `google:connect`/`google:disconnect` IPC handlers +
setup doc.

## Read first
- cdd/plan/tools-and-google.md — GoogleAuthManager interface, scopes, token handling,
  flow-initiated-from-app contract. Binding.

## Deliverables
- `packages/tools-mcp/src/google/auth.ts` — GoogleAuthManager per plan using `googleapis`:
  loopback server on random port, browser opened by caller-provided `openBrowser(url)`
  callback (app passes `shell.openExternal`), token exchange, refresh-event re-persist,
  `disconnect` revokes then deletes file, `status` reads persisted email.
- `src/google/tokenCodec.ts` — encode/decode token file with an injected cipher
  (app injects safeStorage-based cipher; MCP server process, which can't use safeStorage,
  receives a key file path fallback: DPAPI via PowerShell `ProtectedData` one-liner — pick ONE
  mechanism that works in both processes: the PowerShell DPAPI approach, and use it in both).
- App: `google:connect` handler runs beginAuthFlow with config clientId/secret and stores
  `connectedEmail` in config; `google:disconnect` wired; both already stubbed in app-core's
  IpcDeps.
- `docs/google-setup.md` — precise click-path: create GCP project, enable Gmail+Calendar+Drive
  APIs, consent screen (External/Testing, add self as test user), create OAuth Desktop client,
  copy id/secret into settings. Note the 7-day token expiry in Testing mode and the fix
  (publish app or re-consent).

## Tests
- tokenCodec round-trip with fake cipher; no plaintext refresh_token in file (assert).
- AuthManager with mocked OAuth2Client + fake loopback request: full flow state machine
  (url built with right scopes+port, code exchanged, tokens persisted, email fetched),
  refresh event re-persists, disconnect deletes.
- Live smoke `scripts/smoke/smoke-google-auth.ts` (manual): full browser flow → prints email.

## Acceptance
- `npm test` passes; live flow completes against a real GCP client and `status()` survives
  process restart.
