import { beforeEach, describe, expect, it, vi } from 'vitest';

// `@picovoice/porcupine-node` is a native-addon wrapper — there's no subprocess to fake (unlike
// capture.ts/stt.ts), so per cdd/tasks/wakeword.md the whole module is mocked directly. `vi.mock`
// factories are hoisted above imports, so the spies/state the factory closes over must be created
// via `vi.hoisted` to avoid a temporal-dead-zone reference.
const mocks = vi.hoisted(() => ({
  ctorSpy: vi.fn(),
  processImpl: vi.fn((_frame: Int16Array): number => -1),
  releaseSpy: vi.fn(),
  throwOnConstruct: null as Error | null
}));

vi.mock('@picovoice/porcupine-node', () => {
  class FakePorcupine {
    constructor(accessKey: string, keywords: string[], sensitivities: number[], options: unknown) {
      mocks.ctorSpy(accessKey, keywords, sensitivities, options);
      if (mocks.throwOnConstruct) {
        const err = mocks.throwOnConstruct;
        mocks.throwOnConstruct = null;
        throw err;
      }
    }
    process(frame: Int16Array): number {
      return mocks.processImpl(frame);
    }
    release(): void {
      mocks.releaseSpy();
    }
  }

  return {
    Porcupine: FakePorcupine,
    // Real BuiltinKeyword values (cdd copy of node_modules/@picovoice/porcupine-node's enum) —
    // kept in sync manually since the whole module is mocked.
    BuiltinKeyword: {
      ALEXA: 'alexa',
      AMERICANO: 'americano',
      BLUEBERRY: 'blueberry',
      BUMBLEBEE: 'bumblebee',
      COMPUTER: 'computer',
      GRAPEFRUIT: 'grapefruit',
      GRASSHOPPER: 'grasshopper',
      HEY_GOOGLE: 'hey google',
      HEY_SIRI: 'hey siri',
      JARVIS: 'jarvis',
      OK_GOOGLE: 'ok google',
      PICOVOICE: 'picovoice',
      PORCUPINE: 'porcupine',
      TERMINATOR: 'terminator'
    }
  };
});

import { PorcupineWake, type WakeWordConfig } from '../src/voice/wakeword';

function frame(length = 512): { samples: Int16Array } {
  return { samples: new Int16Array(length) };
}

function cfg(overrides: Partial<WakeWordConfig> = {}): WakeWordConfig {
  return {
    accessKey: 'fake-access-key',
    builtinKeyword: null,
    customKeywordPath: null,
    sensitivity: 0.6,
    ...overrides
  };
}

describe('PorcupineWake', () => {
  beforeEach(() => {
    mocks.ctorSpy.mockClear();
    mocks.releaseSpy.mockClear();
    mocks.processImpl.mockReset();
    mocks.processImpl.mockReturnValue(-1);
    mocks.throwOnConstruct = null;
  });

  describe('init() param mapping', () => {
    it('defaults to the builtin "jarvis" keyword when no config is given', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg());

      expect(mocks.ctorSpy).toHaveBeenCalledTimes(1);
      expect(mocks.ctorSpy).toHaveBeenCalledWith('fake-access-key', ['jarvis'], [0.6], {});
    });

    it('resolves a builtin keyword case-insensitively', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg({ builtinKeyword: 'COMPUTER' }));

      expect(mocks.ctorSpy).toHaveBeenCalledWith('fake-access-key', ['computer'], [0.6], {});
    });

    it('passes sensitivity through untouched', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg({ sensitivity: 0.85 }));

      expect(mocks.ctorSpy).toHaveBeenCalledWith('fake-access-key', ['jarvis'], [0.85], {});
    });

    it('a custom keyword path wins over builtinKeyword when both are set', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg({ builtinKeyword: 'jarvis', customKeywordPath: 'C:/models/hey-jarvis.ppn' }));

      expect(mocks.ctorSpy).toHaveBeenCalledWith(
        'fake-access-key',
        ['C:/models/hey-jarvis.ppn'],
        [0.6],
        {}
      );
    });

    it('throws a settings-UI-phrased error for an unrecognized builtin keyword name, without constructing Porcupine', async () => {
      const wake = new PorcupineWake();
      await expect(wake.init(cfg({ builtinKeyword: 'not-a-real-keyword' }))).rejects.toThrow(
        /not recognized — check settings/
      );
      expect(mocks.ctorSpy).not.toHaveBeenCalled();
    });
  });

  describe('init() error phrasing', () => {
    it('rephrases an access-key rejection for the settings UI', async () => {
      mocks.throwOnConstruct = new Error('Invalid AccessKey');
      const wake = new PorcupineWake();

      await expect(wake.init(cfg())).rejects.toThrow(/picovoice access key rejected — check settings/);
    });

    it('rephrases a bad/missing custom .ppn file for the settings UI', async () => {
      mocks.throwOnConstruct = new Error("File not found in 'keywords': C:/models/bad.ppn");
      const wake = new PorcupineWake();

      await expect(
        wake.init(cfg({ customKeywordPath: 'C:/models/bad.ppn' }))
      ).rejects.toThrow(/picovoice custom wake word file rejected — check settings/);
    });

    it('falls back to a generic settings-phrased message for other init failures', async () => {
      mocks.throwOnConstruct = new Error('something else went wrong');
      const wake = new PorcupineWake();

      await expect(wake.init(cfg())).rejects.toThrow(/picovoice initialization failed — check settings/);
    });
  });

  describe('process()', () => {
    it('returns true only when the mock reports a keyword index >= 0', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg());

      mocks.processImpl.mockReturnValueOnce(-1);
      expect(wake.process(frame())).toBe(false);

      mocks.processImpl.mockReturnValueOnce(0);
      expect(wake.process(frame())).toBe(true);

      mocks.processImpl.mockReturnValueOnce(2);
      expect(wake.process(frame())).toBe(true);
    });

    it('throws if called before init()', () => {
      const wake = new PorcupineWake();
      expect(() => wake.process(frame())).toThrow(/init\(\)/);
    });

    it('throws a frame-length guard error when the frame is not 512 samples', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg());

      expect(() => wake.process(frame(256))).toThrow(/512/);
      expect(mocks.processImpl).not.toHaveBeenCalled();
    });
  });

  describe('release()', () => {
    it('releases the underlying Porcupine instance', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg());

      wake.release();
      expect(mocks.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — calling release() twice only releases once', async () => {
      const wake = new PorcupineWake();
      await wake.init(cfg());

      wake.release();
      wake.release();
      expect(mocks.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('is a no-op (does not throw) when called before init()', () => {
      const wake = new PorcupineWake();
      expect(() => wake.release()).not.toThrow();
      expect(mocks.releaseSpy).not.toHaveBeenCalled();
    });
  });
});
