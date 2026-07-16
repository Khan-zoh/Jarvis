import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRouter, routeUtterance } from '../src/agents/router';
import { SessionStore } from '../src/agents/sessions';
import type { ContextProvider, TurnObserver } from '../src/agents/seams';
import type { AgentEvent, TurnRecord } from '../src/shared/types';
import { FakeBackend } from './fakes/fakeBackend';
import { makeConfig } from './fakes/testConfig';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

describe('routeUtterance', () => {
  const cfg = makeConfig(); // defaultBackend: claude

  it.each([
    // [utterance, expected backend, expected cleanedInput]
    ['ask codex to refactor this', 'codex', 'refactor this'],
    ['use codex to check my mail', 'codex', 'check my mail'],
    ["codex, what's up", 'codex', "what's up"],
    ['use claude for this', 'claude', 'for this'],
    ['ask claude what time it is', 'claude', 'what time it is'],
    ['claude, hello there', 'claude', 'hello there'],
    // case-insensitive
    ['Ask Codex to fix it', 'codex', 'fix it'],
    ['CODEX, ping', 'codex', 'ping'],
    // directive with nothing after it
    ['use codex', 'codex', ''],
    // "to" only stripped as a whole word
    ["ask codex tomorrow's agenda", 'codex', "tomorrow's agenda"],
    // no directive → default backend, input untouched
    ["what's the weather tomorrow", 'claude', "what's the weather tomorrow"],
    // mid-sentence mention is NOT a directive
    ['I could ask codex to do this', 'claude', 'I could ask codex to do this'],
    ['tell me about codex, the tool', 'claude', 'tell me about codex, the tool'],
    // bare name without comma is not a directive either
    ['codex is a strange name', 'claude', 'codex is a strange name']
  ])('%j → %s / %j', (text, backend, cleanedInput) => {
    expect(routeUtterance(text, cfg)).toEqual({ backend, cleanedInput });
  });

  it('falls back to the configured default backend', () => {
    const codexDefault = makeConfig({ defaultBackend: 'codex' });
    expect(routeUtterance('hello there', codexDefault)).toEqual({
      backend: 'codex',
      cleanedInput: 'hello there'
    });
  });
});

