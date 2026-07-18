import type { BrainStore } from '@jarvis/tools-mcp/brain/store';
import type { AppConfig, CapturedNote, TurnRecord } from '../../shared/types';
import type { TurnObserver } from '../seams';
import type { CaptureExtractor } from './distill';

/**
 * Auto-capture TurnObserver (binding: cdd/plan/second-brain.md "Capture", amendments.md A8).
 *
 * After a completed turn (the router fires observers detached, so this never delays the reply):
 *  1. Skips entirely when the turn is off the record, when the second brain is disabled, when
 *     auto-capture is off (the global "pause capture" toggle), or when the turn is trivial.
 *  2. Runs the extraction DistillFn over the exchange via the current backend.
 *  3. Adds each durable item as a `source:'auto'` note (dedup-aware, one file per item — A8),
 *     and emits a `brain:captured` event per stored item for the "noted:" UI.
 *
 * Off the record (A8): capture is skipped, but the turn itself is still persisted to session
 * history — that persistence is the router's job (it appends the TurnRecord before firing
 * observers), so here we simply do nothing.
 */

export interface CaptureObserverOptions {
  store: Pick<BrainStore, 'add'>;
  extract: CaptureExtractor;
  getConfig: () => AppConfig;
  /** Emits `brain:captured` for each stored item (overlay "noted:" + recently-captured strip). */
  onCaptured: (note: CapturedNote) => void;
  /** Minimum user-text length to bother distilling. Default 1 (skip only empty turns). */
  minUserChars?: number;
}

/** True when a turn is too thin to hold a durable fact (failed/empty turns). */
function isTrivial(turn: TurnRecord, minUserChars: number): boolean {
  return turn.userText.trim().length < minUserChars || turn.assistantText.trim() === '';
}

export function createCaptureObserver(opts: CaptureObserverOptions): TurnObserver {
  const { store, extract, getConfig, onCaptured } = opts;
  const minUserChars = opts.minUserChars ?? 1;

  return {
    id: 'brain-capture',
    async onTurn(turn: TurnRecord, flags: { offTheRecord: boolean }): Promise<void> {
      if (flags.offTheRecord) return;
      const cfg = getConfig();
      if (!cfg.secondBrain.enabled || !cfg.secondBrain.autoCapture) return;
      if (isTrivial(turn, minUserChars)) return;

      const items = await extract({ user: turn.userText, assistant: turn.assistantText });
      for (const item of items) {
        const note = await store.add({
          title: item.title,
          body: item.body,
          tags: item.tags ?? [],
          source: 'auto'
        });
        onCaptured({ id: note.id, title: note.title, at: note.updated });
      }
    }
  };
}
