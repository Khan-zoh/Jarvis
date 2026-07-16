import type { BackendId, AgentEvent } from '../shared/types';

/**
 * A handle to an in-flight turn. The router keeps the most recent one so a barge-in / hotkey can
 * cancel the turn that is currently streaming.
 */
export interface TurnHandle {
  interrupt(): Promise<void>;
}

/**
 * A backend-agnostic agent. Concrete implementations (ClaudeBackend, CodexBackend) wrap a vendor
 * SDK; the router only ever sees this surface. See cdd/plan/agent-backends.md — this interface is
 * binding and later tasks depend on it verbatim.
 */
export interface AgentBackend {
  readonly id: BackendId;
  /** Verifies login / CLI availability. Returns `{ ok:false, problem }` with a setup message. */
  init(): Promise<{ ok: boolean; problem?: string }>;
  /**
   * Starts a turn. `onEvent` receives zero+ `text_delta`/`tool_start`/`tool_end` then exactly one
   * `done` or `error`. `result` resolves with the backend-native session id for resumption.
   */
  startTurn(args: {
    input: string;
    sessionId: string | null; // backend-native session/thread id to resume, or null for a new one
    onEvent: (e: AgentEvent) => void;
  }): Promise<{ handle: TurnHandle; result: Promise<{ finalText: string; sessionId: string }> }>;
}
