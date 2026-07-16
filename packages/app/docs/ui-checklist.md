# ui visual acceptance checklist

Manual pass for the monochrome editorial shell (binding contract: `cdd/plan/ui-design.md`).
Run `npm run dev`, then open each window with `?demo=1` (overlay: `?view=overlay&demo=1`).
Verify everything below in light AND dark (flip the OS theme, or set
`document.documentElement.dataset.theme = 'dark' | 'light'`).

## global

- [ ] Only the five token colors appear anywhere: `#0a0a0a` ink, `#fafaf7` paper,
      `#e8e8e4` hairline grey, `#8a8a86` secondary grey, `#2a2a28` dark-theme hairline.
      No other color, no gradients, no glow, no shadows.
      (The live-line top fade is an alpha mask, not a color gradient.)
- [ ] Dark theme is a clean inversion: ink and paper swap, hairlines drop to `#2a2a28`,
      secondary text stays `#8a8a86`. `[data-theme]` overrides the OS preference.
- [ ] Fonts load from disk (`assets/fonts/*.woff2`, no network): Fraunces italic 400 +
      semibold 600, Inter 400/600, IBM Plex Mono 400. Check devtools network tab: no
      font requests leave the app origin.
- [ ] All copy is lowercase, terse, human. No "Oops", no emoji, no exclamation marks,
      no icons anywhere except the tray.
- [ ] Motion is opacity/transform fades ≤200 ms ease-out only. Nothing bounces or pulses.

## overlay (`?view=overlay&demo=1`)

- [ ] Card is 560 px wide, paper background, single hairline border, no shadow.
- [ ] State word set in Fraunces italic, lowercase, for every state the demo cycles:
      `listening`, `transcribing`, `thinking`, `speaking`, `something went wrong`;
      idle fades the card out (opacity + 4 px translate).
- [ ] Listening indicator: a row of five 1 px vertical ink bars beside the state word,
      heights tracking mic level, center-weighted. Visible only while listening.
      This is the single "alive" element.
- [ ] Live line: mono; shows the user's transcript while listening (grey while partial,
      ink when final), then the streaming reply. Clamped to the last 3 lines, older
      lines fade upward.
- [ ] Tool ticker: one hairline-topped mono line — `→ checking calendar…` during a tool
      call, `✓ gcal.list` on ok end — and it disappears at idle.
- [ ] Error state reads calmly: state word `something went wrong`, mono detail line
      beneath (e.g. `codex not logged in. run \`codex login\` in a terminal.`).

## main window (`?demo=1`)

- [ ] Custom 32 px titlebar: agent name in Fraunces semibold lowercase on the left
      (drag region), `settings` mono text-button plus `–` and `×` text glyphs on the
      right (no-drag). No native frame, no icons.
- [ ] Two panes split by a 1 px hairline; settings pane hidden until toggled.
- [ ] Session list: mono, title left / relative time right (`42m ago`), grey; the
      active row and hover rows turn ink.
- [ ] Transcript is editorial, NOT chat bubbles: bold Inter user line prefixed
      `you —` (prefix in small grey mono), assistant reply as a Fraunces italic serif
      paragraph beneath, tool calls as small grey mono footnotes (`✓ gcal.list`).
      Max measure ~64ch, generous margins, no boxes.
- [ ] Command bar pinned at the bottom: single hairline-underlined mono input,
      placeholder `type, or say 'jarvis'` (follows the configured agent name).
      Underline sharpens to ink on focus.
- [ ] `Tab` in the input flips the `claude|codex` switch; the active backend is ink
      and underlined, the other grey. Enter submits and clears the input.
- [ ] Settings pane: serif lowercase section headings (`agent`, `voice`, `accounts`)
      over hairlines; fields are label-left grey / control-right mono; checkboxes and
      the sensitivity slider render in ink (accent-color).
- [ ] Accounts copy matches the voice: `codex not logged in. run \`codex login\` in a
      terminal.`, `no google account connected — set up`.

## assets

- [ ] Tray icon (`assets/tray.ico`): agent initial, white on a black rounded square,
      crisp at 16 px and 32 px.
- [ ] `assets/wake.wav`: one short soft click (~80 ms), no chime, no melody.
