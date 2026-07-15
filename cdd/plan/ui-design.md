# UI Design — Monochrome Editorial

Hard constraints from the user: minimalist, clean black & white, "fancy fonts", **no AI
aesthetics** — no gradients, no glow, no purple, no orbs, no sparkle icons, no chat bubbles.
Typography does the work.

## Design tokens (packages/app/src/renderer/styles/tokens.css)

```css
:root {
  --ink: #0a0a0a;          /* near-black */
  --paper: #fafaf7;        /* warm off-white */
  --grey-1: #e8e8e4;       /* hairlines */
  --grey-2: #8a8a86;       /* secondary text */
  --font-display: 'Fraunces';        /* serif, high-contrast — headings, agent name, state word */
  --font-body: 'Inter';              /* UI text */
  --font-mono: 'IBM Plex Mono';      /* transcripts, tool lines, timestamps */
}
[data-theme='dark'] { /* inverted: ink↔paper, greys adjusted */ }
```

- Fonts are self-hosted woff2 in `assets/fonts/` (offline app; no CDN).
- Only these five colors exist. Emphasis via weight, size, italics, and hairline rules —
  never color.
- Motion: opacity/transform fades ≤200ms, ease-out. No bounces, no pulsing glows. The one
  "alive" element is the listening indicator: a row of 5 thin vertical bars (1px wide) whose
  heights track mic level — pure black on paper.

## Overlay window (renderer/overlay/)

Frameless, transparent, always-on-top, bottom-center, ~560×auto px, click-through while idle.

Layout (top to bottom):
1. **State word** — `--font-display` italic, lowercase: "listening", "thinking", "speaking",
   or an error phrase. This is the main status indicator; no icons.
2. **Live line** — mono; user's transcript while listening/transcribing; then the streaming
   reply text (last 3 lines, older lines fade upward).
3. **Tool ticker** — one hairline-topped mono line: "→ searching gmail…" during `tool_start`,
   "✓ gmail" on ok end. Disappears when idle.

```ts
// renderer/overlay/overlay.ts
export class OverlayView {
  constructor(root: HTMLElement, api: JarvisApi);   // subscribes to state/transcript/agent:event
  render(): void;
}
```

## Main window (renderer/main/)

One window, 900×640, two panes separated by a 1px hairline; native frame hidden, custom 32px
titlebar with the agent name set in `--font-display`.

- **Left pane (history)**: session list (title + relative time, mono). Active session's turns
  render as an editorial transcript — NOT chat bubbles: user line set in bold body font with a
  `you —` prefix; assistant reply as a serif paragraph beneath; tool calls as small mono
  footnote lines. Text command bar pinned at bottom: a single hairline-underlined input, mono,
  placeholder "type, or say '<agentName>'"; `Tab` toggles a small `claude|codex` backend
  switch.
- **Right pane (settings)** toggled by a "settings" text-button in the titlebar:
  sections Agent (name, default backend, hotkey, launch on startup), Voice (input device,
  keyword, sensitivity, TTS on/off, model status + "download models" action), Accounts
  (Claude: detected/not + fix hint; Codex: `codex login` status; Google: connect/disconnect,
  client id/secret fields), each section a serif heading + hairline.

```ts
// renderer/main/app.ts
export class MainView {
  constructor(root: HTMLElement, api: JarvisApi);
  showSettings(show: boolean): void;
}
// renderer/shared/api.ts
export type JarvisApi = /* the typed preload surface from architecture.md */;
```

## Copy voice

All UI copy lowercase, terse, human: "listening", "no google account connected — set up",
"codex not logged in. run `codex login` in a terminal." Never "Oops!", never emoji, never
exclamation marks.

## Assets

- Tray icon: 16/32px — the agent's initial letter, white on black rounded square (generated
  SVG → ico in `assets/`).
- Wake sound: `assets/wake.wav`, a single short soft click (~80ms).

## Testing

- Renderer logic classes (OverlayView state→DOM mapping, transcript reducer) unit-tested with
  jsdom in vitest.
- Visual acceptance: `docs/ui-checklist.md` — screenshots of overlay in each state + main
  window light/dark verified manually against constraints (only 5 colors, fonts loaded,
  no icons besides tray).
