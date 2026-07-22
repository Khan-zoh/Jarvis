import { describe, expect, it } from 'vitest';
import { CollaborationManager, buildCollaborationPrompt } from '../src/agents/collaboration';
import type { AgentBackend, TurnHandle } from '../src/agents/types';
import type { AgentEvent, BackendId, CollaborationEvent, CollaborationRequest } from '../src/shared/types';

class FakeCollaborationBackend implements AgentBackend {
  readonly prompts: string[] = [];
  private calls = 0;

  constructor(readonly id: BackendId) {}

  async init(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async startTurn(args: {
    input: string;
    sessionId: string | null;
    onEvent: (event: AgentEvent) => void;
  }): Promise<{ handle: TurnHandle; result: Promise<{ finalText: string; sessionId: string }> }> {
    this.prompts.push(args.input);
    this.calls += 1;
    args.onEvent({ kind: 'status_update', text: `${this.id} is checking` });
    args.onEvent({ kind: 'tool_start', toolName: 'read', summary: 'reading context' });
    args.onEvent({ kind: 'tool_end', toolName: 'read', ok: true });
    const text = `${this.id} answer ${this.calls}`;
    args.onEvent({ kind: 'text_delta', text });
    args.onEvent({ kind: 'done', finalText: text });
    return {
      handle: { interrupt: async () => {} },
      result: Promise.resolve({ finalText: text, sessionId: `${this.id}-thread` })
    };
  }
}

const request: CollaborationRequest = {
  task: 'design and verify a release pipeline',
  claudeRole: 'architect',
  codexRole: 'test engineer',
  rounds: 2,
  firstSpeaker: 'claude'
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition did not settle');
}

describe('CollaborationManager', () => {
  it('alternates both agents, preserves their native threads, and shows every handoff', async () => {
    const claude = new FakeCollaborationBackend('claude');
    const codex = new FakeCollaborationBackend('codex');
    const events: CollaborationEvent[] = [];
    const manager = new CollaborationManager({ backends: { claude, codex }, emit: (event) => events.push(event) });

    manager.start(request);
    await waitUntil(() => manager.snapshot().status === 'completed');

    const snapshot = manager.snapshot();
    expect(snapshot.messages.map((message) => message.backend)).toEqual(['claude', 'codex', 'claude', 'codex']);
    expect(snapshot.messages.every((message) => message.tools[0]?.toolName === 'read')).toBe(true);
    expect(codex.prompts[0]).toContain('claude answer 1');
    expect(claude.prompts[1]).toContain('codex answer 1');
    expect(events.filter((event) => event.kind === 'message')).toHaveLength(4);
  });

  it('refuses to start while a normal turn is running', () => {
    const claude = new FakeCollaborationBackend('claude');
    const codex = new FakeCollaborationBackend('codex');
    const manager = new CollaborationManager({
      backends: { claude, codex },
      emit: () => {},
      normalTurnBusy: () => true
    });
    expect(() => manager.start(request)).toThrow(/current assistant turn/i);
  });
});

describe('buildCollaborationPrompt', () => {
  it('makes the task, roles, speaker order, and partner response explicit', () => {
    const prompt = buildCollaborationPrompt(
      request,
      'codex',
      { id: '1', at: '', backend: 'claude', role: 'architect', text: 'use a matrix build', updates: [], tools: [] },
      2,
      4
    );
    expect(prompt).toContain(request.task);
    expect(prompt).toContain('test engineer');
    expect(prompt).toContain('use a matrix build');
    expect(prompt).toContain('exchange 2 of 4');
  });
});
