import { describe, expect, it } from 'vitest';
import { detectOffTheRecord, OFF_THE_RECORD_ACK } from '../src/agents/brain/offTheRecord';
import { Conductor, type Broadcast } from '../src/main/conductor';
import type { AgentEvent, TurnRecord } from '../src/shared/types';

describe('detectOffTheRecord', () => {
  const cases: { text: string; otr: boolean; standalone?: boolean; forget?: boolean; cleaned?: string }[] = [
    { text: 'off the record', otr: true, standalone: true },
    { text: 'off the record, my ssn is 123-45', otr: true, standalone: false, cleaned: 'my ssn is 123-45' },
    { text: "don't remember this", otr: true, standalone: true },
    { text: 'forget that', otr: true, standalone: true, forget: true },
    { text: 'keep this between us', otr: true, standalone: true },
    { text: 'what time is it', otr: false },
    { text: 'ask codex to summarize this file', otr: false }
  ];

  for (const c of cases) {
    it(`"${c.text}" → offTheRecord=${c.otr}`, () => {
      const r = detectOffTheRecord(c.text);
      expect(r.offTheRecord).toBe(c.otr);
      if (c.standalone !== undefined) expect(r.standalone).toBe(c.standalone);
      if (c.forget !== undefined) expect(r.forget).toBe(c.forget);
      if (c.cleaned !== undefined) expect(r.cleaned).toBe(c.cleaned);
    });
  }
});

/** Minimal router/sessions harness for the conductor's off-the-record pre-check. */
function harness() {
  const events: AgentEvent[] = [];
  const sent: { ch: string; arg: unknown }[] = [];
  const broadcast: Broadcast = (ch, ...args) => sent.push({ ch, arg: args[0] });
  const dispatched: { text: string }[] = [];
  let flag = false;
  const record: TurnRecord = { id: 'r', at: 'now', backend: 'claude', userText: '', assistantText: 'a', tools: [] };
  const router = {
    dispatch: async (text: string, onEvent: (e: AgentEvent) => void): Promise<TurnRecord> => {
      dispatched.push({ text });
      onEvent({ kind: 'done', finalText: 'a' });
      return record;
    },
    interrupt: async () => {},
    setOffTheRecord: (next: boolean) => {
      flag = next;
    }
  };
  const sessions = {
    activeSession: () => ({ id: 's', title: '', updatedAt: 'now', backend: 'claude' as const }),
    turns: () => [record]
  };
  return {
    events,
    sent,
    dispatched,
    getFlag: () => flag,
    conductor: (forgetLast?: () => Promise<unknown> | void) =>
      new Conductor({
        router,
        sessions,
        pipeline: () => ({ onAgentEvent: (e) => events.push(e), cancel: () => {} }),
        broadcast,
        offTheRecord: { detect: detectOffTheRecord, forgetLast }
      })
  };
}

describe('conductor off-the-record path', () => {
  it('a bare directive is acknowledged and never dispatched', async () => {
    const h = harness();
    await h.conductor().handleUtterance('off the record');
    expect(h.dispatched).toEqual([]);
    const dones = h.events.filter((e) => e.kind === 'done');
    expect(dones).toEqual([{ kind: 'done', finalText: OFF_THE_RECORD_ACK }]);
    // No persisted turn pushed for the ack.
    expect(h.sent.filter((s) => s.ch === 'session:updated')).toHaveLength(0);
  });

  it('a directive with content sets the flag and dispatches the remainder', async () => {
    const h = harness();
    await h.conductor().handleText('off the record, tell me a joke');
    expect(h.getFlag()).toBe(true);
    expect(h.dispatched).toEqual([{ text: 'tell me a joke' }]);
  });

  it('"forget that" removes the most recent capture and acknowledges', async () => {
    const h = harness();
    let forgets = 0;
    await h.conductor(() => {
      forgets += 1;
    }).handleUtterance('forget that');
    expect(forgets).toBe(1);
    expect(h.dispatched).toEqual([]);
    expect(h.events.some((e) => e.kind === 'done')).toBe(true);
  });

  it('a normal utterance is unaffected', async () => {
    const h = harness();
    await h.conductor().handleText('what time is it');
    expect(h.getFlag()).toBe(false);
    expect(h.dispatched).toEqual([{ text: 'what time is it' }]);
  });
});
