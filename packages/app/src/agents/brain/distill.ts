import type { DistillFn } from '@jarvis/tools-mcp/brain/types';
import type { AgentBackend } from '../types';

/**
 * Distillation helpers for the second brain: turning a completed turn into durable captures
 * (auto-capture), and turning a group of near-duplicate captures into a consolidation decision.
 * Both are backed by a cheap non-streaming model completion in production and scripted in tests.
 */

/** One durable item extracted from an exchange (fed to BrainStore.add with source 'auto'). */
export interface CapturedItem {
  title: string;
  body: string;
  tags?: string[];
}

/** Extraction seam: exchange → durable items (empty when nothing is worth keeping). */
export type CaptureExtractor = (exchange: { user: string; assistant: string }) => Promise<CapturedItem[]>;

/** The tight auto-capture prompt (cdd/plan/second-brain.md "Capture" step 1). */
export const DISTILL_PROMPT =
  'From the exchange below, list only DURABLE facts worth remembering long-term about the user: ' +
  'their preferences, facts about the people/projects in their life, decisions, and commitments. ' +
  'Ignore transient chit-chat, one-off task requests, and anything not worth recalling weeks later. ' +
  'Reply with ONLY a JSON array; each element is ' +
  '{"title": short label, "body": the fact in one sentence, "tags": optional string array}. ' +
  'If there is nothing durable, reply with exactly [].';

/**
 * Extracts a JSON array from a model reply, tolerating ```json fences and surrounding prose:
 * takes the substring from the first '[' to the last ']'. Returns null if none is present.
 */
export function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

/** Parses a distiller reply into captured items; never throws (bad JSON → []). */
export function parseDistill(raw: string): CapturedItem[] {
  const json = extractJsonArray(raw);
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: CapturedItem[] = [];
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue;
    const rec = el as Record<string, unknown>;
    const title = typeof rec['title'] === 'string' ? rec['title'].trim() : '';
    const body = typeof rec['body'] === 'string' ? rec['body'].trim() : '';
    if (!title && !body) continue;
    const tags = Array.isArray(rec['tags'])
      ? rec['tags'].filter((t): t is string => typeof t === 'string')
      : [];
    out.push({ title: title || body.slice(0, 40), body: body || title, tags });
  }
  return out;
}

/** Builds a production CaptureExtractor over a `complete(prompt)` completion seam. */
export function createDistillExtractor(complete: (prompt: string) => Promise<string>): CaptureExtractor {
  return async ({ user, assistant }) => {
    const raw = await complete(`${DISTILL_PROMPT}\n\nUser: ${user}\nAssistant: ${assistant}`);
    return parseDistill(raw);
  };
}

/**
 * Runs a minimal, non-streaming one-shot completion on a backend: a fresh native thread (no
 * resume), events collected, final text returned. Used for auto-capture distillation and
 * consolidation — never goes through the router, so it neither persists a turn nor re-triggers
 * observers. Best-effort: returns '' if the backend is unavailable or errors.
 */
export async function backendComplete(backend: AgentBackend, prompt: string): Promise<string> {
  const ready = await backend.init();
  if (!ready.ok) return '';
  let text = '';
  const { result } = await backend.startTurn({
    input: prompt,
    sessionId: null,
    onEvent: (e) => {
      if (e.kind === 'text_delta') text += e.text;
      else if (e.kind === 'done' && e.finalText) text = e.finalText;
    }
  });
  try {
    const r = await result;
    return r.finalText || text;
  } catch {
    return text;
  }
}

/** The consolidation prompt (cdd/plan/second-brain.md "Consolidation"). */
export const CONSOLIDATE_PROMPT =
  'You are tidying a personal knowledge vault. Given a group of near-duplicate auto-captured ' +
  'notes about the user and the current profile, decide what to do with the group. ' +
  'Reply with ONLY a JSON object: ' +
  '{"action": "merge" | "promote" | "prune" | "keep", "title"?, "body"?, "tags"?, "profile"?}. ' +
  'Use "promote" for a settled, durable fact worth keeping permanently (it moves to memory/); ' +
  '"merge" to collapse duplicates into one captured note; "prune" for noise; "keep" to leave it. ' +
  'Optionally return an updated "profile" (short, first-person about the user) when the group ' +
  'changes who the user fundamentally is.';

/**
 * Builds a model-backed DistillFn for BrainStore.consolidate. Falls back to a safe "keep" on any
 * parse/model failure, so consolidation can never corrupt the vault.
 */
export function createConsolidationDistiller(
  complete: (prompt: string) => Promise<string>
): DistillFn {
  return async ({ notes, profile }) => {
    const body = notes.map((n, i) => `#${i + 1} ${n.title}\n${n.body}`).join('\n\n');
    const raw = await complete(
      `${CONSOLIDATE_PROMPT}\n\nCurrent profile:\n${profile || '(empty)'}\n\nGroup:\n${body}`
    );
    const json = sliceObject(raw);
    if (!json) return { action: 'keep' };
    try {
      const d = JSON.parse(json) as Record<string, unknown>;
      const action = d['action'];
      if (action === 'merge' || action === 'promote' || action === 'prune' || action === 'keep') {
        return {
          action,
          ...(typeof d['title'] === 'string' ? { title: d['title'] } : {}),
          ...(typeof d['body'] === 'string' ? { body: d['body'] } : {}),
          ...(Array.isArray(d['tags'])
            ? { tags: d['tags'].filter((t): t is string => typeof t === 'string') }
            : {}),
          ...(typeof d['profile'] === 'string' ? { profile: d['profile'] } : {})
        };
      }
    } catch {
      // fall through
    }
    return { action: 'keep' };
  };
}

/** Extract the first {...} object substring, or null. */
function sliceObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}
