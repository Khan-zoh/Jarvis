// @vitest-environment jsdom
// settings-ui task: the settings pane must (a) round-trip every control through the IPC
// surface with debounced saves + a fading `saved ✓` tick, (b) explain that the bundled wake
// phrase remains fixed after rename, (c) capture the hotkey from a real key chord,
// (d) surface model status with a
// working streamed download, (f) probe both backend accounts with fix-hint copy, (g)
// auto-render one section per tools-mcp plugin manifest (text/number/toggle/secret/action),
// (h) never display a fetched secret value, and (i) drive the first-run setup checklist from
// a status matrix.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceleratorFromEvent,
  buildSettingsPane,
  deriveSetupChecklist,
  type SettingsPane,
  type SetupStatuses
} from '../src/renderer/main/settings';
import { createFakeApi, FAKE_CONFIG, type FakeApi } from '../src/renderer/shared/fakeApi';
import type { PluginManifest } from '../src/shared/types';

const flush = async (times = 2): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

const MANIFESTS: PluginManifest[] = [
  {
    id: 'system',
    displayName: 'System',
    settings: [
      {
        key: 'allowUnsafePaths',
        label: 'allow launching file paths',
        kind: 'toggle',
        help: 'off by default'
      }
    ]
  },
  // No settings declared: must not render an (empty) section at all.
  { id: 'web', displayName: 'Web', settings: [] },
  // Deliberately skipped by the generic renderer (see settings.ts) — already has a dedicated,
  // functionally-wired Accounts section using AppConfig, not the plugin store. Its `connect`
  // action still exists in the manifest and routes through plugin:action in main.
  {
    id: 'google',
    displayName: 'Google Workspace',
    settings: [
      { key: 'clientId', label: 'google client id', kind: 'text' },
      { key: 'clientSecret', label: 'google client secret', kind: 'secret' },
      { key: 'connect', label: 'connect / disconnect google', kind: 'action' }
    ]
  },
  {
    id: 'smarthome',
    displayName: 'Smart Home',
    settings: [
      { key: 'baseUrl', label: 'hub base url', kind: 'text', placeholder: 'http://192.168.1.10' },
      { key: 'apiKey', label: 'api key', kind: 'secret', help: 'from the hub admin panel' },
      { key: 'pollSeconds', label: 'poll interval (s)', kind: 'number' },
      { key: 'webhookSecret', label: 'webhook secret', kind: 'secret', placeholder: 'not set' },
      { key: 'rescan', label: 'rescan devices', kind: 'action' }
    ]
  }
];

function findField(el: HTMLElement, labelText: string): HTMLInputElement {
  const fields = Array.from(el.querySelectorAll<HTMLElement>('.field'));
  const wrap = fields.find((f) => f.querySelector('label')?.textContent === labelText);
  if (!wrap) throw new Error(`field not found: ${labelText}`);
  return wrap.querySelector('input, select') as HTMLInputElement;
}

function findButton(el: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === label
  );
  if (!btn) throw new Error(`button not found: ${label}`);
  return btn;
}

function fire(el: HTMLElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('acceleratorFromEvent', () => {
  it('maps chords to Electron accelerator strings', () => {
    expect(
      acceleratorFromEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true }))
    ).toBe('Ctrl+Shift+K');
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', { key: ' ', ctrlKey: true }))).toBe(
      'Ctrl+Space'
    );
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', { key: 'F5', altKey: true }))).toBe(
      'Alt+F5'
    );
  });

  it('returns null while only a modifier is down', () => {
    expect(
      acceleratorFromEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    ).toBeNull();
    expect(
      acceleratorFromEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }))
    ).toBeNull();
  });
});

describe('deriveSetupChecklist (status fixture matrix)', () => {
  const base: SetupStatuses = {
    modelsOk: false,
    micAvailable: false,
    claudeOk: false,
    codexOk: false,
    googleConnected: false
  };

  it('all statuses off → four items, none done, google marked optional', () => {
    const items = deriveSetupChecklist(base);
    expect(items).toHaveLength(4);
    expect(items.every((i) => !i.done)).toBe(true);
    expect(items.map((i) => i.label)).toEqual([
      'download voice models',
      'plug in a microphone',
      'sign in to claude or codex',
      'connect google'
    ]);
    expect(items[3]?.optional).toBe(true);
    expect(items.slice(0, 3).every((i) => !i.optional)).toBe(true);
  });

  it('each status flips exactly its own item', () => {
    const cases: [Partial<SetupStatuses>, number][] = [
      [{ modelsOk: true }, 0],
      [{ micAvailable: true }, 1],
      [{ claudeOk: true }, 2],
      [{ codexOk: true }, 2],
      [{ googleConnected: true }, 3]
    ];
    for (const [patch, index] of cases) {
      const items = deriveSetupChecklist({ ...base, ...patch });
      items.forEach((item, i) => expect(item.done).toBe(i === index));
    }
  });

  it('accounts item is done when EITHER backend is ok', () => {
    expect(deriveSetupChecklist({ ...base, claudeOk: true })[2]?.done).toBe(true);
    expect(deriveSetupChecklist({ ...base, codexOk: true })[2]?.done).toBe(true);
    expect(deriveSetupChecklist({ ...base, claudeOk: true, codexOk: true })[2]?.done).toBe(true);
  });

  it('everything on → all done', () => {
    const items = deriveSetupChecklist({
      modelsOk: true,
      micAvailable: true,
      claudeOk: true,
      codexOk: true,
      googleConnected: true
    });
    expect(items.every((i) => i.done)).toBe(true);
  });
});

