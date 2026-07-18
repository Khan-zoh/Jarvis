import { describe, expect, it } from 'vitest';
import {
  createConsolidationDistiller,
  createDistillExtractor,
  extractJsonArray,
  parseDistill
} from '../src/agents/brain/distill';

describe('parseDistill', () => {
  it('parses a clean JSON array of items', () => {
    const raw = '[{"title":"coffee","body":"oat milk","tags":["pref"]}]';
    expect(parseDistill(raw)).toEqual([{ title: 'coffee', body: 'oat milk', tags: ['pref'] }]);
  });

  it('tolerates ```json fences and surrounding prose', () => {
    const raw = 'Sure, here you go:\n```json\n[{"title":"gym","body":"mondays"}]\n```';
    expect(parseDistill(raw)).toEqual([{ title: 'gym', body: 'mondays', tags: [] }]);
  });

  it('returns [] for an empty array or garbage', () => {
    expect(parseDistill('[]')).toEqual([]);
    expect(parseDistill('nothing durable here')).toEqual([]);
    expect(parseDistill('[not json')).toEqual([]);
  });

  it('drops items with neither title nor body but keeps partial ones', () => {
    const raw = '[{"title":"","body":""},{"body":"only a body"}]';
    expect(parseDistill(raw)).toEqual([{ title: 'only a body', body: 'only a body', tags: [] }]);
  });
});

describe('extractJsonArray', () => {
  it('slices from first [ to last ]', () => {
    expect(extractJsonArray('x [1, [2]] y')).toBe('[1, [2]]');
    expect(extractJsonArray('no array')).toBeNull();
  });
});

describe('createDistillExtractor', () => {
  it('formats the prompt and parses the completion', async () => {
    let seen = '';
    const extract = createDistillExtractor(async (prompt) => {
      seen = prompt;
      return '[{"title":"t","body":"b"}]';
    });
    const items = await extract({ user: 'U', assistant: 'A' });
    expect(seen).toContain('User: U');
    expect(seen).toContain('Assistant: A');
    expect(items).toEqual([{ title: 't', body: 'b', tags: [] }]);
  });
});

describe('createConsolidationDistiller', () => {
  it('parses a decision object and falls back to keep on bad output', async () => {
    const promote = createConsolidationDistiller(async () => '{"action":"promote","title":"Fact","profile":"I am Zoh."}');
    const d1 = await promote({ notes: [], profile: '' });
    expect(d1.action).toBe('promote');
    expect(d1.title).toBe('Fact');
    expect(d1.profile).toBe('I am Zoh.');

    const bad = createConsolidationDistiller(async () => 'not json at all');
    expect((await bad({ notes: [], profile: '' })).action).toBe('keep');
  });
});
