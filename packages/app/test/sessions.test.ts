import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/agents/sessions';
import type { TurnRecord } from '../src/shared/types';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-sessions-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function turn(userText: string, overrides?: Partial<TurnRecord>): TurnRecord {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    backend: 'claude',
    userText,
    assistantText: 'sure',
    tools: [],
    ...overrides
  };
}

describe('SessionStore', () => {
  it('activeSession creates one when the dir is empty and reuses it afterwards', () => {
    const store = new SessionStore(dir);
    const a = store.activeSession();
    const b = store.activeSession();
    expect(a.id).toBe(b.id);
    expect(store.list()).toHaveLength(1);
  });

  it('round-trips turns and summaries through a fresh instance', () => {
    const store = new SessionStore(dir);
    const s = store.activeSession();
    const t = turn('remind me to water the plants', {
      tools: [{ toolName: 'calendar_create', ok: true }]
    });
    store.appendTurn(s.id, t);

    const reopened = new SessionStore(dir);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.activeSession().id).toBe(s.id);
    expect(reopened.turns(s.id)).toEqual([t]);
    expect(reopened.list()[0]?.title).toBe('remind me to water the plants');
  });

  it('lists sessions most recent first, tracking activity across instances', () => {
    const store = new SessionStore(dir);
    const first = store.newSession();
    const second = store.newSession();
    const third = store.newSession();
    expect(store.list().map((s) => s.id)).toEqual([third.id, second.id, first.id]);

    // Touching the oldest session bumps it to the front.
    store.appendTurn(first.id, turn('hello again'));
    expect(store.list().map((s) => s.id)).toEqual([first.id, third.id, second.id]);

    // Ordering survives a reload (and the touched session is the active one).
    const reopened = new SessionStore(dir);
    expect(reopened.list().map((s) => s.id)).toEqual([first.id, third.id, second.id]);
    expect(reopened.activeSession().id).toBe(first.id);
  });

  it('caps list() at 100 while keeping all sessions on disk', () => {
    const store = new SessionStore(dir);
    for (let i = 0; i < 105; i++) store.newSession();
    const listed = store.list();
    expect(listed).toHaveLength(100);
    // The most recent one is first; the oldest five fell off the list.
    expect(listed[0]?.id).toBe(store.activeSession().id);
  });

  it('keeps a separate native session id per backend', () => {
    const store = new SessionStore(dir);
    const s = store.activeSession();
    expect(store.backendSessionId(s.id, 'claude')).toBeNull();
    expect(store.backendSessionId(s.id, 'codex')).toBeNull();

    store.setBackendSessionId(s.id, 'claude', 'claude-thread-1');
    store.setBackendSessionId(s.id, 'codex', 'codex-thread-9');
    expect(store.backendSessionId(s.id, 'claude')).toBe('claude-thread-1');
    expect(store.backendSessionId(s.id, 'codex')).toBe('codex-thread-9');

    const reopened = new SessionStore(dir);
    expect(reopened.backendSessionId(s.id, 'claude')).toBe('claude-thread-1');
    expect(reopened.backendSessionId(s.id, 'codex')).toBe('codex-thread-9');
  });

  it('titles a session with the first utterance truncated to 48 chars', () => {
    const store = new SessionStore(dir);
    const s = store.activeSession();
    const long = 'please summarize the quarterly report and email it to the whole team today';
    store.appendTurn(s.id, turn(long));
    const title = store.list()[0]?.title ?? '';
    expect(title).toBe(long.slice(0, 48));
    expect(title.length).toBe(48);

    // Later turns do not rename the session.
    store.appendTurn(s.id, turn('and another thing'));
    expect(store.list()[0]?.title).toBe(long.slice(0, 48));
  });

  it('records the backend of the most recent turn on the summary', () => {
    const store = new SessionStore(dir);
    const s = store.activeSession();
    store.appendTurn(s.id, turn('hi', { backend: 'codex' }));
    expect(store.list()[0]?.backend).toBe('codex');
  });

  it('throws on unknown session ids', () => {
    const store = new SessionStore(dir);
    expect(() => store.turns('nope')).toThrow(/Unknown session/);
  });
});
