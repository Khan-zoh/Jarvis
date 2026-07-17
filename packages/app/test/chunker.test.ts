// Table-driven SentenceChunker tests per cdd/tasks/voice-pipeline.md ("Chunker: table-driven
// (multi-sentence delta streams, markdown stripping, cap, flush tail)").

import { describe, expect, it } from 'vitest';
import { SentenceChunker, stripMarkdown } from '../src/voice/chunker';

/** Feeds every delta through a fresh chunker and returns [emitted sentences..., flushed tail?]. */
function run(deltas: string[]): { sentences: string[]; tail: string | null } {
  const chunker = new SentenceChunker();
  const sentences: string[] = [];
  for (const d of deltas) sentences.push(...chunker.push(d));
  return { sentences, tail: chunker.flush() };
}

describe('stripMarkdown', () => {
  const cases: Array<[string, string]> = [
    ['plain text', 'plain text'],
    ['`code` here', 'code here'],
    ['**bold** and *italic*', 'bold and italic'],
    ['## Heading text', 'Heading text'],
    ['# H1\nbody', 'H1 body'],
    ['- bullet item', 'bullet item'],
    ['• bullet item', 'bullet item'],
    ['* starred bullet', 'starred bullet'],
    ['a\nb\tc', 'a b c'],
    ['  padded  ', 'padded'],
    ['``', ''],
    ['', '']
  ];
  it.each(cases)('stripMarkdown(%j) -> %j', (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });
});

describe('SentenceChunker', () => {
  it('emits nothing until a boundary arrives, then the completed sentence', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Hello the')).toEqual([]);
    expect(chunker.push('re wor')).toEqual([]);
    expect(chunker.push('ld. And')).toEqual(['Hello there world.']);
    expect(chunker.flush()).toBe('And');
  });

  it.each([
    // [deltas, expected sentences, expected tail]
    [['One. Two! Three? Four: Five'], ['One.', 'Two!', 'Three?', 'Four:'], 'Five'],
    [['No boundary at all'], [], 'No boundary at all'],
    [['Ends exactly. '], ['Ends exactly.'], null],
    // Punctuation NOT followed by whitespace is not a boundary (e.g. decimals, file.ext).
    [['pi is 3.14 exactly'], [], 'pi is 3.14 exactly'],
    // Boundary split across deltas: "." arrives in one push, the whitespace in the next.
    [['First sentence.', ' Second.', ' '], ['First sentence.', 'Second.'], null],
    // Multi-sentence single delta.
    [['A. B. C. '], ['A.', 'B.', 'C.'], null]
  ])('stream %j -> sentences %j + tail %j', (deltas, expectedSentences, expectedTail) => {
    const { sentences, tail } = run(deltas as string[]);
    expect(sentences).toEqual(expectedSentences);
    expect(tail).toBe(expectedTail);
  });

  it('strips markdown from emitted sentences and the flushed tail', () => {
    const { sentences, tail } = run(['## Results\n', '- `item` one is **good**. And *more', '* text']);
    expect(sentences).toEqual(['Results item one is good.']);
    expect(tail).toBe('And more text');
  });

  it('drops sentences that are empty after markdown stripping', () => {
    const chunker = new SentenceChunker();
    // "`**`. " strips to just "." -> "." alone... stripMarkdown('`**`. ') = '.', length 1 > 0 so
    // kept; use a fully-empty case instead: a bullet marker line terminated by a boundary.
    expect(chunker.push('``: ')).toEqual([':']);
    const c2 = new SentenceChunker();
    c2.push('**');
    expect(c2.flush()).toBeNull();
  });

  it('force-breaks at the 220-char cap when no boundary is present, at a word break', () => {
    const word = 'abcdefghij'; // 10 chars
    const long = Array(30).fill(word).join(' '); // 329 chars, no boundary punctuation
    const chunker = new SentenceChunker();
    const out = chunker.push(long);
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(220);
      // Break lands on a word boundary — no mid-word cuts.
      expect(s.endsWith('abcdefghij')).toBe(true);
    }
    const tail = chunker.flush();
    expect(tail).not.toBeNull();
    expect((out.join(' ') + ' ' + tail).split(' ')).toHaveLength(30);
  });

  it('hard-cuts a single 220+ char token with no whitespace', () => {
    const monster = 'x'.repeat(500);
    const chunker = new SentenceChunker();
    const out = chunker.push(monster);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const s of out) expect(s.length).toBeLessThanOrEqual(220);
    const tail = chunker.flush();
    expect(out.join('').length + (tail?.length ?? 0)).toBe(500);
  });

  it('prefers a punctuation boundary over the cap when one exists within 220 chars', () => {
    const sentence = `${'a'.repeat(100)}. ${'b'.repeat(300)}`;
    const chunker = new SentenceChunker();
    const out = chunker.push(sentence);
    expect(out[0]).toBe(`${'a'.repeat(100)}.`);
  });

  it('flush() returns null when nothing is buffered and clears the buffer', () => {
    const chunker = new SentenceChunker();
    expect(chunker.flush()).toBeNull();
    chunker.push('tail text');
    expect(chunker.flush()).toBe('tail text');
    expect(chunker.flush()).toBeNull(); // buffer cleared by the previous flush
  });
});
