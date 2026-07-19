# Gate D — clean-machine install checklist (manual, run by the user)

Gate D proves the shipped product: the NSIS installer installs on a clean Windows user account
with no admin, the app launches and degrades gracefully with nothing configured, the first-run
checklist guides to a working assistant, one voice + one text turn round-trip, and uninstall is
clean. Run Gates A–C first for the live voice/backend/tools proofs; this gate is about packaging.

Artifact: `dist-package/Jarvis Setup 0.1.0.exe` (built by `npm run dist`). Unsigned — see the
signing note at the bottom.

Automated private-beta release evidence (2026-07-18): production audit clean, 616 tests passed,
all model hashes verified, both native ABIs load-tested, brain-enabled packaged and extracted-NSIS
payload startups passed, and normal shutdown left no helpers. Installer SHA-256:
`ca8e50bf25b2ec06579a0464a1e8216b87fe06a5a7da83607bd2d8f1d2f7d64d`.

The remaining items in this checklist require human hardware/account interaction: standalone
Claude/Codex login, speaking/listening through the real microphone and speakers, Google
OAuth consent, and interactive uninstall observation.

## What automated hardening already proved (don't redo)

`npm run dist` + the packaged startup health check verify, on every build:

- native modules (better-sqlite3 and onnxruntime-node) load inside packaged Electron;
- the tools-mcp worker spawns from the asar and serves all 24 tools (`tools/list` health check);
- whisper/piper/ffmpeg + models resolve from `%APPDATA%/Jarvis/models`;
- both agent CLIs (claude, codex) launch from `app.asar.unpacked`;
- startup reaches text-only mode cleanly with nothing configured.

See `docs/packaging-smoke.md` and `docs/release-0.1.0.md` for the evidence.

## 1. Install (clean account, no admin)

- Copy `Jarvis Setup 0.1.0.exe` to a fresh Windows 11 user account (or a new local user).
- Double-click it. The wizard is **per-user** (`perMachine: false`) — it must NOT prompt for admin
  elevation. Accept the default install dir (`%LOCALAPPDATA%\Programs\Jarvis`) or choose another.
- Finish. A desktop shortcut + Start-menu entry named **Jarvis** appear.
- Silent variant (for scripted testing): `"Jarvis Setup 0.1.0.exe" /S /D=C:\path\to\dir`.

## 2. First launch — graceful degradation

- Launch Jarvis. The tray icon (a serif "J") appears; the main window opens.
- With nothing configured it runs **text-only**. The window shows the durable setup notice, and
  Settings shows the **setup** checklist:
  1. download voice models
  2. plug in a microphone
  3. sign in to claude or codex
  4. connect google (optional)
- No crash, no error toast — a missing prerequisite is a durable setup state, not a transient
  error.

## 3. First-run provisioning → working assistant

- **Download voice models**: Settings → click the download-models button. Progress streams in the
  pane; models land in `%APPDATA%/Jarvis/models` (~905 MB). The checklist item ticks.
- **Microphone**: plug one in; the device picker populates.
- **Wake word**: no account or key is required. The local **"Hey Jarvis"** model starts as soon as
  models and a microphone are available.
- **Sign in**: standalone `claude` (or `codex login`) in a terminal — see A9 machine blocker below.

## 4. One voice turn + one text turn

- **Voice**: say **"Hey Jarvis"**, then **"what time is it?"** Overlay:
  `listening → transcribing → thinking`,
  then a spoken reply. (A Google turn like "what's on my calendar today" needs step 6/Gate C.)
- **Text**: press the hotkey, type a request, Enter. Reply shows in the window; no TTS for
  text-initiated turns.

## 5. Autostart

- Settings → enable **launch on startup**. Confirm the HKCU Run value is created:
  `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v Jarvis` →
  points at the installed `Jarvis.exe --hidden`.
- Log out and back in: Jarvis starts hidden to the tray (no window pops).

## 6. Uninstall — clean

- Settings → Apps → Jarvis → Uninstall (or run `Uninstall Jarvis.exe`; `/S` for silent).
- Verify:
  - the install dir (`%LOCALAPPDATA%\Programs\Jarvis`) is removed;
  - the autostart Run value is gone:
    `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v Jarvis` → not found
    (removed by the custom uninstall macro, `packages/app/build/installer.nsh`);
  - shortcuts are removed.
- **Left behind by design**: `%APPDATA%\Jarvis` (sessions, second-brain vault + index, plugin
  config/secrets, and the fetched `models/`). This is deliberate (`deleteAppDataOnUninstall:
  false`) — sessions and the brain are real user content and the models are expensive to re-fetch.
  For a full scrub, delete `%APPDATA%\Jarvis` manually.

## Still-blocked items (user action required)

- **Claude / Codex login** — this machine's Claude login is Desktop host-managed; spawned CLIs see
  "Not logged in" until the user runs a standalone `claude /login` (or `claude setup-token`) /
  `codex login`. See `cdd/plan/amendments.md` A9. Until then, agent turns fail with an
  authentication setup state (not a crash), and steps 4/6 for a *live* agent reply can't complete
  on this machine.

## Signing

The installer and app are **unsigned** for 0.1.0. Windows SmartScreen will show a
"Windows protected your PC" prompt on first run (More info → Run anyway). Provisioning an
Authenticode/EV certificate and wiring it into `electron-builder.yml` is the tracked TODO.
