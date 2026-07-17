// VoicePipeline integration tests with fakes, per cdd/tasks/voice-pipeline.md ("Tests") and
// testing-strategy.md: full happy-path state sequence; barge-in during speaking; listen timeout →
// idle with NO stt call; cancel during thinking stops TTS and ignores late agent events; empty
// transcript → idle silently; error → idle after 3s (fake timers); burst queue never exceeds its
// bound (amendments.md A6 / vad agent's burst finding).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, AssistantState, TranscriptEvent } from '../src/shared/types';
import { VoicePipeline } from '../src/voice/pipeline';
import { Endpointer } from '../src/voice/vad';
import { makeConfig } from './fakes/testConfig';
import { FakeCapture, FakeStt, FakeTts, FakeVad, FakeWake, makeFrame } from './fakes/fakeVoice';

/** Endpointer with tiny thresholds so tests need only 2 silence frames after speech. */
const testEndpointer = (): Endpointer => new Endpointer({ silenceMs: 64, maxMs: 32_000 });

interface Rig {
  pipeline: VoicePipeline;
  capture: FakeCapture;
  wake: FakeWake;
  vad: FakeVad;
  stt: FakeStt;
  tts: FakeTts;
  states: AssistantState[];
  transcripts: TranscriptEvent[];
  utterances: string[];
  micLevels: number[];
  wakeSounds: number;
  config: AppConfig;
}

function makeRig(configPatch?: Partial<AppConfig['voice']>): Rig {
  const config: AppConfig = makeConfig();
  config.voice = { ...config.voice, ttsEnabled: true, ...configPatch };

  const capture = new FakeCapture();
  const wake = new FakeWake();
  const vad = new FakeVad();
  const stt = new FakeStt();
  const tts = new FakeTts();

  const rig: Rig = {
    pipeline: undefined as unknown as VoicePipeline,
    capture,
    wake,
    vad,
    stt,
    tts,
    states: [],
    transcripts: [],
    utterances: [],
    micLevels: [],
    wakeSounds: 0,
    config
  };

  const pipeline = new VoicePipeline({
    capture,
    wake,
    vad,
    stt,
    tts,
    config: () => config,
    playWakeSound: () => {
      rig.wakeSounds += 1;
    },
    makeEndpointer: testEndpointer
  });
  pipeline.on('state', (s) => rig.states.push(s));
  pipeline.on('transcript', (e) => rig.transcripts.push(e));
  pipeline.on('utterance', (t) => rig.utterances.push(t));
  pipeline.on('micLevel', (l) => rig.micLevels.push(l));
  rig.pipeline = pipeline;
  return rig;
}

