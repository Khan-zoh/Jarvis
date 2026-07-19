// Single source of truth for "are the voice-stack models present on disk". Used by app startup
// (to decide whether to prompt the user to run `npm run fetch-models`) and by the settings UI
// (to show model status). See cdd/plan/voice-pipeline.md ("Model/binary provisioning") and
// cdd/tasks/fetch-models.md for the contract this implements.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ModelPaths {
  whisperCli: string;
  /** Persistent whisper-server.exe (cdd/plan/amendments.md A6). Optional/best-effort: populated
   * only when the file is present. Its absence does NOT gate voice — the pipeline falls back to
   * the per-spawn whisperCli — so it is deliberately kept OUT of the required `missing` list. */
  whisperServer?: string;
  whisperModel: string;
  piperExe: string;
  piperVoice: string;
  sileroVad: string;
  wakeMelSpectrogram: string;
  wakeEmbedding: string;
  wakeWordModel: string;
  /** ffmpeg.exe / ffplay.exe are provisioned artifacts (cdd/plan/amendments.md A6) — audio
   * capture and TTS playback take these paths as constructor args and never resolve ffmpeg
   * from PATH. */
  ffmpegExe: string;
  ffplayExe: string;
  /** Only populated (and only required) when the second brain is enabled. */
  embedModel?: string;
  /** Only populated (and only required) when the second brain is enabled. */
  embedTokenizer?: string;
}

export interface ModelPathsMissing {
  missing: string[];
}

export interface ResolveModelPathsOptions {
  /** Directory models were fetched into. Defaults to `<cwd>/models`, matching where
   * `scripts/fetch-models.ts` writes by default when run from the repo root. */
  modelsRoot?: string;
  /** Whether the second brain feature is enabled — gates whether the embedder files are
   * required for the result to be considered complete. */
  brainEnabled?: boolean;
}

function defaultModelsRoot(): string {
  return resolve(process.cwd(), 'models');
}

/**
 * Resolves every model/binary path the voice pipeline (and, if enabled, the second-brain
 * embedder) needs. Returns the full path bundle if everything required is present on disk, or
 * `{ missing: [...] }` naming which pieces are absent so the caller can prompt the user to run
 * `npm run fetch-models` (optionally with `--with-brain`).
 */
export function resolveModelPaths(
  opts: ResolveModelPathsOptions = {}
): ModelPaths | ModelPathsMissing {
  const modelsRoot = opts.modelsRoot ?? defaultModelsRoot();
  const brainEnabled = opts.brainEnabled ?? false;

  const whisperCli = join(modelsRoot, 'bin', 'whisper-cli.exe');
  const whisperServer = join(modelsRoot, 'bin', 'whisper-server.exe');
  const whisperModel = join(modelsRoot, 'whisper', 'ggml-small.en.bin');
  const piperExe = join(modelsRoot, 'bin', 'piper', 'piper.exe');
  const piperVoice = join(modelsRoot, 'piper', 'en_US-lessac-medium.onnx');
  const piperVoiceConfig = join(modelsRoot, 'piper', 'en_US-lessac-medium.onnx.json');
  const sileroVad = join(modelsRoot, 'vad', 'silero_vad.onnx');
  const wakeMelSpectrogram = join(modelsRoot, 'wakeword', 'melspectrogram.onnx');
  const wakeEmbedding = join(modelsRoot, 'wakeword', 'embedding_model.onnx');
  const wakeWordModel = join(modelsRoot, 'wakeword', 'hey_jarvis_v0.1.onnx');
  const ffmpegExe = join(modelsRoot, 'bin', 'ffmpeg', 'ffmpeg.exe');
  const ffplayExe = join(modelsRoot, 'bin', 'ffmpeg', 'ffplay.exe');
  const embedModel = join(modelsRoot, 'embed', 'model.onnx');
  const embedTokenizer = join(modelsRoot, 'embed', 'tokenizer.json');

  const missing: string[] = [];
  if (!existsSync(whisperCli)) missing.push('whisperCli');
  if (!existsSync(whisperModel)) missing.push('whisperModel');
  if (!existsSync(piperExe)) missing.push('piperExe');
  if (!existsSync(piperVoice) || !existsSync(piperVoiceConfig)) missing.push('piperVoice');
  if (!existsSync(sileroVad)) missing.push('sileroVad');
  if (!existsSync(wakeMelSpectrogram)) missing.push('wakeMelSpectrogram');
  if (!existsSync(wakeEmbedding)) missing.push('wakeEmbedding');
  if (!existsSync(wakeWordModel)) missing.push('wakeWordModel');
  if (!existsSync(ffmpegExe)) missing.push('ffmpegExe');
  if (!existsSync(ffplayExe)) missing.push('ffplayExe');
  if (brainEnabled) {
    if (!existsSync(embedModel)) missing.push('embedModel');
    if (!existsSync(embedTokenizer)) missing.push('embedTokenizer');
  }

  if (missing.length > 0) {
    return { missing };
  }

  const result: ModelPaths = {
    whisperCli,
    whisperModel,
    piperExe,
    piperVoice,
    sileroVad,
    wakeMelSpectrogram,
    wakeEmbedding,
    wakeWordModel,
    ffmpegExe,
    ffplayExe
  };
  // Best-effort: expose the resident-server path only when it is actually on disk. Callers use its
  // presence to decide WhisperServerStt vs. the WhisperCppStt fallback.
  if (existsSync(whisperServer)) result.whisperServer = whisperServer;
  if (brainEnabled) {
    result.embedModel = embedModel;
    result.embedTokenizer = embedTokenizer;
  }
  return result;
}
