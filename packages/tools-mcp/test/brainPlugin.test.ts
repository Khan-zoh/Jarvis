import { describe, expect, it } from 'vitest';
import type { BrainStore } from '../src/brain/store.js';
import type { ConsolidationReport, DistillFn, Note, SearchHit } from '../src/brain/types.js';
import { buildBrainTools, createBrainPlugin } from '../src/plugins/brain/index.js';
import type { PluginContext, ToolDef } from '../src/plugin.js';

/** A tiny in-memory stand-in exposing exactly what the brain tools call. */
class FakeBrainStore {
  notes: Note[] = [];
  searchResult: SearchHit[] = [];
  readonly calls: string[] = [];

  mk(partial: Partial<Note>): Note {
    return {
      id: partial.id ?? `id${this.notes.length + 1}`,
      path: partial.path ?? `notes/${partial.id ?? 'n'}.md`,
      title: partial.title ?? 'Untitled',
      body: partial.body ?? '',
      tags: partial.tags ?? [],
      source: partial.source ?? 'manual',
      created: partial.created ?? '2026-01-01T00:00:00.000Z',
      updated: partial.updated ?? '2026-01-01T00:00:00.000Z'
    };
  }

  async search(query: string): Promise<SearchHit[]> {
    this.calls.push(`search:${query}`);
    return this.searchResult;
  }
  async add(note: Omit<Note, 'id' | 'created' | 'updated' | 'path'>): Promise<Note> {
    this.calls.push(`add:${note.title}:${note.source}`);
    const created = this.mk({ ...note, id: `id${this.notes.length + 1}` });
    this.notes.push(created);
    return created;
  }
  async append(id: string, text: string): Promise<Note> {
    this.calls.push(`append:${id}:${text}`);
    return this.mk({ id, title: 'appended' });
  }
  async read(id: string): Promise<Note | null> {
    this.calls.push(`read:${id}`);
    return this.notes.find((n) => n.id === id) ?? this.mk({ id, title: 'Read note', body: 'full body' });
  }
  async recent(limit: number): Promise<Note[]> {
    this.calls.push(`recent:${limit}`);
    return this.notes.slice(0, limit);
  }
  async consolidate(distill: DistillFn): Promise<ConsolidationReport> {
    this.calls.push('consolidate');
    // Exercise the mechanical distiller the plugin passes in.
    await distill({ notes: [this.mk({ title: 'a' }), this.mk({ title: 'b' })], profile: '' });
    return { merged: 1, promoted: 0, pruned: 0 };
  }
}

function toolMap(tools: ToolDef<any>[]): Map<string, ToolDef<any>> {
  return new Map(tools.map((t) => [t.name, t]));
}

const BRAIN_NAMES = [
  'brain_search',
  'brain_add_note',
  'brain_append',
  'brain_read',
  'brain_recent',
  'brain_consolidate'
];

