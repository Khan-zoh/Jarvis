# Jarvis

A resident Windows 11 desktop voice assistant. Say **"Hey Jarvis"**, speak a request, and it
answers aloud — driven by your existing **Claude** and **Codex (ChatGPT)** subscriptions as the
agent brains, with tools for Google Workspace (Gmail, Calendar, Drive), the local system, and the
web. Everything speech-related (wake word, transcription, endpointing, text-to-speech) runs
**locally and offline**. The UI is deliberately monochrome and typography-led — no gradients, no
glowing orbs. It's also usable without voice: a global hotkey opens a text command bar.

See `cdd/plan/overview.md` for the full vision and the architecture decision record.

## What's in the box

- **Wake word** — openWakeWord's local ONNX **"Hey Jarvis"** model; no account or API key.
- **Speech-to-text** — whisper.cpp (`small.en`), run as a persistent local server.
- **Endpointing** — Silero VAD via onnxruntime.
- **Text-to-speech** — Piper (local neural voice).
- **Brains** — Claude Agent SDK + `@openai/codex-sdk`, both on subscription auth (no API keys).
- **Tools** — one stdio MCP server (`packages/tools-mcp`), plugin-based: google, system, web,
  and the second-brain memory. Shared by both brains.
- **Second brain** — an optional local Obsidian-compatible markdown vault with on-device ONNX
  embeddings for recall/auto-capture.

## Setup order

Install the app, then complete the first-run checklist (Settings shows it until each item is
done). The order matters:

1. **Install** — run the NSIS installer (`Jarvis Setup <version>.exe`), or from source:
   `npm install && npm run build`.
2. **Download voice models** — Settings → the first-run checklist has a **download voice models**
   button (fetches whisper + piper + ffmpeg + Silero + openWakeWord into
   `%APPDATA%/Jarvis/models`, ~905 MB).
   From source you can instead run `npm run fetch-models` (add `--with-brain` for the embedder).
3. **Plug in a microphone.**
4. **Sign in to a brain** — a standalone `claude` login (or `codex login`) in a terminal, so the
   spawned CLI has its own credentials. See `cdd/plan/amendments.md` A9.
5. **Connect Google (optional)** — Settings → Accounts: paste a Google OAuth client id/secret
   (`docs/google-setup.md`) and sign in.

With nothing configured, the app still launches and runs **text-only**, showing exactly which
prerequisite is missing rather than failing.

## Development

```powershell
npm install         # postinstall builds native modules for Node (vitest ABI)
npm run build       # builds both workspaces
npm test            # vitest across all workspaces (plain Node)
npm run dev         # launches the Electron app (see native-module note below)
npm run fetch-models
.\scripts\private-beta-release.ps1 # audit + tests + models + installer + packaged smoke + hash
.\scripts\backup-private-beta.ps1  # vault + irreplaceable app data (models excluded)
npm run dist        # builds the NSIS installer into dist-package/
npm run package     # unpacked build only (dist-package/win-unpacked) — fast verification
```

### Native module ABI (better-sqlite3)

`better-sqlite3` is a source-compiled native module, and this repo's single `node_modules` serves
three runtimes with different ABIs: plain-Node vitest (the resting state), dev Electron, and the
packaged app. The scheme:

- **Tests / resting state** — Node ABI. `npm install`, `npm test`, and both `npm run dist`/`npm
  run package` all leave `better-sqlite3` at the **Node** ABI (the build scripts rebuild a private
  copy for Electron at package time and restore the Node ABI afterward). So `npm test` always works
  out of the box.
- **Dev Electron with the second brain enabled** — needs the **Electron** ABI. Run
  `npm run rebuild:electron` before `npm run dev`, and `npm run rebuild:node` before running the
  tests again. (Voice-only dev doesn't touch sqlite and needs neither.)
- **Packaged app** — self-contained; electron-builder rebuilds `better-sqlite3` for Electron into
  the app bundle. Unaffected by the resting ABI.

## Layout

```
jarvis/
  package.json                 # workspace root
  packages/
    app/                       # Electron app (main + preload + renderer)
    tools-mcp/                 # standalone MCP stdio server (google, system, web, brain tools)
  scripts/                     # fetch-models, make-icon, smoke scripts
  docs/                        # setup + gate checklists + release notes
  models/                      # fetched at runtime into %APPDATA%/Jarvis/models when packaged
  cdd/                         # plan + tasks
```

## Licenses & third-party terms

Jarvis bundles or downloads several third-party components; their licenses and terms apply:

- **Fonts** (bundled) — Inter, IBM Plex Mono, and Fraunces, all under the SIL Open Font License
  (OFL) 1.1.
- **openWakeWord** — Apache-2.0 code. Its bundled pretrained `hey_jarvis` model is
  CC BY-NC-SA 4.0 and is used only for this noncommercial private beta.
- **whisper.cpp** — MIT.
- **Piper** — MIT; the neural voices are licensed per-voice (the default en_US-lessac-medium is
  released for free use by its author).
- **Silero VAD** — MIT.
- **FFmpeg** — the fetched Windows build is used for audio capture/playback; distributed under
  LGPL/GPL by its packager.
- **onnxruntime**, **better-sqlite3**, **Electron**, and the Node dependency tree — MIT / Apache-2.0
  / their respective OSS licenses.

Voice models, binaries, and FFmpeg are **not** shipped in the installer — they are fetched at
first run, so the installer itself carries only the app + its Node dependencies.

## Signing

The 0.1.0 installer is **unsigned** — Windows SmartScreen will warn on first launch until an
Authenticode/EV certificate is provisioned. This is a known TODO tracked in the packaging config.
