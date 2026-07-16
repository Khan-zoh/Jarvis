/**
 * Second-brain shared types (binding: cdd/plan/second-brain.md as amended by
 * cdd/plan/amendments.md A8).
 */

export type NoteSource = 'voice' | 'auto' | 'manual';

export interface Note {
  /** Stable short id (8 hex chars), also the trailing `-<shortid>` of the filename. */
  id: string;
  /** Vault-relative path with forward slashes, e.g. `notes/coffee-prefs-1a2b3c4d.md`. */
  path: string;
  title: string;
  body: string;
  tags: string[];
  source: NoteSource;
  /** ISO-8601 timestamp. */
  created: string;
  /** ISO-8601 timestamp. */
  updated: string;
}

export interface SearchHit {
  note: Note;
  snippet: string;
  /** Hybrid score in [0, 1]: semantic cosine plus a bounded keyword-match bonus (capped at 1). */
  score: number;
}

export interface ConsolidationReport {
  /** Number of near-duplicate groups collapsed into a single captured note. */
  merged: number;
  /** Number of groups promoted into `memory/`. */
  promoted: number;
  /** Number of captured notes pruned (deleted). */
  pruned: number;
}

/** One group of near-duplicate captured notes handed to the distiller. */
export interface DistillGroup {
  /** The near-duplicate captured notes (size 1 = a singleton capture). */
  notes: Note[];
  /** Current contents of profile.md (may be empty). */
  profile: string;
}

/** The distiller's decision for one group. */
export interface DistillDecision {
  /**
   * merge   — collapse the group into one captured note (title/body/tags below).
   * promote — collapse the group into one durable note under `memory/`.
   * prune   — delete the group's notes.
   * keep    — leave the group untouched.
   */
  action: 'merge' | 'promote' | 'prune' | 'keep';
  /** Replacement note title for merge/promote (defaults to the first note's title). */
  title?: string;
  /** Replacement note body for merge/promote (defaults to the group bodies joined). */
  body?: string;
  /** Replacement tags for merge/promote (defaults to the union of the group's tags). */
  tags?: string[];
  /**
   * Optional replacement contents for profile.md. Applied after all groups are processed
   * (last one wins) and clamped to the store's profile token budget.
   */
  profile?: string;
}

/**
 * Merges/labels a group of near-duplicate captured notes during consolidation. Backed by a
 * cheap model call in production; scripted in tests.
 */
export type DistillFn = (group: DistillGroup) => Promise<DistillDecision>;