describe('buildSettingsPane', () => {
  let api: FakeApi;
  let pane: SettingsPane;

  const build = async (): Promise<void> => {
    pane = buildSettingsPane(api, { debounceMs: 0 });
    pane.applyConfig(api.config);
    await flush();
  };

  describe('debounced saves + saved tick', () => {
    beforeEach(async () => {
      api = createFakeApi();
      await build();
    });

    it('a config edit lands via config:set after the debounce window, then shows saved ✓', async () => {
      const input = findField(pane.el, 'name');
      input.value = 'friday';
      fire(input);
      // Not yet flushed within the same tick — the save is debounced.
      expect(api.calls.setConfig).toEqual([]);
      await flush();
      expect(api.calls.setConfig).toEqual([{ agentName: 'friday' }]);

      const tick = pane.el.querySelector('.saved-tick') as HTMLElement;
      expect(tick.textContent).toBe('saved ✓');
      expect(tick.classList.contains('show')).toBe(true);
    });

    it('rapid edits to different fields all land, in order, as one burst', async () => {
      const name = findField(pane.el, 'name');
      name.value = 'friday';
      fire(name);
      const tts = findField(pane.el, 'speak replies');
      tts.checked = false;
      fire(tts);
      await flush();
      expect(api.calls.setConfig).toEqual([
        { agentName: 'friday' },
        { voice: { ...FAKE_CONFIG.voice, ttsEnabled: false } }
      ]);
    });

    it('a secret save also shows the tick', async () => {
      const input = findField(pane.el, 'google client secret');
      input.value = 'google-secret';
      fire(input);
      await flush();
      const tick = pane.el.querySelector('.saved-tick') as HTMLElement;
      expect(tick.classList.contains('show')).toBe(true);
    });
  });

  describe('agent section', () => {
    beforeEach(async () => {
      api = createFakeApi();
      await build();
    });

    it('rename warning appears only when name ≠ keyword', () => {
      const warning = pane.el.querySelector('.rename-warning') as HTMLElement;
      // FAKE_CONFIG: name 'jarvis', keyword 'jarvis' → no warning.
      expect(warning.hidden).toBe(true);

      const cfg = structuredClone(FAKE_CONFIG);
      cfg.agentName = 'friday';
      pane.applyConfig(cfg);
      expect(warning.hidden).toBe(false);
      expect(warning.textContent).toContain("wake phrase stays 'hey jarvis'");

      // Back to a matching name → hidden again.
      pane.applyConfig(structuredClone(FAKE_CONFIG));
      expect(warning.hidden).toBe(true);
    });

    it('rename warning updates live on the name field, before the save lands', () => {
      const input = findField(pane.el, 'name');
      input.value = 'friday';
      fire(input);
      expect((pane.el.querySelector('.rename-warning') as HTMLElement).hidden).toBe(false);
    });

    it('the hotkey field captures a key chord instead of text', async () => {
      const input = findField(pane.el, 'hotkey (restart required)');
      expect(input.readOnly).toBe(true);
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, cancelable: true })
      );
      expect(input.value).toBe('Ctrl+Shift+K');
      await flush();
      expect(api.calls.setConfig).toEqual([{ ui: { ...FAKE_CONFIG.ui, hotkey: 'Ctrl+Shift+K' } }]);
    });

    it('a modifier-only keydown does not save', async () => {
      const input = findField(pane.el, 'hotkey (restart required)');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
      await flush();
      expect(api.calls.setConfig).toEqual([]);
    });

    it('the codex model field round-trips through config:set', async () => {
      const input = findField(pane.el, 'codex model');
      input.value = 'o4-mini';
      fire(input);
      await flush();
      expect(api.calls.setConfig).toEqual([
        { agents: { ...FAKE_CONFIG.agents, codex: { model: 'o4-mini' } } }
      ]);
    });
  });

  describe('voice section', () => {
    beforeEach(async () => {
      api = createFakeApi();
      await build();
    });

    it('shows the fixed local wake phrase and requires no key', () => {
      expect(pane.el.textContent).toContain("wake phrase: 'hey jarvis'");
      expect(pane.el.textContent).toContain('no account or key required');
      expect(pane.el.textContent).not.toContain('picovoice access key');
    });
  });

  describe('model status + download', () => {
    beforeEach(() => {
      api = createFakeApi();
    });

    it('models present → status line, no download button', async () => {
      api.models = { ok: true };
      await build();
      expect(
        Array.from(pane.el.querySelectorAll('.status-line')).some(
          (p) => p.textContent === 'voice models present'
        )
      ).toBe(true);
      expect(findButton(pane.el, 'download models').hidden).toBe(true);
    });

    it('models missing → names listed, download runs, streams progress, and re-checks', async () => {
      api.models = { ok: false, missing: ['whisper/ggml-small.en.bin', 'bin/ffmpeg/ffmpeg.exe'] };
      await build();
      const status = Array.from(pane.el.querySelectorAll('.status-line')).find((p) =>
        p.textContent?.startsWith('voice models missing')
      );
      expect(status?.textContent).toBe(
        'voice models missing: whisper/ggml-small.en.bin, bin/ffmpeg/ffmpeg.exe'
      );

      const btn = findButton(pane.el, 'download models');
      expect(btn.hidden).toBe(false);

      // The next status check (after the download) reports everything present.
      api.models = { ok: true };
      btn.click();
      api.pushModelsProgress('whisper-model-small.en: downloading…');
      api.pushModelsProgress('whisper-model-small.en: already present, hash verified');
      await flush(4);

      expect(api.calls.fetchModels).toBe(1);
      const progress = pane.el.querySelector('.model-progress') as HTMLElement;
      expect(progress.hidden).toBe(false);
      expect(progress.textContent).toContain('hash verified');
      expect(
        Array.from(pane.el.querySelectorAll('.status-line')).some(
          (p) => p.textContent === 'voice models present'
        )
      ).toBe(true);
      expect(btn.hidden).toBe(true);
    });

    it('a failed download names the failed specs', async () => {
      api.models = { ok: false, missing: ['vad/silero_vad.onnx'] };
      api.fetchResult = { ok: false, failed: ['silero-vad'] };
      await build();
      findButton(pane.el, 'download models').click();
      await flush(4);
      expect(
        Array.from(pane.el.querySelectorAll('.status-line')).some(
          (p) => p.textContent === 'model download failed: silero-vad'
        )
      ).toBe(true);
    });
  });

  describe('accounts section', () => {
    it('both backends ok → ready lines', async () => {
      api = createFakeApi();
      api.accounts = { claude: { ok: true }, codex: { ok: true } };
      await build();
      const texts = Array.from(pane.el.querySelectorAll('.status-line')).map((p) => p.textContent);
      expect(texts).toContain('claude: ready');
      expect(texts).toContain('codex: ready');
    });

    it('a failed probe shows its problem plus the fix-hint copy', async () => {
      api = createFakeApi();
      api.accounts = {
        claude: { ok: false, problem: 'Not logged in' },
        codex: { ok: false, problem: 'codex CLI not authenticated' }
      };
      await build();
      const texts = Array.from(pane.el.querySelectorAll('.status-line')).map((p) => p.textContent);
      expect(texts).toContain('claude: Not logged in — run `claude /login` in a terminal');
      expect(texts).toContain(
        'codex: codex CLI not authenticated — run `codex login` in a terminal'
      );
    });

    it('google client secret is write-only and never renders a fetched value', async () => {
      api = createFakeApi();
      await build();
      const cfg = structuredClone(FAKE_CONFIG);
      cfg.google.clientSecret = '•set';
      pane.applyConfig(cfg);
      const input = findField(pane.el, 'google client secret');
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('•set');
      input.value = 'shh';
      fire(input);
      await flush();
      expect(api.calls.setSecret).toContainEqual(['googleClientSecret', 'shh']);
      expect(input.value).toBe('');
    });
  });

  describe('plugin sections (data-driven from the manifest)', () => {
    beforeEach(async () => {
      api = createFakeApi();
      api.pluginManifests = MANIFESTS;
      api.pluginConfigs = {
        system: { config: { allowUnsafePaths: false }, secretsSet: [] },
        smarthome: {
          config: { baseUrl: 'http://hub.local', pollSeconds: 30 },
          secretsSet: ['apiKey']
        }
      };
      await build();
      await flush(); // plugin sections build with a nested await per manifest
    });

    it('renders one section per non-empty manifest, skipping empty and google', () => {
      const headings = Array.from(pane.el.querySelectorAll('section h2')).map((h) => h.textContent);
      expect(headings).toContain('System');
      expect(headings).toContain('Smart Home');
      expect(headings).not.toContain('Web');
      expect(headings).not.toContain('Google Workspace');
    });

    it('a toggle field starts from the fetched config and round-trips through plugin:setConfig', () => {
      const checkbox = findField(pane.el, 'allow launching file paths');
      expect(checkbox.type).toBe('checkbox');
      expect(checkbox.checked).toBe(false);
      checkbox.checked = true;
      fire(checkbox);
      expect(api.calls.pluginSetConfig).toEqual([['system', { allowUnsafePaths: true }]]);
    });

    it('renders the help text for a plugin setting', () => {
      const help = Array.from(pane.el.querySelectorAll('.status-line')).map((p) => p.textContent);
      expect(help).toContain('off by default');
      expect(help).toContain('from the hub admin panel');
    });

    it('a text field is pre-filled from getConfig and edits call plugin:setConfig', () => {
      const input = findField(pane.el, 'hub base url');
      expect(input.value).toBe('http://hub.local');
      input.value = 'http://192.168.1.50';
      fire(input);
      expect(api.calls.pluginSetConfig).toEqual([['smarthome', { baseUrl: 'http://192.168.1.50' }]]);
    });

    it('a number field round-trips as a number, not a string', () => {
      const input = findField(pane.el, 'poll interval (s)');
      expect(input.value).toBe('30');
      input.value = '60';
      fire(input);
      expect(api.calls.pluginSetConfig).toEqual([['smarthome', { pollSeconds: 60 }]]);
    });

    it('an action setting renders as a button that invokes plugin:action', () => {
      findButton(pane.el, 'rescan devices').click();
      expect(api.calls.pluginAction).toEqual([['smarthome', 'rescan']]);
    });

    it('a secret field with secretsSet shows the masked placeholder and never a real value', () => {
      const input = findField(pane.el, 'api key');
      expect(input.type).toBe('password');
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('•set');
    });

    it('a secret field absent from secretsSet shows its own placeholder, not the masked one', () => {
      const input = findField(pane.el, 'webhook secret');
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('not set');
    });

    it('typing into a secret field and saving calls plugin:setSecret and clears the input', () => {
      const input = findField(pane.el, 'api key');
      input.value = 'new-hub-key';
      fire(input);
      expect(api.calls.pluginSetSecret).toEqual([['smarthome', 'apiKey', 'new-hub-key']]);
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('•set');
    });

    it('a blank change on a secret field does not call plugin:setSecret', () => {
      const input = findField(pane.el, 'api key');
      fire(input);
      expect(api.calls.pluginSetSecret).toEqual([]);
    });
  });

  describe('setup checklist rendering', () => {
    it('is hidden by default and renders numbered items in setup mode', async () => {
      api = createFakeApi();
      api.models = { ok: false, missing: ['x'] };
      api.accounts = { claude: { ok: false }, codex: { ok: false } };
      await build();
      const sec = pane.el.querySelector('.setup-checklist') as HTMLElement;
      expect(sec.hidden).toBe(true);

      pane.setSetupMode(true);
      expect(sec.hidden).toBe(false);
      const items = Array.from(sec.querySelectorAll('li'));
      expect(items).toHaveLength(4);
      // The mic item is done: the fake api reports one input device.
      expect(items.map((li) => (li as HTMLElement).dataset['done'])).toEqual([
        'false',
        'true',
        'false',
        'false'
      ]);
      expect(items[3]?.textContent).toContain('(optional)');
    });

    it('items check off live as statuses turn ok', async () => {
      api = createFakeApi();
      api.models = { ok: false, missing: ['x'] };
      api.accounts = { claude: { ok: true }, codex: { ok: false } };
      await build();
      pane.setSetupMode(true);

      const done = (): (string | undefined)[] =>
        Array.from(pane.el.querySelectorAll('.setup-checklist li')).map(
          (li) => (li as HTMLElement).dataset['done']
        );
      // models missing, mic ok, claude ok, google off.
      expect(done()).toEqual(['false', 'true', 'true', 'false']);

      // Google connects.
      const cfg = structuredClone(FAKE_CONFIG);
      cfg.google.connectedEmail = 'me@example.com';
      pane.applyConfig(cfg);
      expect(done()).toEqual(['false', 'true', 'true', 'true']);

      // Models arrive (download button flow re-checks status).
      api.models = { ok: true };
      findButton(pane.el, 'download models').click();
      await flush(4);
      expect(done()).toEqual(['true', 'true', 'true', 'true']);
    });
  });
});
