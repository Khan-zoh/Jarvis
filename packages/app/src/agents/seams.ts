import type { AppConfig, TurnRecord } from '../shared/types';

/**
 * Turn seams — generic hooks the router runs around every turn. They keep the second brain (and
 * any future context source) out of the router's core: the router doesn't know what a "brain" is,
 * only that providers may add context before a turn and observers may react after one.
 * See cdd/plan/agent-backends.md — these interfaces are binding.
 */

export interface ContextProvider {
  id: string;
  /** Return text to prepend to this turn's input (as a "context" preamble), or null to add nothing. */
  contribute(utterance: string, cfg: AppConfig): Promise<string | null>;
}

export interface TurnObserver {
  id: string;
  /** Fired after a turn fully completes; may not block the reply (run detached, errors swallowed+logged). */
  onTurn(turn: TurnRecord, flags: { offTheRecord: boolean }): Promise<void>;
}
