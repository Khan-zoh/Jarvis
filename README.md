# Jarvis

A resident Windows desktop voice assistant. See `cdd/plan/overview.md` for the vision and
architecture decisions, and `cdd/tasks/` for the build plan.

## Status

Scaffold stage. The monorepo skeleton exists (`packages/app`, `packages/tools-mcp`) with the
Electron shell, shared types, and an MCP stdio server placeholder wired up.

## Development

```powershell
npm install
npm run dev     # launches the Electron scaffold window
npm test        # runs vitest across all workspaces
npm run build   # builds all workspaces
```

## Layout

```
jarvis/
  package.json                 # workspace root
  packages/
    app/                       # Electron app (main + preload + renderer)
    tools-mcp/                 # standalone MCP stdio server (google, system, web tools)
  models/                      # whisper + piper + vad model files (gitignored, fetched by script)
  cdd/                         # plan + tasks
```
