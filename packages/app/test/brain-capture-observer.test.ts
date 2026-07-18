import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainStore } from '@jarvis/tools-mcp/brain/store';
import type { Note } from '@jarvis/tools-mcp/brain/types';
import type { AppConfig, CapturedNote, TurnRecord } from '../src/shared/types';
import { createCaptureObserver } from '../src/agents/brain/captureObserver';
import type { CaptureExtractor, CapturedItem } from '../src/agents/brain/distill';
import { AgentRouter } from '../src/agents/router';
import { SessionStore } from '../src/agents/sessions';
import { FakeBackend } from './fakes/fakeBackend';
import { makeConfig } from './fakes/testConfig';

/** Records add() calls; returns a Note echoing the input. */
function fakeStore(): { store: Pick<BrainStore, 'add'>; added: CapturedItem[] } {
  const added: CapturedItem[] = [];
  const store: Pick<BrainStore, 'add'> = {
    add: async (note): Promise<Note> => {
      added.push({ title: note.title, body: note.body, tags: note.tags });
      return {
        id: `id${added.length}`,
        path: `captured/${note.title}.md`,
        title: note.title,
        body: note.body,
        tags: note.tags,
        source: note.source,
        created: 'c',
        updated: 'u'
      };
    }
  };
  return { store, added };
}

function turn(userText: string, assistantText: string): TurnRecord {
  return { id: 't1', at: 'now', backend: 'claude', userText, assistantText, tools: [] };
}

const scripted =
  (items: CapturedItem[]): CaptureExtractor =>
  async () =>
    items;

describe('auto-capture TurnObserver', () => {
  const enabled: Partial<AppConfig['secondBrain']> = { enabled: true, autoCapture: true };

  it('adds one auto note per distilled item and emits brain:captured for each', async () => {
    const { store, added } = fakeStore();
    const captured: CapturedNote[] = [];
    const observer = createCaptureObserver({
      store,
      getConfig: () => makeConfig({ secondBrain: enabled }),
      extract: scripted([
        { title: "sister's birthday", body: 'March 3rd' },
        { title: 'coffee', body: 'oat milk', tags: ['pref'] }
      ]),
      onCaptured: (n) => captured.push(n)
    });

    await observer.onTurn(turn('remember my sisters bday is march 3', 'noted'), { offTheRecord: false });

    expect(added.map((a) => a.title)).toEqual(["sister's birthday", 'coffee']);
    expect(captured.map((c) => c.title)).toEqual(["sister's birthday", 'coffee']);
    expect(captured[0]!.id).toBe('id1');
  });

  it('captures nothing when off the record', async () => {
    const { store, added } = fakeStore();
    const observer = createCaptureObserver({
      store,
      getConfig: () => makeConfig({ secondBrain: enabled }),
      extract: scripted([{ title: 'secret', body: 'do not keep' }]),
      onCaptured: () => {}
    });
    await observer.onTurn(turn('off the record, my pin is 1234', 'ok'), { offTheRecord: true });
    expect(added).toEqual([]);
  });

  it('captures nothing when auto-capture is paused', async () => {
    const { store, added } = fakeStore();
    const observer = createCaptureObserver({
      store,
      getConfig: () => makeConfig({ secondBrain: { enabled: true, autoCapture: false } }),
      extract: scripted([{ title: 'x', body: 'y' }]),
      onCaptured: () => {}
    });
    await observer.onTurn(turn('anything', 'reply'), { offTheRecord: false });
    expect(added).toEqual([]);
  });

  it('captures nothing when the second brain is disabled', async () => {
    const { store, added } = fakeStore();
    const observer = createCaptureObserver({
      store,
      getConfig: () => makeConfig({ secondBrain: { enabled: false, autoCapture: true } }),
      extract: scripted([{ title: 'x', body: 'y' }]),
      onCaptured: () => {}
    });
    await observer.onTurn(turn('anything', 'reply'), { offTheRecord: false });
    expect(added).toEqual([]);
  });

  it('skips trivial turns (failed/empty assistant reply)', async () => {
    const { store, added } = fakeStore();
    let extracted = 0;
    const observer = createCaptureObserver({
      store,
      getConfig: () => makeConfig({ secondBrain: enabled }),
      extract: async () => {
        extracted += 1;
        return [];
      },
      onCaptured: () => {}
    });
    await observer.onTurn(turn('hello', ''), { offTheRecord: false });
    expect(extracted).toBe(0);
    expect(added).toEqual([]);
  });
});

describe('off-the-record through the real router (A8)', () => {
  let dir: string;
  let sessions: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-brain-otr-'));
    sessions = new SessionStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('suppresses capture yet still persists the turn to session history', async () => {
    const { store, added } = fakeStore();
    const observer = createCaptureObserver({
      store,
      getConfig: () => makeConfig({ secondBrain: { enabled: true, autoCapture: true } }),
      extract: scripted([{ title: 'leaked', body: 'should never be captured' }]),
      onCaptured: () => {}
    });
    const claude = new FakeBackend('claude');
    claude.script({ events: [{ kind: 'done', finalText: 'understood' }] });
    const router = new AgentRouter({ claude, codex: new FakeBackend('codex') }, sessions, () => makeConfig(), {
      observers: [observer]
    });

    router.setOffTheRecord(true);
    await router.dispatch('my salary is a secret', () => {});
    // Give any (wrongly) fired detached observer a tick.
    await new Promise((r) => setTimeout(r, 10));

    // Capture suppressed …
    expect(added).toEqual([]);
    // … but the turn IS in session history (A8).
    const turns = sessions.turns(sessions.activeSession().id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe('my salary is a secret');
  });
});
