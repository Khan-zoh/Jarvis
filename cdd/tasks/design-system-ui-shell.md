# Task: design-system-ui-shell

## Objective
Build the monochrome editorial design system and the static structure of both windows: overlay
(state word, live line, tool ticker) and main window (titlebar, history pane, settings pane,
command bar). Views render from a `JarvisApi` they subscribe to — this task feeds them a
built-in demo driver; live data arrives in wire-and-converse.

## Read first
- cdd/plan/ui-design.md — binding contract for tokens, layout, copy voice.
- cdd/plan/architecture.md — PushChannels/InvokeChannels shape (the JarvisApi type).

## Deliverables
- `assets/fonts/` — self-hosted woff2: Fraunces (400 italic, 600), Inter (400, 600), IBM Plex
  Mono (400). Download from Google Fonts github releases; commit the files (OFL licensed —
  include OFL.txt).
- `src/renderer/styles/tokens.css` + `base.css` — tokens per plan; dark theme via
  `[data-theme='dark']`; follows `prefers-color-scheme` by default.
- `src/renderer/overlay/` — `OverlayView` class per plan; listening indicator = 5 vertical
  1px bars animated from a `micLevel` number (0..1) — add `'mic:level'` to PushChannels in
  shared types (main will emit it; harmless if silent).
- `src/renderer/main/` — `MainView` per plan: titlebar (agent name in Fraunces, drag region,
  settings text-button, close/min text glyphs), session list, transcript pane (editorial
  layout per plan — no bubbles), command bar with Tab backend switch, settings pane with all
  sections as static controls bound to `config:get/set`.
- Demo driver (`renderer/demo.ts`, dev-only via `?demo=1`): cycles overlay through all states
  with fake transcript/tool events so design can be judged without voice working.
- Tray icon + wake.wav in `assets/` per plan.
- `docs/ui-checklist.md` with the visual acceptance list from the plan.

## Tests
- jsdom unit tests: OverlayView shows correct state word per AssistantState; tool ticker
  renders on tool_start and clears on idle; MainView transcript reducer turns TurnRecord[]
  into the expected DOM order; command bar submit calls `command:text` with the picked backend.

## Acceptance
- `npm test` passes. `npm run dev` + `?demo=1`: every overlay state and a fake conversation
  look correct in light AND dark; only the 5 token colors appear; fonts load from disk.
