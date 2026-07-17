# Gate C — end-to-end conversation checklist (manual, run by the user)

Gate C proves the wired product: voice and text turns reach a real backend with real tools, the
UI tracks the turn live, and cancel/switch behave. Run Gate B's login prerequisites first.

## Prerequisites

1. `npm install && npm run build` at the repo root (builds tools-mcp `dist/` — the backends
   launch `packages/tools-mcp/dist/index.js`).
2. Models fetched: `npm run fetch-models` (voice) — otherwise the app runs text-only and the
   main window shows the durable setup notice naming what is missing.
3. Claude login: run `claude` in a terminal once and sign in (spawned CLIs need their own
   login — see cdd/plan/amendments.md A9 machine blocker). Codex: `codex login`.
4. Settings → voice: Picovoice access key + keyword `jarvis` set. Settings → speak replies ON
   if you want spoken answers.
5. Start the app: `npm run dev` (or the built `out/`).

## 1. Google connect

- Settings → accounts: paste the Google client id + secret (docs/google-setup.md), click
  **connect google**.
- Browser opens, consent completes, the status line shows `google: connected as <email>`.
- Kill and restart the app: still connected (token persisted under userData).

## 2. "what's on my calendar today" — by voice

- Say: **"jarvis — what's on my calendar today?"**
- Expect, in order:
  - overlay fades in: `listening` + mic bars → `transcribing` → `thinking`;
  - overlay tool ticker shows `→ checking your calendar…` then `✓ calendar_list_events`;
  - the app **speaks** the tool summary ("checking your calendar.") and then the streamed
    answer, sentence by sentence, while the overlay shows the streaming reply;
  - main window: the turn appears live (your line, streaming assistant text, tool footnote),
    then settles as the persisted turn; the session list updates;
  - overlay fades out ~4s after idle.

## 3. Same question — by text

- Type `what's on my calendar today` in the command bar, Enter.
- Expect: the answer streams into the main window transcript with the tool footnote — and
  **nothing is spoken** (TTS is voice-only) and the overlay stays hidden.

## 4. Confirmation-visibility check (A5 pragmatic — docs/confirmation-design.md)

- By voice: **"jarvis — send an email to myself saying test"** (or any gmail_send-reaching ask).
- Expect: BEFORE the reply narrates the result, the app speaks the outward action ("sending an
  email to …") and the ticker + main-window footnote show it. The call is visible, not blocked.
- If it fails, the failure is spoken ("gmail send didn't work.") and the footnote shows `✕`.

## 5. Backend switch

- Say or type: **"ask codex what 17 times 23 is"**.
- Expect: the turn routes to Codex (session list shows the codex badge on the session), answers
  391. Codex replies arrive as one block (no incremental deltas — A9), then are spoken whole.
- Because the session already had Claude history, Codex's first turn silently receives a
  one-line context note (verify in reply coherence, e.g. "summarize what we just discussed").

## 6. Cancel

- Ask something long ("jarvis — explain how sqlite works in detail"), then press **Esc** in the
  main window while it is answering.
- Expect: speech stops immediately, the turn ends, state returns to idle. A follow-up question
  works normally.
- Repeat by voice with barge-in: say "jarvis" while it is speaking — it stops and listens.

## 7. Busy + error surfaces

- While a long turn is in flight, ask a second question: the app answers "One moment, still
  working." and the first turn continues; the refusal is NOT added to history.
- Stop the network / log out of codex and ask codex something: a readable error appears in the
  overlay + main window (durable setup problems appear as the settings status lines; transient
  errors clear after ~3s).

## 8. Tray

- Tray → **New session**: the next question starts a fresh session (session list gains a row on
  its first turn).
- Tray → **Pause listening**: wake word stops (tray label flips); **Resume listening** restores
  it. Text bar keeps working while paused.
