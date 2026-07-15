# Overview — "Jarvis" Voice Assistant for Windows

## Vision

A resident Windows desktop assistant. The user says "Hey <AgentName>" (configurable, default
"Jarvis"), speaks a request, and the assistant executes it using the user's existing **Claude**
and **Codex (ChatGPT)** subscriptions as agent brains, with tool access to Google Workspace
(Gmail, Calendar, Drive), the local system, and the web. Replies are spoken aloud and shown in a
minimalist, black-and-white, typography-led UI.

## Non-negotiable requirements

- Runs on Windows 11 as a tray-resident app; wake word works while app is in background.
- Uses subscription auth, not pay-per-token API keys:
  - Claude → Claude Agent SDK, which reuses the Claude Code CLI login.
  - Codex → `@openai/codex-sdk`, which drives the Codex CLI logged in via ChatGPT account.
- Google integration: read/send Gmail, manage Calendar events, search/read Drive files.
- UI: monochrome (black/white/greys only), editorial typography, no gradients, no glowing
  orbs, no "AI product" aesthetics. Text-first.
- Also usable without voice: global hotkey opens a text command bar.

## Architecture decisions (ADR summary)

| # | Decision | Choice | Why (alternatives rejected) |
|---|----------|--------|------------------------------|
| 1 | App shell | **Electron + TypeScript** | Claude Agent SDK and Codex SDK are Node libraries; Electron hosts them in-process. Tauri would need a Node sidecar (extra IPC layer); .NET can't host the SDKs at all. |
| 2 | Claude backend | **@anthropic-ai/claude-agent-sdk** | Only supported way to run agentic Claude on a Claude subscription. Raw Anthropic API rejected (costs per token, no subscription auth). |
| 3 | Codex backend | **@openai/codex-sdk** (wraps Codex CLI) | Uses ChatGPT-account sign-in (`codex login`). OpenAI API rejected for same cost reason. |
| 4 | Wake word | **Picovoice Porcupine** (`@picovoice/porcupine-node`) | Local, accurate, free tier; "Jarvis" is a shipped built-in keyword; custom names trainable free on Picovoice Console (.ppn file). openWakeWord rejected (needs Python sidecar). |
| 5 | Speech-to-text | **whisper.cpp** run locally (small.en default model) | Free, offline, accurate for command-length audio. Cloud STT rejected (cost, privacy, latency of upload). |
| 6 | Endpointing | **Silero VAD** via `onnxruntime-node` | Detects end of speech so user doesn't push a button. Fixed-length recording rejected (bad UX). |
| 7 | Text-to-speech | **Piper TTS** (local neural voices, child process) | Free, fast, natural. Windows SAPI rejected (robotic); cloud TTS rejected (cost). |
| 8 | Tool layer | **One standalone MCP server (stdio), plugin-based** owned by this repo | Both Claude Agent SDK and Codex CLI speak MCP, so every tool is written once and shared by both backends. Capabilities are **plugins** (google, system, web, smarthome…): a new feature is one folder + one loader line, auto-exposed to both brains and auto-rendered in settings. Backends grant the whole server (no hardcoded allowlist to maintain). See extending.md. |
| 9 | Google auth | OAuth 2.0 installed-app flow with loopback redirect, user-supplied GCP OAuth client | Only sanctioned way to access Gmail/Calendar/Drive. Tokens stored via Electron `safeStorage` (DPAPI). |
| 10 | UI | Two frameless windows: always-on-top **overlay** (state + live transcript) and a **main window** (history, settings). Vanilla TS + CSS, no UI framework | App has ~2 views; React adds weight without value. Design system defined in ui-design.md. |
| 11 | Tests | **vitest** unit tests per module; audio fixtures for the pipeline; a text-mode e2e path that bypasses the microphone | Voice hardware can't run in CI; interfaces are designed so audio in/out are mockable. |
| 12 | Second brain | **Local markdown vault (Obsidian-compatible) + local ONNX embeddings; auto-capture; smart-hybrid recall** | Gives the assistant continuity/memory. Markdown-on-disk matches the local/free/no-lock-in ethos and opens in Obsidian; embeddings reuse the onnxruntime already in the stack ($0). Delivered as a `brain` plugin plus two generic agent seams (pre-turn ContextProvider, post-turn TurnObserver). See second-brain.md. |

## Repo layout (target)

```
jarvis/
  package.json                 # electron app workspace root
  packages/
    app/                       # Electron app (main + renderer)
      src/main/                # main process: bootstrap, tray, windows, ipc, config
      src/voice/               # capture, wakeword, vad, stt, tts, pipeline
      src/agents/              # backend interface, claude, codex, router, sessions
      src/renderer/            # overlay + main window UI
    tools-mcp/                 # standalone MCP server: google, system, web tools
  models/                      # whisper + piper + vad model files (gitignored, fetched by script)
  cdd/                         # this plan + tasks
```

## Execution model for tasks

Tasks in `cdd/tasks/` are written for unattended execution by sub-agents in the order given by
`order.json`. Each task states its objective, the exact interfaces it implements (defined in the
plan docs), what to test, and acceptance criteria. Plan docs are the contract; if a task and a
plan doc conflict, the plan doc wins.
