import type { AppConfig } from '../shared/types';

/**
 * Reactive voice pipeline lifecycle (settings-ui task: "voice prereqs checked at startup only —
 * ADD reactive re-init"). Startup gating (src/main/index.ts's `startVoicePipeline`) only ever ran
 * once; a settings change to the Picovoice key, wake keyword, input device, or a model path had no
 * effect until the app was restarted. `VoiceManager` fixes that: it watches `config:changed` and,
 * when a voice-relevant field actually changed, tears down whatever is currently running (a live
 * runtime, or nothing in text-only mode) and rebuilds from scratch via the injected `build()`.
 *
 * Deliberately generic over the runtime type `R` (src/main/index.ts's `VoiceRuntime`) and over
 * `build`/`dispose` so this class is testable with trivial fakes — no VoicePipeline, no Electron,
 * no audio.
 */

export type VoiceBuildResult<R> = R | { reason: string };

function isRuntime<R>(r: VoiceBuildResult<R>): r is R {
  return !(typeof r === 'object' && r !== null && 'reason' in r);
}

export interface VoiceManagerDeps<R> {
  /** Builds a fresh voice runtime from the CURRENT config. Returns `{ reason }` for text-only mode
   * (missing models/binaries, no Picovoice key, no keyword — same contract as the original
   * `startVoicePipeline`). */
  build: () => Promise<VoiceBuildResult<R>>;
  /** Tears down a previously built runtime. Never called for a `{ reason }` result. */
  dispose: (runtime: R) => Promise<void> | void;
  /** Notified after every build (initial and every rebuild) with the new current result. */
  onChange: (result: VoiceBuildResult<R>) => void;
  /** Extracts the voice-relevant subset of config to diff across changes. Defaults to the fields
   * that actually gate/parameterize the pipeline: Picovoice key, keyword (builtin + custom path),
   * sensitivity, input device, and the STT/TTS model paths. */
  voiceKey?: (c: AppConfig) => unknown;
}

function defaultVoiceKey(c: AppConfig): unknown {
  return {
    picovoiceAccessKey: c.voice.picovoiceAccessKey,
    builtinKeyword: c.voice.builtinKeyword,
    customKeywordPath: c.voice.customKeywordPath,
    sensitivity: c.voice.sensitivity,
    inputDeviceId: c.voice.inputDeviceId,
    sttModelPath: c.voice.sttModelPath,
    ttsVoicePath: c.voice.ttsVoicePath
  };
}

export class VoiceManager<R> {
  private readonly voiceKey: (c: AppConfig) => unknown;
  private currentResult: VoiceBuildResult<R> | null = null;
  private lastKey: string | null = null;
  /** Serializes rebuilds so overlapping config:changed bursts never race two builds at once. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VoiceManagerDeps<R>) {
    this.voiceKey = deps.voiceKey ?? defaultVoiceKey;
  }

  /** The most recently built result, or null before `init()` has run. */
  get current(): VoiceBuildResult<R> | null {
    return this.currentResult;
  }

  /** First build, at app startup. Establishes the baseline key so the first `config:changed`
   * (e.g. a name change that ships in the same tick) does not spuriously rebuild. */
  async init(initialConfig: AppConfig): Promise<VoiceBuildResult<R>> {
    this.lastKey = this.keyOf(initialConfig);
    const result = await this.deps.build();
    this.currentResult = result;
    return result;
  }

  /** Call on every `config:changed`. Rebuilds iff a voice-relevant field actually changed;
   * a change to an unrelated field (agent name, hotkey, google, …) is a no-op. */
  onConfigChanged(c: AppConfig): void {
    const key = this.keyOf(c);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.chain = this.chain.then(() => this.rebuild());
  }

  /** Forces a teardown + rebuild regardless of config (settings-ui: after `models:fetch`
   * completes, newly-downloaded models can satisfy startup prerequisites that no config field
   * reflects). Serialized on the same chain as config-driven rebuilds. */
  refresh(): Promise<void> {
    this.chain = this.chain.then(() => this.rebuild());
    return this.chain;
  }

  private keyOf(c: AppConfig): string {
    return JSON.stringify(this.voiceKey(c));
  }

  private async rebuild(): Promise<void> {
    const prev = this.currentResult;
    if (prev && isRuntime(prev)) {
      await this.deps.dispose(prev);
    }
    const result = await this.deps.build();
    this.currentResult = result;
    this.deps.onChange(result);
  }
}
