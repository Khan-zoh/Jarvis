/**
 * Off-the-record utterance detection (binding: cdd/plan/second-brain.md "Off the record",
 * amendments.md A8). "off the record" / "don't remember this" / "forget that" mark a turn so the
 * capture observer skips it — while the turn itself still lands in session history (A8).
 *
 * The conductor uses this before dispatching: it sets the router's off-the-record flag for the
 * turn, strips the directive from the utterance, and — for a bare directive with nothing left to
 * answer — speaks a short acknowledgment instead of dispatching to a backend.
 */

/** Spoken/shown acknowledgment. Copy states EXACTLY the A8 semantics: not saved, still in history. */
export const OFF_THE_RECORD_ACK =
  "okay — off the record. i won't save that to your second brain, but it stays in this conversation.";

export interface OffTheRecordResult {
  /** The utterance carries an off-the-record directive. */
  offTheRecord: boolean;
  /** The directive is a "forget" — the most recent auto-capture should also be removed. */
  forget: boolean;
  /** Nothing is left to answer after stripping the directive → speak the ack, don't dispatch. */
  standalone: boolean;
  /** The utterance with the directive removed (what to actually dispatch, when not standalone). */
  cleaned: string;
}

/** Directives that set the off-the-record flag. Matched case-insensitively, anywhere. */
const OTR_PATTERNS: RegExp[] = [
  /\boff the record\b/i,
  /\bdon['’]?t (?:remember|save|record|note|store) (?:this|that|it)\b/i,
  /\bkeep (?:this|that|it) (?:private|between us|to yourself|off the record)\b/i,
  /\bdon['’]?t keep (?:this|that|it)\b/i
];

/** "forget" directives (a subset that also removes the last capture). */
const FORGET_PATTERN = /\bforget (?:that|this|it|what i (?:just )?said)\b/i;

function stripDirectives(text: string): string {
  let out = text;
  for (const re of [...OTR_PATTERNS, FORGET_PATTERN]) {
    out = out.replace(new RegExp(re.source, 'ig'), ' ');
  }
  // Tidy leftover connectives/punctuation from the removal ("off the record, tell me…" → "tell me…").
  out = out.replace(/\s{2,}/g, ' ').trim();
  out = out.replace(/^[\s,;:.and]+/i, '').replace(/[\s,;:]+$/i, '').trim();
  return out;
}

export function detectOffTheRecord(text: string): OffTheRecordResult {
  const forget = FORGET_PATTERN.test(text);
  const offTheRecord = forget || OTR_PATTERNS.some((re) => re.test(text));
  if (!offTheRecord) {
    return { offTheRecord: false, forget: false, standalone: false, cleaned: text.trim() };
  }
  const cleaned = stripDirectives(text);
  return { offTheRecord: true, forget, standalone: cleaned === '', cleaned };
}
