# Security Best-Practices Review

Review date: 2026-07-22

## Executive summary

Jarvis is suitable to publish as source for a private beta after the hardening changes in this
review. The complete Git history (32 commits before this review) was scanned with Gitleaks 8.30.1
and no credentials or secrets were detected. A manual scan also found no private keys, service
tokens, personal email addresses, user-specific paths, packaged installers, voice models, or local
second-brain data in tracked history.

No critical or high-severity dependency advisories remain. One upstream moderate advisory is
present through `@modelcontextprotocol/sdk`; the vulnerable Hono static-file server is not used by
Jarvis, whose MCP server communicates locally over stdio. Renderer content is protected by a
restrictive Content Security Policy, context isolation is enabled, Node integration is disabled,
and IPC is exposed through a narrow preload bridge. Agent computer access defaults to restricted
and can be widened by the local user to one workspace or the entire computer. Full mode
intentionally bypasses agent permission prompts and must only be used for trusted tasks.

## Findings

### SEC-001 — Resolved: vulnerable URL parser dependency

- Severity: High
- Status: Resolved
- Affected component: production dependency tree (`fast-uri`)
- Risk: A crafted URI could cause excessive resource consumption in versions before 3.1.4.
- Remediation: Updated the lockfile to `fast-uri` 3.1.4. `npm audit --omit=dev` now reports no
  critical or high findings.

### SEC-002 — Accepted: transitive Hono static-file path traversal advisory

- Severity: Moderate
- Status: Accepted pending an upstream MCP SDK update
- Affected component: `@modelcontextprotocol/sdk` -> `@hono/node-server` 1.19.x
- Risk: On Windows, Hono's `serve-static` can traverse paths when given an encoded backslash.
- Exposure: Jarvis starts its MCP tool server over local stdio and does not import or expose Hono's
  HTTP static-file server. The vulnerable route is therefore not reachable in the application.
- Follow-up: Dependabot is enabled weekly. Upgrade when the MCP SDK accepts Hono 2.0.5 or later;
  do not force a major transitive override without compatibility testing.

### SEC-003 — Open: Electron renderer sandbox is disabled

- Severity: Medium
- Status: Open, mitigated
- Location: `packages/app/src/main/windows.ts`
- Risk: A renderer compromise has more process capability than it would with Chromium's renderer
  sandbox enabled.
- Existing controls: `contextIsolation: true`, `nodeIntegration: false`, a restrictive CSP, blocked
  in-window navigation, protocol allowlisting for external links, and a small typed preload bridge.
- Follow-up: Emit the preload as CommonJS and enable `sandbox: true`, then exercise all IPC flows in
  a packaged build before release beyond the private beta.

### SEC-004 — Resolved: HTML-string DOM construction

- Severity: Low
- Status: Resolved
- Location: `packages/app/src/renderer/main/app.ts`
- Risk: The strings were constants and not exploitable, but `innerHTML` makes future interpolation
  mistakes easier.
- Remediation: Replaced production `innerHTML` assignments with `createElement`, `textContent`, and
  `append` calls.

### SEC-005 — Resolved: external URL protocol validation

- Severity: Low
- Status: Resolved
- Location: `packages/app/src/main/windows.ts`
- Risk: Regex-based URL validation is easier to weaken accidentally and does not normalize before
  dispatching to the operating system.
- Remediation: External URLs are parsed with the platform URL parser and allowed only when their
  normalized protocol is `http:`, `https:`, or `mailto:`.

## Repository controls added

- Expanded ignore rules for environment files, private keys, certificates, and encrypted secrets.
- Added a private vulnerability-reporting policy in `SECURITY.md`.
- Added weekly Dependabot updates grouped by production and development dependencies.
- Added a least-privilege Windows CI workflow that installs from the lockfile, builds, tests, and
  rejects critical/high production dependency advisories. Third-party actions are pinned by commit.

## Opt-in full-computer access

Preferences exposes three modes for both coding agents:

- `restricted`: no built-in coding tools; only the reviewed Jarvis MCP tool surface.
- `workspace`: file read/edit/search tools rooted in the configured working folder.
- `full`: built-in coding tools, commands, user-level MCP configuration, and unrestricted local
  filesystem access.

Keep the public/default configuration on `restricted`. Full mode acts with the user's operating-
system permissions and can execute destructive commands or disclose data if given untrusted
instructions.

## Recheck commands

```powershell
npm ci
npm run build
npm test
npm audit --omit=dev
gitleaks git . --redact
```
