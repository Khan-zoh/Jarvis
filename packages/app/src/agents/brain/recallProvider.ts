import type { BrainStore } from '@jarvis/tools-mcp/brain/store';
import type { AppConfig } from '../../shared/types';
import type { ContextProvider } from '../seams';

/**
 * Recall ContextProvider (binding: cdd/plan/second-brain.md "Recall (smart hybrid)").
 *
 * Prepends a preamble to each turn built from two sources:
 *  1. profile.md — the small always-on "who the user is" (baseline "it knows me").
 *  2. above-threshold semantic hits — the top note snippets whose hybrid score clears
 *     `recallThreshold`, so unrelated requests inject nothing and stay fast.
 *
 * Recall mode (cfg.secondBrain.recallMode):
 *  - hybrid    → profile + above-threshold hits (the default).
 *  - on-demand → profile only; notes reach the model only when it calls brain_search itself.
 *  - proactive → profile + every note with any hit (minScore 0).
 *
 * Token-budgeted: the profile and the notes section are each clamped so a large vault can never
 * blow the system-prompt budget. Gated on cfg.secondBrain.enabled (returns null when off).
 */

/** ~4 chars per token — the same heuristic the store uses for its profile budget. */
const CHARS_PER_TOKEN = 4;

export interface RecallProviderOptions {
  /** The shared BrainStore (app owns one instance; A8). */
  store: Pick<BrainStore, 'profile' | 'search'>;
  /** Minimum hybrid score for a note to be injected in hybrid mode. Default 0.4. */
  recallThreshold?: number;
  /** Max note hits considered. Default 4. */
  topK?: number;
  /** Approx token budget for the profile section. Default 500. */
  profileTokenBudget?: number;
  /** Approx token budget for the notes section. Default 400. */
  notesTokenBudget?: number;
}

function clampToTokens(text: string, tokenBudget: number): string {
  const budget = tokenBudget * CHARS_PER_TOKEN;
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > budget / 2 ? cut.slice(0, lastSpace) : cut).replace(/\s+$/, '');
}

function estTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function createRecallProvider(opts: RecallProviderOptions): ContextProvider {
  const { store } = opts;
  const recallThreshold = opts.recallThreshold ?? 0.4;
  const topK = opts.topK ?? 4;
  const profileBudget = opts.profileTokenBudget ?? 500;
  const notesBudget = opts.notesTokenBudget ?? 400;

  return {
    id: 'brain-recall',
    async contribute(utterance: string, cfg: AppConfig): Promise<string | null> {
      if (!cfg.secondBrain.enabled) return null;
      const parts: string[] = [];

      // 1. Profile — always injected when non-empty (baseline "it knows me").
      const profile = (await store.profile()).trim();
      if (profile) {
        parts.push(`About the user (from their profile):\n${clampToTokens(profile, profileBudget)}`);
      }

      // 2. Semantic hits — skipped in on-demand mode; unthresholded in proactive mode.
      const mode = cfg.secondBrain.recallMode;
      if (mode !== 'on-demand' && utterance.trim()) {
        const minScore = mode === 'proactive' ? 0 : recallThreshold;
        const hits = await store.search(utterance, { k: topK, minScore });
        const lines: string[] = [];
        let used = 0;
        for (const h of hits) {
          const line = `- ${h.note.title}: ${h.snippet}`;
          const t = estTokens(line);
          if (used + t > notesBudget) break;
          used += t;
          lines.push(line);
        }
        if (lines.length > 0) {
          parts.push(`Relevant notes from the user's second brain:\n${lines.join('\n')}`);
        }
      }

      return parts.length > 0 ? parts.join('\n\n') : null;
    }
  };
}
