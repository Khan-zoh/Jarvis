// SentenceChunker — see cdd/plan/voice-pipeline.md ("SentenceChunker"). Turns a stream of
// `text_delta` fragments (as they arrive from an agent backend) into whole speakable sentences so
// TTS can start before the full reply exists. Pure and dependency-free: table-testable in
// isolation, constructor-injected into VoicePipeline nowhere — the pipeline just `new`s one per
// turn.
//
// Boundary rule (from the plan): a sentence ends at `.`, `!`, `?`, or `:` immediately followed by
// whitespace, OR when the accumulated buffer reaches the 220-char hard cap (so a boundary-less
// run — a URL, a long list without punctuation — still gets flushed to TTS instead of stalling).
// Markdown symbols (backticks, asterisks, heading markers, bullet markers) are stripped from every
// emitted sentence so TTS never reads formatting aloud.

/** Hard cap: force a sentence break once the buffer reaches this many chars with no punctuation
 * boundary (cdd/plan/voice-pipeline.md "or 220 chars max"). */
const MAX_SENTENCE_CHARS = 220;

/** Punctuation that ends a sentence when immediately followed by whitespace. */
const BOUNDARY_RE = /[.!?:]\s/;

/**
 * Strips markdown formatting so it is never spoken aloud, then normalizes whitespace. Removes:
 *   - inline code / emphasis markers: backticks and asterisks (anywhere)
 *   - heading markers: leading `#`..`######` runs at the start of any line
 *   - bullet markers: a leading `-` or `•` at the start of any line
 * Applied to each sentence right before it is emitted. Exported for direct unit testing.
 */
export function stripMarkdown(input: string): string {
  let text = input;
  // Heading markers at line starts (e.g. "## Title" -> "Title").
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  // Bullet markers at line starts (e.g. "- item" / "• item" -> "item"). Asterisk bullets are
  // covered by the asterisk strip below.
  text = text.replace(/^[ \t]*[-•][ \t]+/gm, '');
  // Inline code / emphasis markers anywhere.
  text = text.replace(/[`*]/g, '');
  // Collapse all runs of whitespace (incl. newlines) to single spaces and trim.
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export class SentenceChunker {
  private buffer = '';

  /** Appends a streamed delta and returns every whole sentence it completed (zero or more),
   * already markdown-stripped. Empty-after-stripping sentences (pure formatting) are dropped. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let raw: string | null;
    while ((raw = this.takeNext()) !== null) {
      const cleaned = stripMarkdown(raw);
      if (cleaned.length > 0) out.push(cleaned);
    }
    return out;
  }

  /** Returns whatever remains (the tail with no terminal punctuation) at stream end, stripped, or
   * null if nothing speakable is left. Clears the buffer. */
  flush(): string | null {
    const cleaned = stripMarkdown(this.buffer);
    this.buffer = '';
    return cleaned.length > 0 ? cleaned : null;
  }

  /** Extracts the next sentence from the front of the buffer, or null if none is complete yet.
   * A punctuation boundary within the cap wins; otherwise, once the buffer is at/over the cap,
   * force a break at the last whitespace before the cap (or a hard cut if there is none). */
  private takeNext(): string | null {
    const m = BOUNDARY_RE.exec(this.buffer);
    const boundaryEnd = m ? m.index + 1 : -1; // index just past the punctuation char

    if (boundaryEnd !== -1 && boundaryEnd <= MAX_SENTENCE_CHARS) {
      const sentence = this.buffer.slice(0, boundaryEnd);
      this.buffer = this.buffer.slice(boundaryEnd).replace(/^\s+/, '');
      return sentence;
    }

    if (this.buffer.length >= MAX_SENTENCE_CHARS) {
      const window = this.buffer.slice(0, MAX_SENTENCE_CHARS);
      const lastWs = window.lastIndexOf(' ');
      const cut = lastWs > 0 ? lastWs : MAX_SENTENCE_CHARS;
      const sentence = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, '');
      return sentence;
    }

    return null;
  }
}
