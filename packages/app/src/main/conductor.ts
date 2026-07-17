import type { AgentEvent, BackendId } from '../shared/types';
import type { AgentRouter } from '../agents/router';
import type { SessionStore } from '../agents/sessions';
import type { PushChannels } from './ipc';

/**
 * Conductor — the wire-and-converse seam extracted from src/main/index.ts (startup step 6) so
 * the whole utterance → router → events → TTS/IPC fanout is testable with all-fake deps
 * (cdd/tasks/wire-and-converse.md "Tests").
 *
 * Rules it owns (binding, from the task file + architecture.md):
 * - Voice utterance: every AgentEvent goes to BOTH `pipeline.onAgentEvent` (sentence-chunked
 *   TTS) AND the `agent:event` broadcast.
 * - Text command: same dispatch path, but events are ONLY broadcast — text-bar requests must
 *   never trigger TTS. TTS is exclusively for voice-initiated turns.
 * - A completed persisted TurnRecord is broadcast on `session:updated`. Synthetic unpersisted
 *   records (busy refusal, failed init) are NOT — the store stays the source of truth for the
 *   history view.
 * - Cancel fans out to `router.interrupt()` AND `pipeline.cancel()`.
 */

/** The slice of VoicePipeline the conductor drives. Null while in text-only mode. */
export interface ConductorPipeline {
  onAgentEvent(e: AgentEvent): void;
  cancel(): void;
}

/** Typed push broadcast (WindowManager.broadcast in production, a recording fake in tests). */
export type Broadcast = <K extends keyof PushChannels>(
  ch: K,
  ...args: Parameters<PushChannels[K]>
) => void;

export interface ConductorDeps {
  router: Pick<AgentRouter, 'dispatch' | 'interrupt'>;
  sessions: Pick<SessionStore, 'activeSession' | 'turns'>;
  /** Getter, not a value: the pipeline is constructed after IPC/tray wiring and may be absent
   * (text-only mode) or replaced (tray pause/resume). */
  pipeline: () => ConductorPipeline | null;
  broadcast: Broadcast;
}

export class Conductor {
  constructor(private readonly deps: ConductorDeps) {}

  /** Voice-initiated turn: events fan to the pipeline (chunker → TTS) AND the IPC broadcast. */
  async handleUtterance(text: string): Promise<void> {
    await this.run(text, undefined, (e) => {
      this.deps.pipeline()?.onAgentEvent(e);
      this.deps.broadcast('agent:event', e);
    });
  }

  /** Text-bar turn: same dispatch, broadcast only — never speaks (TTS is voice-only). */
  async handleText(text: string, backend?: BackendId): Promise<void> {
    await this.run(text, backend, (e) => {
      this.deps.broadcast('agent:event', e);
    });
  }

  /** Esc / pipeline:cancel: stop the in-flight turn everywhere. */
  async cancel(): Promise<void> {
    await this.deps.router.interrupt();
    this.deps.pipeline()?.cancel();
  }

  private async run(
    text: string,
    backend: BackendId | undefined,
    onEvent: (e: AgentEvent) => void
  ): Promise<void> {
    try {
      const record = await this.deps.router.dispatch(text, onEvent, backend);
      // Only persisted turns are pushed: busy refusals / failed inits return a synthetic record
      // that never reached the store, and the history view must mirror the store.
      const active = this.deps.sessions.activeSession();
      if (this.deps.sessions.turns(active.id).some((t) => t.id === record.id)) {
        this.deps.broadcast('session:updated', record);
      }
    } catch (err) {
      // Error policy (architecture.md): any module failure surfaces as agent:event {error}. The
      // router already forwards backend errors through onEvent; this catches wiring/store
      // failures so a turn can never vanish silently.
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ kind: 'error', message });
    }
  }
}
