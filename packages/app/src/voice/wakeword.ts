// WakeWordDetector implementation on Picovoice Porcupine — see cdd/plan/voice-pipeline.md
// ("WakeWordDetector") for the binding interface/behavior and cdd/tasks/wakeword.md for the task
// contract. Mirrors the shape of ./stt.ts and ./capture.ts (constructor-injected seams, hard
// guards, a production factory), but the injectable seam here is different: `@picovoice/
// porcupine-node` is a thin native-addon wrapper (no subprocess to fake), so tests mock the
// module itself with `vi.mock('@picovoice/porcupine-node', ...)` rather than injecting a spawn
// function. PorcupineWake imports the real `Porcupine`/`BuiltinKeyword` exports directly so that
// mock takes effect transparently.

import { Porcupine, BuiltinKeyword } from '@picovoice/porcupine-node';
import type { AudioFrame } from './capture';

export interface WakeWordConfig {
  accessKey: string;
  builtinKeyword: string | null;
  customKeywordPath: string | null;
  sensitivity: number;
}

export interface WakeWordDetector {
  init(cfg: WakeWordConfig): Promise<void>;
  process(frame: AudioFrame): boolean; // true exactly on the frame that completes the wake word
  release(): void;
}

/** Porcupine's required frame length (samples per `process()` call). Matches the fixed 512-
 * sample `AudioFrame` contract produced by capture.ts's Framer, so this is asserted as a literal
 * constant rather than read off the (mockable) `Porcupine.frameLength` getter — per
 * cdd/tasks/wakeword.md ("Frame contract guard"). */
const FRAME_LENGTH = 512;

/** Builtin keyword used when config supplies neither a custom `.ppn` path nor an explicit
 * builtin name — the plan's default wake word (overview.md decision 4). */
const DEFAULT_BUILTIN_KEYWORD = 'jarvis';

/** Resolves the single `keywords[0]` argument Porcupine's constructor expects: a custom
 * `.ppn` path (if configured — it always wins per cdd/plan/voice-pipeline.md) or a builtin
 * keyword resolved case-insensitively against Porcupine's `BuiltinKeyword` enum values (e.g.
 * "Jarvis", "JARVIS", "jarvis" all resolve to the same builtin). Throws a settings-UI-phrased
 * error if a builtin name is supplied but unrecognized. */
function resolveKeywordArg(cfg: WakeWordConfig): string {
  if (cfg.customKeywordPath) {
    return cfg.customKeywordPath;
  }

  const requested = (cfg.builtinKeyword ?? DEFAULT_BUILTIN_KEYWORD).trim().toLowerCase();
  const match = Object.values(BuiltinKeyword).find((v) => v.toLowerCase() === requested);
  if (!match) {
    throw new Error(
      `picovoice built-in wake word "${cfg.builtinKeyword}" not recognized — check settings`
    );
  }
  return match;
}

/** Rephrases whatever Porcupine's constructor throws (bad access key, bad/missing custom `.ppn`,
 * generic init failure) into wording aimed at the settings UI, per cdd/tasks/wakeword.md ("init
 * errors ... throw with messages phrased for the settings UI"). Porcupine's own error messages
 * are developer-facing (e.g. "File not found in 'keywords': ...", messages mentioning
 * "AccessKey"/"activation"), so this pattern-matches on the underlying message to pick the right
 * user-facing phrasing while preserving the original detail for debugging. */
function formatInitError(err: unknown, cfg: WakeWordConfig): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('accesskey') || lower.includes('access key') || lower.includes('activation')) {
    return new Error(`picovoice access key rejected — check settings (${raw})`);
  }

  if (cfg.customKeywordPath && (lower.includes('keyword') || lower.includes('.ppn') || lower.includes('file not found'))) {
    return new Error(`picovoice custom wake word file rejected — check settings (${raw})`);
  }

  return new Error(`picovoice initialization failed — check settings (${raw})`);
}

export class PorcupineWake implements WakeWordDetector {
  private porcupine: Porcupine | null = null;

  async init(cfg: WakeWordConfig): Promise<void> {
    const keywordArg = resolveKeywordArg(cfg);
    try {
      this.porcupine = new Porcupine(cfg.accessKey, [keywordArg], [cfg.sensitivity], {});
    } catch (err) {
      this.porcupine = null;
      throw formatInitError(err, cfg);
    }
  }

  process(frame: AudioFrame): boolean {
    if (!this.porcupine) {
      throw new Error('PorcupineWake.process: init() must be called before process()');
    }
    if (frame.samples.length !== FRAME_LENGTH) {
      throw new Error(
        `PorcupineWake.process: frame length ${frame.samples.length} !== required ${FRAME_LENGTH}`
      );
    }

    const keywordIndex = this.porcupine.process(frame.samples);
    return keywordIndex >= 0;
  }

  /** Idempotent: safe to call multiple times (including before init() or after an earlier
   * release()) — matches the `release` contract used elsewhere in the voice stack. */
  release(): void {
    if (!this.porcupine) return;
    this.porcupine.release();
    this.porcupine = null;
  }
}

/** Production factory — no extra wiring needed since Porcupine itself takes no provisioned
 * file paths beyond what init()'s config already supplies (accessKey / customKeywordPath). */
export function createWakeWordDetector(): WakeWordDetector {
  return new PorcupineWake();
}
