// @vitest-environment jsdom
// Typechecked under tsconfig.web.json (DOM lib); vitest runs it in jsdom via the docblock above.
import { beforeEach, describe, expect, it } from 'vitest';
import { MainView, relativeTime, renderTranscript } from '../src/renderer/main/app';
import { createFakeApi, type FakeApi } from '../src/renderer/shared/fakeApi';
import { DEFAULT_APP_CONFIG, type TurnRecord } from '../src/shared/types';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const TURNS: TurnRecord[] = [
  {
    id: 'a',
    at: '2026-07-15T09:00:00Z',
    backend: 'claude',
    userText: 'first question',
    assistantText: 'first answer',
    tools: [{ toolName: 'gcal.list', ok: true }]
  },
  {
    id: 'b',
    at: '2026-07-15T09:05:00Z',
    backend: 'codex',
    userText: 'second question',
    assistantText: 'second answer',
    tools: [
      { toolName: 'gmail.search', ok: true },
      { toolName: 'gmail.send', ok: false }
    ]
  }
];

describe('renderTranscript', () => {
  it('turns TurnRecord[] into the expected editorial DOM order', () => {
    const host = document.createElement('div');
    host.appendChild(renderTranscript(TURNS));

    const classes = Array.from(host.querySelectorAll('article.turn > p')).map(
      (el) => el.className
    );
    expect(classes).toEqual([
      'turn-user',
      'turn-assistant',
      'turn-tool',
      'turn-user',
      'turn-assistant',
      'turn-tool',
      'turn-tool'
    ]);

    const first = host.querySelector('article.turn') as HTMLElement;
    expect(first.dataset['turnId']).toBe('a');
    expect(first.querySelector('.turn-user')?.textContent).toBe('you — first question');
    expect(first.querySelector('.turn-prefix')?.textContent).toBe('you — ');
    expect(first.querySelector('.turn-assistant')?.textContent).toBe('first answer');
    expect(first.querySelector('.turn-tool')?.textContent).toBe('✓ gcal.list');

    const toolLines = Array.from(host.querySelectorAll('article.turn:last-child .turn-tool')).map(
      (el) => el.textContent
    );
    expect(toolLines).toEqual(['✓ gmail.search', '✕ gmail.send']);

    // editorial, not chat: no bubble-ish structure beyond flat paragraphs
    expect(host.querySelector('.bubble')).toBeNull();
  });
});

describe('MainView command bar', () => {
  let api: FakeApi;
  let root: HTMLElement;
  let view: MainView;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app') as HTMLElement;
    api = createFakeApi();
    api.sessions = [{ id: 's1', title: 'a session', updatedAt: new Date().toISOString(), backend: 'claude' }];
    api.turnsBySession = { s1: TURNS };
    view = new MainView(root, api);
    await flush();
  });

  const input = (): HTMLInputElement => root.querySelector('.command-input') as HTMLInputElement;
  const form = (): HTMLFormElement => root.querySelector('.command-bar') as HTMLFormElement;
  const pressTab = (): void => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  };
  const submit = (): void => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };

  it('submit calls command:text with the default backend and clears the input', () => {
    input().value = 'hello there';
    submit();
    expect(api.calls.sendText).toEqual([['hello there', 'claude']]);
    expect(input().value).toBe('');
  });

  it('Tab toggles the backend switch; submit uses the picked backend', () => {
    pressTab();
    input().value = 'use the other one';
    submit();
    expect(api.calls.sendText).toEqual([['use the other one', 'codex']]);

    const active = Array.from(root.querySelectorAll('.backend-switch [data-active="true"]')).map(
      (el) => el.textContent
    );
    expect(active).toEqual(['codex']);

    pressTab(); // back to claude
    input().value = 'and back';
    submit();
    expect(api.calls.sendText[1]).toEqual(['and back', 'claude']);
  });

  it('does not submit empty text', () => {
    input().value = '   ';
    submit();
    expect(api.calls.sendText).toEqual([]);
  });

  it('renders the seeded session transcript and appends on session:updated', () => {
    expect(root.querySelectorAll('article.turn')).toHaveLength(2);
    api.pushTurn({
      id: 'c',
      at: new Date().toISOString(),
      backend: 'claude',
      userText: 'third question',
      assistantText: 'third answer',
      tools: []
    });
    expect(root.querySelectorAll('article.turn')).toHaveLength(3);
  });

  it('titlebar shows the agent name and toggles the settings pane', () => {
    expect(root.querySelector('.agent-name')?.textContent).toBe('jarvis');
    const pane = root.querySelector('.settings') as HTMLElement;
    expect(pane.hidden).toBe(true);
    view.showSettings(true);
    expect(pane.hidden).toBe(false);
    view.showSettings(false);
    expect(pane.hidden).toBe(true);
  });
});

