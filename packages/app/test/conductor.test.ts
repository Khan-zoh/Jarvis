// Integration tests for the wire-and-converse seam (cdd/tasks/wire-and-converse.md "Tests"):
// the Conductor with a REAL AgentRouter + SessionStore over FakeBackends, and — for the voice
// path — a REAL VoicePipeline over the fake voice components, so the full
// utterance → dispatch → agent events → chunker → TTS chain is exercised with no Electron, no
// SDK, and no audio.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor, type Broadcast } from '../src/main/conductor';
import { AgentRouter, buildSwitchNote } from '../src/agents/router';
import { SessionStore } from '../src/agents/sessions';
import { VoicePipeline } from '../src/voice/pipeline';
import { Endpointer } from '../src/voice/vad';
import type { AgentEvent, TurnRecord } from '../src/shared/types';
import { FakeBackend } from './fakes/fakeBackend';
import { FakeCapture, FakeStt, FakeTts, FakeVad, FakeWake, makeFrame } from './fakes/fakeVoice';
import { makeConfig } from './fakes/testConfig';

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Records every broadcast like a mock webContents would receive it. */
function makeBroadcastLog(): { broadcast: Broadcast; sent: { ch: string; arg: unknown }[] } {
  const sent: { ch: string; arg: unknown }[] = [];
  const broadcast: Broadcast = (ch, ...args) => {
    sent.push({ ch, arg: args[0] });
  };
  return { broadcast, sent };
}

