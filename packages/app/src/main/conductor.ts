import type { AgentEvent, BackendId } from '../shared/types';
import type { AgentRouter } from '../agents/router';
import type { SessionStore } from '../agents/sessions';
import type { OffTheRecordResult } from '../agents/brain/offTheRecord';
import { OFF_THE_RECORD_ACK } from '../agents/brain/offTheRecord';
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
  router: Pick<AgentRouter, 'dispatch' | 'interrupt' | 'setOffTheRecord' | 'busy'>;
  sessions: Pick<SessionStore, 'activeSession' | 'turns'>;
  /** Getter, not a value: the pipeline is constructed after IPC/tray wiring and may be absent
   * (text-only mode) or replaced (tray pause/resume). */
  pipeline: () => ConductorPipeline | null;
  broadcast: Broadcast;
  /**
   * Off-the-record hook (second brain). Present only when the brain is enabled. `detect` marks an
   * utterance; `forgetLast` removes the most recent auto-capture for "forget that". A bare
   * directive is acknowledged and NOT dispatched; a directive with real content sets the router
   * flag (capture skipped, turn still persisted — A8) and dispatches the remainder.
   */
  offTheRecord?: {
    detect: (text: string) => OffTheRecordResult;
    forgetLast?: () => Promise<unknown> | void;
  };
}

export class Conductor {
  constructor(private readonly deps: ConductorDeps) {}

  /** The router.dispatch currently in flight (never rejects), so a barge-in can await its full
   * settlement — including the router's finally that clears the busy flag. Null when idle. */
  private inFlightDispatch: Promise<void> | null = null;

  /** Set by notifyBargeIn(): resolves once the interrupted turn has fully died (backend interrupt
   * delivered AND the router's busy flag cleared). The next run() awaits it before dispatching,
   * so a barge-in replacement utterance can never race the dying turn into a busy refusal. */
  private pendingBargeIn: Promise<void> | null = null;

  /** Bumped per voice turn AND on barge-in, so a barged-in turn's late events (its terminal
   * `error:'cancelled'`, stray deltas) never reach the pipeline — they could otherwise land
   * while the REPLACEMENT turn is thinking and kill it via the pipeline's error path. */
  private voiceGen = 0;

  /** Voice-initiated turn: events fan to the pipeline (chunker → TTS) AND the IPC broadcast. */
  async handleUtterance(text: string): Promise<void> {
    const gen = ++this.voiceGen;
    await this.run(text, undefined, (e) => {
      // Stale (barged-in / superseded) voice turns are broadcast-only: renderers still see the
      // terminal event, but the pipeline — already driving the replacement turn — must not.
      if (gen === this.voiceGen) this.deps.pipeline()?.onAgentEvent(e);
      this.deps.broadcast('agent:event', e);
    });
  }

  /**
   * Barge-in (release blocker B1): the pipeline detected the wake word while SPEAKING and has
   * already cancelled TTS + abandoned the turn locally. This is the backend half: interrupt the
   * in-flight router turn NOW (exactly once — router.interrupt() is a no-op when nothing is in
   * flight) and remember the settlement so the replacement utterance dispatches only after the
   * router's busy flag is genuinely clear. Synchronous by design — it is called from the
   * pipeline's frame path and must never block audio handling.
   */
  notifyBargeIn(): void {
    this.voiceGen += 1; // orphan the dying turn's pipeline fanout (broadcast still flows)
    const dying = this.inFlightDispatch;
    this.pendingBargeIn = (async (): Promise<void> => {
      await this.deps.router.interrupt();
      // interrupt() resolving only means the handle was told to die; the dispatch promise
      // settling is what guarantees the router's finally ran and `busy` is false again.
      if (dying) await dying;
    })().catch(() => {});
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
    // Barge-in ordering (B1): if a barge-in interrupt is pending, wait for the interrupted turn
    // to fully settle (busy flag cleared) BEFORE dispatching — no race, no busy refusal.
    const settled = this.pendingBargeIn;
    if (settled) {
      this.pendingBargeIn = null;
      await settled;
    }
    // Tracked (never-rejecting) mirror of the dispatch that OCCUPIES the router — a busy-refusal
    // dispatch resolves without occupying it and must not clobber the real turn's tracking.
    let mine: Promise<void> | null = null;
    try {
      let input = text;
      // Off-the-record pre-check (second brain, A8): runs before dispatch so the router's
      // per-turn flag is set before it consumes it.
      const otr = this.deps.offTheRecord?.detect(text);
      if (otr?.offTheRecord) {
        if (otr.forget) void Promise.resolve(this.deps.offTheRecord?.forgetLast?.()).catch(() => {});
        if (otr.standalone) {
          // Nothing left to answer: acknowledge and stop — no backend, no persisted turn.
          onEvent({ kind: 'text_delta', text: OFF_THE_RECORD_ACK });
          onEvent({ kind: 'done', finalText: OFF_THE_RECORD_ACK });
          return;
        }
        this.deps.router.setOffTheRecord(true);
        input = otr.cleaned;
      }
      const wasBusy = this.deps.router.busy;
      const dispatched = this.deps.router.dispatch(input, onEvent, backend);
      if (!wasBusy) {
        mine = dispatched.then(
          () => undefined,
          () => undefined
        );
        this.inFlightDispatch = mine;
      }
      const record = await dispatched;
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
    } finally {
      if (mine !== null && this.inFlightDispatch === mine) this.inFlightDispatch = null;
    }
  }
}
