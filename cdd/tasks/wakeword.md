# Task: wakeword

## Objective
Implement `WakeWordDetector` (src/voice/wakeword.ts) on Picovoice Porcupine.

## Read first
- cdd/plan/voice-pipeline.md — WakeWordDetector interface (binding).
- cdd/plan/overview.md — decision 4.

## Deliverables
- `PorcupineWake implements WakeWordDetector` via `@picovoice/porcupine-node`:
  custom `.ppn` path wins over builtin keyword; builtin resolved case-insensitively against
  Porcupine's BuiltinKeyword enum ("jarvis" default); sensitivity from config.
  `init` errors (bad key, bad ppn) throw with messages phrased for the settings UI
  ("picovoice access key rejected — check settings").
- Frame contract guard: assert frame length 512 (matches `Porcupine.frameLength`).
- `docs/wakeword-setup.md`: how to get a free Picovoice access key, and how to train a custom
  "Hey <Name>" .ppn on console.picovoice.ai (Windows platform target).
- `scripts/smoke/smoke-wakeword.ts`: capture → detector, prints "WAKE" with timestamp on
  detection; requires `PICOVOICE_ACCESS_KEY` env var.

## Tests
- Unit with mocked porcupine-node module: init param mapping (custom-over-builtin precedence,
  sensitivity passthrough), process returns true only when mock returns keyword index ≥ 0,
  release idempotent.
- No real-key tests in CI.

## Acceptance
- `npm test` passes. Manual: smoke script detects spoken "jarvis" reliably (≥4 of 5 tries,
  note result) with a real access key.