describe('Conductor', () => {
  let dir: string;
  let sessions: SessionStore;
  let claude: FakeBackend;
  let codex: FakeBackend;
  let router: AgentRouter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-conductor-'));
    sessions = new SessionStore(dir);
    claude = new FakeBackend('claude');
    codex = new FakeBackend('codex');
    router = new AgentRouter({ claude, codex }, sessions, () => makeConfig());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('text command: dispatch → events broadcast → turn persisted → session:updated pushed, NO TTS', async () => {
    claude.script({
      events: [
        { kind: 'text_delta', text: 'Hi ' },
        { kind: 'text_delta', text: 'there.' },
        { kind: 'tool_start', toolName: 'calendar_list_events', summary: 'checking your calendar' },
        { kind: 'tool_end', toolName: 'calendar_list_events', ok: true },
        { kind: 'done', finalText: 'Hi there.' }
      ]
    });
    const { broadcast, sent } = makeBroadcastLog();
    const pipelineCalls: AgentEvent[] = [];
    const conductor = new Conductor({
      router,
      sessions,
      pipeline: () => ({
        onAgentEvent: (e) => pipelineCalls.push(e),
        cancel: () => {}
      }),
      broadcast
    });

    await conductor.handleText('what is on my calendar today');

    // Every agent event was broadcast, in order, followed by exactly one session:updated.
    const agentKinds = sent
      .filter((s) => s.ch === 'agent:event')
      .map((s) => (s.arg as AgentEvent).kind);
    expect(agentKinds).toEqual(['text_delta', 'text_delta', 'tool_start', 'tool_end', 'done']);
    const pushes = sent.filter((s) => s.ch === 'session:updated');
    expect(pushes).toHaveLength(1);
    const pushed = pushes[0]?.arg as TurnRecord;
    expect(pushed.userText).toBe('what is on my calendar today');
    expect(pushed.assistantText).toBe('Hi there.');
    expect(pushed.tools).toEqual([{ toolName: 'calendar_list_events', ok: true }]);

    // The turn is persisted and the pushed record IS the persisted record.
    expect(sessions.turns(sessions.activeSession().id)).toEqual([pushed]);
    // Text-bar rule: the pipeline (TTS path) never saw a single event.
    expect(pipelineCalls).toEqual([]);
  });

  it('text command with an explicit backend override reaches that backend', async () => {
    const { broadcast } = makeBroadcastLog();
    const conductor = new Conductor({ router, sessions, pipeline: () => null, broadcast });
    await conductor.handleText('hello', 'codex');
    expect(codex.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(0);
  });

  it('backend directive routing: "ask codex …" reaches the codex backend', async () => {
    const { broadcast } = makeBroadcastLog();
    const conductor = new Conductor({ router, sessions, pipeline: () => null, broadcast });
    await conductor.handleText('ask codex what 17 times 23 is');
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]?.input).toBe('what 17 times 23 is');
    expect(claude.calls).toHaveLength(0);
  });

  it('voice utterance: dispatch events fan to pipeline.onAgentEvent AND broadcast; chunker feeds TTS', async () => {
    claude.script({
      events: [
        { kind: 'text_delta', text: 'It is noon. And ' },
        { kind: 'text_delta', text: 'sunny.' },
        { kind: 'done', finalText: 'It is noon. And sunny.' }
      ]
    });
    const cfg = makeConfig();
    cfg.voice.ttsEnabled = true;
    const capture = new FakeCapture();
    const wake = new FakeWake();
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const pipeline = new VoicePipeline({ capture, wake, vad, stt, tts, config: () => cfg });
    const { broadcast, sent } = makeBroadcastLog();
    const conductor = new Conductor({ router, sessions, pipeline: () => pipeline, broadcast });
    // Same subscription src/main/index.ts makes (startup step 6).
    let utteranceDone: Promise<void> | null = null;
    pipeline.on('utterance', (text) => {
      utteranceDone = conductor.handleUtterance(text);
    });

    await pipeline.start();
    // Enter the machine at the transcribing-equivalent point with a final user text.
    pipeline.injectText('what time is it');
    expect(utteranceDone).not.toBeNull();
    await utteranceDone;

    // The sentence chunker fed complete sentences to TTS (voice-initiated turn → spoken).
    expect(tts.spoken).toEqual(['It is noon.', 'And sunny.']);
    // Events were ALSO broadcast to the renderers.
    const agentKinds = sent
      .filter((s) => s.ch === 'agent:event')
      .map((s) => (s.arg as AgentEvent).kind);
    expect(agentKinds).toEqual(['text_delta', 'text_delta', 'done']);
    expect(sent.filter((s) => s.ch === 'session:updated')).toHaveLength(1);
    // Turn persisted.
    expect(sessions.turns(sessions.activeSession().id)).toHaveLength(1);
  });

  it('cancel fans out to router.interrupt AND pipeline.cancel', async () => {
    claude.script({ events: [{ kind: 'text_delta', text: 'thinking' }], hold: true });
    const { broadcast } = makeBroadcastLog();
    let cancels = 0;
    const conductor = new Conductor({
      router,
      sessions,
      pipeline: () => ({ onAgentEvent: () => {}, cancel: () => (cancels += 1) }),
      broadcast
    });

    const turn = conductor.handleText('long task');
    // Wait for the backend to receive the turn before cancelling.
    while (claude.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    await conductor.cancel();
    await turn;

    expect(claude.interrupts).toBe(1);
    expect(cancels).toBe(1);
  });

  it('busy refusal is broadcast but NOT pushed as session:updated (never persisted)', async () => {
    claude.script({ events: [{ kind: 'text_delta', text: 'working' }], hold: true });
    const { broadcast, sent } = makeBroadcastLog();
    const conductor = new Conductor({ router, sessions, pipeline: () => null, broadcast });

    const first = conductor.handleText('long task');
    while (claude.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    await conductor.handleText('impatient second ask');

    const refusals = sent
      .filter((s) => s.ch === 'agent:event')
      .map((s) => s.arg as AgentEvent)
      .filter((e) => e.kind === 'done');
    expect(refusals).toEqual([{ kind: 'done', finalText: 'One moment, still working.' }]);
    // No session:updated for the refusal — the store never saw it.
    expect(sent.filter((s) => s.ch === 'session:updated')).toHaveLength(0);

    await router.interrupt();
    await first;
    // The interrupted first turn WAS persisted and pushed.
    expect(sent.filter((s) => s.ch === 'session:updated')).toHaveLength(1);
  });

  it('barge-in mid-backend-stream: exactly one backend interrupt, then the replacement utterance dispatches cleanly (B1 closure)', async () => {
    // Full pipeline → conductor → router integration with fakes: the first voice turn is
    // SPEAKING while its backend turn is still streaming (held); the wake word then fires
    // mid-stream. Review-mandated assertions: exactly ONE backend interrupt, and the replacement
    // utterance dispatches successfully — no "One moment, still working." busy refusal.
    claude.script({ events: [{ kind: 'text_delta', text: 'A very long reply. ' }], hold: true });
    claude.script({
      events: [
        { kind: 'text_delta', text: 'Second answer.' },
        { kind: 'done', finalText: 'Second answer.' }
      ]
    });

    const cfg = makeConfig();
    cfg.voice.ttsEnabled = true;
    const capture = new FakeCapture();
    const wake = new FakeWake();
    const vad = new FakeVad();
    const stt = new FakeStt();
    const tts = new FakeTts();
    tts.hold = true; // playback stays in flight so the pipeline remains in 'speaking'

    let conductorRef!: Conductor;
    const pipeline = new VoicePipeline({
      capture,
      wake,
      vad,
      stt,
      tts,
      config: () => cfg,
      // Same wiring src/main/index.ts makes: barge-in → conductor interrupts the backend.
      onBargeIn: () => conductorRef.notifyBargeIn(),
      makeEndpointer: () => new Endpointer({ silenceMs: 64, maxMs: 32_000 })
    });
    const { broadcast, sent } = makeBroadcastLog();
    const conductor = new Conductor({ router, sessions, pipeline: () => pipeline, broadcast });
    conductorRef = conductor;
    const dispatches: Promise<void>[] = [];
    pipeline.on('utterance', (text) => {
      dispatches.push(conductor.handleUtterance(text));
    });

    await pipeline.start();

    // Turn 1 (voice): backend streams a delta then HOLDS mid-stream; the pipeline speaks it.
    pipeline.injectText('first question');
    await waitFor(() => claude.calls.length === 1);
    await waitFor(() => pipeline.state === 'speaking');
    expect(tts.spoken).toEqual(['A very long reply.']);
    expect(router.busy).toBe(true);

    // Wake word fires while speaking AND while the backend turn is still in flight: barge-in.
    wake.fireOn(1);
    capture.push(makeFrame());
    await waitFor(() => pipeline.state === 'listening');
    expect(tts.cancelCalls).toBe(1);

    // The replacement utterance: speech then 2 silence frames → endpoint → STT.
    stt.script = ['second question'];
    vad.script = ['speech', 'silence', 'silence'];
    capture.push(makeFrame(3277));
    capture.push(makeFrame());
    capture.push(makeFrame());

    // The replacement turn reaches the backend — the in-flight turn died first.
    await waitFor(() => claude.calls.length === 2);
    await Promise.all(dispatches);

    // Exactly ONE backend interrupt for the barge-in.
    expect(claude.interrupts).toBe(1);
    // The replacement dispatched cleanly with the new utterance. (The interrupted turn never
    // recorded a native session id, so the router legitimately prepends its switch note.)
    expect(claude.calls[1]?.input.endsWith('second question')).toBe(true);
    // NO busy refusal anywhere on the wire.
    const deltaTexts = sent
      .filter((s) => s.ch === 'agent:event')
      .map((s) => s.arg as AgentEvent)
      .filter((e): e is Extract<AgentEvent, { kind: 'text_delta' }> => e.kind === 'text_delta')
      .map((e) => e.text);
    expect(deltaTexts).not.toContain('One moment, still working.');
    // Both turns persisted: the interrupted one (with its streamed text) and the replacement.
    const turns = sessions.turns(sessions.activeSession().id);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.assistantText).toBe('A very long reply. ');
    expect(turns[1]?.userText).toBe('second question');
    expect(turns[1]?.assistantText).toBe('Second answer.');
    // The replacement's reply was spoken (the dead turn's TTS was cancelled, the new one plays).
    expect(tts.spoken).toEqual(['A very long reply.', 'Second answer.']);
    expect(router.busy).toBe(false);
  });

  it('backend switch mid-session injects the one-line context note on the first switched turn', async () => {
    const { broadcast } = makeBroadcastLog();
    const conductor = new Conductor({ router, sessions, pipeline: () => null, broadcast });

    claude.script({ events: [{ kind: 'done', finalText: 'the meeting is at 3pm' }] });
    await conductor.handleText('when is my meeting');
    await conductor.handleText('ask codex to double-check that');

    expect(codex.calls).toHaveLength(1);
    const input = codex.calls[0]?.input ?? '';
    // The note precedes the actual ask and carries the prior exchange, bounded.
    expect(input).toContain('taking over an ongoing conversation');
    expect(input).toContain('when is my meeting');
    expect(input).toContain('the meeting is at 3pm');
    expect(input.endsWith('double-check that')).toBe(true);

    // Resumed codex turns do NOT get the note again (native id recorded).
    await conductor.handleText('ask codex one more thing');
    expect(codex.calls[1]?.sessionId).toBe('codex-native-1');
    expect(codex.calls[1]?.input).toBe('one more thing');
  });
});

describe('buildSwitchNote', () => {
  it('is one line, keeps only the last 3 turns, and caps each text', () => {
    const turn = (n: number, len = 10): TurnRecord => ({
      id: `t${n}`,
      at: new Date().toISOString(),
      backend: 'claude',
      userText: `question ${n} ${'x'.repeat(len)}`,
      assistantText: `answer ${n}`,
      tools: []
    });
    const note = buildSwitchNote([turn(1), turn(2), turn(3), turn(4, 500)]);
    expect(note).not.toContain('question 1');
    expect(note).toContain('question 2');
    expect(note).toContain('question 4');
    expect(note).not.toContain('\n');
    // 500-char user text was capped to 160.
    expect(note.length).toBeLessThan(700);
  });
});
