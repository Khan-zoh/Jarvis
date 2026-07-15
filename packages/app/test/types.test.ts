import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  AppConfig,
  BackendId,
  SessionSummary,
  TranscriptEvent,
  TurnRecord
} from '../src/shared/types';

// Type-only test: if the shared types drift or fail to compile, this file fails to typecheck.
describe('shared types', () => {
  it('imports and shapes every shared type', () => {
    const backend: BackendId = 'claude';

    const event: AgentEvent = { kind: 'done', finalText: 'ok' };

    const transcript: TranscriptEvent = { text: 'hello jarvis', final: true };

    const turn: TurnRecord = {
      id: 'turn-1',
      at: new Date().toISOString(),
      backend,
      userText: 'hi',
      assistantText: 'hello',
      tools: [{ toolName: 'ping', ok: true }]
    };

    const session: SessionSummary = {
      id: 'session-1',
      title: 'test session',
      updatedAt: turn.at,
      backend
    };

    const configShape: Pick<AppConfig, 'agentName' | 'ui'> = {
      agentName: 'Jarvis',
      ui: { launchOnStartup: false, hotkey: 'Ctrl+Shift+Space' }
    };

    expect(backend).toBe('claude');
    expect(event.kind).toBe('done');
    expect(transcript.final).toBe(true);
    expect(turn.tools).toHaveLength(1);
    expect(session.backend).toBe('claude');
    expect(configShape.agentName).toBe('Jarvis');
  });
});