describe('MainView live events (wire-and-converse)', () => {
  let api: FakeApi;
  let root: HTMLElement;

  const makeView = async (): Promise<MainView> => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app') as HTMLElement;
    const view = new MainView(root, api);
    await flush();
    return view;
  };
  const input = (): HTMLInputElement => root.querySelector('.command-input') as HTMLInputElement;
  const submit = (): void => {
    (root.querySelector('.command-bar') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
  };

  beforeEach(() => {
    api = createFakeApi();
  });

  it('shows the durable setup notice when voice is disabled, hides it when enabled', async () => {
    api.voice = { enabled: false, reason: 'Voice models are missing — run `npm run fetch-models`.' };
    await makeView();
    const notice = root.querySelector('.setup-notice') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('fetch-models');
    // settings-ui copy voice: lowercase "voice off — <reason>" phrasing.
    expect(notice.textContent).toBe(
      'voice off — voice models are missing — run `npm run fetch-models`.'
    );

    // Voice comes up (e.g. models fetched + config fixed): a config change re-queries status.
    api.voice = { enabled: true, reason: null };
    api.pushConfig(api.config);
    await flush();
    expect(notice.hidden).toBe(true);
  });

  it('accumulates text_delta into a live turn and replaces it with the persisted record', async () => {
    await makeView();
    input().value = 'what time is it';
    submit();

    const live = root.querySelector('article.turn-live') as HTMLElement;
    expect(live).not.toBeNull();
    expect(live.querySelector('.turn-user')?.textContent).toBe('you — what time is it');

    api.pushAgentEvent({ kind: 'text_delta', text: 'It is ' });
    api.pushAgentEvent({ kind: 'text_delta', text: 'noon.' });
    expect(live.querySelector('.turn-assistant')?.textContent).toBe('It is noon.');

    // Tool activity is visible as live footnote lines (A5 confirmation-visibility).
    api.pushAgentEvent({ kind: 'tool_start', toolName: 'gmail_send', summary: 'sending an email' });
    expect(live.querySelector('.turn-tool')?.textContent).toBe('→ sending an email…');
    api.pushAgentEvent({ kind: 'tool_end', toolName: 'gmail_send', ok: true });
    expect(live.querySelector('.turn-tool')?.textContent).toBe('✓ gmail_send');

    // The persisted TurnRecord replaces the live rendition — exactly one turn remains.
    api.pushTurn({
      id: 'p1',
      at: new Date().toISOString(),
      backend: 'claude',
      userText: 'what time is it',
      assistantText: 'It is noon.',
      tools: [{ toolName: 'gmail_send', ok: true }]
    });
    expect(root.querySelector('article.turn-live')).toBeNull();
    expect(root.querySelectorAll('article.turn')).toHaveLength(1);
    expect(root.querySelector('.turn-assistant')?.textContent).toBe('It is noon.');
  });

  it('a voice turn goes live from the final transcript push', async () => {
    await makeView();
    api.pushTranscript({ text: 'partial words', final: false });
    expect(root.querySelector('article.turn-live')).toBeNull();
    api.pushTranscript({ text: 'whole utterance', final: true });
    const live = root.querySelector('article.turn-live') as HTMLElement;
    expect(live.querySelector('.turn-user')?.textContent).toBe('you — whole utterance');
  });

  it('an error event lands in the live turn', async () => {
    await makeView();
    input().value = 'break please';
    submit();
    api.pushAgentEvent({ kind: 'error', message: 'the codex backend is not available' });
    const live = root.querySelector('article.turn-live') as HTMLElement;
    expect(live.classList.contains('turn-error')).toBe(true);
    expect(live.querySelector('.turn-assistant')?.textContent).toBe(
      'the codex backend is not available'
    );
  });

  it('minimize glyph invokes window:minimize', async () => {
    await makeView();
    (root.querySelector('.btn-min') as HTMLButtonElement).click();
    expect(api.calls.minimize).toBe(1);
  });

  it('first-run (default config + models missing) opens the settings pane in setup mode', async () => {
    api.config = structuredClone(DEFAULT_APP_CONFIG);
    api.models = { ok: false, missing: ['whisper/ggml-small.en.bin'] };
    await makeView();
    await flush();
    const pane = root.querySelector('.settings') as HTMLElement;
    expect(pane.hidden).toBe(false);
    const checklist = root.querySelector('.setup-checklist') as HTMLElement;
    expect(checklist.hidden).toBe(false);
    expect(checklist.querySelectorAll('li')).toHaveLength(4);
  });

  it('no setup mode when config was already touched, even with models missing', async () => {
    // FAKE_CONFIG differs from the factory default (name lowercase, tts on).
    api.models = { ok: false, missing: ['whisper/ggml-small.en.bin'] };
    await makeView();
    await flush();
    expect((root.querySelector('.settings') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('.setup-checklist') as HTMLElement).hidden).toBe(true);
  });

  it('no setup mode when models are present, even on a default config', async () => {
    api.config = structuredClone(DEFAULT_APP_CONFIG);
    api.models = { ok: true };
    await makeView();
    await flush();
    expect((root.querySelector('.settings') as HTMLElement).hidden).toBe(true);
  });
});

describe('relativeTime', () => {
  it('is lowercase and terse', () => {
    const now = new Date('2026-07-15T12:00:00Z');
    expect(relativeTime('2026-07-15T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-07-15T11:15:00Z', now)).toBe('45m ago');
    expect(relativeTime('2026-07-15T07:00:00Z', now)).toBe('5h ago');
    expect(relativeTime('2026-07-14T10:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-07-11T12:00:00Z', now)).toBe('4d ago');
  });
});