describe('brain plugin tools', () => {
  it('exposes exactly the six catalog tools with correct effects', () => {
    const store = new FakeBrainStore();
    const tools = buildBrainTools(store as unknown as BrainStore);
    expect(tools.map((t) => t.name)).toEqual(BRAIN_NAMES);
    const byName = toolMap(tools);
    expect(byName.get('brain_search')!.effect).toBe('read');
    expect(byName.get('brain_read')!.effect).toBe('read');
    expect(byName.get('brain_recent')!.effect).toBe('read');
    expect(byName.get('brain_add_note')!.effect).toBe('local-write');
    expect(byName.get('brain_append')!.effect).toBe('local-write');
    expect(byName.get('brain_consolidate')!.effect).toBe('local-write');
  });

  it('brain_search returns titles + snippets, and "no notes" when empty', async () => {
    const store = new FakeBrainStore();
    const tools = toolMap(buildBrainTools(store as unknown as BrainStore));
    const search = tools.get('brain_search')!;

    expect((await search.handler({ query: 'sister' })).text).toContain('no notes found');

    store.searchResult = [
      {
        note: {
          id: 'x',
          path: 'notes/x.md',
          title: "sister's birthday",
          body: 'March 3rd',
          tags: [],
          source: 'auto',
          created: 'c',
          updated: 'u'
        },
        snippet: 'March 3rd',
        score: 0.8
      }
    ];
    const res = await search.handler({ query: 'sister' });
    expect(res.text).toContain("sister's birthday");
    expect(res.text).toContain('March 3rd');
  });

  it('brain_add_note writes a manual note', async () => {
    const store = new FakeBrainStore();
    const tools = toolMap(buildBrainTools(store as unknown as BrainStore));
    const res = await tools.get('brain_add_note')!.handler({ title: 'Coffee', body: 'oat milk', tags: ['pref'] });
    expect(res.text).toBe('saved note "Coffee"');
    expect(store.calls).toContain('add:Coffee:manual');
  });

  it('brain_append updates the best match, else creates', async () => {
    const store = new FakeBrainStore();
    const tools = toolMap(buildBrainTools(store as unknown as BrainStore));
    // no match → create
    const created = await tools.get('brain_append')!.handler({ query: 'gym', text: 'mondays' });
    expect(created.text).toContain('created');

    store.searchResult = [
      { note: store.mk({ id: 'g1', title: 'gym schedule' }), snippet: '', score: 0.9 }
    ];
    const updated = await tools.get('brain_append')!.handler({ query: 'gym', text: 'fridays too' });
    expect(updated.text).toContain('updated');
    expect(store.calls).toContain('append:g1:fridays too');
  });

  it('brain_read returns the full body of the best match', async () => {
    const store = new FakeBrainStore();
    const tools = toolMap(buildBrainTools(store as unknown as BrainStore));
    expect((await tools.get('brain_read')!.handler({ query: 'nope' })).text).toContain('no note matches');

    store.searchResult = [
      { note: store.mk({ id: 'r1', title: 'plan', body: 'the full plan' }), snippet: '', score: 0.7 }
    ];
    store.notes.push(store.mk({ id: 'r1', title: 'plan', body: 'the full plan' }));
    const res = await tools.get('brain_read')!.handler({ query: 'plan' });
    expect(res.text).toContain('the full plan');
  });

  it('brain_recent lists recent notes', async () => {
    const store = new FakeBrainStore();
    store.notes.push(store.mk({ title: 'one' }), store.mk({ title: 'two' }));
    const tools = toolMap(buildBrainTools(store as unknown as BrainStore));
    const res = await tools.get('brain_recent')!.handler({});
    expect(res.text).toContain('one');
    expect(res.text).toContain('two');
  });

  it('brain_consolidate runs the mechanical distiller and reports counts', async () => {
    const store = new FakeBrainStore();
    const tools = toolMap(buildBrainTools(store as unknown as BrainStore));
    const res = await tools.get('brain_consolidate')!.handler({});
    expect(res.text).toContain('merged 1');
    expect(store.calls).toContain('consolidate');
  });
});

function fakeCtx(config: Record<string, unknown> = {}): PluginContext {
  return {
    dataDir: 'C:/tmp/data',
    config,
    secret: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

describe('brain plugin activation', () => {
  it('stubs every tool with a setup hint when the embedding model is missing', async () => {
    const plugin = createBrainPlugin({ modelPresent: () => false });
    const result = await plugin.init(fakeCtx());
    expect('unavailable' in result).toBe(true);
    if ('unavailable' in result) {
      expect(result.stubTools.map((t) => t.name)).toEqual(BRAIN_NAMES);
      const stub = result.stubTools[0]!;
      const out = await stub.handler({});
      expect(out.isError).toBe(true);
      expect(out.text).toContain('not set up');
    }
  });

  it('returns the six real tools when the store is available', async () => {
    const store = new FakeBrainStore();
    const plugin = createBrainPlugin({
      modelPresent: () => true,
      makeStore: () => store as unknown as BrainStore
    });
    const result = await plugin.init(fakeCtx({ vaultDir: 'D:\\Vault' }));
    expect('tools' in result).toBe(true);
    if ('tools' in result) {
      expect(result.tools.map((t) => t.name)).toEqual(BRAIN_NAMES);
    }
  });

  it('declares vaultDir/autoCapture/recallMode settings plus reindex + consolidate actions', () => {
    const plugin = createBrainPlugin();
    const keys = (plugin.settings ?? []).map((s) => s.key);
    expect(keys).toContain('vaultDir');
    expect(keys).toContain('autoCapture');
    expect(keys).toContain('recallMode');
    const actions = (plugin.settings ?? []).filter((s) => s.kind === 'action').map((s) => s.key);
    expect(actions).toEqual(['reindex', 'consolidate']);
  });
});
