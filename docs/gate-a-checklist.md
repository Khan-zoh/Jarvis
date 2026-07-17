# Gate A — live voice-pipeline checklist (manual, run by you)

Everything automated is already green (`npm test`, real whisper-server round trip, `npm run
build`). This checklist covers the parts only a human with a mic and speakers can verify.
Estimated time: ~10 minutes.

## 0. Prerequisites (one-time)

1. **Models/binaries** — from the repo root:
   ```
   npm run fetch-models
   ```
   Must end with "All models present." (includes the new `models/bin/whisper-server.exe`).

2. **Picovoice access key** — the wake word needs a free key:
   - Get one at https://console.picovoice.ai (free tier is fine).
   - Put it in the app: the key is a secret, stored encrypted via the `secret:set` IPC channel
     (settings UI). If the settings UI isn't wired for it yet on your build, you can set it once
     from any renderer devtools console:
     ```js
     await window.jarvis.setSecret('picovoiceAccessKey', '<YOUR-KEY-HERE>')
     ```
     It lands encrypted in `%APPDATA%/jarvis/secrets.bin` (never plaintext in config.json).
   - The wake keyword defaults to the built-in **"jarvis"** (`voice.builtinKeyword` in
     `%APPDATA%/jarvis/config.json`); nothing to do unless you want a custom `.ppn`.
   - **Restart the app after setting the key** — voice prerequisites are checked at startup.

3. Speakers on, microphone connected (the default input device is used unless
   `voice.inputDeviceId` is set).

## 1. Start in echo mode

```
cd packages/app
npm run dev -- -- --echo
```

(The doubled `--`: the first is consumed by npm, the second by electron-vite, which forwards
`--echo` to the Electron main process.)

(`--echo` makes the pipeline speak your transcript back — the Gate A echo test. Without it the
pipeline logs the utterance and returns to idle after transcribing, since the agent router is
not wired until wire-and-converse.)

Watch the terminal for:
- `[main] voice pipeline started` — voice is live. If instead you see
  `[main] voice disabled (text-only mode): <reason>`, fix the named reason (missing models /
  key) and restart. The same reason is available to renderers via the `voice:status` channel:
  `await window.jarvis.voiceStatus()`.
- `[main] --echo: pipeline will speak transcripts back`

## 2. The checklist

| # | Step | Pass criteria |
|---|------|---------------|
| 1 | Say **"jarvis"** | Short click sound (assets/wake.wav) plays; overlay appears bottom-center with listening indicator; terminal/tray state flips to `listening` |
| 2 | **Wake → listening latency** | The overlay/indicator appears **< 300 ms** after you finish saying "jarvis" (subjective is fine; if in doubt, screen-record and count frames) |
| 3 | Say **"what time is it"**, then stop talking | ~0.8 s after you stop, state flips to `transcribing`, then the transcript appears in the overlay and `[voice] utterance: "..."` is logged. End-of-speech → text should be **< 2.5 s** (measured warm whisper-server is ~1.0 s) |
| 4 | **Echo** | The assistant speaks your words back (Piper voice), then returns to idle; overlay fades ~4 s later |
| 5 | Say nothing after waking | Wake it ("jarvis"), stay silent: after 8 s (`voice.listenTimeoutMs`) it returns to idle **without** transcribing |
| 6 | **Barge-in / echo-retrigger risk** (A6 known risk) | Wake it, say something long, and while it is speaking the echo back, say **"jarvis"** again: TTS must stop and it must listen again. Then check the risk: let it echo near your speakers at normal volume — its **own voice saying your words must not re-trigger wake/false listens**. If it self-triggers, note it: the documented fallback is disabling wake-during-speaking + hotkey interrupt |
| 7 | **Mic level bars** | While listening, the overlay's level bars move with your voice (driven by the new `mic:level` push channel) |
| 8 | **Tray pause/resume** | Tray → "Pause listening": saying "jarvis" does nothing (ffmpeg capture stopped). "Resume listening": wake works again |
| 9 | **No orphans on quit** | Tray → Quit, then check Task Manager: no `ffmpeg.exe`, `whisper-server.exe`, `piper.exe`, or `ffplay.exe` left behind |

## 3. Latency components to note (A6 asks for them separately)

While doing step 3, note from the logs/feel:
- capture → endpoint (fixed ~0.8 s silence tail by design)
- STT (logged in the transcript event timing; warm whisper-server measured **~1.0 s**)
- first TTS audio after transcript (echo mode: one piper spawn, ~0.5–1 s)
- total wake → echo-finished

## 4. If something fails

- **Voice never starts**: `await window.jarvis.voiceStatus()` in any renderer devtools gives the
  exact reason string.
- **whisper-server suspicion**: the pipeline silently falls back to per-spawn whisper-cli if the
  server dies (transcription then takes ~3+ s — that slowness is itself the symptom). Check for
  a running `whisper-server.exe` in Task Manager while the app is up.
- **Wake word never fires**: verify the key (step 0.2), then run
  `node scripts/smoke/smoke-wakeword.ts` for a live detector printout.
- **VAD/endpointing doubts**: `node scripts/smoke/smoke-vad.ts` prints per-frame speech/silence
  live from your mic.
