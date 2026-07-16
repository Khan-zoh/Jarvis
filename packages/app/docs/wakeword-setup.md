# wake word setup (Porcupine)

Jarvis's wake-word detection (`src/voice/wakeword.ts`, `PorcupineWake`) runs on Picovoice
Porcupine (`@picovoice/porcupine-node`). It needs an access key and, if you want a custom name
other than "Jarvis", a trained `.ppn` keyword file. Both are free.

## 1. get a free access key

1. Go to <https://console.picovoice.ai/> and sign up (free tier — no credit card).
2. Once logged in, the console's dashboard shows your **AccessKey** — a long string, e.g.
   `AbCd1234...==`. Copy it.
3. Paste it into Jarvis's settings UI (Voice → Picovoice access key). It's stored encrypted via
   Windows DPAPI (Electron `safeStorage`), never written to `config.json` in plaintext — see
   `src/main/config.ts`.

The free tier is rate-limited per rolling month but comfortably covers a single always-on
desktop assistant; Porcupine only calls out to Picovoice's servers once, at init, to validate the
key (detection itself runs fully offline/on-device afterward).

If the key is wrong or has been revoked, `PorcupineWake.init()` throws an error phrased for the
settings UI (something like `picovoice access key rejected — check settings`) — paste a fresh
key from the console and retry.

## 2. built-in keyword (default: "jarvis")

Porcupine ships several built-in wake words for free, and **"Jarvis" is one of them** — this is
why the plan's default requires no training step at all. If you're happy with "Hey Jarvis" /
"Jarvis" as the wake word, you can stop here: leave `customKeywordPath` unset and
`builtinKeyword` as `"jarvis"` (case-insensitive) in settings.

Other built-ins available the same way (set `builtinKeyword` to any of these, case-insensitive):
`alexa`, `americano`, `blueberry`, `bumblebee`, `computer`, `grapefruit`, `grasshopper`,
`hey google`, `hey siri`, `ok google`, `picovoice`, `porcupine`, `terminator`.

## 3. training a custom "Hey \<Name\>" wake word (optional)

If you want the assistant to respond to a different/custom name:

1. Go to <https://console.picovoice.ai/> and open **Porcupine** → **Create Wake Word**.
2. Type the phrase you want (e.g. "Hey Otto"). The console shows a pronunciation preview —
   check it sounds right before training; oddly-spelled words can produce a bad model.
3. Under **Platform**, choose **Windows**. This matters: a `.ppn` file trained for one platform
   will not load on another — Porcupine's Node binding validates the file against the running
   OS's binding and throws a `PorcupineInvalidArgumentError` if it doesn't match.
4. Click **Train**. The console generates a `.ppn` file (near-instant on the free tier) and
   offers it for download.
5. Save the downloaded `<name>_windows.ppn` file somewhere durable, e.g.
   `models/wakeword/hey-otto_windows.ppn` under this repo's (gitignored) `models/` directory —
   the same place `scripts/fetch-models.ts` provisions everything else.
6. In settings, set the custom keyword path to that file's absolute path. Per
   `cdd/plan/voice-pipeline.md`, **a custom keyword path always wins over `builtinKeyword`** when
   both are set — so leave `builtinKeyword` alone; it's simply ignored while a custom path is
   configured.

Free-tier accounts can train and keep a small number of custom wake words at a time; check the
console's current limits if training fails with a quota-style error.

## 4. sensitivity

`sensitivity` (0–1, default `0.6` — see `DEFAULT_CONFIG.voice.sensitivity` in
`src/main/config.ts`) trades false accepts for false rejects: higher catches more true "wake"
utterances but also more false positives from background noise/speech; lower is quieter but may
require repeating the wake word. Adjust in settings and re-test with the smoke script below.

## 5. verifying detection

Run the manual smoke script (not part of `npm test` — needs a real mic and a real access key):

```
set PICOVOICE_ACCESS_KEY=<your key>
npx tsx scripts/smoke/smoke-wakeword.ts
```

It records from the default mic, feeds frames to `PorcupineWake`, and prints `WAKE <timestamp>`
each time the configured wake word is detected. Say the wake word 5 times; per
`cdd/tasks/wakeword.md` acceptance, it should detect at least 4 of 5 tries reliably at normal
speaking volume/distance. Press Ctrl+C to stop.
