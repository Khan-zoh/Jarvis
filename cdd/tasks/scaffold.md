# Task: scaffold

## Objective
Create the monorepo skeleton: an Electron + TypeScript app package and an empty tools-mcp
package, with vitest wired at the root, so every later task has a place to land and `npm test`
+ `npm run dev` both work from day one.

## Read first
- cdd/plan/overview.md (repo layout, decisions 1, 11)

## Deliverables
- Root `package.json` with npm workspaces `packages/*`; scripts: `dev` (runs app), `build`,
  `test` (vitest run across workspaces), `fetch-models` (placeholder that prints "not yet").
- `packages/app/`: Electron 33+, TypeScript strict, `electron-vite` (or esbuild-based
  equivalent) building `src/main`, `src/preload`, `src/renderer`. `npm run dev` opens a
  window showing the text "jarvis scaffold" on a plain white page.
- `packages/tools-mcp/`: TS package with `@modelcontextprotocol/sdk` dependency, `src/index.ts`
  that starts an MCP stdio server exposing a single `ping` tool returning "pong" (placeholder,
  replaced by tools-mcp-core task).
- `packages/app/src/shared/types.ts` containing ALL shared types verbatim from
  cdd/plan/architecture.md ("Shared types" section).
- Root `tsconfig.base.json`, `.gitignore` (node_modules, dist, models/, *.local), `README.md`
  stub, git repo initialized with one commit.
- Vitest configured in both packages; one trivial passing test in each proving the harness.

## Notes
- Windows dev machine; all scripts must run in PowerShell (no bash-isms in npm scripts).
- Pin electron + electron-vite versions in package.json (no ^) to keep sub-agent builds
  reproducible.
- `contextIsolation: true`, `nodeIntegration: false` from the start.

## Tests
- `packages/app/test/types.test.ts`: type-only test importing shared types (compiles = passes).
- `packages/tools-mcp/test/ping.test.ts`: boots the stdio server via MCP client SDK, calls
  `ping`, expects "pong".

## Acceptance
- `npm install && npm test` passes clean on Windows.
- `npm run dev` opens the scaffold window without devtools errors.
