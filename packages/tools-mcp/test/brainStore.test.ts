import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrainStore,
  estimateTokens,
  parseNoteFile,
  serializeNoteFile
} from '../src/brain/store.js';
import type { DistillGroup, Note } from '../src/brain/types.js';
import { FakeEmbedder } from './fakes/fakeEmbedder.js';

/** Temp vault + index per test; everything cleaned up afterwards. */
const cleanups: (() => void)[] = [];

function makeStore(opts?: {
  synonyms?: Record<string, string>;
  dedupThreshold?: number;
  profileTokenBudget?: number;
  vaultDir?: string;
}): { store: BrainStore; vaultDir: string; indexDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'jarvis-brain-'));
  const vaultDir = opts?.vaultDir ?? join(base, 'vault');
  const indexDir = join(base, 'index');
  const store = new BrainStore({
    vaultDir,
    indexDir,
    embedder: new FakeEmbedder({ synonyms: opts?.synonyms }),
    ...(opts?.dedupThreshold !== undefined ? { dedupThreshold: opts.dedupThreshold } : {}),
    ...(opts?.profileTokenBudget !== undefined
      ? { profileTokenBudget: opts.profileTokenBudget }
      : {})
  });
  cleanups.push(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { store, vaultDir, indexDir };
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const manual = (title: string, body: string, tags: string[] = []) =>
  ({ title, body, tags, source: 'manual' }) as Omit<Note, 'id' | 'created' | 'updated' | 'path'>;

describe('BrainStore with FakeEmbedder', () => {
  it('add → search round trip', async () => {
    const { store, vaultDir } = makeStore();
    const note = await store.add(manual('Coffee brewing', 'Use a V60 with a medium grind.', ['howto']));
    await store.add(manual('Gym routine', 'Squats on Monday, deadlifts on Thursday.'));
    await store.add(manual('Taxes', 'File the annual return before April.'));

    expect(note.id).toMatch(/^[0-9a-f]{8}$/);
    expect(note.path).toBe(`notes/coffee-brewing-${note.id}.md`);
    expect(existsSync(join(vaultDir, note.path))).toBe(true);

    const hits = await store.search('coffee brewing with a V60');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.note.id).toBe(note.id);
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
  });

  it('hybrid: keyword-only and semantic-only hits both surface', async () => {
    const { store } = makeStore({ synonyms: { automobile: 'car' } });
    // Semantic-only target: query word "automobile" never appears in the note.
    const carNote = await store.add(manual('Car maintenance', 'The car needs an oil change soon.'));
    // Keyword-only target: shares one rare token with the query, but is long enough that
    // its fake-embedding cosine is far too weak to rank semantically.
    const filler = Array.from({ length: 70 }, (_, i) => `filler${i}`).join(' ');
    const tripNote = await store.add(manual('Trip planning', `Visit Zanzibar in October. ${filler}`));
    await store.add(manual('Grocery list', 'Buy milk and bread.'));

    const semantic = await store.search('automobile');
    expect(semantic.map((h) => h.note.id)).toContain(carNote.id);
    expect(semantic[0]!.note.id).toBe(carNote.id);

    const keyword = await store.search('zanzibar holiday paperwork');
    expect(keyword.map((h) => h.note.id)).toContain(tripNote.id);

    // minScore gates junk out.
    const gated = await store.search('zanzibar holiday paperwork', { minScore: 0.99 });
    expect(gated).toEqual([]);
  });

  it('dedup: near-duplicate add merges into the existing note', async () => {
    const { store, vaultDir } = makeStore();
    const first = await store.add(manual('Coffee preference', 'User likes strong coffee', ['a']));
    // Same token multiset (reordered) → fake cosine 1.0 ≥ 0.92 → merge, even though source differs.
    const second = await store.add({
      title: 'Coffee preference',
      body: 'User likes coffee strong',
      tags: ['b'],
      source: 'auto'
    });

    expect(second.id).toBe(first.id);
    expect(second.tags.sort()).toEqual(['a', 'b']);
    expect(second.body).toContain('User likes strong coffee');
    expect(second.body).toContain('User likes coffee strong');
    expect(readdirSync(join(vaultDir, 'notes'))).toHaveLength(1);
    expect(readdirSync(join(vaultDir, 'captured'))).toHaveLength(0);
    expect((await store.recent(10)).length).toBe(1);
  });

  it('dedup threshold is configurable', async () => {
    // cosine("i like coffee", "i like coffee very much") ≈ 0.77 with the fake embedder.
    const loose = makeStore({ dedupThreshold: 0.6 });
    const a1 = await loose.store.add(manual('Note', 'i like coffee'));
    const a2 = await loose.store.add(manual('Note', 'i like coffee very much'));
    expect(a2.id).toBe(a1.id);

    const strict = makeStore(); // default 0.92
    const b1 = await strict.store.add(manual('Note', 'i like coffee'));
    const b2 = await strict.store.add(manual('Note', 'i like coffee very much'));
    expect(b2.id).not.toBe(b1.id);
  });

  it('append targets the right note and is searchable', async () => {
    const { store } = makeStore();
    const a = await store.add(manual('Alpha', 'first body'));
    const b = await store.add(manual('Beta', 'second body'));

    const updated = await store.append(b.id, 'quixotic addendum line');
    expect(updated.id).toBe(b.id);
    expect(updated.body).toBe('second body\n\nquixotic addendum line');
    expect((await store.read(a.id))!.body).toBe('first body');
    expect((await store.read(b.id))!.body).toContain('quixotic addendum');

    const hits = await store.search('quixotic addendum');
    expect(hits[0]!.note.id).toBe(b.id);
    await expect(store.append('deadbeef', 'x')).rejects.toThrow(/not found/);
  });

  it('remove drops the note from index and vault', async () => {
    const { store, vaultDir } = makeStore();
    const note = await store.add(manual('Doomed', 'zyzzyva content here'));
    expect((await store.search('zyzzyva')).length).toBeGreaterThan(0);

    await store.remove(note.id);
    expect(await store.read(note.id)).toBeNull();
    expect(await store.search('zyzzyva')).toEqual([]);
    expect(existsSync(join(vaultDir, note.path))).toBe(false);
    await expect(store.remove(note.id)).resolves.toBeUndefined(); // idempotent
  });

  it('recent orders by updated, most recent first', async () => {
    const { store } = makeStore();
    const a = await store.add(manual('First', 'aaa'));
    const b = await store.add(manual('Second', 'bbb'));
    const c = await store.add(manual('Third', 'ccc'));

    expect((await store.recent(10)).map((n) => n.id)).toEqual([c.id, b.id, a.id]);
    await store.append(a.id, 'now newest');
    expect((await store.recent(10)).map((n) => n.id)).toEqual([a.id, c.id, b.id]);
    expect((await store.recent(2)).map((n) => n.id)).toEqual([a.id, c.id]);
  });

  it('reindex from files reconstructs identical search results', async () => {
    const first = makeStore();
    await first.store.add(manual('Coffee brewing', 'Use a V60 with a medium grind.', ['howto']));
    await first.store.add(manual('Gym routine', 'Squats on Monday, deadlifts on Thursday.'));
    await first.store.add(manual('Trip planning', 'Visit Zanzibar in October.'));
    const before = {
      q1: await first.store.search('coffee grind'),
      q2: await first.store.search('zanzibar october trip'),
      recent: await first.store.recent(10)
    };

    // Fresh store over the SAME vault but a brand-new index dir: only the files feed it.
    const second = makeStore({ vaultDir: first.vaultDir });
    const { notes } = await second.store.reindex();
    expect(notes).toBe(3);
    expect(await second.store.search('coffee grind')).toEqual(before.q1);
    expect(await second.store.search('zanzibar october trip')).toEqual(before.q2);
    expect(await second.store.recent(10)).toEqual(before.recent);
  });

  it('consolidation merges, promotes, prunes and keeps profile within budget', async () => {
    const { store, vaultDir } = makeStore({ profileTokenBudget: 30 });
    // Seed captured items as raw vault files (per-item files, A8) and index them.
    const seed = (name: string, title: string, body: string) =>
      writeFileSync(
        join(vaultDir, 'captured', name),
        serializeNoteFile(
          {
            title,
            created: '2026-07-10T08:00:00.000Z',
            updated: '2026-07-10T08:00:00.000Z',
            tags: ['auto'],
            source: 'auto'
          },
          body
        ),
        'utf8'
      );
    // Two near-duplicate pairs (same token multiset → grouped), one junk, one keeper.
    seed('2026-07-10-coffee-aaaa0001.md', 'coffee fact', 'user drinks two coffees daily');
    seed('2026-07-10-coffee-aaaa0002.md', 'coffee fact', 'daily user drinks coffees two');
    seed('2026-07-10-deadline-bbbb0001.md', 'deadline fact', 'thesis deadline is september first');
    seed('2026-07-10-deadline-bbbb0002.md', 'deadline fact', 'september first is thesis deadline');
    seed('2026-07-10-junk-cccc0001.md', 'junk fact', 'ephemeral one-off remark');
    seed('2026-07-10-keeper-dddd0001.md', 'keeper fact', 'still deciding what this means');
    expect((await store.reindex()).notes).toBe(6);

    const longProfile = `Drinks two coffees a day. ${'Loves espresso beans very much. '.repeat(30)}`;
    const seen: DistillGroup[] = [];
    const report = await store.consolidate(async (group) => {
      seen.push(group);
      const t = group.notes[0]!.title;
      if (t.includes('coffee')) {
        return { action: 'merge', title: 'Coffee habits', body: 'Drinks two coffees a day.', profile: longProfile };
      }
      if (t.includes('deadline')) {
        return { action: 'promote', title: 'Thesis deadline', body: 'Thesis deadline: September 1.', tags: ['dates'] };
      }
      if (t.includes('junk')) return { action: 'prune' };
      return { action: 'keep' };
    });

    expect(report).toEqual({ merged: 1, promoted: 1, pruned: 1 });
    expect(seen).toHaveLength(4);
    expect(seen.filter((g) => g.notes.length === 2)).toHaveLength(2);

    const memory = readdirSync(join(vaultDir, 'memory'));
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatch(/^thesis-deadline-[0-9a-f]{8}\.md$/);
    const captured = readdirSync(join(vaultDir, 'captured'));
    expect(captured).toHaveLength(2); // merged result + keeper
    expect(captured.some((f) => f.includes('coffee-habits'))).toBe(true);
    expect(captured.some((f) => f.includes('keeper'))).toBe(true);

    // Promoted note is searchable and merged content survives.
    const hits = await store.search('thesis deadline september');
    expect(hits[0]!.note.title).toBe('Thesis deadline');

    // Profile was updated but clamped to the 30-token budget.
    const profile = await store.profile();
    expect(profile.startsWith('Drinks two coffees a day.')).toBe(true);
    expect(estimateTokens(profile)).toBeLessThanOrEqual(30);
    expect(profile.length).toBeLessThan(longProfile.length);
  });

  it('frontmatter round-trip is byte-stable', async () => {
    const data = {
      title: "Maria's coffee: notes & prefs",
      created: '2026-07-15T10:00:00.000Z',
      updated: '2026-07-15T11:30:00.000Z',
      tags: ['food', 'prefs'],
      source: 'manual' as const
    };
    const body = 'Likes flat whites.\n\nSecond paragraph with [[wikilink]] and #tag.';
    const raw = serializeNoteFile(data, body);
    const parsed = parseNoteFile(raw);
    expect(parsed.data).toEqual(data);
    expect(parsed.body).toBe(body);
    expect(serializeNoteFile(parsed.data, parsed.body)).toBe(raw);

    // The same holds for a file the store itself wrote.
    const { store, vaultDir } = makeStore();
    const note = await store.add(manual('Stability check', body, ['x']));
    const onDisk = readFileSync(join(vaultDir, note.path), 'utf8');
    const reparsed = parseNoteFile(onDisk);
    expect(serializeNoteFile(reparsed.data, reparsed.body)).toBe(onDisk);
  });

  it('profile() returns empty string when profile.md is absent', async () => {
    const { store } = makeStore();
    expect(await store.profile()).toBe('');
  });
});
