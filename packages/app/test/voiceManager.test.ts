// Tests for the settings-ui task's reactive voice re-init: a config change to a voice-relevant
// field (Picovoice key/keyword/device/model paths) must tear down the running pipeline and build
// a fresh one WITHOUT an app restart; a change to an unrelated field must not touch it at all.

import { describe, expect, it } from 'vitest';
import { VoiceManager, type VoiceBuildResult } from '../src/main/voiceManager';
import { makeConfig } from './fakes/testConfig';

interface FakeRuntime {
  id: number;
}

function makeHarness() {
  let nextId = 1;
  const disposed: number[] = [];
  const changes: VoiceBuildResult<FakeRuntime>[] = [];
  let buildResult: () => Promise<VoiceBuildResult<FakeRuntime>> = () =>
    Promise.resolve({ id: nextId++ });

  const manager = new VoiceManager<FakeRuntime>({
    build: () => buildResult(),
    dispose: (r) => {
      disposed.push(r.id);
    },
    onChange: (r) => {
      changes.push(r);
    }
  });

  return {
    manager,
    disposed,
    changes,
    setBuildResult: (fn: () => Promise<VoiceBuildResult<FakeRuntime>>) => {
      buildResult = fn;
    }
  };
}

describe('VoiceManager', () => {
  it('init() builds once and does not call onChange (onChange is only for rebuilds)', async () => {
    const { manager, changes } = makeHarness();
    const result = await manager.init(makeConfig());
    expect(result).toEqual({ id: 1 });
    expect(manager.current).toEqual({ id: 1 });
    expect(changes).toEqual([]);
  });

  it('a change to a non-voice field is a no-op: no dispose, no rebuild', async () => {
    const { manager, disposed, changes } = makeHarness();
    await manager.init(makeConfig());

    const next = makeConfig({ agentName: 'Friday' });
    manager.onConfigChanged(next);

    expect(disposed).toEqual([]);
    expect(changes).toEqual([]);
    expect(manager.current).toEqual({ id: 1 });
  });

  it('a change to the Picovoice key tears down the old runtime and builds a new one', async () => {
    const { manager, disposed, changes } = makeHarness();
    await manager.init(makeConfig());

    const next = makeConfig();
    next.voice.picovoiceAccessKey = 'a-real-key';
    manager.onConfigChanged(next);
    // Rebuild runs async (chained promise) — wait for it to settle.
    await flushChain(manager);

    expect(disposed).toEqual([1]);
    expect(changes).toEqual([{ id: 2 }]);
    expect(manager.current).toEqual({ id: 2 });
  });

  it('a change to the wake keyword, sensitivity, device, or model path each rebuild', async () => {
    const fields: Array<(c: ReturnType<typeof makeConfig>) => void> = [
      (c) => (c.voice.builtinKeyword = 'friday'),
      (c) => (c.voice.customKeywordPath = 'C:/keywords/custom.ppn'),
      (c) => (c.voice.sensitivity = 0.9),
      (c) => (c.voice.inputDeviceId = 'mic-2'),
      (c) => (c.voice.sttModelPath = 'C:/models/whisper.bin'),
      (c) => (c.voice.ttsVoicePath = 'C:/models/voice.onnx')
    ];
    for (const mutate of fields) {
      const { manager, disposed, changes } = makeHarness();
      await manager.init(makeConfig());
      const next = makeConfig();
      mutate(next);
      manager.onConfigChanged(next);
      await flushChain(manager);
      expect(disposed).toEqual([1]);
      expect(changes).toEqual([{ id: 2 }]);
    }
  });

  it('rebuild can fall back to a text-only reason; a prior text-only result is never disposed', async () => {
    const { manager, disposed, changes, setBuildResult } = makeHarness();
    setBuildResult(() => Promise.resolve({ reason: 'Picovoice access key is not set' }));
    await manager.init(makeConfig());
    expect(manager.current).toEqual({ reason: 'Picovoice access key is not set' });

    setBuildResult(() => Promise.resolve({ id: 42 }));
    const next = makeConfig();
    next.voice.picovoiceAccessKey = 'now-set';
    manager.onConfigChanged(next);
    await flushChain(manager);

    // The prior result was a reason, not a runtime — nothing to dispose.
    expect(disposed).toEqual([]);
    expect(changes).toEqual([{ id: 42 }]);
    expect(manager.current).toEqual({ id: 42 });
  });

  it('going from a live runtime back to text-only mode disposes the runtime and reports the reason', async () => {
    const { manager, disposed, changes, setBuildResult } = makeHarness();
    await manager.init(makeConfig());
    expect(manager.current).toEqual({ id: 1 });

    setBuildResult(() => Promise.resolve({ reason: 'voice setup failed' }));
    const next = makeConfig();
    next.voice.picovoiceAccessKey = 'changed-again';
    manager.onConfigChanged(next);
    await flushChain(manager);

    expect(disposed).toEqual([1]);
    expect(changes).toEqual([{ reason: 'voice setup failed' }]);
  });

  it('refresh() forces a rebuild without any config change (post model-download re-init)', async () => {
    const { manager, disposed, changes, setBuildResult } = makeHarness();
    setBuildResult(() => Promise.resolve({ reason: 'Voice models are missing' }));
    await manager.init(makeConfig());
    expect(manager.current).toEqual({ reason: 'Voice models are missing' });

    // models:fetch just completed — same config, but a rebuild can now succeed.
    setBuildResult(() => Promise.resolve({ id: 7 }));
    await manager.refresh();

    expect(disposed).toEqual([]);
    expect(changes).toEqual([{ id: 7 }]);
    expect(manager.current).toEqual({ id: 7 });

    // And a later refresh disposes the runtime it replaced.
    await manager.refresh();
    expect(disposed).toEqual([7]);
  });

  it('rapid successive config changes serialize into one rebuild chain (no overlapping builds)', async () => {
    const { manager, disposed, changes } = makeHarness();
    await manager.init(makeConfig());

    const a = makeConfig();
    a.voice.picovoiceAccessKey = 'key-a';
    const b = makeConfig();
    b.voice.picovoiceAccessKey = 'key-b';

    manager.onConfigChanged(a);
    manager.onConfigChanged(b);
    await flushChain(manager);

    // Two distinct voice-relevant changes -> two rebuilds, each disposing its predecessor in order.
    expect(disposed).toEqual([1, 2]);
    expect(changes).toEqual([{ id: 2 }, { id: 3 }]);
  });
});

/** Waits for VoiceManager's internal rebuild chain to settle by yielding a few microtask turns. */
async function flushChain<T>(_manager: VoiceManager<T>): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}
