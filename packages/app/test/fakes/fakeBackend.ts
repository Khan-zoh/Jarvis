import type { AgentEvent, BackendId } from '../../src/shared/types';
import type { AgentBackend, TurnHandle } from '../../src/agents/types';

/**
 * One scripted turn for a FakeBackend. Events are emitted in order (a microtask apart) after
 * `startTurn` returns its handle.
 */
export interface ScriptedTurn {
  /** Events to emit, in order. A terminal `done`/`error` should be last (unless `hold`). */
  events: AgentEvent[];
  /** Backend-native session id resolved by `result` (default `<id>-native-<n>`). */
  sessionId?: string;
  /**
   * When true the turn never terminates on its own: after emitting `events` it stays in flight
   * until `interrupt()` is called, then emits `error {message:'cancelled'}` and rejects.
   * Use this to exercise the busy guard and interrupt delegation.
   */
  hold?: boolean;
}

/**
 * A scripted, in-memory AgentBackend for tests. Each `startTurn` consumes the next script in
 * order (or a default one-shot `done` turn when none is queued) and records the call so tests
 * can assert on routed input and resumed session ids.
 */
export class FakeBackend implements AgentBackend {
  readonly id: BackendId;
  /** What `init()` resolves with; mutate to simulate a login/setup failure. */
  initResult: { ok: boolean; problem?: string } = { ok: true };
  /** Every `startTurn` call, in order. */
  readonly calls: { input: string; sessionId: string | null }[] = [];
  /** How many times a handle's `interrupt()` was invoked. */
  interrupts = 0;

  private readonly scripts: ScriptedTurn[] = [];
  private turnCount = 0;

  constructor(id: BackendId, scripts: ScriptedTurn[] = []) {
    this.id = id;
    this.scripts.push(...scripts);
  }

  /** Queues another scripted turn. Chainable. */
  script(turn: ScriptedTurn): this {
    this.scripts.push(turn);
    return this;
  }

  async init(): Promise<{ ok: boolean; problem?: string }> {
    return this.initResult;
  }

  async startTurn(args: {
    input: string;
    sessionId: string | null;
    onEvent: (e: AgentEvent) => void;
  }): Promise<{ handle: TurnHandle; result: Promise<{ finalText: string; sessionId: string }> }> {
    this.calls.push({ input: args.input, sessionId: args.sessionId });
    const n = ++this.turnCount;
    const script: ScriptedTurn =
      this.scripts.shift() ?? { events: [{ kind: 'done', finalText: 'ok' }] };
    const native = script.sessionId ?? `${this.id}-native-${n}`;

    let onInterrupted!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      onInterrupted = resolve;
    });
    const handle: TurnHandle = {
      interrupt: async () => {
        this.interrupts += 1;
        onInterrupted();
      }
    };

    const result = (async (): Promise<{ finalText: string; sessionId: string }> => {
      // Yield once so the caller has the handle before any event lands.
      await Promise.resolve();
      let finalText = '';
      for (const e of script.events) {
        args.onEvent(e);
        if (e.kind === 'done') finalText = e.finalText;
        if (e.kind === 'error') throw new Error(e.message);
        await Promise.resolve();
      }
      if (script.hold) {
        await interrupted;
        args.onEvent({ kind: 'error', message: 'cancelled' });
        throw new Error('cancelled');
      }
      return { finalText, sessionId: native };
    })();
    // Mark potential rejection as handled: the router (or test) attaches its own handler later.
    result.catch(() => {});

    return { handle, result };
  }
}