describe('AgentRouter', () => {
  let dir: string;
  let sessions: SessionStore;
  let claude: FakeBackend;
  let codex: FakeBackend;
  let events: AgentEvent[];
  const onEvent = (e: AgentEvent): void => {
    events.push(e);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-router-'));
    sessions = new SessionStore(dir);
    claude = new FakeBackend('claude');
    codex = new FakeBackend('codex');
    events = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRouter(seams?: ConstructorParameters<typeof AgentRouter>[3]): AgentRouter {
    return new AgentRouter({ claude, codex }, sessions, () => makeConfig(), seams);
  }

  it('passes backend events through in order and persists the turn with its tool list', async () => {
    claude.script({
      events: [
        { kind: 'text_delta', text: 'Sending ' },
        { kind: 'text_delta', text: 'now.' },
        { kind: 'tool_start', toolName: 'gmail_send', summary: 'Send email to Sam' },
        { kind: 'tool_end', toolName: 'gmail_send', ok: true },
        { kind: 'done', finalText: 'Sending now.' }
      ]
    });
    const router = makeRouter();
    const record = await router.dispatch('email sam that i am late', onEvent);

    expect(events.map((e) => e.kind)).toEqual([
      'text_delta',
      'text_delta',
      'tool_start',
      'tool_end',
      'done'
    ]);
    expect(record.backend).toBe('claude');
    expect(record.userText).toBe('email sam that i am late');
    expect(record.assistantText).toBe('Sending now.');
    expect(record.tools).toEqual([{ toolName: 'gmail_send', ok: true }]);

    const persisted = sessions.turns(sessions.activeSession().id);
    expect(persisted).toEqual([record]);
    expect(router.busy).toBe(false);
  });

  it('routes a leading directive to the named backend with the directive stripped', async () => {
    const router = makeRouter();
    await router.dispatch('ask codex to list my files', onEvent);
    expect(codex.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(0);
    expect(codex.calls[0]?.input).toBe('list my files');
  });

  it('lets an explicit override beat the directive', async () => {
    const router = makeRouter();
    await router.dispatch('ask codex to list my files', onEvent, 'claude');
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(0);
  });

  it('refuses with a synthetic spoken reply while busy', async () => {
    claude.script({ events: [{ kind: 'text_delta', text: 'thinking' }], hold: true });
    const router = makeRouter();

    const first = router.dispatch('long task', onEvent);
    await waitFor(() => claude.calls.length === 1);
    expect(router.busy).toBe(true);

    const busyEvents: AgentEvent[] = [];
    const second = await router.dispatch('another thing', (e) => busyEvents.push(e));
    expect(busyEvents).toEqual([
      { kind: 'text_delta', text: 'One moment, still working.' },
      { kind: 'done', finalText: 'One moment, still working.' }
    ]);
    expect(second.assistantText).toBe('One moment, still working.');
    // The refusal never reached a backend and was not persisted.
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(0);

    await router.interrupt();
    const firstRecord = await first;
    // The interrupted turn keeps its streamed text and is the only persisted turn.
    expect(firstRecord.assistantText).toBe('thinking');
    expect(sessions.turns(sessions.activeSession().id)).toHaveLength(1);
    expect(router.busy).toBe(false);
  });

  it('interrupt() delegates to the in-flight handle', async () => {
    claude.script({ events: [{ kind: 'text_delta', text: 'partial' }], hold: true });
    const router = makeRouter();
    const turn = router.dispatch('never mind', onEvent);
    await waitFor(() => claude.calls.length === 1);

    await router.interrupt();
    expect(claude.interrupts).toBe(1);
    await turn;
    // The backend surfaced the cancellation as its terminal event.
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'cancelled' });

    // Interrupt with nothing in flight is a no-op.
    await expect(router.interrupt()).resolves.toBeUndefined();
  });

  it('turns an init failure into an error event carrying the backend problem', async () => {
    codex.initResult = { ok: false, problem: 'Codex CLI not logged in. Run `codex login` first.' };
    const router = makeRouter();
    await router.dispatch('codex, do a thing', onEvent);

    expect(events).toEqual([
      { kind: 'error', message: 'Codex CLI not logged in. Run `codex login` first.' }
    ]);
    expect(codex.calls).toHaveLength(0);
    // Failed init leaves nothing persisted and does not wedge the router.
    expect(sessions.list()).toHaveLength(0);
    expect(router.busy).toBe(false);
    await router.dispatch('hello', onEvent);
    expect(claude.calls).toHaveLength(1);
  });

  it('records the native session id and resumes with it on the next turn', async () => {
    claude.script({ events: [{ kind: 'done', finalText: 'hi' }], sessionId: 'native-A' });
    claude.script({ events: [{ kind: 'done', finalText: 'again' }], sessionId: 'native-A' });
    const router = makeRouter();

    await router.dispatch('hello', onEvent);
    expect(claude.calls[0]?.sessionId).toBeNull();
    const session = sessions.activeSession();
    expect(sessions.backendSessionId(session.id, 'claude')).toBe('native-A');

    await router.dispatch('and more', onEvent);
    expect(claude.calls[1]?.sessionId).toBe('native-A');
    // Switching backends mid-session starts a fresh native thread.
    await router.dispatch('codex, take over', onEvent);
    expect(codex.calls[0]?.sessionId).toBeNull();
  });

  it('prepends non-null ContextProvider results as a context preamble', async () => {
    const provider: ContextProvider = {
      id: 'profile',
      contribute: async () => 'The user prefers tea over coffee.'
    };
    const silent: ContextProvider = { id: 'silent', contribute: async () => null };
    const router = makeRouter({ providers: [provider, silent] });

    await router.dispatch('what should i drink', onEvent);
    const input = claude.calls[0]?.input ?? '';
    expect(input).toContain('The user prefers tea over coffee.');
    expect(input.indexOf('The user prefers tea over coffee.')).toBeLessThan(
      input.indexOf('what should i drink')
    );
    expect(input.startsWith('Context:')).toBe(true);
    // The persisted turn keeps the bare user text, not the preamble.
    const record = sessions.turns(sessions.activeSession().id)[0];
    expect(record?.userText).toBe('what should i drink');
  });

  it('drops a slow provider at its timeout without stalling the turn', async () => {
    const fast: ContextProvider = { id: 'fast', contribute: async () => 'FAST FACT' };
    const slow: ContextProvider = {
      id: 'slow',
      contribute: () => new Promise((resolve) => setTimeout(() => resolve('SLOW FACT'), 300))
    };
    const throwing: ContextProvider = {
      id: 'boom',
      contribute: async () => {
        throw new Error('provider exploded');
      }
    };
    const router = makeRouter({ providers: [fast, slow, throwing], providerTimeoutMs: 30 });

    const start = Date.now();
    await router.dispatch('quick question', onEvent);
    expect(Date.now() - start).toBeLessThan(250);

    const input = claude.calls[0]?.input ?? '';
    expect(input).toContain('FAST FACT');
    expect(input).not.toContain('SLOW FACT');
    expect(events.at(-1)?.kind).toBe('done');
  });

  it('fires TurnObserver.onTurn detached, after the turn is persisted', async () => {
    let seen: { turn: TurnRecord; persistedIds: string[]; offTheRecord: boolean } | null = null;
    let resolveSeen!: () => void;
    const seenP = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const observer: TurnObserver = {
      id: 'capture',
      onTurn: async (turn, flags) => {
        seen = {
          turn,
          persistedIds: sessions.turns(sessions.activeSession().id).map((t) => t.id),
          offTheRecord: flags.offTheRecord
        };
        resolveSeen();
      }
    };
    const router = makeRouter({ observers: [observer] });
    const record = await router.dispatch('remember my locker code is 4412', onEvent);

    await seenP;
    expect(seen).not.toBeNull();
    const s = seen as unknown as { turn: TurnRecord; persistedIds: string[]; offTheRecord: boolean };
    expect(s.turn).toEqual(record);
    // Persistence happened before the observer ran: the turn was already in the store.
    expect(s.persistedIds).toContain(record.id);
    expect(s.offTheRecord).toBe(false);
  });

  it('an observer failure never breaks the turn', async () => {
    const failing: TurnObserver = {
      id: 'flaky',
      onTurn: async () => {
        throw new Error('observer exploded');
      }
    };
    const router = makeRouter({ observers: [failing] });
    const record = await router.dispatch('hello', onEvent);
    expect(record.assistantText).toBe('ok');
    await sleep(20); // let the detached rejection settle (it is caught and logged)
  });

  it('setOffTheRecord skips observers for exactly the next turn', async () => {
    const calls: TurnRecord[] = [];
    const observer: TurnObserver = {
      id: 'capture',
      onTurn: async (turn) => {
        calls.push(turn);
      }
    };
    const router = makeRouter({ observers: [observer] });

    router.setOffTheRecord(true);
    const secret = await router.dispatch('don\'t remember this: my pin is 9999', onEvent);
    await sleep(30);
    expect(calls).toHaveLength(0);
    // The turn itself is still persisted in local history.
    expect(sessions.turns(sessions.activeSession().id).map((t) => t.id)).toContain(secret.id);

    // Flag was consumed: the following turn is observed again.
    const normal = await router.dispatch('back on the record', onEvent);
    await waitFor(() => calls.length === 1);
    expect(calls[0]?.id).toBe(normal.id);
  });
});
