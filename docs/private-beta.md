# Private beta release

Jarvis 0.1 is distributed as a private, unsigned Windows beta. It is intended for trusted testers
who understand that Windows SmartScreen will warn on first launch and that outward Google actions
are visible but do not yet have a blocking confirmation prompt.

## Reproducible release

From a PowerShell terminal at the repository root:

```powershell
.\scripts\private-beta-release.ps1
```

The release script installs the lockfile without running dependency scripts, rejects high/critical
production dependency advisories, runs the complete test suite, verifies every core and brain model
against its pinned SHA-256, builds the NSIS installer, and writes `dist-package/SHA256SUMS.txt`.

The final hardware/account acceptance pass remains manual because it requires a microphone,
speakers, and authenticated agent accounts. Run `docs/gate-d-checklist.md`, which
incorporates the earlier live Gates A, C, and C2.

## Backup

Create a timestamped backup of the Obsidian vault and irreplaceable Jarvis user data:

```powershell
.\scripts\backup-private-beta.ps1
```

The default destination is `D:\JarvisBackups`. Downloaded voice/embedding models are excluded
because they are reproducible and large. Each backup directory includes SHA-256 checksums.

## Accepted private-beta limitations

- The installer is unsigned and triggers SmartScreen.
- Outward/destructive tool calls are announced and recorded, but are not held for confirmation.
- Google setup uses the tester's own OAuth client credentials.
- Electron renderer sandboxing remains disabled pending a CommonJS preload build; context
  isolation remains enabled and renderer Node integration remains disabled.
- `%APPDATA%\Jarvis` is deliberately retained during uninstall because it contains user data.
