import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@jarvis/tools-mcp/brain/types';
import type { BrainStore } from '@jarvis/tools-mcp/brain/store';
import { createRecallProvider } from '../src/agents/brain/recallProvider';
import { makeConfig } from './fakes/testConfig';

/** Minimal store fake: canned profile + score-filterable hits. */
function fakeStore(profile: string, hits: SearchHit[]): Pick<BrainStore, 'profile' | 'search'> {
  return {
    profile: async () => profile,
    search: async (_q, opts) => {
      const min = opts?.minScore ?? 0;
      return hits.filter((h) => h.score >= min).slice(0, opts?.k ?? hits.length);
    }
  } as Pick<BrainStore, 'profile' | 'search'>;
}

function hit(title: string, snippet: string, score: number): SearchHit {
  return {
    note: {
      id: title,
      path: `notes/${title}.md`,
      title,
      body: snippet,
      tags: [],
      source: 'auto',
      created: 'c',
      updated: 'u'
    },
    snippet,
    score
  };
}

describe('recall ContextProvider', () => {
  it('returns null when the second brain is disabled', async () => {
    const provider = createRecallProvider({ store: fakeStore('I am Zoh.', [hit('a', 'x', 0.9)]) });
    const cfg = makeConfig({ secondBrain: { enabled: false } });
    expect(await provider.contribute('anything', cfg)).toBeNull();
  });

  it('always includes the profile, even with no note hits', async () => {
    const provider = createRecallProvider({ store: fakeStore('The user is Zoh, a data analyst.', []) });
    const cfg = makeConfig({ secondBrain: { enabled: true, recallMode: 'hybrid' } });
    const out = await provider.contribute('unrelated question', cfg);
    expect(out).toContain('Zoh');
    expect(out).toContain('profile');
  });

  it('hybrid mode injects only hits at/above the recall threshold', async () => {
    const provider = createRecallProvider({
      store: fakeStore('', [hit('close', 'near match', 0.7), hit('far', 'weak match', 0.2)]),
      recallThreshold: 0.5
    });
    const cfg = makeConfig({ secondBrain: { enabled: true, recallMode: 'hybrid' } });
    const out = (await provider.contribute('q', cfg)) ?? '';
    expect(out).toContain('near match');
    expect(out).not.toContain('weak match');
  });

  it('on-demand mode injects the profile but never the note hits', async () => {
    const provider = createRecallProvider({
      store: fakeStore('profile text', [hit('close', 'strong match', 0.99)])
    });
    const cfg = makeConfig({ secondBrain: { enabled: true, recallMode: 'on-demand' } });
    const out = (await provider.contribute('q', cfg)) ?? '';
    expect(out).toContain('profile text');
    expect(out).not.toContain('strong match');
  });

  it('proactive mode injects every hit regardless of threshold', async () => {
    const provider = createRecallProvider({
      store: fakeStore('', [hit('a', 'weak but relevant', 0.05)]),
      recallThreshold: 0.5
    });
    const cfg = makeConfig({ secondBrain: { enabled: true, recallMode: 'proactive' } });
    const out = (await provider.contribute('q', cfg)) ?? '';
    expect(out).toContain('weak but relevant');
  });

  it('respects the notes token budget', async () => {
    const long = 'x'.repeat(4000);
    const provider = createRecallProvider({
      store: fakeStore('', [hit('a', long, 0.9), hit('b', long, 0.9), hit('c', long, 0.9)]),
      notesTokenBudget: 200
    });
    const cfg = makeConfig({ secondBrain: { enabled: true, recallMode: 'hybrid' } });
    const out = (await provider.contribute('q', cfg)) ?? '';
    // 200 tokens ≈ 800 chars — one long snippet already blows the budget, so at most one lands.
    const noteLines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(noteLines.length).toBeLessThanOrEqual(1);
  });
});