/** Flushes microtasks (and any due fake timers) so async drain/STT/TTS continuations settle. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VoicePipeline', () => {
  it('runs the full happy path: idle→listening→transcribing→thinking→speaking→idle', async () => {
    const rig = makeRig();
    rig.wake.fireOn(1);
    rig.vad.script = ['speech', 'silence', 'silence'];
    rig.stt.script = ['what time is it'];

    await rig.pipeline.start();
    expect(rig.capture.startCalls).toBe(1);
    expect(rig.pipeline.state).toBe('idle');

    // Frame 1: wake word fires -> listening + wake sound.
    rig.capture.push(makeFrame());
    await flush();
    expect(rig.pipeline.state).toBe('listening');
    expect(rig.wakeSounds).toBe(1);

    // Frames 2-4: speech, then 2 silence frames -> endpoint -> transcribe -> thinking.
    rig.capture.push(makeFrame(3277)); // ~0.1 RMS
    await flush();
    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();

    expect(rig.pipeline.state).toBe('thinking');
    expect(rig.stt.transcribeCalls).toHaveLength(1);
    // The utterance buffer contains exactly the 3 listened frames (3 * 512 samples).
    expect(rig.stt.transcribeCalls[0]!.length).toBe(3 * 512);
    expect(rig.transcripts).toEqual([{ text: 'what time is it', final: true }]);
    expect(rig.utterances).toEqual(['what time is it']);
    // Mic level emitted per listening frame, RMS in 0..1.
    expect(rig.micLevels).toHaveLength(3);
    expect(rig.micLevels[0]!).toBeCloseTo(3277 / 32768, 3);
    for (const l of rig.micLevels) {
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }

    // Agent streams a reply: first completed sentence flips to speaking.
    rig.pipeline.onAgentEvent({ kind: 'text_delta', text: 'It is **noon**. And' });
    expect(rig.pipeline.state).toBe('speaking');
    expect(rig.tts.spoken).toEqual(['It is noon.']);

    // Done: the chunker's tail ("And", left over from the delta stream) is flushed to TTS,
    // then -> idle once playback resolves.
    rig.pipeline.onAgentEvent({ kind: 'done', finalText: 'It is noon. And' });
    await flush();
    expect(rig.tts.spoken).toEqual(['It is noon.', 'And']);
    expect(rig.pipeline.state).toBe('idle');

    expect(rig.states).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'idle']);
  });

  it('barge-in: wake during speaking cancels TTS and enters listening', async () => {
    const rig = makeRig();
    rig.tts.hold = true; // playback stays in flight
    await rig.pipeline.start();

    rig.pipeline.injectText('hello there');
    expect(rig.pipeline.state).toBe('thinking');
    rig.pipeline.onAgentEvent({ kind: 'text_delta', text: 'A very long reply. ' });
    expect(rig.pipeline.state).toBe('speaking');
    expect(rig.tts.spoken).toEqual(['A very long reply.']);

    // Wake word fires while speaking.
    rig.wake.fireOn(1);
    rig.capture.push(makeFrame());
    await flush();

    expect(rig.tts.cancelCalls).toBe(1);
    expect(rig.pipeline.state).toBe('listening');
    expect(rig.wakeSounds).toBe(1);

    // Late agent events from the cancelled turn are ignored.
    rig.pipeline.onAgentEvent({ kind: 'text_delta', text: 'More of the old reply. ' });
    rig.pipeline.onAgentEvent({ kind: 'done', finalText: 'x' });
    await flush();
    expect(rig.tts.spoken).toEqual(['A very long reply.']); // nothing new spoken
    expect(rig.pipeline.state).toBe('listening');

    expect(rig.states).toEqual(['thinking', 'speaking', 'listening']);
  });

  it('listen timeout with no speech returns to idle and never calls STT', async () => {
    const rig = makeRig();
    rig.wake.fireOn(1);
    await rig.pipeline.start();

    rig.capture.push(makeFrame());
    await flush();
    expect(rig.pipeline.state).toBe('listening');

    // A few silence-only frames, then the configured listen timeout elapses.
    rig.capture.push(makeFrame());
    rig.capture.push(makeFrame());
    await flush();
    await vi.advanceTimersByTimeAsync(rig.config.voice.listenTimeoutMs);

    expect(rig.pipeline.state).toBe('idle');
    expect(rig.stt.transcribeCalls).toHaveLength(0);
    expect(rig.states).toEqual(['listening', 'idle']);
  });

  it('speech before the timeout cancels the listen timer (endpointer governs the end)', async () => {
    const rig = makeRig();
    rig.wake.fireOn(1);
    rig.vad.script = ['speech']; // then fallback silence
    rig.stt.script = ['still here'];
    await rig.pipeline.start();

    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame(500)); // speech frame
    await flush();

    // Timeout elapsing after speech must NOT drop back to idle.
    await vi.advanceTimersByTimeAsync(rig.config.voice.listenTimeoutMs);
    expect(rig.pipeline.state).toBe('listening');

    // Endpoint still works afterwards.
    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();
    expect(rig.pipeline.state).toBe('thinking');
    expect(rig.utterances).toEqual(['still here']);
  });

  it('cancel during thinking stops TTS and ignores late agent events', async () => {
    const rig = makeRig();
    await rig.pipeline.start();

    rig.pipeline.injectText('do something');
    expect(rig.pipeline.state).toBe('thinking');

    rig.pipeline.cancel();
    expect(rig.tts.cancelCalls).toBe(1);
    expect(rig.pipeline.state).toBe('idle');

    // Late events from the dropped turn do nothing.
    rig.pipeline.onAgentEvent({ kind: 'text_delta', text: 'Too late. ' });
    rig.pipeline.onAgentEvent({ kind: 'done', finalText: 'Too late.' });
    await flush();
    expect(rig.tts.spoken).toEqual([]);
    expect(rig.pipeline.state).toBe('idle');
    expect(rig.states).toEqual(['thinking', 'idle']);
  });

  it('empty transcript returns to idle silently (no utterance, no thinking)', async () => {
    const rig = makeRig();
    rig.wake.fireOn(1);
    rig.vad.script = ['speech', 'silence', 'silence'];
    rig.stt.script = ['']; // whisper returned nothing usable
    await rig.pipeline.start();

    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();

    expect(rig.pipeline.state).toBe('idle');
    expect(rig.utterances).toEqual([]);
    expect(rig.transcripts).toEqual([]);
    expect(rig.states).toEqual(['listening', 'transcribing', 'idle']);
  });

  it('agent error enters the error state and auto-recovers to idle after 3s', async () => {
    const rig = makeRig();
    await rig.pipeline.start();

    rig.pipeline.injectText('break please');
    rig.pipeline.onAgentEvent({ kind: 'error', message: 'backend exploded' });
    expect(rig.pipeline.state).toBe('error');
    expect(rig.tts.cancelCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(2999);
    expect(rig.pipeline.state).toBe('error');
    await vi.advanceTimersByTimeAsync(1);
    expect(rig.pipeline.state).toBe('idle');
    expect(rig.states).toEqual(['thinking', 'error', 'idle']);
  });

  it('STT failure enters the error state and auto-recovers after 3s', async () => {
    const rig = makeRig();
    rig.wake.fireOn(1);
    rig.vad.script = ['speech', 'silence', 'silence'];
    rig.stt.failWith = new Error('whisper died');
    await rig.pipeline.start();

    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();
    rig.capture.push(makeFrame());
    await flush();

    expect(rig.pipeline.state).toBe('error');
    await vi.advanceTimersByTimeAsync(3000);
    expect(rig.pipeline.state).toBe('idle');
  });

  it('bounds the burst frame queue at ~32 and drops the overflow (never unbounded)', async () => {
    const rig = makeRig();
    rig.wake.fireOn(1);
    await rig.pipeline.start();
    rig.capture.push(makeFrame());
    await flush();
    expect(rig.pipeline.state).toBe('listening');

    // Hold VAD inference in flight, then deliver a 100-frame burst synchronously (ffmpeg's real
    // behavior — many frames per stdout data event).
    let releaseGate!: () => void;
    rig.vad.gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    rig.capture.pushBurst(100);
    await flush();

    // Exactly one frame is in flight; the queue holds at most 32 of the remaining 99.
    releaseGate();
    rig.vad.gate = null;
    await flush();

    // 1 in-flight + <=32 queued survive; the rest were dropped (oldest-first).
    expect(rig.vad.processCalls).toBeGreaterThan(0);
    expect(rig.vad.processCalls).toBeLessThanOrEqual(33);
    expect(rig.micLevels.length).toBeLessThanOrEqual(33 + 1);
  });

  it('thinking goes straight to idle on done when TTS is disabled', async () => {
    const rig = makeRig({ ttsEnabled: false });
    await rig.pipeline.start();

    rig.pipeline.injectText('quiet mode');
    rig.pipeline.onAgentEvent({ kind: 'text_delta', text: 'Reply text. ' });
    expect(rig.tts.spoken).toEqual([]); // never spoken
    rig.pipeline.onAgentEvent({ kind: 'done', finalText: 'Reply text.' });
    await flush();

    expect(rig.pipeline.state).toBe('idle');
    expect(rig.states).toEqual(['thinking', 'idle']);
  });

  it('echo mode speaks the transcript back and returns to idle (Gate A --echo)', async () => {
    const rig = makeRig({ ttsEnabled: false }); // echo must speak even with TTS disabled
    rig.pipeline.setEchoMode(true);
    await rig.pipeline.start();

    rig.pipeline.injectText('testing echo');
    await flush();

    expect(rig.tts.spoken).toEqual(['testing echo']);
    expect(rig.utterances).toEqual(['testing echo']);
    expect(rig.pipeline.state).toBe('idle');
    expect(rig.states).toEqual(['thinking', 'speaking', 'idle']);
  });

  it('stop() halts capture, cancels TTS, and is idempotent; start() resumes', async () => {
    const rig = makeRig();
    await rig.pipeline.start();
    rig.pipeline.injectText('hi');
    rig.pipeline.onAgentEvent({ kind: 'text_delta', text: 'Speaking now. ' });

    await rig.pipeline.stop();
    expect(rig.capture.stopCalls).toBe(1);
    expect(rig.tts.cancelCalls).toBe(1);
    expect(rig.pipeline.state).toBe('idle');

    await rig.pipeline.stop(); // idempotent
    expect(rig.capture.stopCalls).toBe(1);

    await rig.pipeline.start(); // tray "resume listening"
    expect(rig.capture.startCalls).toBe(2);
  });

  it('injectText supersedes an in-flight spoken turn', async () => {
    const rig = makeRig();
    rig.tts.hold = true;
    await rig.pipeline.start();

    rig.pipeline.injectText('first');
    rig.pipeline.onAgentEvent({ kind: 'text_delta', text: 'Old reply. ' });
    expect(rig.pipeline.state).toBe('speaking');

    rig.pipeline.injectText('second');
    expect(rig.tts.cancelCalls).toBe(1);
    expect(rig.pipeline.state).toBe('thinking');
    expect(rig.utterances).toEqual(['first', 'second']);
  });
});
