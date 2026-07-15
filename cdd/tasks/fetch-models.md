# Task: fetch-models

## Objective
Implement `scripts/fetch-models.ts`: downloads and checksum-verifies every binary/model the
voice stack needs into `models/`, idempotently, with a clear progress report.

## Read first
- cdd/plan/voice-pipeline.md — "Model/binary provisioning" section (ModelSpec interface).

## Deliverables
- `scripts/fetch-models.ts` implementing `REQUIRED_MODELS` + `fetchModels(force?)`:
  1. whisper.cpp Windows x64 release zip (ggml-org/whisper.cpp GitHub releases) → extract
     `whisper-cli.exe` + DLLs → `models/bin/`.
  2. `ggml-small.en.bin` from HuggingFace ggerganov/whisper.cpp → `models/whisper/`.
  3. Piper Windows amd64 release zip (rhasspy/piper) → `models/bin/piper/`.
  4. Piper voice `en_US-lessac-medium.onnx` + `.json` (rhasspy/piper-voices HF) → `models/piper/`.
  5. `silero_vad.onnx` (snakers4/silero-vad repo, v4 model) → `models/vad/`.
  6. `bge-small-en-v1.5` ONNX model + tokenizer (BAAI/bge-small-en-v1.5, onnx export) →
     `models/embed/` — the second-brain embedder (384-dim). Only fetched if a `--with-brain`
     flag or config `secondBrain.enabled` is set, but include it in `REQUIRED_MODELS` with a
     `group: 'brain'` field so callers can select.
- Pin exact release URLs + sha256 at authoring time (fetch and hash them while implementing;
  record real hashes — do NOT leave placeholders).
- Behavior: skip when file exists AND hash matches; re-download on mismatch; `--force` flag;
  summary table printed at end; non-zero exit on any failure.
- `src/main/modelPaths.ts` in the app: `resolveModelPaths(): { whisperCli, whisperModel,
  piperExe, piperVoice, sileroVad, embedModel?, embedTokenizer? } | { missing: string[] }` —
  single source for "are models present", used by startup and settings UI. Embedder paths are
  only required when the second brain is enabled.
- Root script `npm run fetch-models` wired.

## Tests
- Unit: hash-verify + skip logic against tiny temp files with a fake spec list (no network).
- `resolveModelPaths` returns `missing` list correctly on empty dir.
- Manual (documented in the task PR/commit message): full run completes on a clean checkout;
  second run prints all-skipped.

## Acceptance
- `npm test` passes; `npm run fetch-models` twice on a clean machine → first downloads all,
  second is a fast no-op; `models/` is gitignored.
